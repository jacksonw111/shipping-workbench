import { readWorkbook, cellText } from './workbook.js';
import { toIsoDate, todayIso } from '../util/dates.js';

export const DEFAULT_KEYS = ['始发港', 'SVC', '船名', '航次'];

const DATE_HEADER = /开航日期|开航时间|ETD|离港|SAILING|DEPARTURE|船期/i;

function headerOf(sheet) {
  for (let index = 0; index < Math.min(sheet.rows.length, 8); index += 1) {
    const row = sheet.rows[index].map((cell) => String(cell).trim());
    if (row.filter(Boolean).length >= 2) return { index, header: row };
  }
  return null;
}

function resolveKeys(header, requested) {
  const wanted = (requested?.length ? requested : DEFAULT_KEYS).filter(Boolean);
  const found = wanted.filter((name) => header.includes(name));
  if (found.length >= 2) return found;
  return header.filter(Boolean).slice(0, Math.min(3, header.length));
}

function findDateColumn(header, requested) {
  if (requested && header.includes(requested)) return requested;
  return header.find((cell) => DATE_HEADER.test(cell)) ?? '';
}

/**
 * Compare two schedule workbooks sheet by sheet.
 *
 * 对比键不一致即视为变更:旧有新无 = 删除,新有旧无 = 新增,
 * 同键但对比列不同 = 变更;开航日期早于 today 的行不参与对比。
 */
export function compareWorkbooks(oldBuffer, newBuffer, { keys, compareColumns, dateColumn, today = todayIso() } = {}) {
  const oldSheets = readWorkbook(oldBuffer);
  const newSheets = readWorkbook(newBuffer);
  const names = [];
  for (const sheet of oldSheets) if (!names.includes(sheet.name)) names.push(sheet.name);
  for (const sheet of newSheets) if (!names.includes(sheet.name)) names.push(sheet.name);

  const sheets = [];
  const stats = { added: 0, removed: 0, changed: 0, skipped: 0, sheets: 0 };
  for (const name of names) {
    const oldSheet = oldSheets.find((sheet) => sheet.name === name);
    const newSheet = newSheets.find((sheet) => sheet.name === name);
    if (!oldSheet || !newSheet) continue;
    const oldHeader = headerOf(oldSheet);
    const newHeader = headerOf(newSheet);
    if (!oldHeader || !newHeader) continue;
    const header = oldHeader.header.filter(Boolean);
    if (header.length === 0) continue;
    const keyColumns = resolveKeys(header, keys);
    const dateCol = findDateColumn(header, dateColumn);
    const compared = (compareColumns?.length ? compareColumns : header).filter(
      (column) => header.includes(column) && !keyColumns.includes(column),
    );

    const oldRows = normalizeRows(oldSheet, oldHeader, header, dateCol, today, keyColumns);
    const newRows = normalizeRows(newSheet, newHeader, header, dateCol, today, keyColumns);
    stats.skipped += oldRows.skipped + newRows.skipped;

    const oldMap = new Map(oldRows.rows.map((row) => [row.key, row]));
    const newMap = new Map(newRows.rows.map((row) => [row.key, row]));
    const resultRows = [];
    for (const row of oldRows.rows) {
      const counterpart = newMap.get(row.key);
      if (!counterpart) {
        resultRows.push({ values: row.values, status: '删除', changed: [], red: true });
        stats.removed += 1;
        continue;
      }
      const changes = compared
        .filter((column) => (row.values[column] ?? '') !== (counterpart.values[column] ?? ''))
        .map((column) => ({ column, from: row.values[column] ?? '', to: counterpart.values[column] ?? '' }));
      if (changes.length > 0) {
        resultRows.push({
          values: row.values,
          status: '变更',
          changed: changes.map((change) => change.column),
          changes,
          red: true,
        });
        stats.changed += 1;
      } else {
        resultRows.push({ values: row.values, status: '', changed: [], changes: [], red: false });
      }
    }
    for (const row of newRows.rows) {
      if (oldMap.has(row.key)) continue;
      resultRows.push({ values: row.values, status: '新增', changed: [], red: true, side: 'new' });
      stats.added += 1;
    }
    sheets.push({
      name,
      columns: header,
      keyColumns,
      dateColumn: dateCol,
      compareColumns: compared,
      rows: resultRows,
    });
    stats.sheets += 1;
  }
  if (sheets.length === 0) throw new Error('两个文件没有可对比的同名 sheet');
  return { sheets, stats, today, generatedAt: new Date().toISOString() };
}

