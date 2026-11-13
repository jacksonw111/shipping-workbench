import { HttpError } from '../util/http-util.js';

const SEARCH_PAGE = 'https://weixin.sogou.com/weixin';
const REQUEST_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** Sogou 风控:串行 + 最小间隔 + 冷却,避免账号被 antispider。 */
export class SogouGateway {
  constructor({ fetchImpl = fetch, sleep = defaultSleep, minIntervalMs = 1200, timeoutMs = 20_000 } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
    this.lastRequestAt = 0;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
  }

  /** Run one request at a time, at least `minIntervalMs` apart. */
  #serial(work) {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      return work();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async #get(url, referer = 'https://weixin.sogou.com/') {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#getOnce(url, referer);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof HttpError ? error.status >= 500 : /fetch failed|ECONNRESET|ETIMEDOUT/i.test(error.message);
        if (!retryable || error.status === 429) throw error;
        await this.sleep(1500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async #getOnce(url, referer) {
    if (Date.now() < this.blockedUntil) {
      const wait = Math.ceil((this.blockedUntil - Date.now()) / 1000);
      throw new HttpError(429, `搜狗检索冷却中,${wait} 秒后再试`);
    }
    const cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        headers: {
          'user-agent': REQUEST_UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          accept: 'text/html,application/xhtml+xml',
          referer,
          ...(cookie ? { cookie } : {}),
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      const location = response.headers.get('location') ?? '';
      if (response.status === 302 || location.includes('antispider')) {
        this.blockedUntil = Date.now() + 60_000;
        throw new HttpError(429, '搜狗风控拦截,60 秒后重试');
      }
      if (!response.ok) throw new HttpError(502, `搜狗返回 ${response.status}`);
      return await response.text();
    } catch (error) {
      if (error.name === 'AbortError') throw new HttpError(504, '搜狗请求超时');
      if (/fetch failed/i.test(error.message)) {
        throw new HttpError(502, `搜狗请求中断(${error.cause?.code ?? 'network'})`, { retryable: true });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Search articles by keyword; returns the Sogou redirect links. */
  async searchArticleLinks(keyword, { limit = 20, pages = 1 } = {}) {
    const links = [];
    for (let page = 1; page <= pages; page += 1) {
      const url = `${SEARCH_PAGE}?type=2&query=${encodeURIComponent(keyword)}&page=${page}`;
      const html = await this.#serial(() => this.#get(url));
      const found = [...html.matchAll(/href="(\/link\?url=[^"]+)"/g)].map((match) =>
        `https://weixin.sogou.com${match[1].replaceAll('&amp;', '&')}`,
      );
      for (const link of found) {
        if (links.length >= limit) return links;
        if (!links.includes(link)) links.push(link);
      }
      if (found.length === 0) break;
    }
    return links;
  }

  /** Follow the Sogou redirect page and rebuild the real mp.weixin.qq.com URL. */
  async resolveArticleUrl(link) {
    const html = await this.#serial(() => this.#get(link));
    const parts = [...html.matchAll(/url \+= '([^']*)'/g)].map((match) => match[1]);
    const url = parts.join('').replaceAll('@', '').replaceAll('\n', '');
    if (!url) throw new HttpError(502, '搜狗跳转页解析失败(可能被风控)');
    return url;
  }

  /** Fetch one article page (shared throttle). */
  async fetchArticle(url) {
    return this.#serial(() => this.#get(url, 'https://weixin.sogou.com/'));
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractBiz(html) {
  return /var\s+biz\s*=\s*["']([^"']+)["']/.exec(html ?? '')?.[1] ?? '';
}

export function extractNickname(html) {
  return (
    /var\s+nickname\s*=\s*["']([^"']*)["']/.exec(html ?? '')?.[1] ??
    /var\s+user_name\s*=\s*["']([^"']*)["']/.exec(html ?? '')?.[1] ??
    ''
  );
}

/** Find 合集 ids referenced by an article page (newest/large album first). */
export function extractAlbumIds(html) {
  const counts = new Map();
  for (const match of String(html ?? '').matchAll(/album_id=(\d{6,})/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
