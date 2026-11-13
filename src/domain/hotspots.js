/**
 * AI 热点追踪:把某一天的公众号文章交给模型,写成**一份条目列表**(items)。
 *
 * 模型只负责写,不负责找事实:素材在这里编号,每条 item 的 sources 必须落在这些编号上,
 * 由 `applyCitations` 对账后变成可点击的来源。编号对不上的引用在界面上不会被渲染成链接。
 */

import { createHash } from 'node:crypto';

export const HOTSPOT_SYSTEM_PROMPT = [
  '你是航运资讯编辑,给货代和船司的运营同事整理今日航运热点,输出条目列表,不是一篇综述。',
  '',
  '写作要求:',
  '1. 全文只用简体中文。素材里的英文标题、正文、公司名、港口名一律翻译成中文;GRI、PSS、LNG、TEU、MSC、CMA 这类行业缩写可以保留。',
  '2. 输出 4-8 条。每条讲一件独立的事,不要重复、不要互相包含;条数不够就少写,不要凑。',
  '3. summary 用 1-2 句把事实说清;impact 用一句话说清对订舱或船期的实际影响,没有影响就写「暂无直接影响」。',
  '4. tags 从「航线」「挂港」「塞港」「运价」「政策」「船期」里选 1-4 个,不加别的词。',
  '5. 每条用 sources 标注依据,编号只能取自素材给出的编号,可以一条事实标多个来源。没有素材支撑的话不要写。',
  '6. 不要编造素材里没有的数字、日期、公司名和事件。素材没提到的就不写。',
  '',
  '只输出 JSON,不要任何其它文字:',
  '{"title":"今日航运热点","items":[{"title":"不超过 24 字","summary":"1-2 句事实","impact":"对订舱/船期的影响,一句话","tags":["航线","挂港"],"sources":[1,2]}]}',
].join('\n');

function day(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function asText(value) {
  return String(value ?? '').trim();
}

/** 取 JSON 候选:原文、去代码围栏、首个 { 到末个 } 之间、首个 [ 到末个 ] 之间。 */
function jsonCandidates(raw) {
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  const arrayStart = raw.indexOf('[');
  const arrayEnd = raw.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(raw.slice(arrayStart, arrayEnd + 1));
  return candidates;
}

/** 素材编号:按发布时间倒序,最新的排 [1]。 */
export function buildSources(articles = [], { limit = 80 } = {}) {
  return [...articles]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, Math.max(1, limit))
    .map((article, index) => ({
      n: index + 1,
      key: article.key,
      accountId: article.accountId,
      accountName: article.accountName,
      title: article.title,
      summary: article.summary ?? '',
      url: article.url ?? '',
      publishedAt: article.publishedAt,
    }));
}

/** 给模型的素材清单:一行一条,带编号、日期、公众号、标题与摘要。 */
export function buildHotspotPrompt({ sources = [], date = '' } = {}) {
  const lines = [`日期:${date || '今天'},素材范围:截至当天的近 7 天,共 ${sources.length} 篇。`, ''];
  for (const source of sources) {
    const summary = String(source.summary ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    const head = `[${source.n}] ${day(source.publishedAt)} ${source.accountName}:${source.title}`;
    lines.push(summary ? `${head}——${summary}` : head);
  }
  return lines.join('\n');
}

/** 模型给的编号:只留正整数,去重后按升序。 */
function normalizeNumbers(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const numbers = list.map((item) => Number(item)).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** 一条 item:字段按契约收成字符串/字符串数组/编号数组;标题和摘要都空的丢掉。 */
function normalizeItem(raw) {
  const item = {
    title: asText(raw?.title),
    summary: asText(raw?.summary),
    impact: asText(raw?.impact),
    tags: Array.isArray(raw?.tags) ? [...new Set(raw.tags.map(asText).filter(Boolean))] : [],
    sources: normalizeNumbers(raw?.sources),
  };
  return item.title || item.summary ? item : null;
}

/**
 * 解析模型回复。容忍代码围栏与前后多余文字;没有 JSON 或没有 items 时返回空列表,不抛。
 */
export function parseHotspotReport(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { title: '', items: [] };
  for (const candidate of jsonCandidates(raw)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 试下一个候选
    }
    const items = Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.report?.items)
          ? parsed.report.items
          : null;
    if (!items) continue;
    const normalized = items.map(normalizeItem).filter(Boolean);
    if (normalized.length === 0) continue;
    return { title: asText(parsed?.title ?? parsed?.report?.title), items: normalized };
  }
  return { title: '', items: [] };
}

/** 文本里出现的引用编号,按出现顺序去重(旧接口,保留给别的调用方)。 */
export function citedNumbers(body) {
  const seen = new Set();
  for (const match of String(body ?? '').matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 把每条 item 的 sources 编号对到素材上,只保留指向真实素材的引用,重复/越界编号去掉。
 * 返回条目数组:`{title, summary, impact, tags, sources:[{n, title, zh, accountName, url, publishedAt}]}`。
 * 新的条目格式不再要求模型逐条给中文译名,`zh` 留空,界面按 `zh || title` 显示即可。
 */
export function applyCitations(report, sources = []) {
  const byN = new Map(sources.map((source) => [source.n, source]));
  return (Array.isArray(report?.items) ? report.items : []).flatMap((item) => {
    const resolved = normalizeNumbers(item?.sources)
      .filter((n) => byN.has(n))
      .map((n) => {
        const source = byN.get(n);
        return {
          n,
          title: source.title,
          zh: '',
          accountName: source.accountName,
          url: source.url,
          publishedAt: source.publishedAt,
        };
      });
    const normalized = normalizeItem(item);
    return normalized ? [{ ...normalized, sources: resolved }] : [];
  });
}

/** 素材指纹:素材换了(或换了日期、换了模型)才需要重新生成。 */
export function digestOf({ date = '', sources = [], provider = '', model = '' } = {}) {
  const material = sources.map((source) => `${source.n}:${source.accountId}/${source.key}`).join(',');
  return createHash('sha1').update([date, provider, model, material].join('|')).digest('hex');
}
