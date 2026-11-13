import * as XLSX from 'xlsx';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectHeaderRow } from './schedule-parse.js';

/**
 * 船期表 PDF → 行表。
 *
 * PDF 里没有表格结构,只有一堆「某坐标上的一小截文字」(`getTextContent` 的 text item)。
 * 这里按坐标把它还原成电子表格:
 * 1. `y` 相近的是同一视觉行;
 * 2. 行内相邻的碎片先拼回文本段(换字体/换字号会把一个词拆成好几截);
 * 3. 列网格以**数据行**为准聚类(表头的港口名会横跨两列,算进网格会多出空列);
 * 4. 连续的几行表头(如 PANDA 的「港口名 + ETA/ETD」两行)合并成一行,
 *    横跨多列的港口名铺到每一列上,得到 `BUSAN ETA` / `BUSAN ETD` 这样的单行表头。
 * 输出的 `[{ name, rows }]` 与 `readWorkbook()` 同构,现有对比引擎可以原样复用。
 */

/** 同一行的 y 容差(pt)。PDF 里同一视觉行常有 1~2pt 的基线漂移。 */
const ROW_TOLERANCE = 2.5;
/** 同一列的 x 容差(pt)。要小于表内最小列间距,否则相邻列会被并成一列。 */
const COLUMN_TOLERANCE = 8;
/** 同一格内的两截文字,间距超过「字号 × 该系数」才补空格,否则视为同一个词被拆开。 */
const SPACE_RATIO = 0.18;
/** 补空格的最小间距阈值,避免小字号下把词内缝隙当空格。 */
const MIN_SPACE_WIDTH = 0.5;
/** 旋转超过该角度(度)的整段文字按竖排处理:先转正再参与行列聚类。 */
const VERTICAL_ANGLE = 45;

const PDF_EXTENSION = /\.pdf$/i;
const SCANNED_MESSAGE = 'PDF 里没有可提取的文字,可能是扫描件';
const CORRUPT_MESSAGE = 'PDF 解析失败:文件已损坏或不是有效的 PDF';
const PASSWORD_MESSAGE = 'PDF 有密码保护,无法解析';
const NO_PAGE_MESSAGE = 'PDF 解析失败:文件里没有页面';

/** 文件名是否 PDF(大小写不敏感)。 */
export function isPdfFile(name) {
  return PDF_EXTENSION.test(String(name ?? ''));
}

/** PDF buffer → `[{ name: '第 N 页', rows: string[][] }]`。 */
export async function readPdfWorkbook(buffer) {
  const pages = await extractPdfPages(buffer);
  const parsed = parsePdfTextItems(pages);
  // 一页都没文字:扫描件/图片型 PDF,再往下解析只会得到空表。
  if (!parsed.some((sheet) => sheet.rows.length > 0)) throw new Error(SCANNED_MESSAGE);
  const workbook = parsed.map(stripRepeatedHeaders);
  // 同一份 PDF 常夹带「港口/码头对照表」这类非船期页:没有船名/始发港表头的页不参与对比。
  const schedulePages = workbook.filter((sheet) => hasScheduleHeader(sheet.rows));
  return schedulePages.length > 0 ? schedulePages : workbook;
}

/** 这一页的表头是否像一个船期表(含船名/始发港/航次中的至少一个字段)。 */
function hasScheduleHeader(rows) {
  const detected = detectHeaderRow(rows);
  if (!detected) return false;
  const { core } = headerScoreOf(detected.header);
  return core > 0;
}

/** 复用 detectHeaderRow 的字段加权:只关心 core(船名/航次/航线/始发港)。 */
function headerScoreOf(header) {
  const fields = [
    ['VESSEL', '船名', '船舶', 'VSL', 'SHIP'],
    ['VOYAGE', 'VOY', '航次', 'TRIP'],
    ['SVC', 'SERVICE', 'LINE', '航线'],
    ['POL', '始发港', '起运港', '装货港', 'PORT OF LOADING', '出发港'],
  ];
  let core = 0;
  for (const hints of fields) {
    const hit = header.some((cell) => {
      const upper = String(cell ?? '').toUpperCase();
      return hints.some((hint) => upper.includes(hint.toUpperCase()));
    });
    if (hit) core += 1;
  }
  return { core };
}

