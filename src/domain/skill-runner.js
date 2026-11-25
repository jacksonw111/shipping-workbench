import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 执行技能包里的对比脚本。
 *
 * Skill 常见的形态是「SKILL.md + scripts/xxx.py|mjs」:真正决定产出格式的是脚本本身,
 * 靠提示词复述规则永远对不上。所以这里把脚本跑起来,把成品文件交给界面下载。
 *
 * 安全边界:
 * - 只有用户显式允许(executeScripts)才会执行;
 * - 工作目录固定在技能包目录,输出写到 run 的 out/ 子目录;
 * - 超时(默认 2 分钟)和输出大小都有上限;
 * - 不联网、不额外给权限,脚本能做什么取决于它自己,风险由用户承担。
 */

/** 脚本执行超时。 */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** stdout/stderr 各保留多少字符。 */
const MAX_LOG_CHARS = 4000;

/** 在包内脚本里挑一个「最像入口」的。 */
export function detectEntryScript(skill) {
  const scripts = (skill?.scripts ?? []).filter((name) => /\.(py|mjs|js|cjs)$/i.test(name));
  if (scripts.length === 0) return null;
  const score = (name) => {
    let value = 0;
    if (/(compare|cmp|diff|shipcmp)/i.test(name)) value += 10;
    if (/\.(mjs|js|cjs)$/i.test(name)) value += 3;
    if (/\.py$/i.test(name)) value += 2;
    if (/(test|setup|install|example)/i.test(name)) value -= 8;
    return value;
  };
  return [...scripts].sort((left, right) => score(right) - score(left))[0];
}

/** 选择解释器:node 一定在(宿主就是 node),python 依次试 python3/python。 */
function interpreterFor(script) {
  const extension = path.extname(script).toLowerCase();
  if (['.mjs', '.js', '.cjs'].includes(extension)) return { command: process.execPath, prefix: [] };
  if (extension === '.py') return { command: process.platform === 'win32' ? 'python' : 'python3', prefix: [] };
  return null;
}

function truncate(value) {
  const text = String(value ?? '');
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}…(截断)` : text;
}

function listOutputs(dir, limit = 20) {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        return stat.isFile() ? { name, size: stat.size, path: file } : null;
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 跑一个脚本:`<runner> <script> <old> <new> --out <outDir>/result.xlsx`
 * 同时给环境变量 `SKILL_OLD_FILE / SKILL_NEW_FILE / SKILL_OUT_DIR`。
 *
 * @returns `{ script, runner, code, stdout, stderr, durationMs, outputs }`
 */
export function runSkillScript({ skillDir, script, oldFile, newFile, outDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const runtime = interpreterFor(script);
  if (!runtime) throw new Error(`不支持的脚本类型:${script}`);
  const target = path.join(skillDir, script);
  if (!fs.existsSync(target)) throw new Error(`技能包里找不到脚本:${script}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'result.xlsx');

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(runtime.command, [...runtime.prefix, target, oldFile, newFile, '--out', outFile], {
      cwd: skillDir,
      env: {
        ...process.env,
        SKILL_OLD_FILE: oldFile,
        SKILL_NEW_FILE: newFile,
        SKILL_OUT_DIR: outDir,
        PYTHONIOENCODING: 'utf-8',
      },
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_LOG_CHARS * 2) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_LOG_CHARS * 2) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(new Error(`脚本启动失败:${error.message}`)));
    child.on('close', (code, signal) => {
      resolve({
        script,
        runner: path.basename(runtime.command),
        code: code ?? -1,
        signal: signal ?? '',
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
        outputs: listOutputs(outDir),
      });
    });
  });
}