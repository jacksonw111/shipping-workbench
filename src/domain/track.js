import { readWorkbook, cellText } from './workbook.js';
import { toIsoDate, todayIso } from '../util/dates.js';

/** Header aliases: canonical field -> accepted column names. */
const FIELDS = {
  rotationId: ['Rotation ID', 'RotationID', 'Rotation Id', 'ROTATION ID'],
  rotationName: ['Rotation名称', 'Rotation 名称', '航线名称'],
  portEn: ['港口英文', 'Port', 'PORT'],
  portCode: ['五字码', '五字碼', '港口代码', 'UN/LOCODE'],
  terminal: ['码头名称', 'Terminal'],
  direction: ['航向', '方向', 'Direction'],
  eta: ['开始时间', 'ETD', 'ETA'],
  cumDays: ['航程', '航程天数', '累计航程'],
  order: ['排序', '序号', 'Sort'],
  version: ['新旧轨迹', '新旧', 'Version'],
  fleet: ['关联船队', '船队', 'Fleet'],
  changeNote: ['港口变更备注', '变更备注'],
  note: ['备注', 'Remark'],
};

export const COMMENT_HEADER = '检测备注';

function detectHeader(rows) {
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const row = (rows[index] ?? []).map((cell) => String(cell).trim());
    if (row.some((cell) => FIELDS.rotationId.includes(cell)) && row.some((cell) => FIELDS.order.includes(cell))) {
      return { index, columns: row };
    }
  }
  return null;
}

function columnMap(header) {
  const map = {};
  for (const [field, aliases] of Object.entries(FIELDS)) {
    const index = header.findIndex((cell) => aliases.includes(String(cell).trim()));
    if (index >= 0) map[field] = index;
  }
  return map;
}

function serializeCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === 'number') return value;
  return String(value);
}

/**
 * Parse the shipping track export.
 *
 * 保留原始表头与每一行的全部单元格 —— 检测结果就是「原表 + 标红 + 备注」,
 * 不重新排版、不丢列。
 */
export function parseTrackWorkbook(buffer) {
  const workbook = readWorkbook(buffer);
  const records = [];
  const warnings = [];
  let detected = null;
  const sheets = [];
  for (const sheet of workbook) {
    const header = detectHeader(sheet.rows);
    if (!header) continue;
    detected ??= { sheet: sheet.name, columns: header.columns };
    const map = columnMap(header.columns);
    const rows = [];
    for (let index = header.index + 1; index < sheet.rows.length; index += 1) {
      const row = sheet.rows[index];
      if (!row || row.every((cell) => String(cell).trim() === '')) continue;
      const rowIndex = index + 1;
      rows.push({ rowIndex, cells: header.columns.map((_, column) => serializeCell(row[column])) });
      const value = (field) => (map[field] === undefined ? '' : cellText(row[map[field]]));
      const rotationId = value('rotationId');
      const order = Number(String(value('order')).replace(/[^\d.-]/g, ''));
      if (!rotationId || !Number.isFinite(order)) {
        warnings.push(`第 ${rowIndex} 行缺少 Rotation ID 或排序,已跳过`);
        continue;
      }
      records.push({
        sheet: sheet.name,
        rowIndex,
        rotationId,
        rotationName: value('rotationName'),
        portEn: value('portEn'),
        portCode: value('portCode').toUpperCase(),
        terminal: value('terminal'),
        direction: value('direction'),
        eta: toIsoDate(value('eta')),
        cumDays: Number(String(value('cumDays')).replace(/[^\d.-]/g, '')) || 0,
        order,
        version: value('version') || '新',
        fleet: value('fleet'),
        changeNote: value('changeNote'),
        note: value('note'),
      });
    }
    sheets.push({ name: sheet.name, header: header.columns, headerIndex: header.index, columns: map, rows });
  }
  if (!detected) {
    throw new Error('未识别到轨迹表头(需要「Rotation ID」与「排序」两列)');
  }
  return { records, warnings, detected, sheets, sheetCount: workbook.length };
}