/**
 * 去掉表头在数据区里重复出现的行(PDF 分块排版时每块都会重打一遍表头),
 * 否则它们会作为没有键的数据行进入对比。
 */
function stripRepeatedHeaders(sheet) {
  const detected = detectHeaderRow(sheet.rows);
  if (!detected) return sheet;
  const labels = new Set(
    detected.header.map((cell) => String(cell ?? '').trim().toUpperCase()).filter(Boolean),
  );
  if (labels.size === 0) return sheet;
  const rows = sheet.rows.filter((row, index) => {
    if (index <= detected.index) return true;
    const hits = row.filter((cell) => labels.has(String(cell ?? '').trim().toUpperCase())).length;
    return hits < 2;
  });
  return { ...sheet, rows };
}

/** PDF buffer → xlsx buffer(sheet 名 `第 N 页`),交给 `readWorkbook()` 即可。 */
export async function pdfToWorkbookBuffer(buffer) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of await readPdfWorkbook(buffer)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 纯几何部分:每页的 text item 数组 → `[{ name, rows }]`。
 *
 * `pages` 是「每页一个数组」;也接受单页平铺数组(按一页处理),便于单测直接喂坐标。
 * item 需要 `str`,坐标取 `transform[4]`(x)、`transform[5]`(y),`width`/`size` 缺失时按 0 处理。
 * `mergeHeaderRows: false` 可关掉表头合并,只看原始视觉行。
 */
export function parsePdfTextItems(pages, options = {}) {
  const rowTolerance = positive(options.rowTolerance, ROW_TOLERANCE);
  const columnTolerance = positive(options.columnTolerance, COLUMN_TOLERANCE);
  const mergeHeaderRows = options.mergeHeaderRows !== false;
  const groups = groupPages(pages);
  return groups.map((items, index) => ({
    name: pageName(index + 1),
    rows: buildRows(items, { rowTolerance, columnTolerance, mergeHeaderRows }),
  }));
}

function pageName(number) {
  return `第 ${number} 页`;
}

/** `pages` 既可以是每页一个数组,也可以是单页的平铺 item 列表。 */
function groupPages(pages) {
  if (!Array.isArray(pages)) throw new TypeError('parsePdfTextItems 需要每页的文本块数组');
  if (pages.length === 0) return [];
  return Array.isArray(pages[0]) ? pages : [pages];
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** 逐页取文字坐标;pdfjs 只在这一层出现。 */
async function extractPdfPages(buffer) {
  const data = toBytes(buffer);
  ensureWorker();
  let task = null;
  try {
    task = pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 });
    const document = await task.promise;
    if (!document.numPages) throw new Error(NO_PAGE_MESSAGE);
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      pages.push(await readPageItems(document, number));
    }
    return pages;
  } catch (error) {
    throw readablePdfError(error);
  } finally {
    // 关掉 worker 与文档,否则批量解析时会攒住内存。
    if (task) await task.destroy().catch(() => {});
  }
}

async function readPageItems(document, number) {
  try {
    const page = await document.getPage(number);
    const rotation = Number(page.rotate) || 0;
    const content = await page.getTextContent();
    const items = content.items.filter((item) => typeof item.str === 'string' && item.str.trim() !== '');
    return items.map((item) => toTextBlock(item, rotation));
  } catch (error) {
    throw new Error(`PDF 解析失败:第 ${number} 页无法读取(${firstLine(error)})`);
  }
}

