import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  parseTrackWorkbook,
  buildTrackGroups,
  applyRules,
  buildTrackReport,
  exportTrackReport,
  COMMENT_HEADER,
} from '../src/domain/track.js';
import { writeXlsx } from '../src/domain/xlsx-writer.js';

const HEADER = [
  'Rotation ID',
  'Rotation名称',
  '港口英文',
  '五字码',
  '码头名称',
  '航向',
  '航程',
  '开始时间',
  '排序',
  '新旧轨迹',
  '关联船队',
  '港口变更备注',
];

function sheetBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, '轨迹');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function detect(buffer) {
  const parsed = parseTrackWorkbook(buffer);
  const groups = applyRules(buildTrackGroups(parsed.records));
  return { parsed, groups, report: buildTrackReport(parsed, groups, { filename: 'x.xlsx' }) };
}

const OLD = [
  [5, '美西直航-26', 'LAEM CHABANG', 'THLCH', 'KSSP', 'E', 55, '2026-09-03', 1, '旧', 'F1', ''],
  [5, '美西直航-26', 'CAI MEP', 'VNVUT', 'GEMALINK', 'E', 2, '2026-09-06', 2, '旧', 'F1', ''],
  [5, '美西直航-26', 'TAIPEI', 'TWTPE', 'TML', 'E', 6, '2026-09-09', 3, '旧', 'F1', ''],
  [5, '美西直航-26', 'KAOHSIUNG', 'TWKHH', 'EMC', 'E', 8, '2026-09-12', 4, '旧', 'F1', ''],
  [5, '美西直航-26', 'YANTIAN', 'CNYTN', 'YANTIAN', 'E', 11, '2026-09-17', 5, '旧', 'F1', ''],
  [5, '美西直航-26', 'LOS ANGELES,CA', 'USLAX', 'ETS', 'W', 27, '2026-10-05', 6, '旧', 'F1', ''],
  [5, '美西直航-26', 'OAKLAND,CA', 'USOAK', 'ETS', 'W', 33, '2026-10-08', 7, '旧', 'F1', ''],
  [5, '美西直航-26', 'KAOHSIUNG', 'TWKHH', 'EMC', 'W', 49, '2026-10-30', 8, '旧', 'F1', '取消挂靠'],
];

test('解析后原样保留列与单元格', () => {
  const { parsed } = detect(sheetBuffer(OLD));
  assert.equal(parsed.records.length, 8);
  assert.equal(parsed.sheets.length, 1);
  const [sheet] = parsed.sheets;
  assert.deepEqual(sheet.header, HEADER);
  assert.equal(sheet.rows.length, 8);
  assert.equal(sheet.rows[0].cells.length, HEADER.length);
  assert.equal(sheet.rows[0].cells[0], 5);
  assert.equal(sheet.rows[0].cells[6], 55);
});

test('闭环段与段天数', () => {
  const { groups } = detect(sheetBuffer(OLD));
  const [group] = groups;
  assert.equal(group.closed, true);
  assert.equal(group.segments.length, 8, '7 段 + 1 段闭环');
  assert.equal(group.segments.at(-1).closure, true);
  assert.equal(group.segments.at(-1).days, 6);
  assert.equal(group.segments[0].days, 2);
});

test('累计航程回退判为异常', () => {
  const rows = [
    [7, '航线', 'A', 'AAAAA', '', '', 30, '2026-09-01', 1, '新', 'F2', ''],
    [7, '航线', 'B', 'BBBBB', '', '', 40, '2026-09-05', 2, '新', 'F2', ''],
    [7, '航线', 'C', 'CCCCC', '', '', 25, '2026-09-09', 3, '新', 'F2', ''],
    [7, '航线', 'D', 'DDDDD', '', '', 20, '2026-09-13', 4, '新', 'F2', ''],
  ];
  const { groups } = detect(sheetBuffer(rows));
  assert.equal(groups[0].abnormal, true);
  assert.ok(groups[0].segments.some((segment) => segment.issues.some((issue) => issue.type === 'negative')));
});