/**
 * Group records and compute segment days.
 *
 * 规则(与需求原文一致):
 * - 排序 1 的累计航程非 0 时,计算 1→2 段时按 0 起算;末尾再补一段 末港→1 港(闭环)。
 * - 排序 1 的累计航程为 0 时,末港到 1 港这一段不检查。
 * - 段天数 = 相邻累计航程之差,取绝对值;为负说明累计值回退,直接判为异常。
 */
export function buildTrackGroups(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.rotationId}|${record.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const result = [];
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.order - b.order);
    const first = rows[0];
    const total = first.cumDays;
    // 只有真的从「排序 1」开始的轨迹才有闭环段;导出的数据可能从中间排序开始。
    const closed = total !== 0 && first.order === 1;
    const segments = [];
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      const fromDays = index === 1 ? 0 : previous.cumDays;
      segments.push(makeSegment(previous, current, current.cumDays - fromDays, index));
    }
    if (closed && rows.length > 1) {
      const last = rows.at(-1);
      segments.push(makeSegment(last, first, total - last.cumDays, rows.length, true));
    }
    result.push({
      key,
      rotationId: first.rotationId,
      rotationName: first.rotationName,
      version: first.version,
      fleet: first.fleet,
      rows,
      totalDays: total,
      closed,
      segments,
      skipped: !first.fleet,
    });
  }
  result.sort(
    (a, b) =>
      String(a.rotationId).localeCompare(String(b.rotationId), 'zh', { numeric: true }) ||
      a.version.localeCompare(b.version),
  );
  return result;
}

function makeSegment(from, to, days, index, closure = false) {
  return {
    index,
    closure,
    from,
    to,
    fromOrder: from.order,
    toOrder: to.order,
    fromPort: from.portEn,
    toPort: to.portEn,
    fromCode: from.portCode,
    toCode: to.portCode,
    fromDays: from.cumDays,
    toDays: to.cumDays,
    days: Math.abs(days),
    rawDays: days,
    issues: [],
  };
}

/** Rule layer: hard errors that never depend on judgement. */
export function applyRules(groups) {
  for (const group of groups) {
    if (group.skipped) continue;
    for (const segment of group.segments) {
      if (segment.rawDays < 0) {
        segment.issues.push({
          type: segment.closure ? 'over-total' : 'negative',
          label: segment.closure ? '累计航程超过闭环总天数' : '累计航程回退',
          severity: 'error',
        });
      }
      if (!segment.fromCode || !segment.toCode) {
        segment.issues.push({ type: 'missing-code', label: '缺少五字码', severity: 'error' });
      }
      if (!segment.toPort || !segment.fromPort) {
        segment.issues.push({ type: 'missing-port', label: '缺少港口英文', severity: 'error' });
      }
    }
    for (const row of group.rows) {
      if (!row.portEn || !row.portCode) group.missingFields = true;
      if (!row.eta) group.missingEta = true;
    }
    group.abnormal = group.segments.some((segment) =>
      segment.issues.some((issue) => issue.severity === 'error'),
    );
  }
  return groups;
}

function segmentComment(segment) {
  const parts = [];
  if (segment.issues.some((issue) => issue.type === 'negative')) {
    parts.push(`累计航程回退(排序 ${segment.fromOrder} 的 ${segment.fromDays} 天 → 排序 ${segment.toOrder} 的 ${segment.toDays} 天)`);
  }
  if (segment.issues.some((issue) => issue.type === 'over-total')) {
    parts.push(`累计值矛盾:排序 ${segment.fromOrder} 已到 ${segment.fromDays} 天,排序 1 只有 ${segment.toDays} 天`);
  }
  if (segment.issues.some((issue) => issue.type === 'missing-code')) parts.push('缺少五字码');
  if (segment.issues.some((issue) => issue.type === 'missing-port')) parts.push('缺少港口英文');
  if (segment.congestion && !segment.suspicious) {
    parts.push(`塞港:${segment.toPort} 等泊 ${segment.congestion.waitingDays ?? '?'} 天`);
  }
  // 冲突原因只写一次(segment.reason 已经包含港口与天数)
  if (segment.suspicious && segment.reason) parts.push(segment.reason);
  return parts.join(';');
}

