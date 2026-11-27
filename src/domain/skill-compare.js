import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readWorkbookDetailed } from './workbook.js';
import { readZip } from '../util/zip.js';

/**
 * Skill 驱动的船期对比。
 *
 * 用户提供一份「技能文件」(Markdown/TXT,写清某船东的解析与对比规则),
 * 再把新旧两份船期表交给模型:模型按 Skill 里的规则自己看表、自己判断增删改。
 * 和内置对比引擎的区别:内置走固定键/固定列,这里规则完全由 Skill 描述。
 */

/** 技能文件大小上限:再大就不是「技能」而是数据集了。 */
export const MAX_SKILL_BYTES = 200_000;
/** 技能包(zip)上限:含脚本和参考资料,给到 10MB。 */
export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
/** 单份参考资料最多喂多少字符。 */
const MAX_REFERENCE_CHARS = 8000;
/** 参考资料合计上限。 */
const MAX_REFERENCES_TOTAL = 30_000;

/** 能作为「参考资料」读进提示词的文本类型。 */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml']);
/** 技能包里的脚本:只列清单,不执行(执行用户上传的脚本需要单独开关)。 */
const SCRIPT_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.bash', '.ps1', '.bat', '.cmd']);
/** 每次喂给模型的最大字符数(两份表 + 技能)。超出会截断并告知模型。 */
export const DEFAULT_PROMPT_BUDGET = 120_000;

export const SKILL_SYSTEM_PROMPT = [
  '你是船期表对比专家。用户会给你一份「对比技能(Skill)」和两份船期表(旧版/新版)。',
  '',
  '要求:',
  '1. 严格按 Skill 里写的规则做对比:它规定的对比键、比较字段、增删口径、忽略项、输出格式优先于你的经验。',
  '2. Skill 没说的地方,按「同一条航次/航线 = 同一行」的常识保守判断;拿不准的不要编造。',
  '3. 只输出 JSON,不要任何其它文字。',
  '',
  '输出结构:',
  '{"summary":"3-5 句中文,先说最重要的变化","stats":{"added":0,"removed":0,"changed":0},',
  ' "items":[{"sheet":"工作表名","key":"这条记录怎么认出来的","status":"新增|删除|变更",',
  '           "changes":[{"field":"字段","from":"旧值","to":"新值"}],"note":"不超过 30 字"}],',
  ' "rules":["本次实际用到的 Skill 规则要点,最多 5 条"]}',
  '',
  '如果 Skill 规定了输出格式(分节、表格、统计口径),必须照它的格式写进 report;',
  '不要把结果改写成「新增/删除/变更」三行清单。',
  '',
  '约束:',
  '- status 只能是 新增 / 删除 / 变更 三者之一。',
  '- 变更项必须给出 changes;新增/删除可以给空数组。',
  '- 只列有差异的行,没有差异就不要编。',
  '- 数据被截断时,summary 里要说明「仅比较了前 N 行」。',
].join('\n');

/** 去掉 BOM,统一换行。 */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** 解析 front-matter(`---` 包裹的 key: value)与一级标题。 */
function parseFrontMatter(text) {
  const meta = {};
  let body = text;
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match) {
    for (const line of match[1].split('\n')) {
      const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (pair) meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '');
    }
    body = text.slice(match[0].length);
  }
  return { meta, body: body.trim() };
}

/**
 * 解析用户导入的 Skill 文件。
 * @returns `{ name, description, body, filename, bytes, hash }`
 */
export function parseSkillFile(buffer, filename = 'skill.md') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  if (bytes.length === 0) throw new Error('技能文件是空的');
  if (bytes.length > MAX_SKILL_BYTES) {
    throw new Error(`技能文件太大(${(bytes.length / 1024).toFixed(0)}KB),上限 ${MAX_SKILL_BYTES / 1000}KB`);
  }
  const text = normalizeText(bytes.toString('utf8'));
  if (!text) throw new Error('技能文件里没有可读文本');
  const { meta, body } = parseFrontMatter(text);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '';
  const name = (meta.name || heading || String(filename).replace(/\.[^.]+$/, '') || '未命名 Skill').slice(0, 80);
  const description = (meta.description || body.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim()).slice(0, 160);
  return {
    name,
    description,
    body,
    filename: String(filename ?? 'skill.md'),
    bytes: bytes.length,
    hash: createHash('sha1').update(bytes).digest('hex').slice(0, 16),
  };
}

function extensionOf(name) {
  const match = /\.[^./]+$/.exec(String(name ?? '').toLowerCase());
  return match ? match[0] : '';
}

/** 归一化包内路径;绝对路径与 `..` 一律丢弃(防目录穿越)。 */
export function safeEntryPath(name) {
  const normalized = String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) return '';
  return parts.join('/');
}

