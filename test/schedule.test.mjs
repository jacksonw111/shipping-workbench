import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { compareWithProfile, compareWorkbooks, scheduleExportSheets } from '../src/domain/schedule.js';
import { writeXlsx } from '../src/domain/xlsx-writer.js';
import { normalizeProfile } from '../src/domain/schedule-parse.js';
import { mappingToOverride } from '../src/domain/schedule-agent.js';

function workbook(rows) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(book, sheet, '美西');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const HEADER = ['始发港', 'SVC', '船名', '航次', '开航日期', '目的港'];

test('对比键识别新增/删除/变更', () => {
  const oldBuffer = workbook([
    HEADER,
    ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶'],
    ['宁波', 'A2', 'MSC', '002', '2099-02-01', '长滩'],
    ['盐田', 'A3', 'COSCO', '003', '2099-03-01', '奥克兰'],
  ]);
  const newBuffer = workbook([
    HEADER,
    ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶'],
    ['宁波', 'A2', 'MSC', '002', '2099-02-02', '长滩'],
    ['厦门', 'A4', 'OOCL', '004', '2099-04-01', '西雅图'],
  ]);
  const result = compareWorkbooks(oldBuffer, newBuffer);
  assert.deepEqual(result.stats, { added: 1, removed: 1, changed: 1, skipped: 0, sheets: 1 });
  const statuses = result.sheets[0].rows.map((row) => row.status);
  assert.ok(statuses.includes('删除'));
  assert.ok(statuses.includes('新增'));
  assert.ok(statuses.includes('变更'));
  const changed = result.sheets[0].rows.find((row) => row.status === '变更');
  assert.deepEqual(changed.changed, ['开航日期']);
});

test('开航日期早于今日的记录不参与对比', () => {
  const oldBuffer = workbook([HEADER, ['上海', 'A1', 'EVER', '001', '2000-01-01', '洛杉矶']]);
  const newBuffer = workbook([HEADER, ['上海', 'A1', 'EVER', '001', '2000-01-01', '洛杉矶']]);
  const result = compareWorkbooks(oldBuffer, newBuffer);
  assert.equal(result.stats.skipped, 2);
  assert.equal(result.sheets[0].rows.length, 0);
});

test('导出的 xlsx 能被 SheetJS 读回', () => {
  const oldBuffer = workbook([HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶']]);
  const newBuffer = workbook([HEADER, ['上海', 'A1', 'EVER', '001', '2099-01-01', '长滩']]);
  const result = compareWorkbooks(oldBuffer, newBuffer);
  const sheets = scheduleExportSheets(result);
  const buffer = writeXlsx(sheets);
  const book = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['美西']);
  const rows = XLSX.utils.sheet_to_json(book.Sheets['美西'], { header: 1 });
  assert.equal(rows[0].at(-1), '对比结果');
  assert.equal(rows[1].at(-1), '变更');
});

test('换模板:模型给的列映射追加成候选,旧版文件仍按自己那套列名解析', () => {
  const xlsx = (rows) => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '美西');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  };
  const oldRows = [
    ['始发港', 'SVC', '船名', '航次', '开航日期'],
    ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
  ];
  const newRows = [
    ['起运港', '航线代码', '船舶名称', '航次号', '离港日'],
    ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
    ['NINGBO', 'AAS', 'MSC BOB', '002E', '2099-12-05'],
  ];
  const mapping = {
    columns: { 始发港: '起运港', SVC: '航线代码', 船名: '船舶名称', 航次: '航次号', 开航日期: '离港日' },
  };
  const override = mappingToOverride(mapping);
  const profile = normalizeProfile({});
  const columns = { ...profile.parse.columns };
  for (const [field, column] of Object.entries(override.columns)) {
    const existing = columns[field];
    const list = Array.isArray(existing) ? existing : existing ? [existing] : [field];
    columns[field] = [...new Set([...list, column])];
  }
  profile.parse.columns = columns;
  profile.keys = [{ name: '主键', columns: override.fields }];

  const result = compareWithProfile(xlsx(oldRows), xlsx(newRows), profile, { carrier: { id: 'x', name: 'X' } });
  // 旧版按「始发港」命中,新版按「起运港」命中,所以 SHANGHAI 是同一行、NINGBO 是新增。
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 0);
  assert.equal(result.stats.changed, 0);
});
