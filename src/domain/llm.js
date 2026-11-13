import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '../util/json-store.js';
import { ensureDir } from '../util/paths.js';

export const BATCH_SYSTEM_PROMPT = [
  '你是集装箱航线的挂港计划审核员。',
  '下面给你若干条 Rotation,每条含完整挂港序列(港口、五字码、累计航程、航向、码头)与逐段天数。',
  '累计航程是自第一个港口起算的累计值,不是单段天数。',
  '塞港等泊数据会一起给到,判断时纳入考虑:目的港等泊天数要算进该航段的在途时间里。',
  '逐条判断哪些航段的天数明显不合理:结合两港地理、常规航速 12–22 节、是否绕苏伊士/巴拿马/好望角、以及同航线其它段和同类港口对的历史区间。',
  '只输出 JSON:{"results":[{"rotation":"<原样回填 Rotation ID|版本>","suspicious":[{"from":排序,"to":排序,"days":天数,"reason":"不超过 40 字","confidence":0 到 1}]}]}',
  '没有可疑段的 rotation 也要出现,给空数组。不要输出任何其它文字。',
].join('\n');

/**
 * 轨迹批量判定的 system 提示词:设置里填了自定义就用自定义,否则用内置默认。
 * 界面上的「轨迹判定提示词」显示的也是这里的结果。
 */
export function trackSystemPrompt(override) {
  const custom = String(override ?? '').trim();
  return custom || BATCH_SYSTEM_PROMPT;
}

const SYSTEM_PROMPT = [
  '你是集装箱航线的挂港计划审核员。',
  '下面给你一条 Rotation 的完整挂港序列(港口、五字码、累计航程天数、排序)以及逐段天数。',
  '累计航程是自第一个港口起算的累计值,不是单段天数。',
  '塞港等泊数据会一起给到,判断时纳入考虑:目的港等泊天数要算进该航段的在途时间里。',
  '请判断哪些航段的天数明显不合理:结合两港地理距离、常规航速 12–22 节、是否需要过苏伊士/巴拿马/绕好望角、同航线其它段的一致性。',
  '只输出 JSON:{"suspicious":[{"from":排序,"to":排序,"days":天数,"reason":"不超过 40 字","confidence":0 到 1}]}。',
  '没有可疑段就输出 {"suspicious":[]}。不要输出任何其它文字。',
].join('\n');

/**
 * Optional model pass. It uses the DeepSeek Harness model the user already
 * selected (ctx.llm + agent-default-model), so the workbench never asks for a
 * second API key.
 */
export class LlmChecker {
  constructor(home, ctx) {
    this.ctx = ctx;
    this.cacheFile = path.join(ensureDir(path.join(home, 'track')), 'llm-cache.json');
    this.cache = readJson(this.cacheFile, {});
  }

  /** Resolve a host service without assuming it was injected into this fiber. */
  service(property, name) {
    try {
      const direct = this.ctx?.[property];
      if (direct) return direct;
    } catch {
      // Not injected into this fiber; fall through to the registry lookup.
    }
    try {
      return this.ctx?.get?.(name) ?? null;
    } catch {
      return null;
    }
  }

  get llm() {
    return this.service('llm', 'llm');
  }

  get defaults() {
    return this.service('agentDefaultModel', 'agentDefaultModel');
  }

  /** The harness selection, or a readable reason why no model can be used. */
  selection() {
    const model = this.defaults?.currentSelection?.();
    if (model?.provider && model?.model) return model;
    return null;
  }

  availability() {
    if (!this.llm) return { available: false, reason: '当前 profile 没有挂载模型服务' };
    const model = this.selection();
    if (!model) return { available: false, reason: '当前会话没有默认模型(先在 DSH 里选一个模型)' };
    return { available: true, provider: model.provider, model: model.model };
  }

  buildPrompt(group, stats = new Map()) {
    const lines = [
      // 让模型知道附带的等泊天数是什么口径,否则容易把它当成额外航程忽略掉。
      '塞港数据为到港等泊天数,判断时要把等泊算进航段时间。',
      `[rotationKey: ${group.rotationId}|${group.version}]`,
      `航线 Rotation ${group.rotationId}(${group.rotationName || '未命名'} · 版本:${group.version}),共 ${group.rows.length} 个挂港:`,
    ];
    for (const row of group.rows) {
      lines.push(
        `  排序${row.order} | ${row.portEn}(${row.portCode}) | 累计天数 ${row.cumDays} | 航向 ${row.direction || '-'} | 码头 ${row.terminal || '-'}`,
      );
    }
    lines.push('待判断的航段:');
    for (const segment of group.segments) {
      const tag = segment.closure ? '(闭环段)' : '';
      let line = `  排序${segment.fromOrder} ${segment.fromPort} -> 排序${segment.toOrder} ${segment.toPort}:${segment.days} 天${tag}`;
      const history = stats.get(`${segment.fromCode}|${segment.toCode}`);
      if (history) {
        line += `(同类港口对历史 ${history.count} 次:中位数 ${history.median} 天,范围 ${history.min}-${history.max})`;
      }
      const congestion = segment.congestion;
      const waiting = Number(congestion?.waitingDays);
      if (Number.isFinite(waiting) && waiting > 0) {
        line += `; 目的港等泊 ${waiting} 天(等级:${congestion.level || '未知'})`;
      }
      lines.push(line);
    }
    lines.push('判断时优先看「本航线其他段」和「同类港口对历史」是否一致;没有先例的段再按两港地理与绕行情况估算。');
    return lines.join('\n');
  }

