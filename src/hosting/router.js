import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, readBody, sendError, sendJson, parseMultipart } from '../util/http-util.js';
import { ingestMailAttachments } from '../domain/mail-ingest.js';
import { buildSchedulePairs, matchRunForPair } from '../domain/schedule-pairs.js';
import { parseSkillPackage } from '../domain/skill-compare.js';
import { createHash } from 'node:crypto';
import { BATCH_SYSTEM_PROMPT, trackSystemPrompt } from '../domain/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR =
  [path.join(HERE, '..', 'ui'), path.join(HERE, '..', '..', 'ui')].find((candidate) =>
    fs.existsSync(path.join(candidate, 'index.html')),
  ) ?? path.join(HERE, '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export const PREFIX = '/shipping-workbench';

/** 路由用到的服务。少接一个就会在某个请求上 500,这里改成装配时直接报错。 */
export const REQUIRED_SERVICES = ['settings', 'wechat', 'track', 'schedule', 'congestion', 'mail', 'llm', 'hotspot', 'db'];

/** Build the HTTP handler for the workbench (static UI + JSON API). */
export function createHandler(services) {
  const missing = REQUIRED_SERVICES.filter((name) => !services?.[name]);
  if (missing.length > 0) throw new Error(`工作台缺少服务:${missing.join('、')}`);
  return async function handle(req, res, url) {
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith(PREFIX)) return notFound(res);
      const relative = pathname.slice(PREFIX.length) || '/';
      if (relative === '/api' || relative.startsWith('/api/')) {
        await handleApi(req, res, url, relative.slice(4), services);
        return;
      }
      serveStatic(req, res, relative === '/' ? '/index.html' : relative);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, relative) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  const resolved = path.join(UI_DIR, path.normalize(relative).replace(/^([/\\])+/, ''));
  if (!resolved.startsWith(UI_DIR)) return notFound(res);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** 统一的分页/搜索参数:limit 上限 200,offset 非负。 */
function pageParams(url, { limit = 20 } = {}) {
  const params = url.searchParams;
  return {
    q: (params.get('q') ?? '').trim(),
    limit: Math.min(200, Math.max(1, Number(params.get('limit')) || limit)),
    offset: Math.max(0, Number(params.get('offset')) || 0),
  };
}

async function handleApi(req, res, url, route, services) {
  const { settings, wechat, track, schedule, congestion, mail, llm, hotspot, db, updater } = services;
  const method = req.method ?? 'GET';
  // URL 路径是百分号编码的,文件名/文章 key 里可能有中文与括号。
  const [head, ...rest] = route.split('/').filter(Boolean).map(safeDecode);

  if (head === 'bootstrap' && method === 'GET') {
    const accounts = wechat.listAccounts();
    const latest = wechat.listArticles({ limit: 1 });
    return sendJson(res, 200, {
      settings: settings.publicView(),
      accounts,
      latestAt: latest.items[0]?.publishedAt ?? 0,
      accountTotal: wechat.listArticles({ limit: 1 }).total,
      trackRuns: track.listRuns({ limit: 5 }).items,
      scheduleRuns: schedule.listRuns({ limit: 5 }).items,
      carriers: db.listCarriers(),
      congestion: congestion.list({ limit: 1 }),
      mailMessages: mail.listMessages().slice(0, 50),
      model: llm.availability(),
      version: updater?.currentVersion ?? '',
    });
  }

  if (head === 'runs') {
    if (method === 'GET') {
      const page = pageParams(url);
      return sendJson(res, 200, db.listRuns({ ...page, kind: url.searchParams.get('kind') ?? '' }));
    }
    if (method === 'DELETE' && rest[0]) {
      const row = db.getRun(rest[0]);
      if (!row) throw new HttpError(404, '任务记录不存在');
      if (row.kind === 'track') track.remove(row.id);
      else schedule.remove(row.id);
      return sendJson(res, 200, { deleted: row.id, runs: db.listRuns({ limit: 50 }) });
    }
  }

  if (head === 'carriers' && method === 'GET') {
    return sendJson(res, 200, { carriers: db.listCarriers() });
  }

  // 判定提示词:默认 + 自定义覆盖,设置页展示/编辑用。
  if (head === 'prompts' && method === 'GET') {
    const track = settings.read().track ?? {};
    const override = String(track.promptOverride ?? '');
    return sendJson(res, 200, {
      track: {
        default: BATCH_SYSTEM_PROMPT,
        override,
        system: trackSystemPrompt(override),
      },
    });
  }

  // 版本与更新:查远端 package.json;apply 会下载并覆盖 lib/ui(后端变更需重启)。
  if (head === 'update' && method === 'GET') {
    if (!updater) throw new HttpError(501, '当前安装没有更新器');
    return sendJson(res, 200, await updater.check());
  }

  if (head === 'update' && method === 'POST') {
    if (!updater) throw new HttpError(501, '当前安装没有更新器');
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return sendJson(res, 200, await updater.apply({ force: Boolean(body.force) }));
  }

  if (head === 'settings' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return sendJson(res, 200, { settings: settings.save(body) });
  }

  if (head === 'accounts' && method === 'GET') {
    const { q, limit, offset } = pageParams(url, { limit: 10 });
    const keyword = q.toLowerCase();
    const matched = wechat
      .listAccounts()
      .filter((account) => !keyword || `${account.name} ${account.biz}`.toLowerCase().includes(keyword));
    return sendJson(res, 200, {
      accounts: matched.slice(offset, offset + limit),
      total: matched.length,
      limit,
      offset,
    });
  }

  // AI 热点追踪:一篇中文综述,正文的 [n] 对应 articles 里的来源。
  if (head === 'hotspots' && rest[0] === 'report' && method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return sendJson(res, 200, hotspot.view({ days }));
  }

  if (head === 'hotspots' && rest[0] === 'report' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const days = Math.min(90, Math.max(1, Number(body.days) || 7));
    return sendJson(res, 200, await hotspot.generate({ days, refresh: Boolean(body.refresh) }));
  }

  if (head === 'accounts') {
    if (method === 'POST' && rest[0] && rest[1] === 'collect') {
      const result = await wechat.collect(rest[0]);
      return sendJson(res, 200, { ...result, accounts: wechat.listAccounts() });
    }
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const account = await wechat.saveAccount(body);
      return sendJson(res, 200, { accounts: wechat.listAccounts(), account });
    }
    if (method === 'DELETE' && rest[0]) {
      wechat.removeAccount(rest[0]);
      return sendJson(res, 200, { accounts: wechat.listAccounts() });
    }
  }

  if (head === 'lookup') {
    const name = url.searchParams.get('name') ?? '';
    const candidates = await wechat.lookup(name);
    return sendJson(res, 200, { candidates });
  }

  if (head === 'articles' && method === 'GET') {
    const { q, limit, offset } = pageParams(url, { limit: 20 });
    const accountId = url.searchParams.get('accountId') ?? '';
    const page = wechat.listArticles({ limit, offset, accountId, q });
    return sendJson(res, 200, { articles: page.items, total: page.total, limit, offset });
  }

  if (head === 'article' && method === 'GET') {
    const article = wechat.getArticle(rest[0], rest[1]);
    if (!article) throw new HttpError(404, '文章不存在');
    return sendJson(res, 200, { article });
  }

  if (head === 'track') {
    if (rest[0] === 'start' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const file = files.find((item) => item.name === 'file') ?? files[0];
      if (!file) throw new HttpError(400, '请上传轨迹文件');
      const status = track.start(file.data, {
        filename: file.filename ?? 'track.xls',
        useLlm: fields.useLlm === '1' || fields.useLlm === 'true',
        source: fields.source || 'upload',
      });
      return sendJson(res, 202, { status });
    }
    if (rest[0] === 'run' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const file = files.find((item) => item.name === 'file') ?? files[0];
      if (!file) throw new HttpError(400, '请上传轨迹文件');
      const report = await track.run(file.data, {
        filename: file.filename ?? 'track.xls',
        useLlm: fields.useLlm === '1' || fields.useLlm === 'true',
        source: fields.source || 'upload',
      });
      return sendJson(res, 200, { report, runs: track.listRuns({ limit: 20 }).items });
    }
    if (rest[0] === 'runs' && method === 'GET' && !rest[1]) {
      const { q, limit, offset } = pageParams(url);
      return sendJson(res, 200, track.listRuns({ q, limit, offset }));
    }
    if (rest[0] === 'runs' && rest[1] && method === 'GET' && rest[2] === 'export') {
      const { buffer, filename } = track.exportBuffer(rest[1]);
      return sendDownload(res, buffer, filename);
    }
    if (rest[0] === 'runs' && rest[1] && method === 'GET' && rest[2] === 'progress') {
      return sendJson(res, 200, { status: track.status(rest[1]) });
    }
    if (rest[0] === 'runs' && rest[1] && method === 'GET') {
      return sendJson(res, 200, { report: track.getReport(rest[1]) });
    }
  }

  if (head === 'schedule') {
    if (rest[0] === 'ingest' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const file = files.find((item) => item.name === 'file') ?? files[0];
      const carrierId = String(fields.carrierId ?? '').trim();
      if (!file) throw new HttpError(400, '请上传船期表文件');
      if (!carrierId) throw new HttpError(400, '请指定船东');
      const result = await schedule.ingest({
        carrierId,
        buffer: file.data,
        filename: file.filename ?? 'schedule.xlsx',
        source: fields.source || 'upload',
        mapping: fields.mapping ? JSON.parse(fields.mapping) : null,
      });
      return sendJson(res, 200, {
        ...result,
        runs: schedule.listRuns({ limit: 20 }).items,
        versions: schedule.versions(carrierId),
      });
    }
    // Skill 驱动的对比:导入技能文件,让模型按里面的规则比两份表。
    if (rest[0] === 'skill' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const oldFile = files.find((item) => item.name === 'oldFile');
      const newFile = files.find((item) => item.name === 'newFile');
      const skillFile = files.find((item) => item.name === 'skillFile');
      if (!oldFile || !newFile) throw new HttpError(400, '请同时上传旧版与新版文件');
      if (!skillFile) throw new HttpError(400, '请导入 Skill 包(.zip)或 .md / .txt');
      let skill;
      try {
        skill = await parseSkillPackage(skillFile.data, skillFile.filename ?? 'skill.zip');
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      const result = await schedule.compareWithSkill({
        oldBuffer: oldFile.data,
        oldName: oldFile.filename ?? 'old.xlsx',
        newBuffer: newFile.data,
        newName: newFile.filename ?? 'new.xlsx',
        skill,
        carrierId: String(fields.carrierId ?? '').trim(),
        executeScripts: fields.executeScripts === '1' || fields.executeScripts === 'true',
      });
      return sendJson(res, 200, { result, runs: schedule.listRuns({ limit: 20 }).items });
    }

    // 技能脚本产物下载
    if (rest[0] === 'runs' && rest[1] && rest[2] === 'outputs' && rest[3] && method === 'GET') {
      const { buffer, filename } = schedule.outputFile(rest[1], rest[3]);
      return sendDownload(res, buffer, filename);
    }

    // 结构体检:能不能按现有配置认出来;认不出来就请模型给列映射。
    if (rest[0] === 'analyze' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const file = files.find((item) => item.name === 'file') ?? files[0];
      if (!file) throw new HttpError(400, '请上传船期表文件');
      return sendJson(
        res,
        200,
        await schedule.analyze({
          buffer: file.data,
          filename: file.filename ?? 'schedule.xlsx',
          carrierId: String(fields.carrierId ?? '').trim(),
        }),
      );
    }
    // 邮件系列里新旧两份附件的配对结果:一行 = 旧附件 + 新附件 + 邮件 + 已有对比。
    if (rest[0] === 'pairs' && method === 'GET') {
      return sendJson(res, 200, schedulePairs({ mail, db, schedule }));
    }
    // 对某一条配对现场跑一次对比(附件字节从邮件库读)。
    if (rest[0] === 'pairs' && rest[1] === 'compare' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const pairs = schedulePairs({ mail, db, schedule });
      const row = pairs.rows.find((item) => item.key === body.key);
      if (!row) throw new HttpError(404, '这条对比任务不存在,刷新后再试');
      if (row.kind !== 'excel' && row.kind !== 'pdf') {
        throw new HttpError(415, `${row.kind.toUpperCase()} 船期表解析还没接入`);
      }
      const oldFile = mail.readAttachment(row.old.uid, row.old.attachmentId);
      const newFile = mail.readAttachment(row.new.uid, row.new.attachmentId);
      const result = await schedule.run({
        oldBuffer: oldFile.data,
        oldName: oldFile.attachment.filename,
        newBuffer: newFile.data,
        newName: newFile.attachment.filename,
        carrierId: row.carrierId ?? '',
        carrierName: row.carrierName ?? '',
        source: 'mail',
        oldRef: row.old,
        newRef: row.new,
      });
      return sendJson(res, 200, { result, pairs: schedulePairs({ mail, db, schedule }) });
    }
    if (rest[0] === 'versions' && rest[1] === 'compare' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const carrierId = String(body.carrierId ?? '').trim();
      if (!carrierId) throw new HttpError(400, '请指定船东');
      return sendJson(res, 200, await schedule.compareVersions(carrierId));
    }
    if (rest[0] === 'versions' && method === 'GET') {
      const carrierId = url.searchParams.get('carrierId') ?? rest[1] ?? '';
      if (!carrierId) throw new HttpError(400, '请指定船东');
      return sendJson(res, 200, schedule.versions(carrierId));
    }
    if (rest[0] === 'run' && method === 'POST') {
      const { files, fields } = await readMultipart(req);
      const oldFile = files.find((item) => item.name === 'oldFile');
      const newFile = files.find((item) => item.name === 'newFile');
      if (!oldFile || !newFile) throw new HttpError(400, '请同时上传旧版与新版文件');
      const carrier = fields.carrierId ? db.listCarriers().find((item) => item.id === fields.carrierId) : null;
      const mapping = fields.mapping ? JSON.parse(fields.mapping) : null;
      const record = await schedule.run({
        oldBuffer: oldFile.data,
        oldName: oldFile.filename,
        newBuffer: newFile.data,
        newName: newFile.filename,
        // 选了船东就用船东配置里的键,只有手填才覆盖。
        keys: fields.keys || '',
        compareColumns: fields.compareColumns,
        dateColumn: fields.dateColumn,
        carrierId: carrier?.id ?? '',
        carrierName: carrier?.name ?? '',
        source: fields.source || 'upload',
        mapping,
        wantDigest: fields.digest !== '0',
      });
      return sendJson(res, 200, { result: record, runs: schedule.listRuns({ limit: 20 }).items });
    }
    if (rest[0] === 'runs' && method === 'GET' && !rest[1]) {
      const { q, limit, offset } = pageParams(url);
      return sendJson(res, 200, schedule.listRuns({ q, limit, offset }));
    }
    if (rest[0] === 'runs' && rest[1] && method === 'GET' && rest[2] === 'export') {
      const { buffer, filename } = schedule.exportBuffer(rest[1]);
      return sendDownload(res, buffer, filename);
    }
    // 用这条记录留存的源文件重跑一次(重新做映射、复核和摘要)。
    if (rest[0] === 'runs' && rest[1] && rest[2] === 'recompare' && method === 'POST') {
      const result = await schedule.recompare(rest[1]);
      return sendJson(res, 200, { result, runs: schedule.listRuns({ limit: 20 }).items });
    }
    if (rest[0] === 'runs' && rest[1] && method === 'GET') {
      return sendJson(res, 200, { result: schedule.getRun(rest[1]) });
    }
  }

  if (head === 'congestion') {
    if (method === 'GET') {
      const { q, limit, offset } = pageParams(url, { limit: 50 });
      return sendJson(res, 200, congestion.list({ q, limit, offset }));
    }
    if (rest[0] === 'import' && method === 'POST') {
      const { files } = await readMultipart(req);
      const file = files[0];
      if (!file) throw new HttpError(400, '请上传塞港数据文件');
      const result = congestion.importWorkbook(file.data);
      return sendJson(res, 200, { ...result, congestion: congestion.list() });
    }
    if (rest[0] === 'fetch' && method === 'POST') {
      const result = await congestion.fetchFromCargoAct();
      return sendJson(res, 200, { ...result, congestion: congestion.list() });
    }
  }

  if (head === 'mail') {
    if (rest[0] === 'test' && method === 'POST') {
      return sendJson(res, 200, await mail.testConnection());
    }
    if (rest[0] === 'detect' && method === 'POST') {
      return sendJson(res, 200, await mail.detect());
    }
    if (rest[0] === 'smtp-check' && method === 'POST') {
      return sendJson(res, 200, await mail.smtpCheck());
    }
    if (rest[0] === 'smtp-send' && method === 'POST') {
      return sendJson(res, 200, await mail.sendTestMail());
    }
    if (rest[0] === 'messages' && method === 'GET' && !rest[1]) {
      const { q, limit, offset } = pageParams(url);
      const all = mail.listMessages();
      const keyword = q.toLowerCase();
      const filtered = keyword
        ? all.filter((message) => `${message.subject} ${message.from}`.toLowerCase().includes(keyword))
        : all;
      return sendJson(res, 200, {
        messages: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
      });
    }
    if (rest[0] === 'messages' && rest[1] && method === 'GET') {
      const message = mail.findMessage(rest[1]);
      if (!message) throw new HttpError(404, '邮件不存在');
      return sendJson(res, 200, { message, body: mail.readBody(rest[1]) });
    }
    // 流式拉取:每入库一封就推一行 NDJSON,界面可以「拉一封显示一封」。
    if (rest[0] === 'fetch' && rest[1] === 'stream' && method === 'POST') {
      return streamMailFetch(req, res, { mail, db, schedule });
    }
    if (rest[0] === 'fetch' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const result = await mail.fetchRecent({ limit: body.limit });
      // 附件能认出船东的,顺手收进版本库并与上一版对比。
      const ingested = await ingestMailAttachments({
        db,
        schedule,
        // 只处理这一轮新入库的邮件:历史附件已经识别过,重复读盘/重复对比没有意义。
        messages: result.newMessages ?? result.messages ?? [],
        readAttachment: (uid, id) => mail.readAttachment(uid, id).data,
      });
      return sendJson(res, 200, { ...result, ingested, runs: schedule.listRuns({ limit: 20 }).items });
    }
    if (rest[0] === 'attachments' && rest[1] && rest[2] && method === 'GET') {
      const { attachment, data } = mail.readAttachment(rest[1], rest[2]);
      return sendDownload(res, data, attachment.filename, attachment.contentType || contentTypeFor(attachment.filename));
    }
  }

  notFound(res);
}

/**
 * 邮件索引 + 船东配置 + 已有对比记录 → 船期对比任务行。
 *
 * 同名附件(如 PANDA 每天都是 rasp.pdf)不能只按文件名认结果,这里读两边文件算哈希,
 * 只有内容一致才算「这条配对已经有结果」。
 */
function schedulePairs({ mail, db, schedule }) {
  const runs = db.listRuns({ kind: 'schedule', limit: 500 }).items;
  const hashCache = new Map();
  const sha1 = (data) => createHash('sha1').update(data).digest('hex');
  const attachmentHash = (ref) => {
    try {
      return sha1(mail.readAttachment(ref.uid, ref.attachmentId).data);
    } catch {
      return '';
    }
  };
  const hashOf = (run) => {
    if (hashCache.has(run.id)) return hashCache.get(run.id);
    let value = { old: '', new: '' };
    try {
      const dir = schedule.runDir(run.id);
      const files = fs.readdirSync(dir);
      const oldFile = files.find((name) => name.startsWith('old-'));
      const newFile = files.find((name) => name.startsWith('new-'));
      value = {
        old: oldFile ? sha1(fs.readFileSync(path.join(dir, oldFile))) : '',
        new: newFile ? sha1(fs.readFileSync(path.join(dir, newFile))) : '',
      };
    } catch {
      // 目录/文件被清理过的老记录:留空,走文件名 + 日期兜底。
    }
    hashCache.set(run.id, value);
    return value;
  };
  return buildSchedulePairs({
    messages: mail.listMessages(),
    carriers: db.listCarriers(),
    runs,
    matchRun: (row) =>
      matchRunForPair(row, runs, {
        oldHash: attachmentHash(row.old),
        newHash: attachmentHash(row.new),
        hashOf,
      }),
  });
}


/** NDJSON 流式拉邮件:message → result → ingested(逐条)→ done。 */
async function streamMailFetch(req, res, { mail, db, schedule }) {
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  const write = (event) => {
    try {
      res.write(`${JSON.stringify(event)}\n`);
    } catch {
      // 客户端断开就停止写,不抛
    }
  };
  try {
    write({ type: 'start', at: Date.now() });
    const result = await mail.fetchRecent({
      limit: body.limit,
      // 逐封回调:前端收到就插一行。
      onMessage: (message) => write({ type: 'message', message }),
    });
    write({
      type: 'result',
      fetched: result.fetched,
      scanned: result.scanned,
      skipped: result.skipped,
      endpoint: result.endpoint,
      timings: result.timings,
    });
    for (const message of result.newMessages ?? []) {
      let items = [];
      try {
        items = await ingestMailAttachments({
          db,
          schedule,
          messages: [message],
          readAttachment: (uid, id) => mail.readAttachment(uid, id).data,
        });
      } catch (error) {
        write({ type: 'warn', message: `${message.subject}: ${error.message}` });
      }
      for (const item of items) write({ type: 'ingested', item });
    }
    write({ type: 'done', fetched: result.fetched, timings: result.timings });
  } catch (error) {
    write({ type: 'error', error: error.message, status: error.status ?? 502 });
  } finally {
    res.end();
  }
}

async function readMultipart(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) throw new HttpError(415, '请用 multipart/form-data 上传');
  const body = await readBody(req);
  return parseMultipart(body, contentType);
}

const DOWNLOAD_TYPES = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.eml': 'message/rfc822',
};

/** 按扩展名给出下载用的 content-type;未知类型退回二进制流。 */
export function contentTypeFor(filename, fallback = 'application/octet-stream') {
  const match = /\.[A-Za-z0-9]+$/.exec(String(filename ?? ''));
  if (!match) return fallback;
  return DOWNLOAD_TYPES[match[0].toLowerCase()] ?? fallback;
}

function sendDownload(res, buffer, filename, contentType = '') {
  res.writeHead(200, {
    // 之前固定写 xlsx,下载 pdf/png 时类型是错的,浏览器会打不开。
    'content-type': contentType || contentTypeFor(filename),
    'content-length': buffer.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}
