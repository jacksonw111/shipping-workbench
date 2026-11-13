import { readWorkbook } from './workbook.js';
import { detectHeaderRow, resolveColumn, resolveDateColumn, normalizeProfile } from './schedule-parse.js';

/**
 * 船期表结构体检 + 模型辅助。
 *
 * 表头探测靠关键词打分,船东换一次模板就可能失手:键列对不上、开航日期列找不到,
 * 对比结果会静默变错。这里把「对不上的那些字段」连同表头和样例行交给模型,
 * 让它给出 列名 → 标准字段 的映射,人工确认一次再比。
 */

/** 标准字段与它们在船期表里的常见写法(给模型当提示,也给报错用)。 */
export const FIELD_HINTS = {
  始发港: '起运港 / 装货港 / 出发港 / POL / ORIGIN / PORT OF LOADING',
  SVC: '航线代码 / 服务 / SERVICE / SVC / LINE',
  船名: '船舶名称 / VESSEL / VSL / SHIP',
  航次: '航次号 / VOYAGE / VOY / TRIP',
  开航日期: '开航日 / 离港日 / ETD / SAILING / DEPARTURE',
};

const MAPPING_SYSTEM_PROMPT = [
  '你是船期表结构识别助手。我会给你一张船期表的表头行和几行样例数据。',
  '请判断每个标准字段对应表头里的哪一列。',
  '',
  '标准字段:始发港、SVC、船名、航次、开航日期。',
  '对应关系不一定和字段同名:比如「起运港」「POL」「装港」都可能是「始发港」,',
  '「服务代码」「LINE」都可能是「SVC」。只从给到的表头里选,不要编造列名。',
  '如果某个字段在表头里确实找不到,就给空字符串。',
  '',
  '只输出 JSON,不要任何其它文字:',
  '{"columns":{"始发港":"<表头原文>","SVC":"","船名":"","航次":"","开航日期":""},"note":"不超过 30 字,说明你是怎么判断的"}',
].join('\n');

const DIGEST_SYSTEM_PROMPT = [
  '你是船期数据核对助手,给货代运营写一段中文变更摘要。',
  '我会给你一条船东船期表的新旧对比统计和变更明细。',
  '',
  '要求:',
  '1. 只用简体中文,3 到 5 句,不要分点。',
  '2. 先说要紧的:哪些航线/船名/航次的开船时间调整最大,新增和取消的是哪些。',
  '3. 结尾一句给运营提醒(比如哪几条要通知客户改舱)。',
  '4. 只讲数据里有的,不要编造。没有变更就说「本次没有实际变更」。',
  '',
  '直接输出摘要正文,不要 JSON,不要标题。',
].join('\n');

/** 取模型回复里的第一个 JSON 对象,容忍代码围栏与多余文字。 */
function firstJson(raw) {
  const text = String(raw ?? '').trim();
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).trim();
}

/**
 * 结构体检:表头在哪、键列和开航日期列能不能对上。
 *
 * 返回 `{ ok, sheetName, header, headerIndex, sampleRows, missing, dateMissing, reason }`。
 * `ok:false` 且 `reason` 有值时表示连表头都没找到,后续可比性无从谈起。
 */
export function inspectStructure(buffer, profileInput) {
  const profile = normalizeProfile(profileInput);
  const workbook = readWorkbook(buffer);
  const usable = workbook.filter((sheet) => (sheet.rows ?? []).length > 0);
  if (usable.length === 0) {
    return { ok: false, reason: '这个文件里没有可读的工作表', missing: [], dateMissing: true };
  }
  // 体检只看第一个有数据的 sheet:模型映射是「这版模板怎么认」,各 sheet 通常同构。
  const sheet = usable[0];
  const detected = detectHeaderRow(sheet.rows, profile.parse);
  if (!detected) {
    return { ok: false, reason: `${sheet.name} 里找不到表头行`, missing: [], dateMissing: true };
  }
  const header = detected.header.map((cell, index) => (cell && String(cell).trim() ? String(cell).trim() : `列${index + 1}`));
  const keyColumns = [...new Set(profile.keys.flatMap((group) => group.columns ?? []))];
  const missing = keyColumns.filter((column) => resolveColumn(header, column, profile.parse) < 0);
  const dateMissing = resolveDateColumn(header, profile) < 0;
  const sampleRows = sheet.rows
    .slice(detected.index + 1, detected.index + 6)
    .filter((row) => (row ?? []).some((cell) => cellText(cell) !== ''))
    .map((row) => header.map((_, index) => cellText(row[index])));
  return {
    ok: true,
    sheetName: sheet.name,
    header,
    headerIndex: detected.index,
    sampleRows,
    missing,
    dateMissing,
    reason: '',
  };
}

