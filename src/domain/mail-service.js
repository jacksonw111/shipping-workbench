import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { readJson, appendJsonl } from '../util/json-store.js';
import { ensureDir, slugify } from '../util/paths.js';
import { HttpError } from '../util/http-util.js';
import { ImapClient } from './imap.js';
import { SmtpClient, checkSmtp } from './smtp.js';
import { parseMime, parseHeaders, splitHeaderBody, decodeWords } from './mime.js';
import { sanitizeHtml } from './wechat.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 已知邮件托管商的 IMAP 端点(按 MX 记录识别)。企业邮常见是「网页在 mail.域名,IMAP 在服务商」。 */
const PROVIDERS = [
  {
    name: '腾讯企业邮',
    match: (exchange) => /mxbiz\d*\.qq\.com$/i.test(exchange),
    endpoints: [
      { host: 'imap.exmail.qq.com', port: 993, secure: true, label: '腾讯企业邮 IMAP' },
      { host: 'imap.exmail.qq.com', port: 143, secure: false, label: '腾讯企业邮 IMAP+STARTTLS' },
    ],
  },
  {
    name: '腾讯企业邮(旧域名)',
    match: (exchange) => /mxmail\.qq\.com$/i.test(exchange),
    endpoints: [{ host: 'imap.exmail.qq.com', port: 993, secure: true, label: '腾讯企业邮 IMAP' }],
  },
];

function imapDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

/** 邮箱读取:自动识别服务商端点、IMAP / STARTTLS、附件提取。 */
export class MailService {
  constructor(home, settings) {
    this.home = home;
    this.settings = settings;
    this.dir = ensureDir(path.join(home, 'mail'));
    this.indexFile = path.join(this.dir, 'messages.json');
    this.attachDir = ensureDir(path.join(this.dir, 'attachments'));
  }

  config() {
    return this.settings.read().mail;
  }

  /** 当前配置 + 按 MX 推断的服务商端点(配置优先)。 */
  async endpointCandidates() {
    const config = this.config();
    const domain = String(config.user ?? '').split('@')[1]?.toLowerCase() ?? '';
    const candidates = [];
    const add = (endpoint) => {
      if (!endpoint.host) return;
      const key = `${endpoint.host}:${endpoint.port}:${endpoint.secure ? 'tls' : 'plain'}`;
      if (candidates.some((item) => `${item.host}:${item.port}:${item.secure ? 'tls' : 'plain'}` === key)) return;
      candidates.push({ ...endpoint, port: Number(endpoint.port) || 993, secure: endpoint.secure !== false });
    };
    add({ host: config.host, port: config.port, secure: config.secure, label: '当前配置' });
    if (domain) {
      try {
        const records = await dns.resolveMx(domain);
        for (const provider of PROVIDERS) {
          if (records.some((record) => provider.match(record.exchange))) {
            for (const endpoint of provider.endpoints) add({ ...endpoint, label: `${endpoint.label}(${provider.name})` });
          }
        }
      } catch {
        // 域名解析不出来就只用通用候选
      }
      add({ host: `imap.${domain}`, port: 993, secure: true, label: `imap.${domain}` });
      add({ host: `mail.${domain}`, port: 993, secure: true, label: `mail.${domain}` });
    }
    return candidates;
  }

  /** Probe one endpoint: connect + read greeting, no login. */
  async probe(endpoint, timeoutMs = 8000) {
    const client = new ImapClient({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      user: '',
      password: '',
      timeoutMs,
    });
    try {
      const greeting = await client.connect();
      client.socket?.destroy();
      return { ...endpoint, ok: true, banner: String(greeting).slice(0, 120) };
    } catch (error) {
      client.socket?.destroy();
      return { ...endpoint, ok: false, error: readableEndpointError(error, endpoint) };
    }
  }

  /** Probe every candidate so the UI can show what this mailbox actually speaks. */
  async detect() {
    const candidates = await this.endpointCandidates();
    const results = [];
    for (const endpoint of candidates) {
      results.push(await this.probe(endpoint));
    }
    return { results, recommended: results.find((item) => item.ok) ?? null };
  }

