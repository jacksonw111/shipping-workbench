#!/usr/bin/env node
/**
 * 手动体检脚本(不参与 npm test):把 PDF 船期表解析成行表,打印前 N 行。
 *
 *   node scripts/pdf-inspect.mjs                    # 默认跑仓库内 + 邮件附件里的真实样本
 *   node scripts/pdf-inspect.mjs <file.pdf> [更多]   # 只跑指定文件
 *   node scripts/pdf-inspect.mjs --rows 20 <file>   # 打印行数
 *
 * 输出:每页的 item 数、耗时、探测出的表头行、行数,以及前几行(按 `|` 分列)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdfWorkbook, isPdfFile } from '../src/domain/pdf.js';
import { detectHeaderRow } from '../src/domain/schedule-parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const workbench = path.join(os.homedir(), '.dsh', 'shipping-workbench', 'mail', 'attachments');

const SAMPLES = [
  path.join(repoRoot, 'docs', 'AI相关技能文件', 'Matson 船期表', 'sha_and_ngb (1).pdf'),
  path.join(workbench, '32', '01-rasp.pdf'),
  path.join(workbench, '9', '01-SLG-schedule-Nov-04th.pdf'),
  path.join(workbench, '10', '01-SFT-West-Bound-船期表-2026.11.4-update.pdf'),
];

const argv = process.argv.slice(2);
const rowFlag = argv.findIndex((arg) => arg === '--rows');
const rowLimit = rowFlag >= 0 ? Number(argv[rowFlag + 1]) || 10 : 10;
const files = argv.filter((arg, index) => !arg.startsWith('--') && index !== rowFlag + 1);
const targets = files.length > 0 ? files : SAMPLES;

for (const file of targets) {
  console.log(`\n==== ${file}`);
  if (!fs.existsSync(file)) {
    console.log('  跳过:文件不存在');
    continue;
  }
  if (!isPdfFile(file)) {
    console.log('  跳过:不是 .pdf');
    continue;
  }
  const started = Date.now();
  try {
    const pages = await readPdfWorkbook(fs.readFileSync(file));
    const elapsed = Date.now() - started;
    const totalRows = pages.reduce((sum, page) => sum + page.rows.length, 0);
    const columns = Math.max(0, ...pages.map((page) => page.rows.reduce((max, row) => Math.max(max, row.length), 0)));
    console.log(`  ${pages.length} 页 / ${totalRows} 行 / 最多 ${columns} 列 / ${elapsed}ms`);
    for (const page of pages) {
      const detected = detectHeaderRow(page.rows);
      const header = detected ? page.rows[detected.index] : null;
      console.log(
        `  [${page.name}] ${page.rows.length} 行;表头行=${detected ? detected.index + 1 : '未识别'}` +
          `${header ? `: ${header.filter(Boolean).join(' | ')}` : ''}`,
      );
      page.rows.slice(0, rowLimit).forEach((row, index) => {
        console.log(`    ${String(index + 1).padStart(2)}| ${row.join(' | ')}`);
      });
      if (page.rows.length > rowLimit) console.log(`    … 还有 ${page.rows.length - rowLimit} 行`);
    }
  } catch (error) {
    console.log(`  失败:${error.message}`);
  }
}
