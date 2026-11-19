/**
 * 船期新旧对比的「配对」层:纯函数,只做数据整形,不碰磁盘/网络。
 *
 * 邮件里的船期附件通常长这样:同一家船东每周/每天发一封同主题邮件,
 * 附件名只差一个日期。把「主题 + 附件名(去掉日期)」当作系列,取最近两封邮件的附件,
 * 就是用户要看的「旧版 / 新版」一行;如果这条已经跑过对比,直接把结果挂上去。
 */

import { matchCarrier } from './carrier-match.js';

const EXCEL_EXTENSIONS = new Set(['xls', 'xlsx']);

/** 能进对比流程的附件类型。 */
export const ATTACHMENT_EXTENSIONS = new Set(['xls', 'xlsx', 'pdf', 'zip']);

/** 取扩展名(小写,不含点);没有扩展名返回空串。 */
function extensionOf(filename) {
  return (/\.([a-z0-9]+)$/i.exec(String(filename ?? ''))?.[1] ?? '').toLowerCase();
}

/**
 * 主题归一化:小写,去掉 8 位/6 位日期与 `YYYY-MM-DD` 这类日期片段,再把标点与多余空白压平。
 *
 * 例:`NANSHA Monthly schedule of NOV-20261104` → `nansha monthly schedule of nov`
 */
