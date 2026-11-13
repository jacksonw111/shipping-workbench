import { readWorkbook } from './workbook.js';
import { todayIso, toIsoDate } from '../util/dates.js';

/** 表头关键词:命中越多越像表头行。 */
const HEADER_HINTS = [
  '船名',
  '船舶',
  'VESSEL',
  'VSL',
  'SVC',
  'SERVICE',
  'VOYAGE',
  'VOY',
  '航次',
  'ETD',
  'ETA',
  '开航',
  '离港',
  '始发',
  '目的',
  'POL',
  'POD',
  '港口',
  'PORT',
  '截关',
  '航线',
  '船东',
  '码头',
  'TERMINAL',
];

/**
 * 表头行的「字段权重」:PDF 两行表头里,ETA/ETD 子表头往往比字段行更长,
 * 只数命中个数会把子表头当表头。这里按字段去重加权,船名/航次/航线/始发港优先。
 */
const HEADER_FIELDS = [
  { weight: 5, hints: ['VESSEL', '船名', '船舶', 'VSL', 'SHIP'] },
  { weight: 5, hints: ['VOYAGE', 'VOY', '航次', 'TRIP'] },
  { weight: 4, hints: ['SVC', 'SERVICE', 'LINE', '航线'] },
  { weight: 4, hints: ['POL', '始发港', '起运港', '装货港', 'PORT OF LOADING', '出发港'] },
  { weight: 3, hints: ['ETD', '开航', 'SAILING', 'DEPARTURE', '离港'] },
  { weight: 2, hints: ['ETA', '到港', 'ARRIV'] },
];

/**
 * 一行命中多少个「不同字段」的加权分;同一字段重复出现只算一次。
 * `core` 只算船名/航次/航线/始发港:表头行必须带这些,光有 ETA/ETD 的是子表头。
 */
function fieldScore(cells) {
  let score = 0;
  let core = 0;
  HEADER_FIELDS.forEach((field, index) => {
    const hit = cells.some((cell) => {
      const upper = cell.toUpperCase();
      return field.hints.some((hint) => upper.includes(hint.toUpperCase()));
    });
    if (!hit) return;
    score += field.weight;
    if (index < 4) core += field.weight;
  });
  return { score, core };
}

const DATE_HINT = /开航|离港|ETD|SAILING|DEPARTURE|启航/i;

export const DEFAULT_KEYS = [
  { name: '主键', columns: ['始发港', 'SVC', '船名', '航次'] },
];

/** 默认的船东配置;种子与迁移都用它。 */
export const DEFAULT_PROFILE = {
  match: { senderIncludes: [], subjectIncludes: [], filenameIncludes: [] },
  ingest: { kind: 'excel', sheet: { mode: 'all', pattern: '' } },
  parse: { headerRow: 'auto', columns: {}, ignoreColumns: [] },
  keys: DEFAULT_KEYS,
  dateColumn: '',
  output: { merge: false },
  enabled: true,
};

export function normalizeProfile(raw = {}) {
  const profile = structuredClone(DEFAULT_PROFILE);
  for (const key of ['match', 'ingest', 'parse', 'output']) {
    if (raw[key] && typeof raw[key] === 'object') profile[key] = { ...profile[key], ...raw[key] };
  }
  if (Array.isArray(raw.keys) && raw.keys.length > 0) {
    profile.keys = raw.keys;
  } else {
    const columns =
      Array.isArray(raw.keyColumns) && raw.keyColumns.length > 0 ? raw.keyColumns : DEFAULT_KEYS[0].columns;
    profile.keys = [{ name: '主键', columns }];
  }
  if (typeof raw.dateColumn === 'string') profile.dateColumn = raw.dateColumn;
  if (raw.enabled !== undefined) profile.enabled = Boolean(raw.enabled);
  return profile;
}

function normalizeHeaderCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .trim();
}

/** 在前 20 行里按关键词命中数挑表头行;命中不足 2 个就退回"第一行有 ≥2 个非空"。 */
export function detectHeaderRow(rows, { headerRow = 'auto' } = {}) {
  if (typeof headerRow === 'number' && headerRow > 0) {
    return { index: headerRow - 1, header: (rows[headerRow - 1] ?? []).map((cell) => String(cell).trim()) };
  }
  let best = null;
  const limit = Math.min(rows.length, 20);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index] ?? [];
    const cells = row.map(normalizeHeaderCell);
    const nonEmpty = cells.filter(Boolean).length;
    if (nonEmpty < 2) continue;
    // 字段加权优先:PDF 的 ETA/ETD 子表头命中多但字段少,不能压过字段行。
    const { score, core } = fieldScore(cells);
    const candidate = { index, header: row.map((cell) => String(cell).trim()), score, core, nonEmpty };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score &&
        (candidate.core > best.core ||
          (candidate.core === best.core && candidate.nonEmpty > best.nonEmpty)))
    ) {
      best = candidate;
    }
  }
  if (best && best.score >= 4) return { index: best.index, header: best.header };
  const fallback = rows.findIndex((row) => (row ?? []).filter((cell) => String(cell).trim()).length >= 2);
  if (fallback < 0) return null;
  return { index: fallback, header: (rows[fallback] ?? []).map((cell) => String(cell).trim()) };
}

