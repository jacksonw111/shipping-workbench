import tls from 'node:tls';
import net from 'node:net';
import { Buffer } from 'node:buffer';

const CRLF = '\r\n';

/** Minimal IMAP4rev1 client: connect, login, select, uid search/fetch, logout. */
export class ImapClient {
  constructor({ host, port = 993, secure = true, user, password, timeoutMs = 20_000 }) {
    this.options = { host, port, secure, user, password, timeoutMs };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.greeting = '';
    this.counter = 0;
    this.pending = null;
    this.closed = false;
  }

  connect() {
    const { host, port, secure, timeoutMs } = this.options;
    if (!host) return Promise.reject(new Error('未配置邮件服务器地址'));
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
      this.rawSocket = socket;
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
        this.readGreeting().then(async (greeting) => {
          if (!secure) await this.startTls().catch(() => {});
          resolve(greeting);
        }, reject);
      });
    });
  }

  /** Attach the reader to a socket (initial connect or after a STARTTLS upgrade). */
  attach(socket) {
    this.socket = socket;
    socket.on('error', (error) => this.failPending(error));
    this.onDataHandler = (chunk) => this.onData(chunk);
    socket.on('data', this.onDataHandler);
    socket.on('close', () => {
      this.closed = true;
      this.failPending(new Error('邮件连接已断开'));
    });
  }

  /** Upgrade a plaintext connection with STARTTLS, when the server offers it. */
  async startTls() {
    const { lines } = await this.command('CAPABILITY');
    const supports = lines.some((item) => /STARTTLS/i.test(item.line));
    if (!supports) return false;
    await this.command('STARTTLS');
    this.pending = null;
    this.buffer = Buffer.alloc(0);
    this.socket.removeListener('data', this.onDataHandler);
    const upgraded = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { socket: this.socket, servername: this.options.host, rejectUnauthorized: false },
        () => resolve(socket),
      );
      socket.once('error', reject);
    });
    this.attach(upgraded);
    return true;
  }

  readGreeting() {
    return new Promise((resolve, reject) => {
      this.pending = {
        onLine: (line) => {
          if (line.startsWith('* OK')) {
            this.pending = null;
            resolve(line);
            return true;
          }
          if (line.startsWith('* BYE') || line.startsWith('* NO')) {
            this.pending = null;
            reject(new Error(`邮件服务器拒绝连接:${line}`));
            return true;
          }
          return false;
        },
        items: [],
      };
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  drain() {
    while (this.pending && this.buffer.length > 0) {
      const index = this.buffer.indexOf('\r\n');
      if (index < 0) return;
      const lineBuffer = this.buffer.subarray(0, index);
      const literal = /\{(\d+)\}$/.exec(lineBuffer.toString('latin1'));
      if (literal) {
        const size = Number(literal[1]);
        const start = index + 2;
        if (this.buffer.length < start + size) return;
        const data = this.buffer.subarray(start, start + size);
        this.buffer = this.buffer.subarray(start + size);
        if (this.buffer.subarray(0, 2).toString() === '\r\n') this.buffer = this.buffer.subarray(2);
        const line = lineBuffer.toString('latin1');
        const done = this.pending.onLine(line, data);
        if (done || !this.pending) return;
        continue;
      }
      const line = lineBuffer.toString('latin1');
      this.buffer = this.buffer.subarray(index + 2);
      const done = this.pending.onLine(line);
      if (done || !this.pending) return;
    }
  }

  failPending(error) {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.reject?.(error);
    }
  }

  command(name, ...args) {
    if (this.closed || !this.socket) return Promise.reject(new Error('邮件连接已关闭'));
    const tag = `A${String(++this.counter).padStart(4, '0')}`;
    return new Promise((resolve, reject) => {
      const state = {
        items: [],
        reject,
        onLine: (line, literal) => {
          if (literal) {
            state.items.push({ line, literal });
            return false;
          }
          if (line.startsWith(`${tag} `)) {
            const status = line.slice(tag.length + 1);
            this.pending = null;
            if (/^OK/i.test(status)) resolve({ lines: state.items, status });
            else reject(new Error(`IMAP ${name} 失败:${line}`));
            return true;
          }
          state.items.push({ line, literal: null });
          return false;
        },
      };
      this.pending = state;
      this.socket.write(`${tag} ${name}${args.length ? ` ${args.join(' ')}` : ''}${CRLF}`);
    });
  }

  async login() {
    const { user, password } = this.options;
    if (!user || !password) throw new Error('未配置邮箱账号或密码');
    const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    await this.command('LOGIN', quote(user), quote(password));
  }

  async select(folder = 'INBOX') {
    const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    return this.command('SELECT', quote(folder));
  }

  async uidSearch(criteria = 'ALL') {
    const { lines } = await this.command('UID', 'SEARCH', criteria);
    for (const { line } of lines) {
      if (/^\* SEARCH/.test(line)) {
        return line.slice(8).trim().split(/\s+/).filter(Boolean);
      }
    }
    return [];
  }

  /** Fetch full raw messages for the given UIDs. */
  async uidFetch(uids) {
    if (uids.length === 0) return [];
    const { lines } = await this.command('UID', 'FETCH', uids.join(','), '(UID BODY.PEEK[])');
    const messages = [];
    let currentUid = null;
    for (const item of lines) {
      if (item.literal) {
        // FETCH 头行和字面量是一体的:UID 就在这一行里。
        const uid = /UID (\d+)/i.exec(item.line)?.[1] ?? currentUid;
        if (uid && uid !== 'null') messages.push({ uid, raw: item.literal });
        continue;
      }
      const uidMatch = /^\* \d+ FETCH .*UID (\d+)/i.exec(item.line);
      if (uidMatch) currentUid = uidMatch[1];
    }
    return messages;
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // best effort
    }
    this.socket?.end();
    this.closed = true;
  }
}