  /**
   * Connect through the first endpoint that answers, and remember it when it
   * differs from the saved settings (企业邮网页域名 ≠ IMAP 域名)。
   */
  async connectClient() {
    const candidates = await this.endpointCandidates();
    const config = this.config();
    const errors = [];
    for (const endpoint of candidates) {
      const client = new ImapClient({
        host: endpoint.host,
        port: endpoint.port,
        secure: endpoint.secure,
        user: config.user,
        password: config.password,
      });
      try {
        await client.connect();
        if (endpoint.host !== config.host || Number(endpoint.port) !== Number(config.port) || endpoint.secure !== config.secure) {
          this.settings.save({ mail: { host: endpoint.host, port: endpoint.port, secure: endpoint.secure } });
        }
        return { client, endpoint };
      } catch (error) {
        client.socket?.destroy();
        errors.push(`${endpoint.host}:${endpoint.port} → ${readableEndpointError(error, endpoint)}`);
      }
    }
    throw new HttpError(502, `连不上任何邮件服务器:${errors.join(';')}`, {
      hint: '企业邮箱常见是「网页在 mail.域名,收信在服务商」;点「自动探测」找可用端点',
    });
  }

  async testConnection() {
    const { client, endpoint } = await this.connectClient();
    try {
      await this.login(client);
      const selection = await client.select(this.config().folder || 'INBOX');
      const exists = selection.lines.find((item) => /^\* \d+ EXISTS/.test(item.line))?.line ?? '';
      await client.logout();
      return { ok: true, endpoint, mailbox: this.config().folder || 'INBOX', exists };
    } catch (error) {
      client.socket?.destroy();
      throw error instanceof HttpError ? error : readableLoginError(error);
    }
  }

  async login(client) {
    try {
      await client.login();
      return true;
    } catch (error) {
      throw readableLoginError(error);
    }
  }

  /** SMTP 端点:配置优先,再补服务商默认。SMTP 只用来验证凭据/发测试信,不收信。 */
  smtpEndpoints() {
    const config = this.config();
    const domain = String(config.user ?? '').split('@')[1]?.toLowerCase() ?? '';
    const endpoints = [];
    const add = (endpoint) => {
      if (!endpoint.host) return;
      const key = `${endpoint.host}:${endpoint.port}`;
      if (endpoints.some((item) => `${item.host}:${item.port}` === key)) return;
      endpoints.push({ ...endpoint, port: Number(endpoint.port) || 465, secure: endpoint.secure !== false });
    };
    add({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, label: '当前配置' });
    if (domain) add({ host: `smtp.${domain}`, port: 465, secure: true, label: `smtp.${domain}` });
    add({ host: 'smtp.exmail.qq.com', port: 465, secure: true, label: '腾讯企业邮 SMTP' });
    add({ host: 'smtp.exmail.qq.com', port: 587, secure: false, label: '腾讯企业邮 SMTP+STARTTLS' });
    return endpoints;
  }

  /** 逐个试 SMTP:能区分「密码不对」和「只是 IMAP 没开」。 */
  async smtpCheck() {
    const config = this.config();
    const results = [];
    for (const endpoint of this.smtpEndpoints()) {
      results.push(
        await checkSmtp({
          host: endpoint.host,
          port: endpoint.port,
          secure: endpoint.secure,
          user: config.user,
          password: config.password,
        }),
      );
      // 能连上就算找到服务;认证失败说明是密码问题,不必再换端口。
      if (results.at(-1).auth || results.at(-1).stage === 'auth') break;
    }
    const good = results.find((item) => item.auth) ?? null;
    return {
      results: results.map((item) => ({
        host: item.endpoint.host,
        port: item.endpoint.port,
        secure: item.endpoint.secure,
        ok: item.auth,
        banner: item.banner,
        error: item.error,
        raw: item.raw ?? '',
      })),
      authenticated: Boolean(good),
      hint: good
        ? 'SMTP 认证通过,密码没问题;IMAP 若被拒,就是邮箱里没开 IMAP 服务'
        : '服务器拒绝这对「账号 + 密码」。先做一步判断:用同一个密码登录邮箱网页版——能登进去=需要客户端专用密码;登不进去=密码本身不对',
    };
  }