/**
 * 解析技能包:支持 `.zip`(SKILL.md + 参考资料 + 脚本)与单个 `.md/.txt`。
 *
 * zip 会被安全解包:过滤绝对路径/`..`;找 `SKILL.md`(优先最浅的那份);
 * 参考资料里的文本会随提示词一起给模型;脚本只列清单、不执行。
 */
export async function parseSkillPackage(buffer, filename = 'skill.zip') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length === 0) throw new Error('Skill 包是空的');
  if (bytes.length > MAX_PACKAGE_BYTES) {
    throw new Error(`Skill 包太大(${(bytes.length / 1024 / 1024).toFixed(1)}MB),上限 ${MAX_PACKAGE_BYTES / 1024 / 1024}MB`);
  }
  const looksZip = /\.zip$/i.test(filename) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (!looksZip) {
    const skill = parseSkillFile(bytes, filename);
    return { ...skill, kind: 'text', entries: [], references: [], files: [], scripts: [] };
  }

  const zip = await readZip(bytes);
  const entries = [];
  for (const [rawName, data] of zip) {
    const entryPath = safeEntryPath(rawName);
    if (!entryPath || entryPath.endsWith('/')) continue;
    entries.push({ path: entryPath, data, size: data.length });
  }
  if (entries.length === 0) throw new Error('Skill 包里没有可用文件');

  const documents = entries
    .filter((entry) => /(^|\/)skill\.md$/i.test(entry.path))
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length);
  if (documents.length === 0) throw new Error('Skill 包里缺少 SKILL.md');
  const skillDocument = documents[0];
  const skill = parseSkillFile(skillDocument.data, skillDocument.path);

  // 参考资料:除 SKILL.md 外的文本文件,按路径排序,单份与总量都设上限。
  let budget = MAX_REFERENCES_TOTAL;
  const references = [];
  for (const entry of entries) {
    if (entry === skillDocument) continue;
    if (!TEXT_EXTENSIONS.has(extensionOf(entry.path))) continue;
    if (budget <= 0) break;
    const text = normalizeText(entry.data.toString('utf8')).slice(0, Math.min(MAX_REFERENCE_CHARS, budget));
    if (!text) continue;
    references.push({ path: entry.path, text });
    budget -= text.length;
  }
  const scripts = entries
    .filter((entry) => SCRIPT_EXTENSIONS.has(extensionOf(entry.path)))
    .map((entry) => entry.path);
  return {
    ...skill,
    kind: 'zip',
    entries,
    references,
    scripts,
    files: entries.map((entry) => ({ path: entry.path, size: entry.size })),
  };
}

/** 脚本执行完之后,让模型读产物做总结(而不是只把文件丢给用户)。 */
export const SKILL_OUTPUT_SYSTEM_PROMPT = [
  '你是船期表对比专家。用户提供了一个「对比技能(Skill)」,其脚本已经按该技能跑完并生成了结果文件。',
  '',
  '你的任务:阅读结果文件的内容,用中文写清楚这次对比的结论。',
  '1. 严格按 Skill 规定的口径和输出格式表达;Skill 有版式要求就照做。',
  '2. 只讲产物里真实存在的内容,不要重复执行脚本,也不要编造数字。',
  '3. 结果文件被截断时,在 summary 里说明。',
  '',
  '只输出 JSON:',
  '{"summary":"3-6 句中文结论","report":"可选:按 Skill 格式排版的 Markdown","stats":{"added":0,"removed":0,"changed":0},',
  ' "items":[{"sheet":"","key":"","status":"新增|删除|变更","changes":[{"field":"","from":"","to":""}],"note":""}],',
  ' "rules":["本次结论依据的 Skill 规则,最多 5 条"]}',
  'items 只在产物确实是增删改清单时才给;Skill 更偏报告时只写 summary/report 即可。',
].join('\n');

/**
 * 把脚本产物读成文本给模型:表格解析成行,文本原样截断。
 * @param outputs - `[{ name, size, path }]`
 */
export function outputsToText(outputs, { maxChars = 40000 } = {}) {
  const blocks = [];
  let used = 0;
  for (const file of outputs ?? []) {
    if (used >= maxChars) break;
    const extension = extensionOf(file.name);
    try {
      if (['.xlsx', '.xls'].includes(extension)) {
        const buffer = readFileSync(file.path);
        const text = workbookToText(readSheets(buffer), { maxChars: maxChars - used }).text;
        blocks.push(`### 产物:${file.name}\n${text}`);
        used += text.length;
      } else if (['.csv', '.txt', '.json', '.md', '.tsv'].includes(extension)) {
        const text = normalizeText(readFileSync(file.path, 'utf8')).slice(0, maxChars - used);
        blocks.push(`### 产物:${file.name}\n${text}`);
        used += text.length;
      } else {
        blocks.push(`### 产物:${file.name}(${file.size ?? 0} 字节,未解析)`);
      }
    } catch (error) {
      blocks.push(`### 产物:${file.name}(读取失败:${error.message})`);
    }
  }
  return { text: blocks.join('\n\n'), truncated: used >= maxChars };
}