/** pdfjs text item → 逻辑坐标下的文本块(x/y/width/字号)。 */
function toTextBlock(item, pageRotation) {
  let transform = toArray(item.transform);
  // 页面自带旋转(/Rotate)时,先把坐标转回「从上往下读」的逻辑方向。
  if (pageRotation) transform = compose(rotationMatrix(-pageRotation), transform);
  // 竖排文字:按它自己的角度转正,才能和横排文字一起参与行列聚类。
  const degrees = angleOf(transform);
  if (degrees > VERTICAL_ANGLE && degrees < 360 - VERTICAL_ANGLE) {
    transform = compose(rotationMatrix(-degrees), transform);
  }
  return {
    str: item.str,
    x: transform[4],
    y: transform[5],
    width: Number(item.width) > 0 ? Number(item.width) : 0,
    size: fontSize(transform),
  };
}

/** 一页的文本块 → 行表(含表头合并)。 */
function buildRows(items, { rowTolerance, columnTolerance, mergeHeaderRows }) {
  const blocks = items
    .map(normalizeBlock)
    .filter((block) => block && block.str.trim() !== '')
    .sort((left, right) => right.y - left.y || left.x - right.x);
  if (blocks.length === 0) return [];
  // mergeRuns 会新建数组,把行对象的 y 带过去,后面算行距才不是 NaN。
  const lines = groupLines(blocks, rowTolerance).map((line) => {
    const runs = mergeRuns(line);
    runs.y = line.y;
    return runs;
  });
  // 先按全部文本粗聚一次列,只为把表头块找出来(表头行的行高、行距与数据区不同)。
  const roughColumns = clusterColumns(lines.flat(), columnTolerance);
  const band = mergeHeaderRows ? findHeaderBand(lines, project(lines, roughColumns)) : null;
  // 列网格一律以数据行为准:表头里的港口名横跨两列,算进网格会多出空列,数据行就会错位。
  const dataLines = band ? [...lines.slice(0, band.start), ...lines.slice(band.end + 1)] : lines;
  const columns = dataLines.length > 0 ? clusterColumns(dataLines.flat(), columnTolerance) : roughColumns;
  const rows = project(lines, columns);
  if (!band || band.end === band.start) {
    const merged = mergeSubheaderRow(rows);
    const detected = detectHeaderRow(merged);
    const start = detected ? detected.index + 1 : 0;
    return [...merged.slice(0, start), ...mergeRecordRows(merged.slice(start), medianGap(lines))];
  }
  const header = composeHeader(lines, band, columns);
  // 合并出的表头至少要有一个像样的格子,否则不动(避免把数据行误当表头吞掉)。
  if (header.filter(Boolean).length < 2) return rows;
  const before = rows.slice(0, band.start);
  const after = mergeRecordRows(rows.slice(band.end + 1), medianGap(lines));
  return [...before, header, ...after];
}

/** 兼容外部直接构造的文本块(只要求 str + 坐标)。 */
function normalizeBlock(block) {
  if (!block || typeof block.str !== 'string') return null;
  const transform = toArray(block.transform);
  const x = Number.isFinite(Number(block.x)) ? Number(block.x) : transform[4];
  const y = Number.isFinite(Number(block.y)) ? Number(block.y) : transform[5];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    str: block.str,
    x,
    y,
    width: Number(block.width) > 0 ? Number(block.width) : 0,
    size: Number(block.size) > 0 ? Number(block.size) : fontSize(transform) || 1,
  };
}

/** 按 y 从上到下聚行;同一行按 x 升序。 */
function groupLines(blocks, tolerance) {
  const lines = [];
  for (const block of blocks) {
    // 以「本行第一个文本块的 y」为锚,漂移不超过容差就并入,避免逐块比较导致的链式漂移。
    const line = lines.find((candidate) => Math.abs(candidate.y - block.y) <= tolerance);
    if (line) {
      line.blocks.push(block);
    } else {
      lines.push({ y: block.y, blocks: [block] });
    }
  }
  lines.sort((left, right) => right.y - left.y);
  return lines.map((line) => {
    const runs = line.blocks.sort((left, right) => left.x - right.x);
    runs.y = line.y;
    return runs;
  });
}

/**
 * 行内把被拆开的碎片拼回文本段:间距小于「字号 × 系数」就当作同一个词(`BUS` + `AN`)。
 * 拼成段之后再聚列,否则一个词的两截会各自成为一列。
 */