  /** 发一封测试信到本邮箱:验证整条发信链路。 */
  async sendTestMail() {
    const config = this.config();
    const endpoint = this.smtpEndpoints()[0];
    const client = new SmtpClient({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      user: config.user,
      password: config.password,
    });
    try {
      await client.connect();
      await client.ehlo();
      if (!endpoint.secure) await client.startTls();
      await client.authLogin();
      await client.send({
        subject: '船期工作台 SMTP 测试',
        body: `这是一封测试邮件。\n发件人:${config.user}\n时间:${new Date().toISOString()}\n`,
      });
      client.close();
      return { ok: true, endpoint };
    } catch (error) {
      client.close();
      throw new HttpError(502, `测试邮件发送失败:${error.message}`);
    }
  }

  listMessages() {
    return readJson(this.indexFile, [])
      .filter((message) => message.uid && message.uid !== 'null')
      .sort((a, b) => b.date - a.date);
  }

  dropInvalidMessages() {
    const index = readJson(this.indexFile, []);
    const valid = index.filter((message) => message.uid && message.uid !== 'null');
    if (valid.length !== index.length) {
      fs.writeFileSync(this.indexFile, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    }
  }

  findMessage(uid) {
    return this.listMessages().find((message) => String(message.uid) === String(uid));
  }

  attachmentPath(messageUid, attachmentId) {
    return path.join(this.attachDir, slugify(messageUid), slugify(attachmentId));
  }

  async fetchRecent({ limit } = {}) {
    const config = this.config();
    const cap = Math.max(1, Math.min(200, Number(limit) || config.maxMessages || 40));
    const since = new Date(Date.now() - (Number(config.lookbackDays) || 30) * 86400_000);
    const { client, endpoint } = await this.connectClient();
    try {
      await this.login(client);
      await client.select(config.folder || 'INBOX');
      const uids = await client.uidSearch(`SINCE ${imapDate(since)}`);
      const wanted = uids.slice(-cap);
      const messages = await client.uidFetch(wanted);
      const stored = [];
      for (const message of messages) {
        const record = this.storeMessage(message.raw, message.uid);
        if (record) stored.push(record);
      }
      // 早期版本可能写进过 uid 为空的记录,一次清掉。
      this.dropInvalidMessages();
      await client.logout();
      return { fetched: stored.length, endpoint, messages: this.listMessages().slice(0, cap) };
    } catch (error) {
      client.socket?.destroy();
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `抓取邮件失败:${error.message}`);
    }
  }

