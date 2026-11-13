import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Resolve the harness home exactly like @deepseek-ai/dsh-home-paths does. */
export function dshHome(env = process.env) {
  const configured = (env.DSH_HOME ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), '.dsh');
}

export function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Root directory of this plugin's runtime data. */
export function workbenchHome(env = process.env) {
  const configured = (env.SHIPPING_WORKBENCH_HOME ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(dshHome(env), 'shipping-workbench');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slugify(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
