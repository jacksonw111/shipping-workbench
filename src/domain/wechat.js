import { HttpError } from '../util/http-util.js';

const ALBUM_ENDPOINT = 'https://mp.weixin.qq.com/mp/appmsgalbum';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44 NetType/WIFI Language/zh_CN';

export const BLOCK_PATTERNS = ['环境异常', '验证码', '请在微信客户端打开链接', '访问过于频繁', '该内容已被发布者删除'];

export function looksBlocked(html) {
  if (!html) return true;
  return BLOCK_PATTERNS.some((pattern) => html.includes(pattern));
}

/** Extract `album_id` / `__biz` from a pasted album URL, if any. */
export function parseAlbumUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      biz: parsed.searchParams.get('__biz') ?? '',
      albumId: parsed.searchParams.get('album_id') ?? '',
    };
  } catch {
    return { biz: '', albumId: '' };
  }
}

export async function fetchAlbumPage({ biz, albumId, beginMsgId = '', beginItemIdx = '', count = 20 }) {
  const url = new URL(ALBUM_ENDPOINT);
  url.searchParams.set('action', 'getalbum');
  url.searchParams.set('__biz', biz);
  url.searchParams.set('album_id', albumId);
  url.searchParams.set('f', 'json');
  url.searchParams.set('count', String(count));
  url.searchParams.set('begin_msgid', beginMsgId);
  url.searchParams.set('begin_itemidx', beginItemIdx);
  const response = await fetch(url, {
    headers: {
      'user-agent': MOBILE_UA,
      referer: 'https://mp.weixin.qq.com/',
      accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) throw new HttpError(502, `公众号合集接口返回 ${response.status}`);
  const text = await response.text();
  if (looksBlocked(text)) throw new HttpError(429, '公众号合集接口命中微信风控');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(502, '公众号合集接口返回的不是 JSON(可能被风控)');
  }
  const body = payload?.getalbum_resp ?? {};
  const list = Array.isArray(body.article_list) ? body.article_list : [];
  return {
    articles: list.map(normalizeAlbumItem),
    continueFlag: String(body.continue_flag ?? '0') === '1' && list.length > 0,
  };
}

function normalizeAlbumItem(item) {
  const msgid = String(item.msgid ?? '');
  const itemidx = String(item.itemidx ?? '1');
  const url = String(item.url ?? '').replaceAll('&amp;', '&');
  return {
    key: `${msgid}-${itemidx}`,
    msgid,
    itemidx,
    title: String(item.title ?? '').trim(),
    url: url.startsWith('http') ? url : `https://mp.weixin.qq.com/s?__biz=&mid=${msgid}&idx=${itemidx}`,
    publishedAt: Number(item.create_time ?? item.update_time ?? 0) * 1000,
    cover: item.cover_img_1_1 ?? item.cover ?? '',
  };
}

/** Fetch and parse one article page. */
export async function fetchArticle(url, { intervalMs = 1200 } = {}) {
  if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const response = await fetch(url, {
    headers: {
      'user-agent': MOBILE_UA,
      referer: 'https://mp.weixin.qq.com/',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new HttpError(502, `文章页返回 ${response.status}`);
  const html = await response.text();
  if (looksBlocked(html)) throw new HttpError(429, '文章页命中微信风控(环境异常/验证码)');
  return parseArticleHtml(html, url);
}

export function parseArticleHtml(html, url) {
  const title =
    matchMeta(html, 'og:title') ||
    matchVar(html, 'msg_title') ||
    matchTag(html, 'title') ||
    '未命名文章';
  const account = matchVar(html, 'nickname') || matchVar(html, 'user_name') || '';
  const publishedAt = parsePublishTime(html);
  const cover = matchMeta(html, 'og:image');
  const contentHtml = extractElementById(html, 'js_content') || '';
  const text = stripTags(contentHtml).replace(/\s+/g, ' ').trim();
  return {
    title: decodeEntities(title).trim(),
    account: decodeEntities(account),
    publishedAt,
    cover,
    url,
    html: sanitizeHtml(contentHtml),
    summary: text.slice(0, 140),
    wordCount: text.length,
  };
}

function parsePublishTime(html) {
  const ct = matchVar(html, 'ct') || matchVar(html, 'create_time');
  const seconds = Number(ct);
  if (Number.isFinite(seconds) && seconds > 1_000_000_000) return seconds * 1000;
  const dateText = matchVar(html, 'publish_time') || matchVar(html, 'createTime');
  if (dateText) {
    const parsed = new Date(dateText.replaceAll('-', '/'));
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  return Date.now();
}

function matchMeta(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
  return pattern.exec(html)?.[1] ?? '';
}

function matchVar(html, name) {
  const pattern = new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']*)["']`);
  return pattern.exec(html)?.[1] ?? '';
}

function matchTag(html, tag) {
  return new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(html)?.[1] ?? '';
}

/** Extract the inner HTML of `<div id="...">` using depth counting. */
export function extractElementById(html, id) {
  const open = new RegExp(`<div[^>]*id=["']${id}["'][^>]*>`, 'i').exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const tagPattern = /<div\b[^>]*>|<\/div>/gi;
  tagPattern.lastIndex = start;
  let depth = 1;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

/** Remove scripts, inline event handlers and javascript: URLs from article HTML. */
export function sanitizeHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

export function stripTags(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