test('无关联船队的组整体跳过', () => {
  const rows = [
    [9, '航线', 'A', 'AAAAA', '', '', 10, '2026-09-01', 1, '新', '', ''],
    [9, '航线', 'B', 'BBBBB', '', '', 4, '2026-09-05', 2, '新', '', ''],
  ];
  const { groups, report } = detect(sheetBuffer(rows));
  assert.equal(groups[0].skipped, true);
  assert.equal(report.stats.flagged, 0);
  assert.ok(report.sheets[0].rows.every((row) => row.red.length === 0 && row.comment === ''));
});

test('异常时 Rotation ID 整列标红,段两端标红并写备注', () => {
  const rows = [
    [11, '航线', 'A', 'AAAAA', '', '', 20, '2026-09-01', 1, '新', 'F3', ''],
    [11, '航线', 'B', 'BBBBB', '', '', 26, '2026-09-05', 2, '新', 'F3', ''],
    [11, '航线', 'C', 'CCCCC', '', '', 12, '2026-09-09', 3, '新', 'F3', ''],
    [11, '航线', 'D', 'DDDDD', '', '', 18, '2026-09-13', 4, '新', 'F3', ''],
  ];
  const { report } = detect(sheetBuffer(rows));
  const sheet = report.sheets[0];
  const rotationColumn = HEADER.indexOf('Rotation ID');
  const portColumn = HEADER.indexOf('港口英文');
  const daysColumn = HEADER.indexOf('航程');
  assert.ok(sheet.rows.every((row) => row.red.includes(rotationColumn)), 'Rotation ID 整列红');
  const flaggedRows = sheet.rows.filter((row) => row.red.includes(daysColumn));
  assert.ok(flaggedRows.length >= 2, '异常段两端都标红');
  assert.ok(flaggedRows.every((row) => row.red.includes(portColumn)), '港口英文同时标红');
  const commented = sheet.rows.filter((row) => row.comment);
  assert.equal(commented.length, 1, '备注写在到达行');
  assert.match(commented[0].comment, /累计航程回退/);
});

test('导出保留原表所有列,末尾追加检测备注', () => {
  const rows = [
    [11, '航线', 'A', 'AAAAA', '', '', 20, '2026-09-01', 1, '新', 'F3', ''],
    [11, '航线', 'B', 'BBBBB', '', '', 26, '2026-09-05', 2, '新', 'F3', ''],
    [11, '航线', 'C', 'CCCCC', '', '', 12, '2026-09-09', 3, '新', 'F3', ''],
    [11, '航线', 'D', 'DDDDD', '', '', 18, '2026-09-13', 4, '新', 'F3', ''],
  ];
  const { report } = detect(sheetBuffer(rows));
  const buffer = writeXlsx(exportTrackReport(report));
  const book = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['轨迹']);
  const table = XLSX.utils.sheet_to_json(book.Sheets['轨迹'], { header: 1 });
  assert.deepEqual(table[0], [...HEADER, COMMENT_HEADER]);
  assert.equal(table.length, rows.length + 1);
  assert.equal(table[2][0], 11);
  assert.match(table[3][HEADER.length], /累计航程回退/);
});

test('塞港冲突只在等泊明显长于航段时判红', async () => {
  const { congestionConflict, DEFAULT_CONGESTION_RULE } = await import('../src/domain/congestion.js');
  const rule = DEFAULT_CONGESTION_RULE;
  assert.equal(congestionConflict({ days: 1 }, { waitingDays: 1.5 }, rule), null, '近洋短段不报');
  assert.equal(congestionConflict({ days: 0 }, { waitingDays: 1.2 }, rule), null);
  assert.equal(congestionConflict({ days: 2 }, { waitingDays: 3 }, rule), null, '差距不足 2 天不报');
  const hit = congestionConflict({ days: 3 }, { waitingDays: 6 }, rule);
  assert.ok(hit, '等泊 6 天 vs 航段 3 天要报');
  assert.equal(hit.gap, 3);
  assert.equal(congestionConflict({ days: 1 }, { waitingDays: 5 }, rule), null, '航段 1 天内的可疑点不提醒');
  assert.equal(congestionConflict({ days: 1 }, { waitingDays: 5 }, { ...rule, suppressWithinDays: 0 }).gap, 4, '窗口可配置');
  assert.equal(congestionConflict({ days: 1 }, { waitingDays: null }, rule), null, '没有天数不猜');
});