  /**
   * 批量判定。
   *
   * 调用次数由「字符预算」决定,不是固定几条一组:把候选航段按 ~charBudget 字符拼成一次请求,
   * 再用 maxCalls 兜底。这样 1.4k 组全量只需要个位数到十几次请求,而不是几百次。
   *
   * @returns `{ result, checked, total, truncated, suspicious, calls, requests, cached }`
   */
  async check(
    groups,
    {
      maxGroups = 0,
      concurrency = 4,
      charBudget = 20000,
      maxCalls = 20,
      promptOverride = '',
      onProgress = () => {},
    } = {},
  ) {
    const availability = this.availability();
    if (!availability.available) return { skipped: true, reason: availability.reason };
    const selection = this.selection();
    const system = trackSystemPrompt(promptOverride);
    const candidates = groups.filter((group) => !group.skipped);
    const targets = maxGroups > 0 ? candidates.slice(0, maxGroups) : candidates;
    if (targets.length === 0) return { skipped: true, reason: '没有可判定的轨迹组' };
    const stats = collectPairStats(groups);

    // 按字符预算打包:一个组一条 prompt,攒到预算就发一次。
    const budget = Math.max(2000, Number(charBudget) || 20000);
    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const group of targets) {
      const prompt = this.buildPrompt(group, stats);
      if (current.length > 0 && currentChars + prompt.length > budget) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push({ group, prompt });
      currentChars += prompt.length + 8;
    }
    if (current.length > 0) batches.push(current);

    const limit = Number(maxCalls) > 0 ? Math.min(batches.length, Number(maxCalls)) : batches.length;
    const used = batches.slice(0, limit);
    const covered = used.reduce((sum, batch) => sum + batch.length, 0);

