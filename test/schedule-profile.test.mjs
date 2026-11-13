import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { compareWithProfile, exportProfileResult } from '../src/domain/schedule.js';
import { detectHeaderRow, parseScheduleWorkbook } from '../src/domain/schedule-parse.js';
import { writeXlsx } from '../src/domain/xlsx-writer.js';

const HEADER = ['始发港', 'SVC', '船名', '航次', '开航日期', '目的港'];

function buffer(sheets) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const MATSON_PROFILE = {
  keys: [
    { name: '主键', columns: ['始发港', 'SVC', '船名', '航次'] },
    { name: '次键', columns: ['SVC', '船名', '航次'] },
  ],
};

test('表头行探测跳过标题行', () => {
  const rows = [
    ['某某船务 2026 年 11 月船期表'],
    ['更新日期:2026-11-05'],
    HEADER,
    ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶'],
  ];
  const detected = detectHeaderRow(rows);
  assert.equal(detected.index, 2);
  assert.deepEqual(detected.header, HEADER);
});

test('主键相同 → 逐列比,变化格标红', () => {
  const oldBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const newBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-02', '长滩']] });
  const result = compareWithProfile(oldBuf, newBuf, MATSON_PROFILE);
  assert.equal(result.stats.changed, 1);
  assert.equal(result.stats.added, 0);
  const sheet = result.sheets[0];
  const oldRow = sheet.oldRows[0];
  const newRow = sheet.newRows[0];
  assert.equal(oldRow.status, '变更');
  assert.equal(newRow.status, '变更');
  assert.deepEqual(oldRow.changes.map((change) => change.column), ['开航日期', '目的港']);
  assert.deepEqual(oldRow.red, [4, 5]);
  assert.deepEqual(newRow.red, [4, 5]);
});

test('主键变了但次键命中 → 按变更处理,两行整行标红', () => {
  const oldBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const newBuf = buffer({ 美西: [HEADER, ['宁波', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const result = compareWithProfile(oldBuf, newBuf, MATSON_PROFILE);
  assert.equal(result.stats.changed, 1);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.removed, 0);
  assert.equal(result.sheets[0].oldRows[0].red.length, HEADER.length);
  assert.equal(result.sheets[0].newRows[0].status, '变更');
});

test('主键与次键都不命中 → 新增 + 删除', () => {
  const oldBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const newBuf = buffer({ 美西: [HEADER, ['厦门', 'A9', 'OOCL', '009', '2099-02-01', '西雅图']] });
  const result = compareWithProfile(oldBuf, newBuf, { keys: [MATSON_PROFILE.keys[0]] });
  assert.deepEqual(result.stats, { added: 1, removed: 1, changed: 0, skipped: 0, sheets: 1 });
});

test('开航日期早于今日的行不参与对比', () => {
  const oldBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2000-01-01', '洛杉矶']] });
  const newBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2000-01-01', '洛杉矶']] });
  const result = compareWithProfile(oldBuf, newBuf, MATSON_PROFILE);
  assert.equal(result.stats.skipped, 2);
  assert.equal(result.sheets[0].oldRows.length, 0);
});

test('多 sheet 逐页对比并产出汇总', () => {
  const oldBuf = buffer({
    美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']],
    美东: [HEADER, ['宁波', 'B1', 'MSC', '002', '2099-03-01', '纽约']],
  });
  const newBuf = buffer({
    美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-05', '洛杉矶']],
    美东: [HEADER, ['宁波', 'B1', 'MSC', '002', '2099-03-01', '纽约']],
  });
  const result = compareWithProfile(oldBuf, newBuf, { keys: [MATSON_PROFILE.keys[0]], output: { merge: true } });
  assert.equal(result.stats.sheets, 2);
  assert.equal(result.summary.length, 1);
  assert.equal(result.summary[0].sheet, '美西');
  const exported = exportProfileResult(result).sheets;
  assert.deepEqual(
    exported.map((sheet) => sheet.name),
    ['汇总', '旧-美西', '新-美西', '旧-美东', '新-美东'],
  );
});

test('没配 keys 的船东退回 keyColumns / 默认键', () => {
  const oldBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const newBuf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-02', '洛杉矶']] });
  const result = compareWithProfile(oldBuf, newBuf, { keyColumns: ['始发港', 'SVC', '船名', '航次'] });
  assert.equal(result.stats.changed, 1);
  assert.deepEqual(result.sheets[0].keyColumns, ['始发港', 'SVC', '船名', '航次']);
});

test('解析后保留原始列与单元格', () => {
  const buf = buffer({ 美西: [HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']] });
  const parsed = parseScheduleWorkbook(buf, MATSON_PROFILE);
  assert.equal(parsed.sheets.length, 1);
  assert.deepEqual(parsed.sheets[0].header, HEADER);
  assert.deepEqual(parsed.sheets[0].rows[0].cells, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']);
});

test('显式忽略列参与对比时被跳过', () => {
  const header = [...HEADER, '批注'];
  const oldBuf = buffer({ 美西: [header, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶', '旧批注']] });
  const newBuf = buffer({ 美西: [header, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶', '新批注']] });
  const result = compareWithProfile(oldBuf, newBuf, {
    keys: [MATSON_PROFILE.keys[0]],
    parse: { ignoreColumns: ['批注'] },
  });
  assert.equal(result.stats.changed, 0);
});
