import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../util/http-util.js';
import { fetchAlbumPage, fetchArticle, parseAlbumUrl, parseArticleHtml, looksBlocked } from './wechat.js';
import { SogouGateway, extractAlbumIds, extractBiz, extractNickname } from './sogou.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;

/** Article key shared by both channels: `mid-idx` when the page exposes them. */
export function articleKey({ mid = '', idx = '', url = '' }) {
  if (mid && idx) return `${mid}-${idx}`;
  return `u-${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;
}

/** 公众号:按名称找号、采集(合集 + 搜狗)、定时器。数据全部落在 SQLite。 */
export class WechatService {
  constructor(db, settings, gateway = new SogouGateway()) {
    this.db = db;
    this.settings = settings;
    this.gateway = gateway;
    this.timer = null;
    this.running = new Set();
  }

  listAccounts() {
    return this.db.listAccounts();
  }

  getAccount(id) {
    return this.db.getAccount(id);
  }

  /**
   * 按公众号名称找号:搜文章 → 打开正文 → 用 `var biz` 归并,
   * 顺带从正文里找它的合集 id(有就留着当补充通道)。
   */
  async lookup(name) {
    const keyword = String(name ?? '').trim();
    if (!keyword) throw new HttpError(400, '请填公众号名称');
    const settings = this.settings.read().wechat;
    const links = await this.searchByName(keyword, 12);
    if (links.length === 0) throw new HttpError(404, `没搜到「${keyword}」的文章,请确认公众号显示名`);

    const candidates = new Map();
    for (const link of links.slice(0, Math.min(links.length, settings.lookupProbeCount ?? 8))) {
      try {
        const url = await this.gateway.resolveArticleUrl(link);
        const html = await this.gateway.fetchArticle(url);
        if (looksBlocked(html)) throw new HttpError(429, '命中微信风控(环境异常/验证码)');
        const biz = extractBiz(html);
        if (!biz) continue;
        const parsed = parseArticleHtml(html, url);
        const nickname = extractNickname(html);
        const displayName = nickname && !nickname.startsWith('gh_') ? nickname : keyword;
        const entry = candidates.get(biz) ?? {
          biz,
          name: displayName || parsed.account || keyword,
          albumId: '',
          albumVotes: new Map(),
          matches: 0,
          sample: null,
        };
        entry.matches += 1;
        if (!entry.sample) {
          entry.sample = { title: parsed.title, url, publishedAt: parsed.publishedAt };
        }
        const albumId = extractAlbumIds(html)[0];
        if (albumId) entry.albumVotes.set(albumId, (entry.albumVotes.get(albumId) ?? 0) + 1);
        candidates.set(biz, entry);
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) throw error;
        // 单篇打不开就继续看下一条
      }
    }
    if (candidates.size === 0) throw new HttpError(502, '搜到了文章,但没解析出公众号标识');
    return [...candidates.values()]
      .map((entry) => ({
        biz: entry.biz,
        name: entry.name,
        albumId: [...entry.albumVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
        matches: entry.matches,
        sample: entry.sample,
      }))
      .sort((a, b) => b.matches - a.matches);
  }

  saveAccount(patch) {
    const existing = patch.id ? this.getAccount(patch.id) : null;
    const fromUrl = patch.albumUrl ? parseAlbumUrl(patch.albumUrl) : { biz: '', albumId: '' };
    if (!existing && !patch.biz && !fromUrl.biz) {
      return this.createFromLookup(patch);
    }
    const biz = String(patch.biz || fromUrl.biz || existing?.biz || '').trim();
    const albumId = String(patch.albumId || fromUrl.albumId || existing?.albumId || '').trim();
    if (!biz) throw new HttpError(400, '缺少公众号标识');
    if (!existing) {
      const duplicate = this.db.findAccountByBiz(biz);
      if (duplicate) throw new HttpError(409, `这个公众号已经登记了:${duplicate.name}`);
      return this.db.insertAccount({
        id: randomUUID(),
        name: String(patch.name ?? '').trim() || '未命名公众号',
        biz,
        albumId,
        enabled: patch.enabled !== false,
        intervalMinutes: Math.max(
          MIN_INTERVAL_MINUTES,
          Number(patch.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES,
        ),
        createdAt: new Date().toISOString(),
        lastCollectAt: null,
        lastError: null,
        lastStatus: 'idle',
        channel: albumId ? 'auto' : 'sogou',
      });
    }
    return this.db.updateAccount(existing.id, {
      name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
      biz,
      albumId,
      enabled: patch.enabled ?? existing.enabled,
      intervalMinutes: Math.max(
        MIN_INTERVAL_MINUTES,
        Number(patch.intervalMinutes ?? existing.intervalMinutes) || existing.intervalMinutes,
      ),
      channel: existing.channel,
    });
  }

  /** Create an account from just a name (or a name + one chosen candidate). */
  async createFromLookup(patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new HttpError(400, '请填公众号名称');
    const candidates = await this.lookup(name);
    const chosen =
      candidates.find((candidate) => candidate.biz === patch.biz) ??
      (candidates.length === 1 ? candidates[0] : null);
    if (!chosen) {
      throw new HttpError(409, `「${name}」搜到多个公众号,请选择`, { candidates, name });
    }
    const duplicate = this.db.findAccountByBiz(chosen.biz);
    if (duplicate) throw new HttpError(409, `这个公众号已经登记了:${duplicate.name}`);
    return this.db.insertAccount({
      id: randomUUID(),
      name: chosen.name || name,
      biz: chosen.biz,
      albumId: patch.albumId || chosen.albumId || '',
      enabled: true,
      intervalMinutes: Math.max(
        MIN_INTERVAL_MINUTES,
        Number(patch.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) || DEFAULT_INTERVAL_MINUTES,
      ),
      createdAt: new Date().toISOString(),
      lastCollectAt: null,
      lastError: null,
      lastStatus: 'idle',
      channel: patch.albumId || chosen.albumId ? 'auto' : 'sogou',
    });
  }

  removeAccount(id) {
    this.db.removeAccount(id);
  }

  listArticles(options) {
    return this.db.listArticles(options);
  }

  getArticle(accountId, key) {
    return this.db.getArticle(accountId, key);
  }

  /** Collect one account through every usable channel. */
  async collect(accountId, { onProgress = () => {} } = {}) {
    if (this.running.has(accountId)) throw new HttpError(409, '该公众号正在采集中');
    const account = this.getAccount(accountId);
    if (!account) throw new HttpError(404, '公众号不存在');
    this.running.add(accountId);
    const startedAt = Date.now();
    const settings = this.settings.read().wechat;
    const known = this.db.articleKeys(account.id);
    // 还没回填过的号不套回填窗口:否则合集里最新一篇超过 5 天就一篇都采不到。
    const firstRun = !account.backfilled;
    let added = 0;
    let attempted = 0;
    const channels = { album: 0, sogou: 0 };
    let albumAdded = 0;
    const errors = [];
    try {
      if (account.albumId) {
        attempted += 1;
        try {
          const count = await this.collectAlbum(account, settings, known, onProgress, { firstRun });
          channels.album = count;
          albumAdded = count;
          added += count;
        } catch (error) {
          if (error instanceof HttpError && error.status === 429) throw error;
          errors.push(`合集:${error.message}`);
        }
      }
      const needSogou = settings.sogouEnabled !== false && (!account.albumId || (albumAdded === 0 && !firstRun));
      if (needSogou) {
        attempted += 1;
        try {
          const count = await this.collectSogou(account, settings, known, onProgress);
          channels.sogou = count;
          added += count;
        } catch (error) {
          errors.push(`搜狗:${error.message}`);
          if (error instanceof HttpError && error.status === 429) throw error;
        }
      }
      if (attempted > 0 && errors.length === attempted) {
        throw new HttpError(502, errors.join(';'));
      }
      this.db.updateAccount(account.id, {
        lastCollectAt: new Date().toISOString(),
        lastError: errors.length ? errors.join(';') : null,
        lastStatus: added > 0 ? 'ok' : errors.length ? 'partial' : 'ok',
        // 只要这一轮没被风控打断,就算回填完成(合集翻完、该收的都收了)。
        backfilled: firstRun ? true : account.backfilled,
      });
      return { added, channels, durationMs: Date.now() - startedAt, warnings: errors };
    } catch (error) {
      this.db.updateAccount(account.id, {
        lastCollectAt: new Date().toISOString(),
        lastError: error.message,
        lastStatus: 'failed',
      });
      throw error;
    } finally {
      this.running.delete(accountId);
      onProgress({ phase: 'done', added });
    }
  }

  /** 合集通道:按合集翻页,只收回填窗口内的新文章。 */
  async collectAlbum(account, settings, known, onProgress, { firstRun = false } = {}) {
    const since = Date.now() - settings.backfillDays * 86400_000;
    const maxFirstRun = Math.max(1, Number(settings.firstRunMaxArticles) || 60);
    let added = 0;
    let beginMsgId = '';
    let beginItemIdx = '';
    let done = false;
    for (let page = 0; page < settings.maxPages && !done; page += 1) {
      const result = await fetchAlbumPage({
        biz: account.biz,
        albumId: account.albumId,
        beginMsgId,
        beginItemIdx,
      });
      if (result.articles.length === 0) break;
      for (const item of result.articles) {
        if (known.has(item.key)) continue;
        if (!firstRun && item.publishedAt < since) {
          done = true;
          break;
        }
        if (firstRun && added >= maxFirstRun) {
          done = true;
          break;
        }
        onProgress({ phase: 'article', title: item.title });
        const parsed = await fetchArticle(item.url, { intervalMs: settings.requestIntervalMs });
        this.storeArticle(account, {
          key: item.key,
          title: parsed.title || item.title,
          url: item.url,
          publishedAt: item.publishedAt || parsed.publishedAt,
          cover: item.cover || parsed.cover,
          summary: parsed.summary,
          html: parsed.html,
          wordCount: parsed.wordCount,
        });
        known.add(item.key);
        added += 1;
      }
      if (!result.continueFlag || done) break;
      const last = result.articles.at(-1);
      beginMsgId = last.msgid;
      beginItemIdx = last.itemidx;
    }
    return added;
  }

  /**
   * 搜狗通道:按号名搜文章,打开正文后用 `var biz` 过滤,只留这个号的。
   * 搜狗结果是「搜得到的」而不是完整历史,所以不受回填窗口限制。
   */
  async collectSogou(account, settings, known, onProgress) {
    const limit = Math.max(1, Number(settings.sogouMaxArticles) || 12);
    const keywords = [...new Set([account.name, account.name.replace(/\s+/g, '')])].filter(Boolean);
    let added = 0;
    for (const keyword of keywords) {
      const links = await this.searchByName(keyword, limit);
      added += await this.collectSogouLinks(account, links, known, onProgress);
      if (added > 0) break;
    }
    return added;
  }

  async collectSogouLinks(account, links, known, onProgress) {
    let added = 0;
    for (const link of links) {
      try {
        const url = await this.gateway.resolveArticleUrl(link);
        const direct = /[?&]mid=(\d+)/.exec(url);
        const directIdx = /[?&]idx=(\d+)/.exec(url);
        if (direct && directIdx) {
          const earlyKey = articleKey({ mid: direct[1], idx: directIdx[1] });
          if (known.has(earlyKey)) continue;
        }
        const html = await this.gateway.fetchArticle(url);
        if (looksBlocked(html)) throw new HttpError(429, '文章页命中微信风控');
        if (extractBiz(html) !== account.biz) continue;
        const mid = /var\s+mid\s*=\s*["'](\d+)["']/.exec(html)?.[1] ?? '';
        const idx = /var\s+idx\s*=\s*["'](\d+)["']/.exec(html)?.[1] ?? '';
        const key = articleKey({ mid, idx, url });
        if (known.has(key)) continue;
        const parsed = parseArticleHtml(html, url);
        onProgress({ phase: 'article', title: parsed.title });
        this.storeArticle(account, {
          key,
          title: parsed.title,
          url,
          publishedAt: parsed.publishedAt,
          cover: parsed.cover,
          summary: parsed.summary,
          html: parsed.html,
          wordCount: parsed.wordCount,
        });
        known.add(key);
        added += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) throw error;
        // 单篇失败不影响其它结果
      }
    }
    return added;
  }

  /** 名称带空格时(如「泓昀国际 STL」)再试一次去掉空格的搜索。 */
  async searchByName(name, limit) {
    const keyword = String(name ?? '').trim();
    let links = await this.gateway.searchArticleLinks(keyword, { limit });
    if (links.length === 0 && keyword.includes(' ')) {
      links = await this.gateway.searchArticleLinks(keyword.replace(/\s+/g, ''), { limit });
    }
    return links;
  }

  storeArticle(account, article) {
    this.db.upsertArticle({
      accountId: account.id,
      ...article,
      collectedAt: new Date().toISOString(),
    });
  }

  /** Start the background schedule (one timer, checks due accounts every minute). */
  start({ firstTickDelayMs = 15_000 } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timer.unref?.();
    const kickoff = setTimeout(() => this.tick().catch(() => {}), firstTickDelayMs);
    kickoff.unref?.();
    this.kickoff = kickoff;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.kickoff) clearTimeout(this.kickoff);
    this.timer = null;
    this.kickoff = null;
  }

  async tick() {
    const due = this.db
      .listAccounts()
      .filter((account) => account.enabled && !this.running.has(account.id))
      .filter((account) => {
        const dueAt = account.lastCollectAt
          ? new Date(account.lastCollectAt).getTime() + account.intervalMinutes * 60_000
          : 0;
        return Date.now() >= dueAt;
      })
      // 文章少的号先抓,避免新装的号一直排在后面。
      .sort((a, b) => (a.articleCount ?? 0) - (b.articleCount ?? 0));
    for (const account of due) {
      try {
        await this.collect(account.id);
      } catch (error) {
        // 命中搜狗风控时本次不再继续,冷却后下一轮再来。
        if (error instanceof HttpError && error.status === 429) break;
      }
    }
  }
}