/**
 * 标准字段在真实表头里的常见写法。
 *
 * 配置里没写候选列名时用它兜底:PDF 表头是英文(VESSEL NAME / VOYAGE NO. / # LINE / POL),
 * 只按中文字段名找会全部落空。配置里写了的仍然优先。
 */
export const FIELD_ALIASES = {
  始发港: ['始发港', '起运港', '装货港', '出发港', 'POL', 'ORIGIN', 'PORT OF LOADING'],
  SVC: ['SVC', 'SERVICE', 'LINE', '航线', '航线代码', '服务'],
  船名: ['船名', '船舶名称', 'VESSEL NAME', 'VESSEL', 'VSL', 'SHIP'],
  航次: ['航次', '航次号', 'VOYAGE NO.', 'VOYAGE', 'VOY', 'TRIP'],
  开航日期: ['开航日期', '开航日', '离港日', 'ETD', 'SAILING', 'DEPARTURE'],
};

/**
 * 用配置里的列映射,把标准字段解析成表头下标。
 *
 * `columns[field]` 可以是字符串,也可以是候选数组:船东换模板时,
 * 同一字段在不同版本里可能叫「起运港」也可能叫「始发港」,候选列表让新旧版都能解析。
 */
export function resolveColumn(header, field, { columns = {} } = {}) {
  const configured = columns[field];
  const fallback = FIELD_ALIASES[field] ?? [field];
  const wanted = Array.isArray(configured) ? configured : configured ? [configured] : fallback;
  for (const name of wanted) {
    const exact = header.findIndex((cell) => normalizeHeaderCell(cell) === normalizeHeaderCell(name));
    if (exact >= 0) return exact;
  }
  for (const name of wanted) {
    const loose = header.findIndex((cell) => normalizeHeaderCell(cell).includes(normalizeHeaderCell(name)));
    if (loose >= 0) return loose;
  }
  return -1;
}

export function resolveDateColumn(header, { dateColumn = '', columns = {} } = {}) {
  const configured = resolveColumn(header, dateColumn || '开航日期', { columns });
  if (configured >= 0) return configured;
  return header.findIndex((cell) => DATE_HINT.test(cell));
}

/**
 * 把上传的船期表按船东配置解析成统一结构。
 * 每个 sheet:`{ name, header, rows:[{ index, cells }] }`。
 */
export function parseScheduleWorkbook(buffer, profile = DEFAULT_PROFILE) {
  const normalized = normalizeProfile(profile);
  const workbook = readWorkbook(buffer);
  const sheets = [];
  for (const sheet of workbook) {
    if (!matchSheetName(sheet.name, normalized.ingest.sheet)) continue;
    const detected = detectHeaderRow(sheet.rows, normalized.parse);
    if (!detected) continue;
    const header = detected.header.map((cell, index) => (cell && cell.trim() ? cell.trim() : `列${index + 1}`));
    const rows = [];
    for (let index = detected.index + 1; index < sheet.rows.length; index += 1) {
      const raw = sheet.rows[index] ?? [];
      if (raw.every((cell) => String(cell ?? '').trim() === '')) continue;
      rows.push({
        index,
        cells: header.map((_, column) => serializeCell(raw[column])),
      });
    }
    if (rows.length === 0) continue;
    sheets.push({ name: sheet.name, header, headerIndex: detected.index, rows });
  }
  return { sheets, profile: normalized };
}

function matchSheetName(name, sheetConfig) {
  if (!sheetConfig || sheetConfig.mode !== 'namePattern' || !sheetConfig.pattern) return true;
  try {
    return new RegExp(sheetConfig.pattern, 'i').test(name);
  } catch {
    return true;
  }
}

function serializeCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return toIsoDate(value);
  return value;
}

/** 一行 → 字段值;键列缺失时返回空串,由调用方判定。 */
export function rowValues(header, cells, profile) {
  const values = {};
  const columns = profile.parse?.columns ?? {};
  for (const field of Object.keys(columns)) {
    const index = resolveColumn(header, field, profile.parse);
    values[field] = index >= 0 ? String(cells[index] ?? '').trim() : '';
  }
  header.forEach((name, index) => {
    values[name] = String(cells[index] ?? '').trim();
  });
  return values;
}

export function rowKey(row, columns, header, profile) {
  return columns
    .map((column) => {
      const index = resolveColumn(header, column, profile.parse);
      return index >= 0 ? normalizeKey(row.cells[index]) : '';
    })
    .join('\u0001');
}

function normalizeKey(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function rowDate(row, header, profile) {
  const index = resolveDateColumn(header, profile);
  return index >= 0 ? toIsoDate(row.cells[index]) : '';
}

export function filterByDate(rows, header, profile, today = todayIso()) {
  const kept = [];
  let skipped = 0;
  for (const row of rows) {
    const date = rowDate(row, header, profile);
    if (date && date < today) {
      skipped += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, skipped };
}

export { normalizeHeaderCell };
