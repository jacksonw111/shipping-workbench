#!/usr/bin/env node
/**
 * 一键更新:从 GitHub 拉最新版本,覆盖已安装的插件。
 *
 *   ./update.command            # 检查并更新
 *   ./update.command --check    # 只看有没有新版本
 *   ./update.command --restart  # 更新完顺手重启 DeepSeek Harness
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Updater } from '../src/domain/updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const wantRestart = args.includes('--restart');

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const profile = process.env.DSH_PROFILE ?? 'desktop';
const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(dshHome, 'profiles', profile);
const appDir = path.join(profileDir, 'plugins', 'shipping-workbench');
const dataHome = path.join(dshHome, 'shipping-workbench');

if (!fs.existsSync(path.join(appDir, 'package.json'))) {
  console.error(`没找到已安装的插件:${appDir}`);
  console.error('先运行 ./install.sh,或者确认 profile 名称(DSH_PROFILE)。');
  process.exit(1);
}

const updater = new Updater({ appDir, home: dataHome });

if (checkOnly) {
  const info = await updater.check();
  if (info.error) {
    console.error(`检查更新失败:${info.error}`);
    process.exit(2);
  }
  console.log(`当前 v${info.current} · 远端 v${info.latest}${info.hasUpdate ? '(有新版本)' : '(已是最新)'}`);
  process.exit(0);
}

let result;
try {
  result = await updater.apply();
} catch (error) {
  console.error(`更新失败:${error.message}`);
  process.exit(2);
}

if (result.skipped) {
  console.log(result.reason);
  process.exit(0);
}

console.log(`已更新:v${result.from} → v${result.to}`);
console.log(`备份:${result.backup}`);
if (result.restartRequired) {
  console.log('后端代码已更新,**需要重启 DeepSeek Harness 才生效**;界面文件刷新页面即可。');
  if (wantRestart) {
    console.log('正在重启…');
    spawnSync('bash', [path.join(repoRoot, 'restart.command')], { stdio: 'inherit' });
  } else {
    console.log('也可以加 --restart 让脚本自动重启。');
  }
} else {
  console.log('只更新了界面文件,刷新工作台页面即可。');
}