function mergeRuns(blocks) {
  const runs = [];
  for (const block of blocks) {
    const previous = runs[runs.length - 1];
    if (previous) {
      const gap = block.x - (previous.x + previous.width);
      const threshold = Math.max(MIN_SPACE_WIDTH, Math.max(block.size, previous.size) * SPACE_RATIO);
      if (gap <= threshold) {
        previous.str += block.str;
        previous.width = Math.max(previous.width, block.x + block.width - previous.x);
        continue;
      }
    }
    runs.push({ ...block });
  }
  return runs;
}

/**
 * 按 x 中心聚列:排序后扫一遍,x 相距超过容差就另起一列。
 * 用中心而不是左边界,是因为表里居中的单元格(日期/CJK 短词)比左对齐更常见。
 */
function clusterColumns(runs, tolerance) {
  const values = runs.map((run) => run.x + run.width / 2).sort((left, right) => left - right);
  const groups = [];
  for (const value of values) {
    const last = groups[groups.length - 1];
    if (last && value - last.max <= tolerance) {
      last.values.push(value);
      last.max = value;
      continue;
    }
    groups.push({ values: [value], min: value, max: value });
  }
  return groups
    .map((group) => ({
      center: group.values.reduce((sum, value) => sum + value, 0) / group.values.length,
      count: group.values.length,
    }))
    .sort((left, right) => left.center - right.center);
}

/** 把每行的文本段落到最近的列上;同一列多截按 x 顺序用空格拼。 */
function project(lines, columns) {
  return lines.map((runs) => {
    const cells = columns.map(() => []);
    for (const run of runs) cells[nearestColumn(columns, run.x + run.width / 2)].push(run);
    const row = cells.map((parts) => joinParts(parts.sort((left, right) => left.x - right.x)));
    // 记住 y,数据行合并要用相邻行距判断「是不是同一条记录」。
    row.y = runs.y;
    return row;
  });
}

function nearestColumn(columns, value) {
  let index = 0;
  let distance = Infinity;
  columns.forEach((column, position) => {
    const current = Math.abs(column.center - value);
    if (current < distance) {
      distance = current;
      index = position;
    }
  });
  return index;
}

function joinParts(parts) {
  let text = '';
  let previous = null;
  for (const part of parts) {
    if (previous) {
      const gap = part.x - (previous.x + previous.width);
      const threshold = Math.max(MIN_SPACE_WIDTH, Math.max(part.size, previous.size) * SPACE_RATIO);
      if (gap > threshold) text += ' ';
    }
    text += part.str;
    previous = part;
  }
  return text.trim();
}

/**
 * 找出连续的表头行块。
 *
 * 以调用方的 `detectHeaderRow`(字段加权)选中的那一行为锚,向上下扩到相邻的「标签行」
 * (不含数字,表头不会带数字;数据行一定带日期/航次),行距不超过本页常规行距的 1.6 倍。
 * 最后再剪掉底部那种「格子数远少于表头」的行,避免把被拆开的第一个数据行(如 vessel 名)
 * 吞进表头。
 */
function findHeaderBand(lines, rows) {
  const detected = detectHeaderRow(rows);
  if (!detected || detected.index < 0 || detected.index >= lines.length) return null;
  // 锚点必须是标签行,否则会把数据行当表头吞掉(PANDA 第 2 页是港口/码头对照表)。
  if (!isLabelLine(lines[detected.index])) return null;
  const pitch = medianGap(lines);
  const gapLimit = Math.max(pitch * 1.6, 6);
  let start = detected.index;
  let end = detected.index;
  while (start > 0 && isLabelLine(lines[start - 1]) && gapOf(lines, start - 1, start) <= gapLimit) start -= 1;
  while (end + 1 < lines.length && isLabelLine(lines[end + 1]) && gapOf(lines, end, end + 1) <= gapLimit) {
    end += 1;
  }
  // 底部剪枝:表头每行至少有一半列被填,数据行的碎片(单个船名)远少于这个数。
  let maxCells = 0;
  for (let index = start; index <= end; index += 1) maxCells = Math.max(maxCells, lines[index].length);
  while (end > start && lines[end].length * 2 < maxCells) end -= 1;
  return { start, end };
}