/** 脚本产物 + 技能 + stdout → 给模型的用户消息。 */
export function buildSkillOutputPrompt({ skill, script = '', stdout = '', outputsText = '' }) {
  return [
    `===== 对比技能(Skill:${skill.name}) =====`,
    skill.body,
    '',
    `===== 执行信息 =====`,
    `脚本:${script}`,
    stdout ? `脚本输出:\n${stdout}` : '',
    '',
    '===== 脚本产物内容 =====',
    outputsText || '(产物无法解析成文本,只能依据脚本输出判断)',
    '',
    '按 Skill 的口径总结这次对比,只输出约定的 JSON。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 去掉 Buffer/长文本,只留能进接口与记录的元信息。 */
export function skillMeta(skill) {
  if (!skill) return null;
  return {
    name: skill.name,
    description: skill.description,
    filename: skill.filename,
    hash: skill.hash,
    kind: skill.kind ?? 'text',
    files: (skill.files ?? []).map((file) => ({ path: file.path, size: file.size })),
    scripts: skill.scripts ?? [],
    referenceCount: (skill.references ?? []).length,
  };
}

/** 单元格 → 便于模型读的文本。 */
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * 把工作簿渲染成紧凑文本:`[sheet] 表头 | ...` + 编号行。
 * 超过 maxRows / maxChars 会截断,并回报 truncated,提示词里会告诉模型。
 */
export function workbookToText(sheets, { maxRows = 600, maxSheets = 6, maxChars = 60_000 } = {}) {
  const blocks = [];
  let chars = 0;
  let truncated = false;
  let usedRows = 0;
  let hiddenCount = 0;
  for (const sheet of (sheets ?? []).slice(0, maxSheets)) {
    const source = (sheet.rows ?? [])
      .map((row, index) => ({ row, hidden: Boolean(sheet.hiddenRows?.[index]) }))
      .filter((item) => (item.row ?? []).some((cell) => cellToText(cell) !== ''));
    const header = (sheet.header ?? source[0]?.row ?? []).map(cellToText);
    const body = source.slice(0, maxRows);
    const lines = [`### 工作表:${sheet.name}`, `表头: ${header.join(' | ')}`];
    body.forEach((item, index) => {
      // 隐藏行必须标出来:Skill 常按 hidden="1" 剔除无效航线。
      const marker = item.hidden ? '(隐藏) ' : '';
      if (item.hidden) hiddenCount += 1;
      lines.push(`${index + 1}) ${marker}${item.row.map(cellToText).join(' | ')}`);
    });
    if (source.length > body.length) truncated = true;
    const block = lines.join('\n');
    if (chars + block.length > maxChars) {
      truncated = true;
      const remain = Math.max(0, maxChars - chars);
      if (remain > 200) blocks.push(`${block.slice(0, remain)}\n…(已截断)`);
      break;
    }
    blocks.push(block);
    chars += block.length;
    usedRows += body.length;
  }
  return { text: blocks.join('\n\n'), truncated, rows: usedRows, hiddenRows: hiddenCount };
}

/** 组装用户消息:Skill 在前,两份表在后。 */
export function buildSkillPrompt({ skill, oldName, newName, oldWorkbook, newWorkbook, carrierName = '' }) {
  const oldText = workbookToText(oldWorkbook);
  const newText = workbookToText(newWorkbook, {
    maxChars: Math.max(20_000, DEFAULT_PROMPT_BUDGET / 2 - oldText.text.length),
  });
  const lines = [
    `船东:${carrierName || '未指定'}`,
    '',
    `===== 对比技能(Skill:${skill.name}) =====`,
    skill.body,
  ];
  if (skill.files?.length) {
    lines.push('', `技能包文件:${skill.files.map((file) => file.path).join('、')}`);
  }
  if (skill.scripts?.length) {
    lines.push(`技能包内脚本(本次不执行,只按文档与参考资料判断):${skill.scripts.join('、')}`);
  }
  if (skill.references?.length) {
    lines.push('', '===== 技能包参考资料 =====');
    for (const reference of skill.references) {
      lines.push(`--- ${reference.path} ---`, reference.text);
    }
  }
  lines.push(
    '',
    '表格中带 (隐藏) 前缀的行 = Excel 隐藏行;Skill 若要求按隐藏状态剔除航线,以此为准。',
    '',
    `===== 旧版文件:${oldName} =====`,
    oldText.text,
    '',
    `===== 新版文件:${newName} =====`,
    newText.text,
    '',
  );
  const truncated = oldText.truncated || newText.truncated;
  if (truncated) lines.push('注意:表格内容有截断,summary 里必须说明「仅比较了部分行」。');
  lines.push('按 Skill 的规则逐行对比,只输出约定的 JSON。');
  return { prompt: lines.join('\n'), truncated, rows: oldText.rows + newText.rows };
}

/** 容错取 JSON:原文 / 代码围栏 / 首个 { 到末个 }。 */
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
      // 试下一个
    }
  }
  return null;
}