function normalizeRows(sheet, headerInfo, header, dateCol, today, keyColumns) {
  const rows = [];
  let skipped = 0;
  for (let index = headerInfo.index + 1; index < sheet.rows.length; index += 1) {
    const raw = sheet.rows[index];
    if (!raw || raw.every((cell) => String(cell).trim() === '')) continue;
    const values = {};
    header.forEach((column) => {
      const position = headerInfo.header.indexOf(column);
      values[column] = position >= 0 ? cellText(raw[position]) : '';
    });
    const dateValue = dateCol ? toIsoDate(values[dateCol]) : '';
    if (dateValue && dateValue < today) {
      skipped += 1;
      continue;
    }
    const key = keyColumns.map((column) => values[column]).join('\u0001');
    if (!key.replaceAll('\u0001', '').trim()) continue;
    rows.push({ key, values });
  }
  return { rows, skipped };
}

/** Build the export workbook: one sheet per source sheet, 对比结果 column, red changed rows. */
export function scheduleExportSheets(result) {
  return result.sheets.map((sheet) => ({
    name: sheet.name.slice(0, 28) || '对比',
    columns: [...sheet.columns.map((column) => ({ header: column, width: 16 })), { header: '对比结果', width: 10 }],
    rows: sheet.rows.map((row) => [
      ...sheet.columns.map((column) => ({
        value: row.values[column] ?? '',
        red: row.red && (row.status !== '变更' || row.changed.includes(column)),
      })),
      { value: row.status, red: row.red },
    ]),
  }));
}

/* ------------------------------------------------------------------ 船东配置版 */

import {
  DEFAULT_PROFILE,
  filterByDate,
  normalizeProfile,
  parseScheduleWorkbook,
  resolveColumn,
  rowKey,
} from './schedule-parse.js';

/**
 * 按船东配置对比两份船期表。
 *
 * - 主键命中:逐列比对比列,不同即「变更」,变化格标红;
 * - 主键不命中但次键命中:按「变更」处理,新旧两行都标红(Matson 的第 2 段规则);
 * - 主键都不命中:旧有新无 = 删除,新有旧无 = 新增,整行标红;
 * - 开航日期早于今日的行不参与对比。
 */
