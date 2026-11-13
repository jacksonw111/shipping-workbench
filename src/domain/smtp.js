import tls from 'node:tls';
import net from 'node:net';

/**
 * Minimal SMTP client: EHLO → (STARTTLS) → AUTH LOGIN → optional send.
 * Used to tell "密码不对" apart from "IMAP 服务没开" — SMTP 不能收信,但能验证凭据。
 */
export class SmtpClient {
  constructor({ host, port = 465, secure = true, user, password, timeoutMs = 15_000 }) {
    this.options = { host, port, secure, user, password, timeoutMs };
    this.socket = null;
    this.buffer = '';
    this.waiters = [];
    this.banner = '';
  }

  connect() {
    const { host, port, secure, timeoutMs } = this.options;
    if (!host) return Promise.reject(new Error('未配置 SMTP 服务器'));
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
      this.socket = socket;
      socket.setTimeout(timeoutMs);
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('timeout', () => fail(new Error(`连接 ${host}:${port} 超时`)));
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.removeListener('error', fail);
        socket.setTimeout(0);
        this.attach(socket);
        this.read().then((response) => {
          this.banner = response.text;
          if (response.code !== 220) reject(new Error(`SMTP 问候异常:${response.text}`));
          else resolve(response.text);
        }, reject);
      });
    });
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('SMTP 连接已断开')));
  }

  drain() {
    while (this.waiters.length > 0) {
      const lines = [];
      let rest = this.buffer;
      let consumed = 0;
      let complete = false;
      while (true) {
        const index = rest.indexOf('\r\n');
        if (index < 0) break;
        const line = rest.slice(0, index);
        lines.push(line);
        consumed += index + 2;
        rest = rest.slice(index + 2);
        if (/^\d{3} /.test(line)) {
          complete = true;
          break;
        }
      }
      if (!complete) return;
      this.buffer = this.buffer.slice(consumed);
      const text = lines.join('\n');
      const code = Number(/^(\d{3})/.exec(lines.at(-1))[1]);
      const waiter = this.waiters.shift();
      waiter.resolve({ code, text, lines });
    }
  }

  read(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.socket?.destroy();
        reject(new Error('SMTP 响应超时'));
      }, timeoutMs);
      timer.unref?.();
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  failAll(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async command(text) {
    this.socket.write(`${text}\r\n`);
    return this.read();
  }

  async ehlo() {
    const response = await this.command('EHLO workbench.local');
    return response.text;
  }

  async startTls() {
    await this.command('STARTTLS');
    this.buffer = '';
    const upgraded = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STARTTLS 握手超时')), 10_000);
      const socket = tls.connect(
        { socket: this.socket, servername: this.options.host, rejectUnauthorized: false },
        () => {
          clearTimeout(timer);
          resolve(socket);
        },
      );
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.attach(upgraded);
    await this.ehlo();
    return true;
  }

  async authLogin() {
    const { user, password } = this.options;
    if (!user || !password) throw new Error('未配置账号或密码');
    let response = await this.command('AUTH LOGIN');
    if (response.code !== 334) throw new Error(`SMTP 不支持 AUTH LOGIN:${response.text}`);
    response = await this.command(Buffer.from(user).toString('base64'));
    if (response.code !== 334) throw new Error(`SMTP 拒绝用户名:${response.text}`);
    response = await this.command(Buffer.from(password).toString('base64'));
    if (response.code !== 235) {
      const error = new Error(`SMTP 认证失败:${response.text}`);
      error.code = 'SMTP_AUTH_FAILED';
      throw error;
    }
    return true;
  }

  async send({ from, to, subject, body, headers = {} }) {
    const envelopeFrom = from || this.options.user;
    const envelopeTo = to || this.options.user;
    await this.command(`MAIL FROM:<${envelopeFrom}>`);
    await this.command(`RCPT TO:<${envelopeTo}>`);
    await this.command('DATA');
    const message = [
      `From: <${envelopeFrom}>`,
      `To: <${envelopeTo}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      '',
      Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '.',
    ].join('\r\n');
    const response = await this.command(message);
    await this.command('QUIT').catch(() => {});
    return response;
  }

  close() {
    this.socket?.destroy();
  }
}

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Connect, EHLO, optional STARTTLS and AUTH; returns the failed step when it fails. */
export async function checkSmtp(endpoint, { timeoutMs = 12_000 } = {}) {
  const client = new SmtpClient({ ...endpoint, timeoutMs });
  const result = { endpoint, banner: '', auth: false, tls: Boolean(endpoint.secure), stage: 'connect' };
  try {
    result.banner = String(await client.connect()).slice(0, 120);
    result.stage = 'ehlo';
    await client.ehlo();
    if (!endpoint.secure) {
      result.stage = 'starttls';
      result.tls = await client.startTls().catch(() => false);
    }
    if (endpoint.user && endpoint.password) {
      result.stage = 'auth';
      await client.authLogin();
      result.auth = true;
    }
    client.close();
    return { ok: true, ...result };
  } catch (error) {
    client.close();
    return { ok: false, ...result, error: normalizeSmtpError(error), raw: String(error?.message ?? error).slice(0, 160) };
  }
}

function normalizeSmtpError(error) {
  const message = String(error?.message ?? error);
  if (/authentication failed|535/i.test(message)) {
    return 'SMTP 认证被拒(535):登录密码不能用于客户端,需要在邮箱里生成「客户端专用密码」';
  }
  if (/TLS|ssl|handshake|eof/i.test(message)) return '这不是 SMTP 服务(TLS 握手失败)';
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'SMTP 域名解析不到';
  if (/ECONNREFUSED/i.test(message)) return 'SMTP 端口拒绝连接';
  if (/超时|ETIMEDOUT/i.test(message)) return 'SMTP 连接超时';
  return message;
}