/** 需要模型介入吗:键列或开航日期列没对上,都算结构变了。 */
export function needsModelHelp(inspection) {
  if (!inspection) return true;
  if (!inspection.ok) return true;
  return inspection.missing.length > 0 || Boolean(inspection.dateMissing);
}

export function buildMappingPrompt({ carrier = {}, inspection } = {}) {
  const lines = [
    `船东:${carrier.name ?? '未指定'}`,
    `工作表:${inspection.sheetName ?? '-'}`,
    '',
    '表头行(按列顺序):',
    inspection.header.map((cell, index) => `  ${index + 1}. ${cell}`).join('\n'),
    '',
    '样例数据:',
    ...(inspection.sampleRows ?? []).map((row, index) => `  第${index + 1}行: ${row.join(' | ')}`),
    '',
    '标准字段说明:',
    ...Object.entries(FIELD_HINTS).map(([field, hint]) => `  ${field}:${hint}`),
    '',
    `当前对不上的字段:${(inspection.missing ?? []).join('、') || '(无)'}`,
    inspection.dateMissing ? '开航日期列也没找到。' : '',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

/** 把模型回复整理成可直接用的映射;表头里不存在的列名一律丢弃。 */
export function parseMapping(text, header = []) {
  const parsed = firstJson(text);
  if (!parsed?.columns || typeof parsed.columns !== 'object') return null;
  const known = new Set(header);
  const columns = {};
  for (const [field, column] of Object.entries(parsed.columns)) {
    const name = String(column ?? '').trim();
    if (!name || !known.has(name)) continue;
    columns[field] = name;
  }
  if (Object.keys(columns).length === 0) return null;
  return { columns, note: String(parsed.note ?? '').trim().slice(0, 60) };
}

/** 让模型给出列映射;没模型或回复不可用就返回 null,由调用方退回原配置。 */
export async function proposeMapping({ llm, carrier = {}, inspection } = {}) {
  const availability = llm?.availability?.() ?? { available: false };
  if (!availability.available || !inspection?.ok) return null;
  const text = await llm.complete({
    system: MAPPING_SYSTEM_PROMPT,
    prompt: buildMappingPrompt({ carrier, inspection }),
    temperature: 0,
  });
  return parseMapping(text, inspection.header);
}

/**
 * 把映射转成 profile 覆盖。
 *
 * `fields` 是「哪些标准字段这版能认出来」,`columns` 是「这版的列名」。
 * 键用标准字段名:解析时再由 columns 候选列表去找真实列,新旧模板都能命中。
 */
export function mappingToOverride(mapping) {
  const columns = mapping?.columns ?? {};
  const fields = ['始发港', 'SVC', '船名', '航次'].filter((field) => columns[field]);
  return {
    columns,
    dateColumn: columns['开航日期'] ?? '',
    fields,
  };
}

export function buildDigestPrompt({ carrier = {}, stats = {}, summary = [] } = {}) {
  const lines = [
    `船东:${carrier.name ?? '未指定'}`,
    `统计:新增 ${stats.added ?? 0} 行,删除 ${stats.removed ?? 0} 行,变更 ${stats.changed ?? 0} 行,跳过已过期 ${stats.skipped ?? 0} 行。`,
  ];
  const notable = summary.slice(0, 30);
  if (notable.length > 0) {
    lines.push('', '变更明细(最多 30 条):');
    for (const item of notable) {
      const fields = Array.isArray(item.changes) ? ` 涉及 ${item.changes.join('、')}` : '';
      lines.push(`  [${item.status}] ${item.sheet ?? ''} ${item.key ?? ''}${fields}`);
    }
  }
  return lines.join('\n');
}

/** 让模型写一段中文变更摘要。没模型就返回空串,界面上不显示这一块。 */
export async function writeDigest({ llm, carrier = {}, stats = {}, summary = [] } = {}) {
  const availability = llm?.availability?.() ?? { available: false };
  if (!availability.available) return '';
  try {
    const text = await llm.complete({
      system: DIGEST_SYSTEM_PROMPT,
      prompt: buildDigestPrompt({ carrier, stats, summary }),
      temperature: 0.3,
    });
    return String(text ?? '').trim().slice(0, 600);
  } catch {
    // 摘要只是锦上添花,失败不能拖垮对比结果。
    return '';
  }
}
/**
 * 变更复核:模型把「真实变更」和「解析噪声」分开。
 *
 * PDF/多模板解析出来的差异里常见空格、换行、全半角、日期格式、拆行拼接造成的假差异;
 * 这部分判断需要语义,规则层做不到。逐条输出 real / noise,拿不准一律 real。
 */
const REVIEW_SYSTEM_PROMPT = [
  '你是船期表对比复核员。给你一条对比产生的变更清单,里面可能混着解析噪声。',
  '',
  '噪声指:',
  '- 空格、换行、全半角、大小写不同,但语义相同;',
  '- 日期格式不同但同一天(2026/11/3、2026-11-03、3-Nov-2026、03-Nov);',
  '- 同一格被拆成两截后拼回来的多余空格或重复片段;',
  '- 数字前导零、单位写法不同(如 001 与 1)。',
  '',
  '真实变更指船期本身变了:开航日期挪了、船名/航次换了、港口增删。',
  '拿不准时判 real,不要为了减少数量把真变更当噪声。',
  '',
  '只输出 JSON,不要任何其它文字:',
  '{"reviews":[{"i":1,"verdict":"real","reason":"不超过 20 字"}]}',
  '清单里每一条都要出现一次,verdict 只能是 real 或 noise。',
].join('\n');

/** 变更清单 → 给模型的一行行文本。 */
export function buildReviewPrompt({ carrier = {}, stats = {}, items = [] } = {}) {
  const lines = [
    `船东:${carrier.name ?? '未指定'}`,
    `统计:新增 ${stats.added ?? 0}、删除 ${stats.removed ?? 0}、变更 ${stats.changed ?? 0}。`,
    '',
    '变更清单:',
  ];
  items.forEach((item, index) => {
    const field = item.field ? `${item.field}: ` : '';
    const values = item.from || item.to ? `${item.from || '(空)'} → ${item.to || '(空)'}` : '';
    lines.push(
      `  #${index + 1} [${item.status}] ${item.sheet ?? ''} ${item.key ?? ''} ${field}${values}`.replace(/\s+/g, ' '),
    );
  });
  return lines.join('\n');
}

/** 模型回复 → `{index(0 起): {verdict, reason}}`;坏 JSON 返回空表。 */
export function parseReview(text, count = 0) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed?.reviews)) continue;
      const map = new Map();
      for (const item of parsed.reviews) {
        const index = Number(item?.i) - 1;
        if (!Number.isInteger(index) || index < 0 || (count > 0 && index >= count)) continue;
        const verdict = item?.verdict === 'noise' ? 'noise' : 'real';
        map.set(index, { verdict, reason: String(item?.reason ?? '').trim().slice(0, 40) });
      }
      return map;
    } catch {
      // 试下一个候选
    }
  }
  return new Map();
}

/**
 * 自动复核:模型可用且有变更才调用;失败/没有模型返回 null,不阻塞对比。
 * @returns `{checked, real, noise, items:[{i, verdict, reason}]}` 或 null
 */
export async function reviewChanges({ llm, carrier = {}, stats = {}, items = [] } = {}) {
  if (!items.length) return null;
  const availability = llm?.availability?.() ?? { available: false };
  if (!availability.available) return null;
  try {
    const text = await llm.complete({
      system: REVIEW_SYSTEM_PROMPT,
      prompt: buildReviewPrompt({ carrier, stats, items }),
      temperature: 0,
    });
    const map = parseReview(text, items.length);
    const reviews = items.map((_, index) => ({
      i: index + 1,
      verdict: map.get(index)?.verdict ?? 'real',
      reason: map.get(index)?.reason ?? '',
    }));
    const noise = reviews.filter((item) => item.verdict === 'noise').length;
    return {
      checked: items.length,
      real: items.length - noise,
      noise,
      reviews,
      model: { provider: availability.provider ?? '', model: availability.model ?? '' },
    };
  } catch {
    return null;
  }
}