export function compareWithProfile(oldBuffer, newBuffer, profileInput, { today = todayIso(), carrier = {} } = {}) {
  const profile = normalizeProfile(profileInput ?? DEFAULT_PROFILE);
  const oldParsed = parseScheduleWorkbook(oldBuffer, profile);
  const newParsed = parseScheduleWorkbook(newBuffer, profile);
  const names = [...new Set([...oldParsed.sheets.map((sheet) => sheet.name), ...newParsed.sheets.map((sheet) => sheet.name)])];
  // 键列写的是「标准字段名」,经 parse.columns 映射后才是真实表头。
  const keyFields = [...new Set(profile.keys.flatMap((group) => group.columns ?? []))];
  const sheets = [];
  const summary = [];
  const stats = { added: 0, removed: 0, changed: 0, skipped: 0, sheets: 0 };

  for (const name of names) {
    const oldSheet = oldParsed.sheets.find((sheet) => sheet.name === name);
    const newSheet = newParsed.sheets.find((sheet) => sheet.name === name);
    if (!oldSheet || !newSheet) continue;
    const header = oldSheet.header.length >= newSheet.header.length ? oldSheet.header : newSheet.header;
    const keyColumns = keyFields.map((field) => {
      const index = resolveColumn(header, field, profile.parse);
      return index >= 0 ? header[index] : field;
    });
    const filteredOld = filterByDate(oldSheet.rows, header, profile, today);
    const filteredNew = filterByDate(newSheet.rows, header, profile, today);
    stats.skipped += filteredOld.skipped + filteredNew.skipped;

    const primary = profile.keys[0] ?? { columns: [] };
    const secondary = profile.keys[1] ?? null;
    const compareColumns = header.filter(
      (column) => !keyColumns.includes(column) && !(profile.parse?.ignoreColumns ?? []).includes(column),
    );

    const oldRows = filteredOld.rows.map((row) => ({
      ...row,
      primaryKey: rowKey(row, primary.columns, header, profile),
      secondaryKey: secondary ? rowKey(row, secondary.columns, header, profile) : '',
    }));
    const newRows = filteredNew.rows.map((row) => ({
      ...row,
      primaryKey: rowKey(row, primary.columns, header, profile),
      secondaryKey: secondary ? rowKey(row, secondary.columns, header, profile) : '',
    }));

    const newByPrimary = new Map(newRows.map((row) => [row.primaryKey, row]));
    const newBySecondary = new Map();
    if (secondary) {
      for (const row of newRows) {
        if (!newBySecondary.has(row.secondaryKey)) newBySecondary.set(row.secondaryKey, row);
      }
    }
    const usedNew = new Set();
    const oldResult = [];
    const newResult = newRows.map((row) => emptyResult(row, header.length));

    for (const row of oldRows) {
      const same = newByPrimary.get(row.primaryKey);
      if (same) {
        usedNew.add(same.primaryKey);
        const changes = compareColumns
          .map((column) => {
            const index = resolveColumn(header, column, profile.parse);
            const from = String(row.cells[index] ?? '').trim();
            const to = String(same.cells[index] ?? '').trim();
            return from === to ? null : { column, from, to, index };
          })
          .filter(Boolean);
        const oldEntry = emptyResult(row, header.length);
        const newEntry = newResult.find((item) => item.row === same);
        if (changes.length > 0) {
          oldEntry.status = '变更';
          newEntry.status = '变更';
          for (const change of changes) {
            oldEntry.red.add(change.index);
            newEntry.red.add(change.index);
          }
          oldEntry.changes = changes;
          newEntry.changes = changes;
          stats.changed += 1;
          summary.push({ sheet: name, status: '变更', key: row.primaryKey, changes: changes.map((item) => item.column) });
        }
        oldResult.push(oldEntry);
        continue;
      }
      // 主键变了,但次键还没变 → 按变更处理(Matson 规则 2)。
      const bySecondary = secondary ? newBySecondary.get(row.secondaryKey) : null;
      if (bySecondary && !usedNew.has(bySecondary.primaryKey)) {
        usedNew.add(bySecondary.primaryKey);
        const oldEntry = emptyResult(row, header.length);
        const newEntry = newResult.find((item) => item.row === bySecondary);
        for (let index = 0; index < header.length; index += 1) {
          oldEntry.red.add(index);
          newEntry.red.add(index);
        }
        oldEntry.status = '变更';
        newEntry.status = '变更';
        oldEntry.changes = [{ column: '主键', from: '', to: '', index: -1 }];
        newEntry.changes = oldEntry.changes;
        stats.changed += 1;
        summary.push({ sheet: name, status: '变更(键变化)', key: row.primaryKey, changes: ['主键'] });
        oldResult.push(oldEntry);
        continue;
      }
      const oldEntry = emptyResult(row, header.length);
      oldEntry.status = '删除';
      for (let index = 0; index < header.length; index += 1) oldEntry.red.add(index);
      oldResult.push(oldEntry);
      stats.removed += 1;
      summary.push({ sheet: name, status: '删除', key: row.primaryKey, changes: [] });
    }

    for (const entry of newResult) {
      if (usedNew.has(entry.row.primaryKey)) continue;
      if (entry.status !== '') continue;
      entry.status = '新增';
      for (let index = 0; index < header.length; index += 1) entry.red.add(index);
      stats.added += 1;
      summary.push({ sheet: name, status: '新增', key: entry.row.primaryKey, changes: [] });
    }

    sheets.push({
      name,
      header,
      keyColumns,
      secondaryColumns: secondary?.columns ?? [],
      compareColumns,
      oldRows: oldResult.map((entry) => finalize(entry)),
      newRows: newResult.map((entry) => finalize(entry)),
      skipped: filteredOld.skipped + filteredNew.skipped,
    });
    stats.sheets += 1;
  }

  if (sheets.length === 0) throw new Error('两个文件没有可对比的同名 sheet(或表头没识别出来)');
  return {
    mode: 'profile',
    carrierId: carrier.id ?? '',
    carrierName: carrier.name ?? '',
    formatVersion: 1,
    today,
    generatedAt: new Date().toISOString(),
    stats,
    sheets,
    summary,
  };
}

function emptyResult(row, width) {
  return { row, status: '', red: new Set(), changes: [], width };
}

function finalize(entry) {
  return {
    cells: entry.row.cells,
    status: entry.status,
    red: [...entry.red].sort((a, b) => a - b),
    changes: entry.changes,
  };
}

/** 导出:旧版/新版各一个 sheet(各带「对比结果」列),需要时多一张「汇总」。 */
export function exportProfileResult(result, carrierName = '') {
  const out = [];
  if (result.summary?.length) {
    out.push({
      name: '汇总',
      columns: [
        { header: 'sheet', width: 18 },
        { header: '对比结果', width: 12 },
        { header: '对比键', width: 40 },
        { header: '变化列', width: 30 },
      ],
      rows: result.summary.map((item) => [
        { value: item.sheet },
        { value: item.status, red: item.status !== '' },
        { value: displayKey(item.key) },
        { value: (item.changes ?? []).join('、') },
      ]),
    });
  }
  for (const sheet of result.sheets) {
    for (const side of ['oldRows', 'newRows']) {
      const label = side === 'oldRows' ? '旧' : '新';
      out.push({
        name: `${label}-${sheet.name}`.slice(0, 28),
        columns: [
          ...sheet.header.map((header) => ({ header, width: 16 })),
          { header: '对比结果', width: 10 },
        ],
        rows: sheet[side].map((row) => [
          ...sheet.header.map((_, index) => ({ value: row.cells[index] ?? '', red: row.red.includes(index) })),
          { value: row.status, red: row.status !== '' },
        ]),
      });
    }
  }
  return { sheets: out, carrierName };
}

function displayKey(key) {
  return String(key ?? '').replaceAll('\u0001', ' / ');
}