/** 规则层可读中文结论;没有规则层错误时返回空串。 */
function ruleReason(segment) {
  const issues = segment.issues ?? [];
  const has = (type) => issues.some((issue) => issue.type === type && issue.severity === 'error');
  const parts = [];
  if (has('negative')) {
    parts.push(
      `累计航程回退:排序 ${segment.fromOrder} 的 ${segment.fromDays} 天 → 排序 ${segment.toOrder} 的 ${segment.toDays} 天`,
    );
  }
  if (has('over-total')) {
    parts.push(`累计值矛盾:排序 ${segment.fromOrder} 已到 ${segment.fromDays} 天,排序 1 只有 ${segment.toDays} 天`);
  }
  if (has('missing-code')) parts.push('缺少五字码');
  if (has('missing-port')) parts.push('缺少港口英文');
  return parts.join(';');
}

/**
 * 把「需要提醒的不合理点」整理成可读结论列表。
 *
 * - 规则层硬错永远收集(kind: 'rule'),不受 1 天抑制影响;
 * - 塞港冲突 / 模型可疑:航段天数 ≤ suppressWithinDays 时**不提醒**,计入 suppressed;
 * - 同一 segment 只出一条,优先级 rule > congestion > agent。
 */
export function collectFindings(groups, { suppressWithinDays = 1 } = {}) {
  const limit = Number(suppressWithinDays);
  const window = Number.isFinite(limit) ? limit : 1;
  const findings = [];
  let suppressed = 0;
  for (const group of groups) {
    if (group.skipped) continue;
    for (const segment of group.segments) {
      const issues = segment.issues ?? [];
      const hasCongestion = issues.some((issue) => issue.type === 'congestion');
      const hasAgent = issues.some((issue) => issue.type === 'llm');
      const rule = ruleReason(segment);
      const days = Number(segment.days);
      // 被「1 天内不提醒」压下去的塞港/模型可疑点(含上游已打标记的)。
      const isSuppressed =
        segment.suppressed === true || ((hasCongestion || hasAgent) && Number.isFinite(days) && days <= window);
      if (isSuppressed) suppressed += 1;
      let kind = '';
      let reason = '';
      let confidence = null;
      if (rule) {
        kind = 'rule';
        reason = rule;
      } else if (!isSuppressed && hasCongestion) {
        kind = 'congestion';
        reason = segment.reason || `${segment.toPort} 等泊 ${segment.congestion?.waitingDays ?? '?'} 天,航段只有 ${segment.days} 天`;
        confidence = Number(segment.confidence) || null;
      } else if (!isSuppressed && hasAgent) {
        kind = 'agent';
        reason = segment.reason || '模型判为可疑';
        confidence = Number(segment.confidence) || null;
      }
      if (!kind) continue;
      findings.push({
        rotationId: group.rotationId,
        version: group.version,
        rotationName: group.rotationName,
        fromOrder: segment.fromOrder,
        toOrder: segment.toOrder,
        fromPort: segment.fromPort,
        toPort: segment.toPort,
        days: segment.days,
        kind,
        reason,
        confidence,
      });
    }
  }
  findings.sort(
    (a, b) =>
      String(a.rotationId).localeCompare(String(b.rotationId), 'zh', { numeric: true }) ||
      String(a.version).localeCompare(String(b.version)) ||
      Number(a.fromOrder) - Number(b.fromOrder) ||
      Number(a.toOrder) - Number(b.toOrder),
  );
  return { findings, suppressed };
}

/**
 * Paint the detection result back onto the uploaded workbook:
 * same sheets, same columns, red fonts where needed, one extra comment column.
 */
