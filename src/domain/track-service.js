import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../util/json-store.js';
import { ensureDir, slugify } from '../util/paths.js';
import { HttpError } from '../util/http-util.js';
import {
  parseTrackWorkbook,
  buildTrackGroups,
  applyRules,
  buildTrackReport,
  collectFindings,
  exportTrackReport,
} from './track.js';
import { DEFAULT_CONGESTION_RULE, enrichWithCongestion } from './congestion.js';
import { selectCandidates } from './track-candidates.js';
import { writeXlsx } from './xlsx-writer.js';

/** 读取「1 天内不提醒」的窗口;配置缺失或非法时退回默认 1 天。 */
function suppressWindow(config) {
  const value = Number(config?.suppressWithinDays);
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

/** 组装塞港规则(阈值 + 抑制窗口)。 */
function congestionRule(config) {
  return {
    minWaitDays: config.congestionMinWaitDays ?? DEFAULT_CONGESTION_RULE.minWaitDays,
    minGapDays: config.congestionGapDays ?? DEFAULT_CONGESTION_RULE.minGapDays,
    suppressWithinDays: suppressWindow(config),
  };
}

/** 轨迹检测任务:解析 → 规则 → 塞港 →(可选)模型 → 标红报告,记录进 SQLite。 */
export class TrackService {
  constructor(db, home, congestion, llm, settings) {
    this.db = db;
    this.dir = ensureDir(path.join(home, 'track', 'runs'));
    this.congestion = congestion;
    this.llm = llm;
    this.settings = settings;
    this.jobs = new Map();
  }

  runDir(id) {
    return path.join(this.dir, slugify(id));
  }

  statusFile(id) {
    return path.join(this.runDir(id), 'status.json');
  }

  status(id) {
    const live = this.jobs.get(id);
    if (live) return live;
    const saved = readJson(this.statusFile(id), null);
    if (!saved) throw new HttpError(404, '检测任务不存在');
    return saved;
  }

  /** 同步跑完(测试与旧接口用);界面走 {@link start} 后台跑。 */
  async run(buffer, options = {}) {
    const id = randomUUID();
    const dir = ensureDir(this.runDir(id));
    fs.writeFileSync(path.join(dir, `source-${slugify(path.basename(options.filename ?? 'track.xls'))}`), buffer);
    return this.execute(id, buffer, options, () => {});
  }

  /** 后台启动:模型判定可能要十几分钟,不能挂在一次 HTTP 请求上。 */
  start(buffer, options = {}) {
    const id = randomUUID();
    const dir = ensureDir(this.runDir(id));
    const filename = options.filename ?? 'track.xls';
    fs.writeFileSync(path.join(dir, `source-${slugify(path.basename(filename))}`), buffer);
    const status = {
      id,
      filename,
      phase: 'parse',
      startedAt: new Date().toISOString(),
      done: 0,
      total: 0,
    };
    this.#saveStatus(status);
    this.jobs.set(id, status);
    setImmediate(() => {
      this.execute(id, buffer, options, (patch) => {
        const next = { ...this.jobs.get(id), ...patch };
        this.#saveStatus(next);
        this.jobs.set(id, next);
      })
        .then((report) => {
          const done = { ...this.jobs.get(id), phase: 'done', reportId: id, stats: report.stats };
          this.#saveStatus(done);
          this.jobs.set(id, done);
          setTimeout(() => this.jobs.delete(id), 10 * 60_000).unref?.();
        })
        .catch((error) => {
          const failed = { ...this.jobs.get(id), phase: 'failed', error: error.message };
          this.#saveStatus(failed);
          this.jobs.set(id, failed);
        });
    });
    return status;
  }

  #saveStatus(status) {
    writeJson(path.join(this.runDir(status.id), 'status.json'), status);
  }

  async execute(id, buffer, options, onProgress) {
    const startedAt = Date.now();
    const { filename = 'track.xls', source = 'upload' } = options;
    const config = this.settings?.read?.().track ?? {};
    const availability = this.llm.availability();
    const wantModel =
      options.useLlm === undefined
        ? config.modelByDefault !== false && availability.available
        : Boolean(options.useLlm);

    onProgress({ phase: 'parse' });
    const parsed = parseTrackWorkbook(buffer);
    const groups = applyRules(buildTrackGroups(parsed.records));
    onProgress({ phase: 'rules' });
    const rule = congestionRule(config);
    const congestionHits = enrichWithCongestion(groups, this.congestion, rule);

    let llmInfo = { skipped: true, reason: availability.available ? '未启用模型判定' : availability.reason };
    if (wantModel) {
      // 先本地预筛:只有规则硬错、塞港冲突、统计异常才值得模型看一眼。
      const prefilter = selectCandidates(groups, {
        scope: String(config.llmScope ?? 'candidates'),
        // 0 = 不限;界面上的「候选上限」填 0 即全量。
        maxCandidates: Number(config.llmMaxCandidates ?? 400),
        minDays: Number(config.llmOutlierMinDays ?? 25),
        ratio: Number(config.llmOutlierRatio ?? 2.5),
      });
      onProgress({ phase: 'model', done: 0, total: prefilter.candidates });
      try {
        const result = await this.llm.check(prefilter.groups, {
          concurrency: Math.max(1, Number(config.llmConcurrency ?? 4)),
          charBudget: Math.max(2000, Number(config.llmCharBudget ?? 30000)),
          maxCalls: Math.max(0, Number(config.llmMaxCalls ?? 12)),
          promptOverride: String(config.promptOverride ?? ''),
          onProgress: (progress) => onProgress({ phase: 'model', ...progress }),
        });
        if (!result.skipped) {
          this.llm.apply(groups, result.result, { suppressWithinDays: suppressWindow(config) });
          llmInfo = {
            skipped: false,
            checked: result.checked,
            total: prefilter.scanned,
            truncated: prefilter.truncated + result.truncated,
            suspicious: result.suspicious,
            // 调用次数与预筛构成,界面要能看出「为什么只问了这么几次」。
            calls: result.calls,
            requests: result.requests,
            cached: result.cached,
            candidates: prefilter.candidates,
            scanned: prefilter.scanned,
            prefilter: prefilter.reasons,
            // 覆盖率:送模型的行数 / 全部有效行数。
            rowsSent: prefilter.rows ?? 0,
            rowsScanned: prefilter.rowsScanned ?? 0,
            scope: prefilter.scope ?? 'candidates',
          };
        } else {
          llmInfo = result;
        }
      } catch (error) {
        llmInfo = { skipped: true, reason: error.message };
      }
    }

    onProgress({ phase: 'report' });
    const dir = this.runDir(id);
    const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: suppressWindow(config) });
    const report = buildTrackReport(parsed, groups, {
      id,
      filename,
      source,
      warnings: parsed.warnings.slice(0, 200),
      detected: parsed.detected,
      congestionHits,
      findings,
      suppressed,
      llm: llmInfo,
    });
    writeJson(path.join(dir, 'report.json'), report);
    this.db.insertRun({
      id,
      kind: 'track',
      title: filename,
      source,
      inputs: { filename, useLlm: wantModel },
      stats: report.stats,
      detail: { llm: llmInfo, congestionHits, warnings: parsed.warnings.length },
      createdAt: report.generatedAt,
      durationMs: Date.now() - startedAt,
    });
    return report;
  }

  listRuns({ limit = 20, offset = 0, q = '' } = {}) {
    const page = this.db.listRuns({ kind: 'track', limit, offset, q });
    return { ...page, items: page.items.map((run) => ({ ...run, status: run.status })) };
  }

  getReport(id) {
    const report = readJson(path.join(this.runDir(id), 'report.json'), null);
    if (!report) throw new HttpError(404, '检测结果不存在(可能还在跑)');
    if (report.formatVersion !== 2) return this.rebuild(id, report);
    return report;
  }

  /**
   * 旧版记录(groups 结构)打不开:用当时存下来的源文件重跑一遍,
   * 覆写同一条记录,前端就能拿到「原表 + 标红 + 备注」的新结构。
   */
  rebuild(id, previous) {
    const dir = this.runDir(id);
    const sourceFile = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((name) => name.startsWith('source-'))
      : null;
    if (!sourceFile) throw new HttpError(409, '这条记录是旧格式且源文件已丢失,请重新上传检测');
    const buffer = fs.readFileSync(path.join(dir, sourceFile));
    const filename = previous.filename ?? sourceFile.replace(/^source-/, '');
    const parsed = parseTrackWorkbook(buffer);
    const groups = applyRules(buildTrackGroups(parsed.records));
    const config = this.settings?.read?.().track ?? {};
    const congestionHits = enrichWithCongestion(groups, this.congestion, congestionRule(config));
    const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: suppressWindow(config) });
    const report = buildTrackReport(parsed, groups, {
      id,
      filename,
      source: previous.source ?? 'upload',
      warnings: parsed.warnings.slice(0, 200),
      detected: parsed.detected,
      congestionHits,
      findings,
      suppressed,
      llm: previous.llm ?? { skipped: true, reason: '旧记录未保留模型判定' },
    });
    writeJson(path.join(dir, 'report.json'), report);
    return report;
  }

  exportBuffer(id) {
    const report = readJson(path.join(this.runDir(id), 'report.json'), null);
    if (!report) throw new HttpError(404, '检测结果不存在');
    return { buffer: writeXlsx(exportTrackReport(report)), filename: `轨迹检测-${id.slice(0, 8)}.xlsx` };
  }

  remove(id) {
    this.db.removeRun(id);
    this.jobs.delete(id);
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
  }
}