/** 表头行:整行只有一个/几个短标签、不含数字。 */
function isLabelLine(runs) {
  return runs.every((run) => !/\d/.test(run.str));
}

function gapOf(lines, upper, lower) {
  return lines[upper].y - lines[lower].y;
}

/** 本页相邻行的间距中位数,用来判断两行是否属于同一个表头块。 */
function medianGap(lines) {
  const gaps = [];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = gapOf(lines, index - 1, index);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * 把表头块压成一行:每个网格列收集覆盖它的标签(自上而下),
 * 横跨多列的组名铺到每一列上 —— `BUSAN` + `ETA` → `BUSAN ETA`。
 */
function composeHeader(lines, band, columns) {
  const reach = medianPitch(columns) / 2;
  return columns.map((column) => {
    const parts = [];
    for (let index = band.start; index <= band.end; index += 1) {
      const label = coverLabel(lines[index], column, reach);
      if (!label) continue;
      const text = label.str.trim();
      if (!text || text === parts[parts.length - 1]) continue;
      parts.push(text);
    }
    return parts.join(' ');
  });
}

/**
 * 找出覆盖某一列的标签:标签中心与列中心的距离要在「半个标签宽 + 半个列间距」以内。
 * 组名(如居中于两列之间的 `BUSAN`)因此会同时覆盖 ETA、ETD 两列。
 */
function coverLabel(runs, column, reach) {
  let best = null;
  let bestDistance = Infinity;
  for (const run of runs) {
    const center = run.x + run.width / 2;
    const distance = Math.abs(center - column.center);
    if (distance > run.width / 2 + reach) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = run;
    }
  }
  return best;
}

