import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * 从 GitHub 跟随更新。
 *
 * 插件装进 profile 的是**一份副本**,不跟 git;这里负责:查最新版本 → 下载 main 压缩包 →
 * 校验包名 → 覆盖 lib/ui/package.json 等 → 告诉调用方「只改了界面」还是「后端也变了」。
 * 后端代码在进程启动时已经加载,覆盖文件不会热替换,必须重启应用。
 */

/** 默认更新源。改仓库只改这里,或由设置覆盖。 */
export const DEFAULT_UPDATE_SOURCE = {
  owner: 'jacksonw111',
  repo: 'shipping-workbench',
  branch: 'main',
};

/** 覆盖进插件目录的文件/目录。 */
const UPDATE_ENTRIES = [
  'lib',
  'ui',
  'src',
  'scripts',
  'package.json',
  'README.md',
  'cordis.patch.yml',
  'update.command',
  'restart.command',
];

/** 版本比较:`0.10.1` > `0.9.9`;解析不出来的按 0 处理。 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

function safeVersion(value) {
  return String(value ?? '').replace(/[^\w.-]/g, '') || 'unknown';
}

function hashFile(file) {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function copyEntry(sourceDir, targetDir, entry) {
  const from = path.join(sourceDir, entry);
  if (!fs.existsSync(from)) return false;
  const to = path.join(targetDir, entry);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

export class Updater {
  /**
   * @param options.appDir - 已安装的插件目录(含 package.json / lib / ui)。
   * @param options.home - 工作台数据目录,用来放备份。
   * @param options.source - `{owner, repo, branch}`,默认见 DEFAULT_UPDATE_SOURCE。
   * @param options.fetchImpl - 便于测试替换。
   */
  constructor({ appDir, home, source = DEFAULT_UPDATE_SOURCE, fetchImpl } = {}) {
    this.appDir = appDir;
    this.home = home;
    this.source = { ...DEFAULT_UPDATE_SOURCE, ...(source ?? {}) };
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  get currentVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.appDir, 'package.json'), 'utf8')).version ?? '';
    } catch {
      return '';
    }
  }

  get rawBase() {
    const { owner, repo, branch } = this.source;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  }

  get tarballUrl() {
    const { owner, repo, branch } = this.source;
    return `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
  }

  /**
   * 读远端 package.json。
   *
   * 优先走 GitHub API:raw.githubusercontent 是 CDN,刚推完的几分钟里仍返回旧内容,
   * 会让「检查更新」误报「已是最新」。API 拿不到(限流/离线)再退回 raw。
   */
  async remoteManifest({ timeoutMs = 8000 } = {}) {
    const { owner, repo, branch } = this.source;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`;
    const api = await this.fetchImpl(apiUrl, {
      headers: { accept: 'application/vnd.github.raw', 'user-agent': 'shipping-workbench-updater' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => ({ ok: false, status: 0, error }));
    if (api.ok) {
      const text = await api.text();
      const manifest = JSON.parse(text);
      if (manifest?.version) return manifest;
    }
    const raw = await this.fetchImpl(`${this.rawBase}/package.json`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!raw.ok) throw new Error(`GitHub 返回 HTTP ${raw.status || api.status}`);
    const manifest = await raw.json();
    if (!manifest?.version) throw new Error('远端 package.json 没有 version');
    return manifest;
  }

  /** 只查远端 package.json 的版本,不下载整包。 */
  async check({ timeoutMs = 8000 } = {}) {
    const current = this.currentVersion;
    try {
      const remote = await this.remoteManifest({ timeoutMs });
      const latest = String(remote.version ?? '').trim();
      return {
        current,
        latest,
        hasUpdate: isNewer(latest, current),
        source: this.source,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        current,
        latest: '',
        hasUpdate: false,
        source: this.source,
        error: error.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /** 下载并解压 main 分支;返回解压后的包目录与清理函数。 */
  async download({ timeoutMs = 60_000 } = {}) {
    const response = await this.fetchImpl(this.tarballUrl, {
      headers: { accept: 'application/gzip' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`下载更新包失败:HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('下载到的更新包是空的');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-update-'));
    const archive = path.join(tempRoot, 'update.tar.gz');
    fs.writeFileSync(archive, buffer);
    const extractDir = path.join(tempRoot, 'src');
    fs.mkdirSync(extractDir);
    const result = spawnSync('tar', ['-xzf', archive, '-C', extractDir], { encoding: 'utf8' });
    if (result.status !== 0) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw new Error(`解压更新包失败:${(result.stderr ?? '').split('\n')[0] || 'tar 出错'}`);
    }
    const top = fs.readdirSync(extractDir).find((name) => fs.statSync(path.join(extractDir, name)).isDirectory());
    if (!top) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw new Error('更新包里没有找到插件目录');
    }
    return {
      dir: path.join(extractDir, top),
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  }

  /**
   * 把一个解压好的包目录覆盖到当前安装目录(不负责下载,便于测试)。
   * 覆盖前先把当前 lib/ui/package.json 备份到 `<home>/plugin-backup/`。
   */
  applyFromDirectory(sourceDir, { force = false } = {}) {
    const manifestFile = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(manifestFile)) throw new Error('更新包里没有 package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.name !== 'shipping-workbench') {
      throw new Error(`更新包不是本插件(name=${manifest.name ?? '未知'})`);
    }
    if (!fs.existsSync(path.join(sourceDir, 'lib', 'index.js'))) {
      throw new Error('更新包里没有 lib/index.js');
    }
    const from = this.currentVersion;
    const to = String(manifest.version ?? '');
    if (!force && !isNewer(to, from)) {
      return { skipped: true, reason: `已是最新版本(v${from})`, from, to };
    }

    const before = hashFile(path.join(this.appDir, 'lib', 'index.js'));
    const backupDir = path.join(
      this.home,
      'plugin-backup',
      `${safeVersion(from)}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    fs.mkdirSync(backupDir, { recursive: true });
    for (const entry of UPDATE_ENTRIES) {
      try {
        fs.cpSync(path.join(this.appDir, entry), path.join(backupDir, entry), { recursive: true });
      } catch {
        // 备份缺项不影响更新
      }
    }

    const copied = UPDATE_ENTRIES.filter((entry) => copyEntry(sourceDir, this.appDir, entry));
    const after = hashFile(path.join(this.appDir, 'lib', 'index.js'));
    const backendChanged = before !== after;
    const result = {
      skipped: false,
      from,
      to,
      copied,
      backendChanged,
      // 只改了界面时刷新页面就够;后端变了必须重启。
      uiOnly: !backendChanged,
      restartRequired: backendChanged,
      backup: backupDir,
      appliedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(this.home, 'plugin-backup', 'last.json'), `${JSON.stringify(result, null, 2)}\n`);
    } catch {
      // 记录失败不影响更新
    }
    return result;
  }

  /** 下载 + 覆盖。 */
  async apply(options = {}) {
    const latest = await this.check();
    if (latest.error) throw new Error(latest.error);
    if (!latest.hasUpdate && !options.force) {
      return { skipped: true, reason: `已是最新版本(v${latest.current})`, from: latest.current, to: latest.latest };
    }
    const download = await this.download();
    try {
      return this.applyFromDirectory(download.dir, options);
    } finally {
      download.cleanup();
    }
  }
}