    const result = new Map();
    const state = { cursor: 0, failure: null, requests: 0, cached: 0 };
    const worker = async () => {
      while (state.cursor < used.length && !state.failure) {
        const batch = used[state.cursor];
        state.cursor += 1;
        const prompt = batch.map((item) => item.prompt).join('\n\n---\n\n');
        const key = createHash('sha1')
          .update(`${selection.provider}/${selection.model}\u0000${system}\u0000${prompt}`)
          .digest('hex');
        let answers = this.cache[key];
        if (answers) {
          state.cached += 1;
        } else {
          try {
            answers = await this.callModel(prompt, { batch: true, system });
            state.requests += 1;
            this.cache[key] = answers;
          } catch (error) {
            state.failure = error;
            return;
          }
        }
        const normalized = normalizeAnswers(answers);
        for (const item of batch) {
          result.set(item.group.key, lookupAnswer(normalized, item.group) ?? []);
          onProgress({ done: result.size, total: targets.length });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, used.length) }, worker));
    } finally {
      writeJson(this.cacheFile, this.cache);
    }
    if (state.failure) throw state.failure;
    const suspiciousCount = [...result.values()].reduce((sum, list) => sum + (list?.length ?? 0), 0);
    return {
      skipped: false,
      checked: result.size,
      total: candidates.length,
      truncated: candidates.length - covered,
      suspicious: suspiciousCount,
      // 实际发出的请求数(缓存命中不算)与批次数,界面上要说清楚。
      calls: used.length,
      requests: state.requests,
      cached: state.cached,
      result,
    };
  }

  /**
   * 通用文本补全:一段 system + 一条用户消息,返回纯文本。
   * 热点综述等一次性写作都走这里,不用再摸 ctx.llm 的流式细节。
   */
  async complete({ system, prompt, temperature = 0, reasoningEffort = 'low' } = {}) {
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.reason);
    const selection = this.selection();
    const messages = [
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(prompt ?? '') }],
        source: { kind: 'user' },
      },
    ];
    const request = (withEffort) => ({
      provider: selection.provider,
      model: selection.model,
      // 辅助调用不要继承会话里的高推理档,否则一次要几十秒。
      ...(withEffort ? { reasoningEffort } : {}),
      temperature,
      system,
      messages,
    });
    return this.streamText(request(true), () => request(false));
  }

  /** 读一次流式回复;模型不支持 reasoningEffort 时降级重试一次。 */
  async streamText(request, fallback) {
    let text = '';
    const collect = async (stream) => {
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
        if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) text += chunk.block.text;
        if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败');
          if (chunk.reason?.kind === 'aborted') throw new Error('模型调用被中断');
        }
      }
    };
    try {
      await collect(this.llm.stream(request));
    } catch (error) {
      if (!fallback || text || !/effort|reasoning/i.test(String(error.message))) throw error;
      await collect(fallback());
    }
    return text;
  }

  async callModel(prompt, { batch = false, system = '' } = {}) {
    const text = await this.complete({
      system: system || (batch ? BATCH_SYSTEM_PROMPT : SYSTEM_PROMPT),
      prompt,
      temperature: 0,
    });
    return batch ? parseBatchSuspicious(text) : parseSuspicious(text);
  }

  /**
   * Merge model findings into segments, suppressing points on segments that
   * are within `suppressWithinDays` (product rule: 1 天内的可疑点不提醒).
   *
   * @returns {{applied:number, suppressed:number}}
   */
  applySuspicious(groups, result, { suppressWithinDays = 1 } = {}) {
    const limit = Number(suppressWithinDays);
    const window = Number.isFinite(limit) ? limit : 1;
    let applied = 0;
    let suppressed = 0;
    for (const group of groups) {
      const suspicious = result.get(group.key);
      if (!suspicious || suspicious.length === 0) continue;
      let groupApplied = 0;
      for (const item of suspicious) {
        const segment = group.segments.find(
          (candidate) => candidate.fromOrder === item.from && candidate.toOrder === item.to,
        );
        if (!segment) continue;
        // 航段天数在抑制窗口内:不标可疑,只记一笔,供结论统计使用。
        if (Number(segment.days) <= window) {
          segment.suppressed = true;
          segment.suppressReason = `航段仅 ${segment.days} 天,1 天内的可疑点不提醒`;
          suppressed += 1;
          continue;
        }
        segment.suspicious = true;
        segment.reason = String(item.reason ?? '').slice(0, 80);
        segment.confidence = Number(item.confidence) || null;
        segment.issues.push({ type: 'llm', label: '模型判为可疑', severity: 'warning' });
        applied += 1;
        groupApplied += 1;
      }
      if (groupApplied > 0) group.abnormal = true;
    }
    return { applied, suppressed };
  }

  /** Merge model findings into segments. */
  apply(groups, result, options = {}) {
    return this.applySuspicious(groups, result, options);
  }
}

/** Parse the model reply, tolerating code fences and stray prose. */
export function parseSuspicious(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidates = [raw];
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.suspicious)) return parsed.suspicious;
    } catch {
      // try the next candidate
    }
  }
  return [];
}


/** 同一对港口在本批数据里的历史天数分布(给模型当「先例」)。 */
export function collectPairStats(groups) {
  const samples = new Map();
  for (const group of groups) {
    if (group.skipped) continue;
    for (const segment of group.segments) {
      if (segment.rawDays < 0) continue;
      const key = `${segment.fromCode}|${segment.toCode}`;
      if (!samples.has(key)) samples.set(key, []);
      samples.get(key).push(segment.days);
    }
  }
  const stats = new Map();
  for (const [key, values] of samples) {
    if (values.length < 3) continue;
    const sorted = [...values].sort((a, b) => a - b);
    stats.set(key, {
      count: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted.at(-1),
    });
  }
  return stats;
}


/** 批量回复:`{"results":[{"rotation":"id|版本","suspicious":[...]}]}` → Map(rotationKey -> list) */
export function parseBatchSuspicious(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidates = [raw];
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed?.results)) {
        const map = {};
        for (const item of parsed.results) {
          const key = String(item?.rotation ?? '').trim();
          if (!key) continue;
          map[key] = Array.isArray(item.suspicious) ? item.suspicious : [];
        }
        return map;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return {};
}


/** 模型回填的 rotation 可能只写 id、或带空格,统一成 `id|版本` 再匹配。 */
export function normalizeAnswers(answers) {
  const map = new Map();
  for (const [key, list] of Object.entries(answers ?? {})) {
    const compact = String(key).replace(/\s+/g, '');
    map.set(compact, Array.isArray(list) ? list : []);
    const [id] = compact.split('|');
    if (id && !map.has(id)) map.set(id, map.get(compact));
  }
  return map;
}

export function lookupAnswer(normalized, group) {
  const exact = `${group.rotationId}|${group.version}`.replace(/\s+/g, '');
  if (normalized.has(exact)) return normalized.get(exact);
  const byId = String(group.rotationId).replace(/\s+/g, '');
  return normalized.get(byId) ?? null;
}
