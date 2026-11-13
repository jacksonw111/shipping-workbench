import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../util/http-util.js';
import { readJson, writeJson } from '../util/json-store.js';
import { ensureDir } from '../util/paths.js';
import {
  HOTSPOT_SYSTEM_PROMPT,
  applyCitations,
  buildHotspotPrompt,
  buildSources,
  digestOf,
  parseHotspotReport,
} from './hotspots.js';

/** 一天最多喂多少篇素材:再多模型也读不完,还会拖长生成时间。 */
const MAX_SOURCES = 80;

/** 每天的热点看「截至当天」多长的窗口:公众号不是每天都有推送。 */
const SOURCE_WINDOW_DAYS = 7;

/** 报告文件名的日期格式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD。 */
function localDate(input = new Date()) {
  return `${input.getFullYear()}-${pad(input.getMonth() + 1)}-${pad(input.getDate())}`;
}

/** 把 YYYY-MM-DD 往前/后挪 N 天(按本地日历,避免 UTC 偏移)。 */
function shiftDate(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  const target = new Date(year, month - 1, day);
  target.setDate(target.getDate() + days);
  return localDate(target);
}

/** 路由传来的日期;空值算今天,格式不对直接 400。 */
function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return localDate();
  const date = String(value).trim();
  if (!DATE_PATTERN.test(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  return date;
}

/**
 * AI 热点追踪:每天一份热点条目列表,按日期落盘,可回看历史。
 *
 * 报告按「当天素材 + 模型」指纹缓存在磁盘:文章没变就直接复用,变了或点了重新生成才调模型。
 * 定时器每天过生成时点后自动补齐当天报告(见 startDaily)。
 */
export class HotspotService {
  constructor(db, llm, home) {
    this.db = db;
    this.llm = llm;
    this.dir = ensureDir(path.join(home, 'hotspots', 'reports'));
  }

  /** 某天的报告文件。 */
  fileFor(date) {
    return path.join(this.dir, `${date}.json`);
  }

  /** 今天的本地日期。 */
  today() {
    return localDate();
  }

  /**
   * 某天的素材:截至当天的近 7 天文章,最多 80 篇,按发布时间倒序编号。
   * 公众号不是每天都有推送,只看当天经常是空的,所以按窗口取。
   */
  sourcesFor(date) {
    const byKey = new Map();
    for (let offset = 0; offset < SOURCE_WINDOW_DAYS; offset += 1) {
      const day = shiftDate(date, -offset);
      const articles = this.db.articlesOn ? this.db.articlesOn(day) : [];
      for (const article of articles) byKey.set(article.key ?? `${article.accountId}:${article.publishedAt}`, article);
    }
    return buildSources([...byKey.values()], { limit: MAX_SOURCES });
  }

  /** 素材与模型一起决定当天的报告是否过期。 */
  fingerprint(date, sources) {
    const availability = this.llm.availability();
    return digestOf({
      date,
      sources,
      provider: availability.provider ?? '',
      model: availability.model ?? '',
    });
  }

  /** 已存的当天报告;没有就 null。 */
  stored(date) {
    return readJson(this.fileFor(date), null);
  }

  /** 历史列表:按日期倒序,只返回真的存在的报告文件。 */
  list({ limit = 30 } = {}) {
    const availability = this.llm.availability();
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      files = [];
    }
    const reports = files
      .filter((name) => name.endsWith('.json') && DATE_PATTERN.test(name.slice(0, -'.json'.length)))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(1, limit))
      .flatMap((name) => {
        const report = readJson(path.join(this.dir, name), null);
        if (!report) return [];
        return [
          {
            date: report.date ?? name.slice(0, -'.json'.length),
            title: report.title ?? '',
            itemCount: Array.isArray(report.items) ? report.items.length : 0,
            generatedAt: report.generatedAt ?? '',
            model: report.model ?? null,
          },
        ];
      });
    return {
      reports,
      today: this.today(),
      ready: Boolean(availability.available),
      reason: availability.available ? '' : (availability.reason ?? ''),
    };
  }

  /** 首屏:某天的报告 + 能不能生成 + 有多少素材 + 历史列表。 */
  view({ date } = {}) {
    const day = normalizeDate(date);
    const availability = this.llm.availability();
    return {
      date: day,
      today: this.today(),
      report: this.stored(day),
      articleCount: this.sourcesFor(day).length,
      ready: Boolean(availability.available),
      reason: availability.available ? '' : (availability.reason ?? ''),
      reports: this.list().reports,
    };
  }

  async generate({ date, refresh = false } = {}) {
    const day = normalizeDate(date);
    const availability = this.llm.availability();
    if (!availability.available) throw new HttpError(400, availability.reason);
    const sources = this.sourcesFor(day);
    if (sources.length === 0) throw new HttpError(400, '这天没有文章,先采集公众号');

    const digest = this.fingerprint(day, sources);
    const existing = this.stored(day);
    if (!refresh && existing?.digest === digest) {
      return { date: day, report: existing, articleCount: sources.length, reused: true };
    }

    const text = await this.llm.complete({
      system: HOTSPOT_SYSTEM_PROMPT,
      prompt: buildHotspotPrompt({ sources, date: day }),
      temperature: 0.4,
    });
    const parsed = parseHotspotReport(text);
    // 只有对得上素材的编号才会变成可点击来源。
    const items = applyCitations(parsed, sources);
    if (items.length === 0) throw new Error('模型没有返回热点条目');

    const report = {
      date: day,
      title: parsed.title || '今日航运热点',
      items,
      sourceCount: sources.length,
      model: { provider: availability.provider, model: availability.model },
      generatedAt: new Date().toISOString(),
      digest,
    };
    writeJson(this.fileFor(day), report);
    return { date: day, report, articleCount: sources.length, reused: false };
  }

  /**
   * 定时器用:补齐今天的热点,纯副作用不抛。
   * 模型不可用、当天没文章、报告已是最新时只返回原因,不调模型。
   */
  async ensureDaily() {
    const day = this.today();
    const availability = this.llm.availability();
    if (!availability.available) return { generated: false, reason: availability.reason ?? '没有模型' };
    const sources = this.sourcesFor(day);
    if (sources.length === 0) return { generated: false, reason: '今天还没有文章' };
    const existing = this.stored(day);
    if (existing?.digest === this.fingerprint(day, sources)) {
      return { generated: false, reason: '今天的热点已是最新' };
    }
    try {
      await this.generate({ date: day });
      return { generated: true, date: day };
    } catch (error) {
      console.warn('[shipping-workbench] 今日热点生成失败:', error.message);
      return { generated: false, reason: error.message };
    }
  }

  /**
   * 每日自动生成:每 checkIntervalMs 检查一次,本地时间过了 hour:minute 且今天的报告缺失/过期才生成。
   * 启动 20 秒后先跑一次(补上应用没开着时错过的当天报告)。返回停止函数。
   */
  startDaily({ hour = 7, minute = 0, checkIntervalMs = 10 * 60_000 } = {}) {
    const check = async () => {
      const now = new Date();
      const gate = new Date(now);
      gate.setHours(hour, minute, 0, 0);
      if (now < gate) return;
      try {
        await this.ensureDaily();
      } catch (error) {
        console.warn('[shipping-workbench] 今日热点检查失败:', error.message);
      }
    };
    const kickoff = setTimeout(() => check(), 20_000);
    kickoff.unref?.();
    const timer = setInterval(() => check(), Math.max(60_000, checkIntervalMs));
    timer.unref?.();
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }
}