/** 列间距的中位数;单列时退回 0。 */
function medianPitch(columns) {
  const gaps = [];
  for (let index = 1; index < columns.length; index += 1) {
    const gap = columns[index].center - columns[index - 1].center;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 把各种 buffer 形态统一成 pdfjs 可以接管的 Uint8Array(复制一份,不改调用方的内存)。 */
function toBytes(buffer) {
  if (buffer instanceof Uint8Array) return new Uint8Array(buffer);
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer.slice(0));
  throw new TypeError('PDF 解析需要 Buffer 或 Uint8Array');
}

/**
 * pdfjs 在 Node 里用 fake worker 干活,默认按相对路径找 `pdf.worker.mjs`;
 * 一旦被 esbuild 打进 `lib/index.js`,相对路径就指向插件目录了。这里按包内真实路径兜底。
 */
let workerConfigured = false;

function ensureWorker() {
  if (workerConfigured) return;
  workerConfigured = true;
  // 优先用打包时复制到 lib/ 旁边的 worker:装进 DSH 后插件目录里没有 node_modules。
  try {
    const local = fileURLToPath(new URL('./pdf.worker.mjs', import.meta.url));
    if (existsSync(local)) {
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(local).href;
      return;
    }
  } catch {
    // 源码直接运行时这里不存在,继续走包解析。
  }
  try {
    const resolve = createRequire(import.meta.url);
    const workerPath = resolve.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  } catch {
    // 解析不到就保留 pdfjs 自身的默认值(源码直接运行时本来就能找到 worker)。
  }
}

/** 任何失败都翻译成一句人能读的话,不把 pdfjs 的堆栈甩给用户。 */
function readablePdfError(error) {
  const message = firstLine(error);
  if (message.startsWith('PDF ')) return error;
  if (error?.name === 'PasswordException' || /password/i.test(message)) return new Error(PASSWORD_MESSAGE);
  if (error?.name === 'InvalidPDFException' || /invalid pdf|not a pdf|missing pdf/i.test(message)) {
    return new Error(CORRUPT_MESSAGE);
  }
  return new Error(message.startsWith('PDF 解析失败') ? message : `${CORRUPT_MESSAGE}(${message || '未知错误'})`);
}

function firstLine(error) {
  return String(error?.message ?? '')
    .split('\n')[0]
    .trim();
}

/** 文字基线方向的角度(0~360 度,逆时针)。 */
function angleOf(transform) {
  const degrees = (Math.atan2(transform[1], transform[0]) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/** 字号取变换矩阵 y 轴的模长(旋转后仍是字高)。 */
function fontSize(transform) {
  return Math.hypot(transform[2], transform[3]) || Math.hypot(transform[1], transform[0]) || 0;
}

function rotationMatrix(degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

/** 2D 变换矩阵相乘,与 pdfjs `Util.transform` 同义。 */
function compose(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function toArray(value) {
  return Array.isArray(value) && value.length >= 6 ? value.map(Number) : [1, 0, 0, 1, 0, 0];
}


/**
 * 兜底:两行表头的第二行(ETA / ETD / ARRIVES / DEPARTS)只由短标签组成、不含数字。
 * 把它并进上一行,横跨两列的港口名沿用上一个非空标签,得到 `BUSAN ETA` / `BUSAN ETD`。
 * 合并后总行数 -1,数据行紧跟在表头之后。
 */
function mergeSubheaderRow(rows) {
  const detected = detectHeaderRow(rows);
  if (!detected || detected.index < 0) return rows;
  const index = detected.index;
  const upper = rows[index] ?? [];
  const lower = rows[index + 1];
  if (!lower) return rows;
  const labels = lower.filter(Boolean);
  const looksLikeSubheader =
    labels.length >= 2 &&
    labels.length <= 40 &&
    labels.every((label) => label.length <= 12 && !/\d/.test(label)) &&
    upper.some(Boolean);
  if (!looksLikeSubheader) return rows;
  let previous = '';
  const merged = upper.map((cell, column) => {
    if (cell) previous = cell;
    const label = lower[column] ?? '';
    const head = cell || (label ? previous : '');
    return [head, label].filter(Boolean).join(' ').trim();
  });
  // 第二行可能比第一行多出几列(港口数多于字段数),多出来的列直接按子表头命名。
  if (lower.length > merged.length) {
    for (let column = merged.length; column < lower.length; column += 1) {
      merged.push(String(lower[column] ?? '').trim());
    }
  }
  return [...rows.slice(0, index), merged, ...rows.slice(index + 1)];
}


/** 一行里非空单元格数。 */
function filledCount(row) {
  return (row ?? []).filter((cell) => String(cell ?? '').trim() !== '').length;
}

/**
 * 把「一条记录占好几行」的数据行并成一行。
 *
 * Matson 每条船 = 船名行 + SVC/日期行 + 括号别名行;SFT/SLG 也是「中文船名 / 航次+日期 / 英文船名」。
 * 规则:相邻两行行距不超过 1.6 倍常规行距,且其中一行是稀疏行(≤3 个非空格),
 * 就按列把文本拼起来(中文名 + 英文名 → `盛唐 SHENGTANG`)。
 * PANDA 的数据行本身就是满的,不会命中。
 */
function mergeRecordRows(rows, pitch) {
  const limit = Math.max((pitch || 0) * 1.6, 6);
  const result = [];
  for (const row of rows) {
    const previous = result[result.length - 1];
    const gap = previous && Number.isFinite(previous.y) && Number.isFinite(row.y) ? previous.y - row.y : Infinity;
    const bothClose = gap > 0 && gap <= limit;
    const sparse = filledCount(row) <= 3 || (previous && filledCount(previous) <= 3);
    if (previous && bothClose && sparse) {
      const width = Math.max(previous.length, row.length);
      for (let column = 0; column < width; column += 1) {
        const left = String(previous[column] ?? '').trim();
        const right = String(row[column] ?? '').trim();
        previous[column] = left && right ? `${left} ${right}` : left || right;
      }
      continue;
    }
    result.push(row);
  }
  return result;
}