const STATUSES = new Set(['新增', '删除', '变更']);

/**
 * 解析模型输出,收敛成可渲染的结构。
 * 缺 stats 时按 items 现算;非法 status 丢弃该条。
 */
export function parseSkillResult(text, { limit = 300 } = {}) {
  const parsed = firstJson(text);
  if (!parsed) return null;
  const items = [];
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    const status = String(raw?.status ?? '').trim();
    if (!STATUSES.has(status)) continue;
    const changes = (Array.isArray(raw?.changes) ? raw.changes : [])
      .map((change) => ({
        field: String(change?.field ?? '').trim().slice(0, 60),
        from: String(change?.from ?? '').trim().slice(0, 120),
        to: String(change?.to ?? '').trim().slice(0, 120),
      }))
      .filter((change) => change.field || change.from || change.to);
    items.push({
      sheet: String(raw?.sheet ?? '').trim().slice(0, 60),
      key: String(raw?.key ?? '').trim().slice(0, 120),
      status,
      changes,
      note: String(raw?.note ?? '').trim().slice(0, 120),
    });
    if (items.length >= limit) break;
  }
  const counted = items.reduce(
    (sum, item) => {
      if (item.status === '新增') sum.added += 1;
      else if (item.status === '删除') sum.removed += 1;
      else sum.changed += 1;
      return sum;
    },
    { added: 0, removed: 0, changed: 0 },
  );
  const stats = parsed.stats && typeof parsed.stats === 'object'
    ? {
        added: Number(parsed.stats.added) || counted.added,
        removed: Number(parsed.stats.removed) || counted.removed,
        changed: Number(parsed.stats.changed) || counted.changed,
      }
    : counted;
  const summary = String(parsed.summary ?? '').trim();
  // Skill 可以只要求一份报告(不要求结构化条目),所以 report 也算有效结果。
  const markdown = String(parsed.report ?? parsed.markdown ?? '').trim().slice(0, 40_000);
  if (!summary && items.length === 0 && !markdown) return null;
  return {
    summary,
    markdown,
    stats: { ...stats, sheets: new Set(items.map((item) => item.sheet).filter(Boolean)).size || 0 },
    items,
    rules: (Array.isArray(parsed.rules) ? parsed.rules : [])
      .map((rule) => String(rule ?? '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 8),
  };
}

/** 把技能对比结果导出成 xlsx 的 sheet 结构。 */
export function exportSkillResult(record) {
  const rows = [['工作表', '对比键', '对比结果', '字段', '旧值', '新值', '说明']];
  for (const item of record.items ?? []) {
    if ((item.changes ?? []).length === 0) {
      rows.push([item.sheet ?? '', item.key ?? '', item.status, '', '', '', item.note ?? '']);
      continue;
    }
    for (const change of item.changes) {
      rows.push([item.sheet ?? '', item.key ?? '', item.status, change.field, change.from, change.to, item.note ?? '']);
    }
  }
  const reportSheet = record.markdown
    ? [
        {
          name: '报告',
          columns: [{ header: '按 Skill 输出的报告', width: 100 }],
          rows: String(record.markdown).split('\n').map((line) => [{ value: line }]),
        },
      ]
    : [];
  return [
    ...reportSheet,
    {
      name: 'Agent 对比',
      columns: [
        { header: '工作表', width: 18 },
        { header: '对比键', width: 32 },
        { header: '对比结果', width: 10 },
        { header: '字段', width: 16 },
        { header: '旧值', width: 18 },
        { header: '新值', width: 18 },
        { header: '说明', width: 36 },
      ],
      rows: rows.slice(1).map((row) => row.map((value) => ({ value }))),
    },
    {
      name: '摘要',
      columns: [{ header: '摘要', width: 100 }],
      rows: [[{ value: record.summary ?? '' }]],
    },
  ];
}

/** 供服务层读取 excel/pdf 统一的表格结构。 */
export function readSheets(buffer) {
  return readWorkbookDetailed(buffer).filter((sheet) => (sheet.rows ?? []).length > 0);
}