  storeMessage(raw, uid) {
    if (uid === null || uid === undefined || uid === '') return null;
    const parsed = parseMime(raw);
    const headerText = splitHeaderBody(raw).header;
    const headers = parseHeaders(headerText);
    const subject = decodeWords(headers.subject ?? '(无主题)');
    const from = decodeWords(headers.from ?? '');
    const date = headers.date ? new Date(headers.date).getTime() || Date.now() : Date.now();
    const messageKey = `${uid}`;
    const dir = ensureDir(path.join(this.attachDir, slugify(messageKey)));
    const attachments = [];
    for (const [index, attachment] of parsed.attachments.entries()) {
      const safeName = `${String(index + 1).padStart(2, '0')}-${slugify(attachment.filename)}`;
      const file = path.join(dir, safeName);
      fs.writeFileSync(file, attachment.data);
      attachments.push({
        id: safeName,
        filename: attachment.filename,
        contentType: attachment.contentType,
        contentId: attachment.contentId ?? '',
        size: attachment.data.length,
        path: file,
      });
    }
    // 正文单独存一份:列表只放摘要,点开才读正文。
    const bodyDir = ensureDir(path.join(this.dir, 'bodies'));
    const htmlBody = parsed.html || '';
    const textBody = (parsed.text || '').trim();
    const bodyFile = path.join(bodyDir, `${slugify(messageKey)}.json`);
    fs.writeFileSync(
      bodyFile,
      JSON.stringify({ html: rewriteInlineImages(htmlBody, uid, attachments), text: textBody }),
      { mode: 0o600 },
    );
    const record = {
      uid: String(uid),
      subject,
      from,
      date,
      receivedAt: new Date(date).toISOString(),
      attachments,
      textPreview: textBody.replace(/\s+/g, ' ').trim().slice(0, 400),
      hasBody: Boolean(htmlBody || textBody),
      fetchedAt: new Date().toISOString(),
    };
    const index = readJson(this.indexFile, []).filter((message) => String(message.uid) !== String(uid));
    index.push(record);
    fs.writeFileSync(this.indexFile, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    return record;
  }

  /** Full body for the detail view (already sanitized, inline images rewritten). */
  readBody(uid) {
    const file = path.join(this.dir, 'bodies', `${slugify(String(uid))}.json`);
    const body = readJson(file, null);
    if (body) return body;
    const message = this.findMessage(uid);
    return {
      html: '',
      text: message?.textPreview ?? '',
    };
  }

  /** Attachment bytes for download / import into a comparison run. */
  readAttachment(uid, attachmentId) {
    const message = this.findMessage(uid);
    const attachment = message?.attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new HttpError(404, '附件不存在');
    return { attachment, data: fs.readFileSync(attachment.path) };
  }

  log(value) {
    appendJsonl(path.join(this.dir, 'log.jsonl'), { at: new Date().toISOString(), ...value });
  }
}

/**
 * 邮件正文只取 <body> 内容,并丢掉 <style>/<link>:
 * 直接嵌进工作台时,邮件自带的样式会把整页字体/布局带跑。
 */
function cleanBodyHtml(html) {
  if (!html) return '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return sanitizeHtml(
    body
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      .replace(/<\/?html[^>]*>/gi, '')
      .replace(/<\/?head[^>]*>/gi, '')
      .replace(/<\/?body[^>]*>/gi, ''),
  );
}

/** `cid:xxx` → 本地附件地址,让正文里的内嵌图能显示。 */
function rewriteInlineImages(html, uid, attachments) {
  if (!html) return '';
  const safe = cleanBodyHtml(html);
  return safe.replace(/src=(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const found = attachments.find((item) => item.contentId && item.contentId === cid.replace(/[<>]/g, ''));
    if (!found) return match;
    return `src=${quote}/shipping-workbench/api/mail/attachments/${encodeURIComponent(String(uid))}/${encodeURIComponent(found.id)}${quote}`;
  });
}

function readableEndpointError(error, endpoint) {
  const message = String(error?.message ?? error);
  if (/TLS|ssl|secure|eof|handshake/i.test(message)) {
    return `${endpoint.host}:${endpoint.port} 不是 IMAP 服务(TLS 握手失败)`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return `${endpoint.host} 解析不到`;
  if (/ECONNREFUSED/i.test(message)) return `${endpoint.host}:${endpoint.port} 拒绝连接`;
  if (/超时|ETIMEDOUT/i.test(message)) return `${endpoint.host}:${endpoint.port} 连接超时`;
  return message;
}

function readableLoginError(error) {
  const message = String(error?.message ?? error);
  const serverLine = /Login fail[^\n]*|AUTHENTICATIONFAILED[^\n]*|LOGIN failed[^\n]*/i.exec(message)?.[0] ?? '';
  if (/AUTHENTICATIONFAILED|LOGIN failed|Login fail|authentication|密码|password/i.test(message)) {
    return new HttpError(401, '服务器拒绝登录(账号 + 密码)', {
      hint: '先在邮箱网页版用同一密码登录:能登进去 = 客户端登录被限制/需要专用密码;登不进去 = 密码不对',
      server: serverLine.slice(0, 200),
    });
  }
  if (/IMAP .* failed/i.test(message)) return new HttpError(502, message);
  return new HttpError(502, `邮件登录失败:${message}`);
}