export function normalizeSubject(subject) {
  return String(subject ?? '')
    .toLowerCase()
    // 日期片段先去掉,否则它们会留下孤立的数字/连字符。
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ')
    .replace(/\b\d{8}\b/g, ' ')
    .replace(/\b\d{6}\b/g, ' ')
    // 去掉标点但保留各语种的字母数字(中文主题不能被抹掉)。
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 附件名归一化:小写、去扩展名、去括号说明、去连续数字(含 `03rd`/`04th` 这类序数后缀),
 * 再合并空白。用于把同一系列日期不同的文件配成一组:
 * `SLG schedule-Nov 03rd.pdf` 与 `SLG schedule-Nov 04th.pdf` 都归一成 `slg schedule-nov`。
 */
export function normalizeAttachmentName(filename) {
  return String(filename ?? '')
    .toLowerCase()
    .replace(/\.(xlsx?|pdf|zip)$/i, '')
    // 括号里通常是「(1)」「(update)」之类的补充说明,不参与系列判定。
    .replace(/[（(][^）)]*[）)]/g, ' ')
    // 连续数字连同比它更短的序数后缀一起删:03、03rd、20261104、2026-11-04 都算日期噪声。
    .replace(/\d+(?:st|nd|rd|th)?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 对比记录里存的是文件名(可能带路径);配对比只看 basename,大小写不敏感。 */
function baseName(name) {
  return String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .trim()
    .toLowerCase();
}

/**
 * 在一批对比记录里找「这一对附件」的那次对比。
 *
 * 记录里的 oldName/newName 允许和邮件里的新旧顺序相反(用户可能是反着传的),
 * 两个方向都算命中;同一对有多条时取最新的一条(runs 由 listRuns 按时间倒序给出)。
 */
export function findRunForPair(runs, oldName, newName, { notBefore = 0 } = {}) {
  const wantedOld = baseName(oldName);
  const wantedNew = baseName(newName);
  if (!wantedOld || !wantedNew) return null;
  for (const run of runs ?? []) {
    const inputs = run?.inputs ?? {};
    const runOld = baseName(inputs.oldName);
    const runNew = baseName(inputs.newName);
    if (!runOld || !runNew) continue;
    const same = runOld === wantedOld && runNew === wantedNew;
    const reversed = runOld === wantedNew && runNew === wantedOld;
    if (!same && !reversed) continue;
    // 日期守卫:对比不可能发生在附件到达之前。同名附件(如每天都是 rasp.pdf)
    // 单靠文件名会把别的日子的结果错配过来。
    if (notBefore && timeOf(run.createdAt) < timeOf(notBefore)) continue;
    return run;
  }
  return null;
}

/**
 * 精确匹配一份「旧 → 新」配对对应的历史对比记录。
 *
 * 文件名相同不代表是同一份文件(PANDA 每天都是 rasp.pdf),所以先用**内容哈希**对;
 * 哈希对不上就不认。没有哈希(更早的记录没留文件)时才退回「文件名 + 日期守卫」。
 *
 * @param hashOf - `(runId) => ({ old, new })`,由调用方读 run 目录里的源文件算出来
 */
export function matchRunForPair(row, runs, { oldHash = '', newHash = '', hashOf } = {}) {
  if (!row?.old?.name || !row?.new?.name) return null;
  const notBefore = Math.max(timeOf(row.old.date), timeOf(row.new.date));
  const candidates = (runs ?? []).filter((run) => {
    const inputs = run?.inputs ?? {};
    const runOld = baseName(inputs.oldName);
    const runNew = baseName(inputs.newName);
    const wantedOld = baseName(row.old.name);
    const wantedNew = baseName(row.new.name);
    return (runOld === wantedOld && runNew === wantedNew) || (runOld === wantedNew && runNew === wantedOld);
  });
  if (candidates.length === 0) return null;

  if (oldHash && newHash && typeof hashOf === 'function') {
    for (const run of candidates) {
      let hashes = null;
      try {
        hashes = hashOf(run);
      } catch {
        hashes = null;
      }
      if (!hashes?.old || !hashes?.new) continue;
      const same = hashes.old === oldHash && hashes.new === newHash;
      const reversed = hashes.old === newHash && hashes.new === oldHash;
      if (same || reversed) return run;
    }
    // 有哈希但对不上 = 不是同一份文件,不要退化成按名字认。
    return null;
  }

  return findRunForPair(candidates, row.old.name, row.new.name, { notBefore });
}

function kindOf(filename) {
  const ext = extensionOf(filename);
  if (EXCEL_EXTENSIONS.has(ext)) return 'excel';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'zip') return 'zip';
  return 'excel';
}

/** 统一输出 ISO 字符串;时间缺失/非法时给空串,排序由调用方用毫秒值兜底。 */
function isoOf(value) {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

/** 时间统一成毫秒,用来排序。 */
function timeOf(value) {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

/** 一条系列里,某个附件在邮件里的原始信息。 */
function candidateOf(message, attachment) {
  return {
    uid: String(message.uid ?? ''),
    attachmentId: String(attachment.id ?? ''),
    name: String(attachment.filename ?? ''),
    message,
  };
}

/**
 * 把邮件附件整理成「新旧两版一行」的对比列表。
 *
 * @param options.messages - 邮件列表(`MailService.listMessages()` 的形状:
 *   `{ uid, subject, from, date, attachments: [{ id, filename }] }`)。
 * @param options.carriers - 船东配置(`db.listCarriers()`),用来认出 carrierId/carrierName。
 * @param options.runs - 已有对比记录(`db.listRuns({ kind: 'schedule', limit }).items` 形状)。
 * @returns `{ rows, unpaired }`:
 *   - `rows`:每个「至少两封不同邮件」的系列一行,按新版邮件时间倒序;字段见 README/契约。
 *   - `unpaired`:只有一封的系列摘要 `{ count, items }`,给 UI 做「还有 N 个系列只有单版」的提示。
 */
export function buildSchedulePairs({ messages = [], carriers = [], runs = [], matchRun } = {}) {
  // 先按邮件时间升序排好,后面取「最近两封」就只看数组尾部。
  const ordered = [...(messages ?? [])]
    .filter(Boolean)
    .map((message, index) => ({ message, index, time: timeOf(message.date) }))
    .sort((a, b) => a.time - b.time || a.index - b.index);

  const series = new Map();
  for (const { message } of ordered) {
    const subjectNorm = normalizeSubject(message.subject);
    for (const attachment of message.attachments ?? []) {
      const name = String(attachment?.filename ?? '');
      if (!ATTACHMENT_EXTENSIONS.has(extensionOf(name))) continue;
      const fileNorm = normalizeAttachmentName(name);
      if (!fileNorm) continue;
      const key = `${subjectNorm}#${fileNorm}`;
      let group = series.get(key);
      if (!group) {
        group = { key, items: [], byUid: new Set() };
        series.set(key, group);
      }
      // 同一封邮件里同名附件只算一次,避免把一封邮件误当成两版。
      const candidate = candidateOf(message, attachment);
      if (group.byUid.has(candidate.uid)) continue;
      group.byUid.add(candidate.uid);
      group.items.push(candidate);
    }
  }

  const rows = [];
  const unpaired = { count: 0, items: [] };
  for (const group of series.values()) {
    if (group.items.length < 2) {
      unpaired.count += 1;
      const only = group.items[0];
      if (unpaired.items.length < 50) {
        unpaired.items.push({
          key: group.key,
          subject: only?.message?.subject ?? '',
          name: only?.name ?? '',
          date: isoOf(only?.message?.date),
        });
      }
      continue;
    }
    // ordered 已按时间升序,组内 items 也保持升序:倒数第二封=old,最后一封=new。
    const oldItem = group.items[group.items.length - 2];
    const newItem = group.items[group.items.length - 1];
    const carrier = matchCarrier(carriers, {
      subject: newItem.message.subject,
      from: newItem.message.from,
      filename: newItem.name,
    });
    const kind = kindOf(newItem.name);
    const run = typeof matchRun === 'function'
      ? matchRun(
          {
            old: { uid: oldItem.uid, attachmentId: oldItem.attachmentId, name: oldItem.name, date: isoOf(oldItem.message.date) },
            new: { uid: newItem.uid, attachmentId: newItem.attachmentId, name: newItem.name, date: isoOf(newItem.message.date) },
          },
          runs,
        )
      : findRunForPair(runs, oldItem.name, newItem.name, {
          notBefore: Math.max(timeOf(isoOf(oldItem.message.date)), timeOf(isoOf(newItem.message.date))),
        });
    let status;
    let reason = '';
    if (run) {
      status = 'done';
    } else if (kind === 'excel' || kind === 'pdf') {
      status = 'ready';
      reason = '还没对比';
    } else {
      status = 'unsupported';
      reason = '压缩包解析还没接入';
    }
    rows.push({
      key: group.key,
      carrierId: carrier?.id ?? '',
      carrierName: carrier?.name ?? '',
      subject: newItem.message.subject ?? '',
      from: newItem.message.from ?? '',
      emailDate: isoOf(newItem.message.date),
      old: {
        uid: oldItem.uid,
        attachmentId: oldItem.attachmentId,
        name: oldItem.name,
        date: isoOf(oldItem.message.date),
      },
      new: {
        uid: newItem.uid,
        attachmentId: newItem.attachmentId,
        name: newItem.name,
        date: isoOf(newItem.message.date),
      },
      kind,
      status,
      runId: run?.id ?? '',
      stats: run?.stats ?? null,
      comparedAt: run?.createdAt ? isoOf(run.createdAt) : '',
      reason,
    });
  }

  // 新版时间倒序;同一时间按系列 key 稳定排序,避免每次刷新行序抖动。
  rows.sort((a, b) => timeOf(b.new.date) - timeOf(a.new.date) || a.key.localeCompare(b.key));
  return { rows, unpaired };
}
