import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

/** Read a JSON file, returning `fallback` when it is absent or unparsable. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (tmp file + rename) with owner-only permissions. */
export function writeJson(file, value, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  return value;
}

/** Append one JSON line to a newline-delimited log file. */
export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** Read at most `limit` recent JSON lines, newest last. */
export function readJsonl(file, limit = 200) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit)).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
