import { matchCarrier } from './carrier-match.js';

const PARSEABLE_EXTENSIONS = new Set(['xls', 'xlsx', 'pdf']);

/**
 * 邮件附件自动入版本:认出船东 → 收下这一版 → 与上一版自动对比。
 *
 * 只处理能直接解析的形态(excel);PDF / zip 如实记成"还没接入",不做假成功。
 *
 * @param options.db - 工作台数据库(读船东配置)。
 * @param options.schedule - 船期对比服务(负责版本与对比)。
 * @param options.messages - 邮件列表。
 * @param options.readAttachment - `(uid, attachmentId) => Buffer`。
 * @param options.onProgress - 进度回调。
 * @returns 每条附件的处理结果。
 */
export async function ingestMailAttachments({ db, schedule, messages, readAttachment, onProgress = () => {} }) {
  const carriers = db.listCarriers().filter((carrier) => carrier.enabled !== false);
  const results = [];
  for (const message of messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      const name = String(attachment.filename ?? '');
      const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
      if (!PARSEABLE_EXTENSIONS.has(ext)) continue;
      const carrier = matchCarrier(carriers, {
        subject: message.subject,
        from: message.from,
        filename: name,
      });
      if (!carrier) continue;
      const kind = carrier.ingest?.kind ?? 'excel';
      // excel 与 pdf 都走同一套解析;zip 还没接入。
      if (kind === 'zip') {
        results.push({ carrier: carrier.name, file: name, skipped: true, reason: 'zip 解析还没接入' });
        continue;
      }
      onProgress({ carrier: carrier.name, file: name });
      try {
        const data = await readAttachment(message.uid, attachment.id);
        // ingest 是 async(要落盘、要跑对比),漏了 await 会把 Promise 展开进结果里。
        const outcome = await schedule.ingest({
          carrierId: carrier.id,
          buffer: data,
          filename: name,
          source: 'mail',
        });
        results.push({ carrier: carrier.name, file: name, ...outcome });
      } catch (error) {
        results.push({ carrier: carrier.name, file: name, error: error.message });
      }
    }
  }
  return results;
}