export function buildTrackReport(parsed, groups, meta = {}) {
  const flagged = new Map(); // `${sheet}|${rowIndex}` -> { red:Set<number>, comments:string[] }
  const entry = (row) => {
    const key = `${row.sheet}|${row.rowIndex}`;
    if (!flagged.has(key)) flagged.set(key, { red: new Set(), comments: [] });
    return flagged.get(key);
  };
  let flaggedGroups = 0;
  for (const group of groups) {
    if (group.skipped) continue;
    const bad = group.segments.filter(
      (segment) =>
        segment.issues.some((issue) => issue.severity === 'error') || segment.suspicious,
    );
    if (bad.length === 0) continue;
    flaggedGroups += 1;
    for (const segment of bad) {
      const comment = segmentComment(segment);
      for (const row of [segment.from, segment.to]) {
        const target = entry(row);
        const sheet = parsed.sheets.find((item) => item.name === row.sheet);
        for (const field of ['portEn', 'cumDays']) {
          const column = sheet?.columns?.[field];
          if (column !== undefined) target.red.add(column);
        }
      }
      if (comment) entry(segment.to).comments.push(comment);
    }
    for (const row of group.rows) {
      const sheet = parsed.sheets.find((item) => item.name === row.sheet);
      const column = sheet?.columns?.rotationId;
      if (column !== undefined) entry(row).red.add(column);
    }
  }

  const sheets = parsed.sheets.map((sheet) => ({
    name: sheet.name,
    header: sheet.header,
    rows: sheet.rows.map((row) => {
      const painted = flagged.get(`${sheet.name}|${row.rowIndex}`);
      return {
        rowIndex: row.rowIndex,
        cells: row.cells,
        red: painted ? [...painted.red].sort((a, b) => a - b) : [],
        comment: painted ? [...new Set(painted.comments)].join(' / ') : '',
      };
    }),
  }));
  const rowCount = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  return {
    ...meta,
    formatVersion: 2,
    generatedAt: new Date().toISOString(),
    today: todayIso(),
    // 可读结论列表:规则层硬错 + 塞港冲突 + 模型可疑(1 天内的已在上游抑制)。
    findings: Array.isArray(meta.findings) ? meta.findings : [],
    stats: {
      rows: rowCount,
      groups: groups.length,
      checked: groups.filter((group) => !group.skipped).length,
      skipped: groups.filter((group) => group.skipped).length,
      flagged: flaggedGroups,
      comments: sheets.reduce((sum, sheet) => sum + sheet.rows.filter((row) => row.comment).length, 0),
      congestionHits: Number(meta.congestionHits) || 0,
      // 被「1 天内不提醒」抑制的可疑段数
      suppressed: Number(meta.suppressed) || 0,
      model: meta.llm && !meta.llm.skipped
        ? {
            checked: meta.llm.checked,
            total: meta.llm.total,
            suspicious: meta.llm.suspicious ?? 0,
            // 预筛与调用预算:界面上要能看出「只问了几次、覆盖了多少组」。
            candidates: meta.llm.candidates ?? 0,
            calls: meta.llm.calls ?? 0,
            requests: meta.llm.requests ?? 0,
            truncated: meta.llm.truncated ?? 0,
            prefilter: meta.llm.prefilter ?? null,
          }
        : { checked: 0, total: 0, suspicious: 0 },
    },
    sheets,
  };
}

/** Build the export workbook: original columns + 检测备注, red fonts kept. */
export function exportTrackReport(report) {
  return report.sheets.map((sheet) => ({
    name: sheet.name.slice(0, 28) || '检测结果',
    columns: [...sheet.header.map((header, index) => ({ header: header || `列${index + 1}`, width: 16 })), { header: COMMENT_HEADER, width: 44 }],
    rows: sheet.rows.map((row) => [
      ...sheet.header.map((_, index) => ({ value: row.cells[index] ?? '', red: row.red.includes(index) })),
      { value: row.comment, red: false },
    ]),
  }));
}
