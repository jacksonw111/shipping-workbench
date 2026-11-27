import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../util/json-store.js';
import { ensureDir, slugify } from '../util/paths.js';
import { HttpError } from '../util/http-util.js';
import {
  compareWorkbooks,
  compareWithProfile,
  exportProfileResult,
  scheduleExportSheets,
} from './schedule.js';
import { normalizeProfile } from './schedule-parse.js';
import {
  inspectStructure,
  mappingToOverride,
  needsModelHelp,
  proposeMapping,
  reviewChanges,
  writeDigest,
} from './schedule-agent.js';
import { writeXlsx } from './xlsx-writer.js';
import { todayIso } from '../util/dates.js';
import { isPdfFile, pdfToWorkbookBuffer } from './pdf.js';
import {
  SKILL_SYSTEM_PROMPT,
  buildSkillPrompt,
  exportSkillResult,
  parseSkillResult,
  readSheets,
  skillMeta,
  SKILL_OUTPUT_SYSTEM_PROMPT,
  buildSkillOutputPrompt,
  outputsToText,
} from './skill-compare.js';
import { detectEntryScript, runSkillScript } from './skill-runner.js';
import { runSkillAgent } from './skill-agent.js';

/** 船期表新旧对比:有船东配置走配置引擎,没有就走通用对比。 */
export class ScheduleService {
  constructor(db, home, llm = null) {
    this.db = db;
    this.llm = llm;
    this.dir = ensureDir(path.join(home, 'schedule', 'runs'));
    this.versionsDir = ensureDir(path.join(home, 'schedule', 'versions'));
    this.home = home;
    this.mappingCacheFile = path.join(ensureDir(path.join(home, 'schedule')), 'mapping-cache.json');
    this.mappingCache = readJson(this.mappingCacheFile, {});
  }

  runDir(id) {
    return path.join(this.dir, slugify(id));
  }

  async run({
    oldBuffer,
    oldName,
    newBuffer,
    newName,
    keys,
    compareColumns,
    dateColumn,
    carrierId = '',
    carrierName = '',
    source = 'upload',
    mapping = null,
    wantDigest = true,
    // 邮件来源引用:日后靠它精确找回「这行配对对应哪次对比」。
    oldRef = null,
    newRef = null,
  }) {
    const startedAt = Date.now();
    const carrier = carrierId ? this.db.getCarrier(carrierId) : null;
    // PDF 先按文本坐标还原成表格,后面走同一套对比引擎;原件仍然落盘。
    const oldWorkbook = await workbookOf(oldBuffer, oldName);
    const newWorkbook = await workbookOf(newBuffer, newName);
    const keyList = splitList(keys);
    // 自动表头识别:两份文件的键列/日期列对不上时,直接问 DSH 模型要列映射,不再要人确认。
    const autoMappings = carrier
      ? {
          old: await this.autoMapping({ workbook: oldWorkbook, carrier, side: 'old' }),
          new: await this.autoMapping({ workbook: newWorkbook, carrier, side: 'new' }),
        }
      : { old: null, new: null };
    let result;
    if (carrier) {
      const profile = normalizeProfile(carrier);
      if (keyList.length > 0) {
        profile.keys = [{ name: '主键', columns: keyList }];
      }
      if (compareColumns) profile.parse.ignoreColumns = [];
      if (dateColumn) profile.dateColumn = dateColumn;
      // 模型给的映射(显式传入 + 两份文件各自自动识别)统一作为**候选**追加:
      // 旧版文件仍按它自己那套列名解析,否则旧行键会全部落空。
      const applied = [mapping, autoMappings.old, autoMappings.new].filter(Boolean);
      const fields = new Set();
      for (const item of applied) {
        const override = mappingToOverride(item);
        const columns = { ...profile.parse.columns };
        for (const [field, column] of Object.entries(override.columns)) {
          const existing = columns[field];
          const list = Array.isArray(existing) ? existing : existing ? [existing] : [field];
          columns[field] = [...new Set([...list, column])];
        }
        profile.parse.columns = columns;
        for (const field of override.fields) fields.add(field);
      }
      // 键继续用标准字段名,由上面的候选列表负责找列;直接换成真实列名会让旧版文件解析不到键。
      if (fields.size >= 2) profile.keys = [{ name: '主键', columns: [...fields] }];
      result = compareWithProfile(oldWorkbook, newWorkbook, profile, { carrier });
    } else {
      result = {
        ...compareWorkbooks(oldWorkbook, newWorkbook, {
          keys: keyList,
          compareColumns: splitList(compareColumns),
          dateColumn: String(dateColumn ?? '').trim() || undefined,
        }),
        mode: 'generic',
      };
    }
    // 自动复核:把变更清单交给模型分「真实变更 / 解析噪声」;和摘要并行,失败不影响对比。
    const reviewItems = buildReviewItems(result);
    const carrierForModel = { name: carrier?.name ?? carrierName };
    const [digest, agentReview] = await Promise.all([
      wantDigest && result.summary?.length
        ? writeDigest({ llm: this.llm, carrier: carrierForModel, stats: result.stats, summary: result.summary })
        : Promise.resolve(''),
      reviewItems.length
        ? reviewChanges({ llm: this.llm, carrier: carrierForModel, stats: result.stats, items: reviewItems })
        : Promise.resolve(null),
    ]);
    const id = randomUUID();
    const dir = ensureDir(this.runDir(id));
    fs.writeFileSync(path.join(dir, `old-${slugify(path.basename(oldName || 'old.xlsx'))}`), oldBuffer);
    fs.writeFileSync(path.join(dir, `new-${slugify(path.basename(newName || 'new.xlsx'))}`), newBuffer);
    const record = {
      id,
      mode: result.mode,
      generatedAt: result.generatedAt,
      oldName: oldName || '旧版',
      newName: newName || '新版',
      oldRef: oldRef ?? null,
      newRef: newRef ?? null,
      carrierId: carrier?.id ?? '',
      carrierName: carrier?.name ?? carrierName,
      today: result.today,
      keyColumns: carrier ? result.sheets[0]?.keyColumns ?? [] : result.sheets[0]?.keyColumns ?? [],
      stats: result.stats,
      sheets: result.sheets.map((sheet) =>
        result.mode === 'profile'
          ? {
              name: sheet.name,
              header: sheet.header,
              keyColumns: sheet.keyColumns,
              secondaryColumns: sheet.secondaryColumns,
              compareColumns: sheet.compareColumns,
              oldRows: sheet.oldRows.slice(0, 400),
              newRows: sheet.newRows.slice(0, 400),
              truncated: Math.max(0, sheet.oldRows.length - 400, sheet.newRows.length - 400),
            }
          : {
              name: sheet.name,
              columns: sheet.columns,
              keyColumns: sheet.keyColumns,
              dateColumn: sheet.dateColumn,
              compareColumns: sheet.compareColumns,
              rows: sheet.rows.slice(0, 600),
              truncated: Math.max(0, sheet.rows.length - 600),
            },
      ),
      summary: (result.summary ?? []).slice(0, 500),
      digest,
      mapped: Boolean(mapping) || Boolean(autoMappings.old) || Boolean(autoMappings.new),
      // 自动表头映射:界面上能看出这次是「按识别出的列」比的。
      mappings: {
        old: summarizeMapping(autoMappings.old),
        new: summarizeMapping(autoMappings.new),
      },
      // 自动复核结论:index 对应 buildReviewItems 的顺序(1 起)。
      agentReview: agentReview ? { ...agentReview, items: reviewItems } : null,
    };
    writeJson(path.join(dir, 'result.json'), record);
    writeJson(path.join(dir, 'result-full.json'), result);
    this.db.insertRun({
      id,
      kind: 'schedule',
      title: `${carrier ? `${carrier.name} · ` : ''}${record.oldName} → ${record.newName}`,
      source,
      inputs: { oldName, newName, keys: keyList, dateColumn, carrierId: carrier?.id ?? '', oldRef, newRef },
      stats: record.stats,
      detail: {
        sheets: record.sheets.map((sheet) => sheet.name),
        mode: result.mode,
        keyColumns: record.keyColumns,
      },
      createdAt: record.generatedAt,
      durationMs: Date.now() - startedAt,
    });
    return record;
  }

  /**
   * 自动表头映射:认不出键列/日期列时直接问模型,结果按「文件表头 + 模型」缓存。
   * 没有模型、结构正常、模型失败都静默返回 null —— 对比本身不受影响。
   */
  async autoMapping({ workbook, carrier, side }) {
    const availability = this.llm?.availability?.() ?? { available: false };
    if (!availability.available) return null;
    const profile = normalizeProfile(carrier);
    const inspection = inspectStructure(workbook, profile);
    if (!inspection.ok || !needsModelHelp(inspection)) return null;
    const key = createHash('sha1')
      .update(
        JSON.stringify({
          provider: availability.provider ?? '',
          model: availability.model ?? '',
          carrier: carrier?.id ?? '',
          side,
          header: inspection.header,
          sample: inspection.sampleRows,
          missing: inspection.missing,
          dateMissing: Boolean(inspection.dateMissing),
        }),
      )
      .digest('hex');
    if (this.mappingCache[key]) return this.mappingCache[key];
    try {
      const mapping = await proposeMapping({ llm: this.llm, carrier: { name: carrier?.name ?? '' }, inspection });
      if (!mapping) return null;
      this.mappingCache[key] = mapping;
      writeJson(this.mappingCacheFile, this.mappingCache);
      return mapping;
    } catch {
      return null;
    }
  }

  /**
   * Skill 驱动的对比:按用户导入的技能文件,让模型自己看两份表做对比。
   *
   * 和 run() 的区别:不走固定键/固定列,规则完全来自 Skill 文本;
   * 结果是一份结构化差异清单(mode: 'skill'),同样能导出 xlsx。
   */
  async compareWithSkill({
    oldBuffer,
    oldName,
    newBuffer,
    newName,
    skill,
    carrierId = '',
    carrierName = '',
    executeScripts,
  }) {
    if (!skill?.body) throw new HttpError(400, '请先导入 Skill 文件');
    const startedAt = Date.now();
    const carrier = carrierId ? this.db.getCarrier(carrierId) : null;
    const id = randomUUID();
    const dir = ensureDir(this.runDir(id));
    const oldPath = path.join(dir, `old-${slugify(path.basename(oldName || 'old.xlsx'))}`);
    const newPath = path.join(dir, `new-${slugify(path.basename(newName || 'new.xlsx'))}`);
    fs.writeFileSync(oldPath, oldBuffer);
    fs.writeFileSync(newPath, newBuffer);
    fs.writeFileSync(path.join(dir, `skill-${slugify(path.basename(skill.filename || 'skill.md'))}`), skill.body);
    // 技能包落盘留档:以后能回看这次到底用了哪份 Skill。
    const skillDir = this.saveSkillPackage(skill);

    // ---- Skill 就是流程:交给 Agent,由它自己决定读什么、跑不跑脚本 ----
    let execution = null;
    let parsed = null;
    let modelUsed = null;
    let agentSteps = [];
    let outputFiles = [];
    const availability = this.llm?.availability?.() ?? { available: false, reason: '当前 profile 没有挂载模型服务' };

    if (availability.available && typeof this.llm?.streamAgent === 'function') {
      modelUsed = { provider: availability.provider ?? '', model: availability.model ?? '' };
      const agent = await runSkillAgent({
        llm: this.llm,
        skill,
        skillDir,
        oldPath,
        newPath,
        runDir: dir,
        outDir: path.join(dir, 'out'),
      });
      execution = agent.executions.at(-1) ?? null;
      agentSteps = agent.steps;
      outputFiles = agent.outputs;
      parsed = {
        summary: agent.stopped === 'max-steps' ? `${agent.summary}\n(达到步数上限,结论可能不完整)` : agent.summary,
        markdown: agent.markdown,
        stats: agent.stats,
        items: agent.items,
        rules: agent.rules,
      };
    } else if (availability.available) {
      // 老路径:模型不支持工具调用时,退回「一份提示词 + 两份表」。
      modelUsed = { provider: availability.provider ?? '', model: availability.model ?? '' };
      const oldSheets = readSheets(await workbookOf(oldBuffer, oldName));
      const newSheets = readSheets(await workbookOf(newBuffer, newName));
      if (oldSheets.length === 0 || newSheets.length === 0) throw new HttpError(400, '文件里没有可读的表格数据');
      const built = buildSkillPrompt({
        skill,
        oldName,
        newName,
        oldWorkbook: oldSheets,
        newWorkbook: newSheets,
        carrierName: carrier?.name ?? carrierName,
      });
      const text = await this.llm.complete({ system: SKILL_SYSTEM_PROMPT, prompt: built.prompt, temperature: 0.2 });
      parsed = parseSkillResult(text);
      if (!parsed) throw new HttpError(502, '模型没有返回可用的对比结果,换个 Skill 或再试一次');
      parsed.promptChars = built.prompt.length;
      parsed.tableRows = built.rows;
      parsed.truncated = built.truncated;
    } else {
      // 没有模型:只能执行技能脚本,否则无法按 Skill 对比。
      const entryScript = detectEntryScript(skill);
      if (!entryScript || !skillDir) throw new HttpError(400, availability.reason ?? '当前 profile 没有挂载模型服务');
      try {
        execution = await runSkillScript({
          skillDir,
          script: entryScript,
          oldFile: oldPath,
          newFile: newPath,
          outDir: path.join(dir, 'out'),
        });
      } catch (error) {
        throw new HttpError(400, `技能脚本执行失败(${error.message}),且没有可用模型可以兜底`);
      }
      outputFiles = execution.outputs ?? [];
      parsed = {
        summary: `已执行技能脚本 ${entryScript}(退出码 ${execution.code}),生成 ${outputFiles.length} 个文件。(没有可用模型,未生成文字结论)`,
        markdown: '',
        stats: { added: 0, removed: 0, changed: 0, sheets: 0 },
        items: [],
        rules: [],
      };
    }

    const record = {
      id,
      mode: 'skill',
      generatedAt: new Date().toISOString(),
      oldName: oldName || '旧版',
      newName: newName || '新版',
      carrierId: carrier?.id ?? '',
      carrierName: carrier?.name ?? carrierName,
      today: todayIso(),
      skill: { ...skillMeta(skill), dir: skillDir },
      summary: parsed.summary,
      markdown: parsed.markdown ?? '',
      digest: parsed.summary,
      stats: { ...parsed.stats, skipped: 0 },
      items: parsed.items,
      rules: parsed.rules,
      truncated: Boolean(parsed.truncated),
      promptChars: parsed.promptChars ?? 0,
      tableRows: parsed.tableRows ?? 0,
      // 脚本执行明细:退出码、stdout/stderr、产物文件(界面提供下载)。
      execution,
      steps: agentSteps,
      outputFiles: outputFiles.map((file) => ({ name: file.name, size: file.size })),
      analysisSkipped: '',
      model: modelUsed,
      sheets: [],
      durationMs: Date.now() - startedAt,
    };
    writeJson(path.join(dir, 'result.json'), record);
    writeJson(path.join(dir, 'result-full.json'), record);
    this.db.insertRun({
      id,
      kind: 'schedule',
      title: `${carrier ? `${carrier.name} · ` : ''}${record.oldName} → ${record.newName} · Skill:${skill.name}`,
      source: 'skill',
      inputs: {
        oldName,
        newName,
        carrierId: carrier?.id ?? '',
        skill: { name: skill.name, hash: skill.hash },
        executeScripts: Boolean(executeScripts),
      },
      stats: record.stats,
      detail: {
        mode: 'skill',
        skill: skill.name,
        truncated: record.truncated,
        items: record.items.length,
        script: execution?.script ?? '',
      },
      createdAt: record.generatedAt,
      durationMs: record.durationMs,
    });
    return record;
  }

  /** 读一次脚本产物(界面下载用),名字限定在 run 的 out/ 下。 */
  outputFile(id, name) {
    const safe = path.basename(String(name ?? ''));
    const file = path.join(this.runDir(id), 'out', safe);
    if (!safe || !fs.existsSync(file)) throw new HttpError(404, '产物文件不存在');
    return { buffer: fs.readFileSync(file), filename: safe };
  }

  /** 把技能包解出来的文件存到 `schedule/skills/<hash>/`,便于复用与审计。 */
  saveSkillPackage(skill) {
    if (!skill?.hash || !(skill.entries ?? []).length) return '';
    const dir = ensureDir(path.join(this.home, 'schedule', 'skills', skill.hash));
    for (const entry of skill.entries) {
      const target = path.join(dir, entry.path);
      const relative = path.relative(dir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    }
    writeJson(path.join(dir, 'meta.json'), skillMeta(skill));
    return dir;
  }

  /**
   * 结构体检:这版文件的表头能不能被现有配置认出来。
   *
   * 认不出来(或键列/开航日期列对不上)时,让模型给一份「字段 → 表头列」的映射,
   * 由用户在界面上确认后带进 run()。模型不可用就只报结构问题,不阻塞。
   */
  async analyze({ buffer, filename = 'schedule.xlsx', carrierId = '' }) {
    const carrier = carrierId ? this.db.getCarrier(carrierId) : null;
    if (carrierId && !carrier) throw new HttpError(404, `船东不存在:${carrierId}`);
    const profile = carrier ? normalizeProfile(carrier) : normalizeProfile({});
    const sourceKind = isPdfFile(filename) ? 'pdf' : 'excel';
    const inspection = inspectStructure(await workbookOf(buffer, filename), profile);
    const availability = this.llm?.availability?.() ?? { available: false, reason: '当前 profile 没有挂载模型服务' };
    const wanted = needsModelHelp(inspection);
    let mapping = null;
    let mappingError = '';
    if (wanted && availability.available && inspection.ok) {
      try {
        mapping = await proposeMapping({ llm: this.llm, carrier: { name: carrier?.name ?? '' }, inspection });
      } catch (error) {
        mappingError = error.message;
      }
    }
    return {
      filename,
      sourceKind,
      carrier: carrier ? { id: carrier.id, name: carrier.name } : null,
      ...inspection,
      needsModel: wanted,
      model: {
        available: Boolean(availability.available),
        reason: availability.reason ?? '',
        used: Boolean(mapping),
        error: mappingError,
      },
      mapping,
      // 模型没法帮忙时的兜底:让用户手填键列。
      hint: wanted
        ? inspection.ok
          ? `这版表头里找不到:${[...inspection.missing, inspection.dateMissing ? '开航日期' : ''].filter(Boolean).join('、') || '可用的键列'}`
          : inspection.reason
        : '',
      versions: carrier ? this.versions(carrier.id) : null,
    };
  }

  /**
   * 收下一版船期表:与上一版自动对比,并把新文件记成该船东的最新版本。
   *
   * 同一份文件重复导入(哈希一致)直接跳过,避免一天内多封同样的邮件产生空任务。
   */
  async ingest({ carrierId, buffer, filename = 'schedule.xlsx', source = 'mail', mapping = null }) {
    const carrier = this.db.getCarrier(carrierId);
    if (!carrier) throw new HttpError(404, `船东不存在:${carrierId}`);
    const digest = createHash('sha1').update(buffer).digest('hex');
    const latest = this.db.latestVersion(carrier.id);
    if (latest) {
      const previousFile = latest.filePath && fs.existsSync(latest.filePath) ? fs.readFileSync(latest.filePath) : null;
      if (previousFile && createHash('sha1').update(previousFile).digest('hex') === digest) {
        return { skipped: true, reason: '与当前版本内容相同', version: latest, run: null };
      }
    }

    const filePath = path.join(this.versionsDir, `${slugify(carrier.id)}-${Date.now()}-${slugify(path.basename(filename))}`);
    fs.writeFileSync(filePath, buffer);

    let record = null;
    if (latest?.filePath && fs.existsSync(latest.filePath)) {
      record = await this.run({
        oldBuffer: fs.readFileSync(latest.filePath),
        oldName: latest.filename || '上一版',
        newBuffer: buffer,
        newName: filename,
        carrierId: carrier.id,
        carrierName: carrier.name,
        source,
        mapping,
      });
    }
    const version = this.db.insertVersion({
      carrierId: carrier.id,
      filename,
      source,
      filePath,
      rowCount: record?.sheets?.[0]
        ? (record.sheets[0].oldRows?.length ?? 0) + (record.sheets[0].newRows?.length ?? 0)
        : 0,
      runId: record?.id ?? null,
    });
    return {
      skipped: false,
      version,
      run: record,
      comparedWith: latest ?? null,
      message: latest ? `已与 v${latest.versionNo} 对比` : '这是第一版,已存档作为基线',
    };
  }

  /**
   * 用已存档的最近两版重新跑一次对比。
   *
   * 场景:邮件自动入版本时对比失败了(比如第一次是 PDF),或者用户只想重看一下结果。
   * 不重新上传文件,直接从版本库里读两版存档;成功后把这次 run 挂到最新版上。
   */
  async compareVersions(carrierId) {
    const carrier = this.db.getCarrier(carrierId);
    if (!carrier) throw new HttpError(404, `船东不存在:${carrierId}`);
    const versions = this.db.listVersions(carrier.id, 2);
    if (versions.length < 2) throw new HttpError(400, '这个船东还没有两版可对比');
    // listVersions 按 version_no 倒序:第一个是最新版,第二个是上一版。
    const [newVersion, oldVersion] = versions;
    const oldPath = oldVersion?.filePath ?? '';
    const newPath = newVersion?.filePath ?? '';
    if (!oldPath || !fs.existsSync(oldPath)) {
      throw new HttpError(400, `旧版文件已不在:${oldVersion?.filename || oldVersion?.id || '未知'}`);
    }
    if (!newPath || !fs.existsSync(newPath)) {
      throw new HttpError(400, `最新版文件已不在:${newVersion?.filename || newVersion?.id || '未知'}`);
    }
    const record = await this.run({
      oldBuffer: fs.readFileSync(oldPath),
      oldName: oldVersion.filename || '上一版',
      newBuffer: fs.readFileSync(newPath),
      newName: newVersion.filename || '最新版',
      carrierId: carrier.id,
      carrierName: carrier.name,
      // 来源跟随这一版是怎么进来的,记录里才好区分「邮件自动」和「手动重比」。
      source: newVersion.source === 'mail' ? 'mail' : 'upload',
      wantDigest: true,
    });
    this.db.attachRunToVersion(carrier.id, record.id);
    return { run: record, versions: this.versions(carrier.id) };
  }

  /**
   * 重新对比:用这条记录当时留存的旧版/新版源文件重跑一遍。
   * 会重新走解析、自动表头映射、diff、Agent 复核与摘要,生成一条新记录;
   * 源文件被清理掉的旧记录会给出可读原因。
   */
  async recompare(id) {
    const record = this.getRun(id);
    const dir = this.runDir(id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const oldFile = files.find((name) => name.startsWith('old-'));
    const newFile = files.find((name) => name.startsWith('new-'));
    if (!oldFile || !newFile) {
      throw new HttpError(409, '这条记录没有留下旧版/新版源文件,无法重新对比,请重新上传');
    }
    const oldName = record.oldName || oldFile.replace(/^old-/, '');
    const newName = record.newName || newFile.replace(/^new-/, '');
    return this.run({
      oldBuffer: fs.readFileSync(path.join(dir, oldFile)),
      oldName,
      newBuffer: fs.readFileSync(path.join(dir, newFile)),
      newName,
      carrierId: record.carrierId || '',
      carrierName: record.carrierName || '',
      source: 'recompare',
    });
  }

  /** 某船东的版本历史 + 当前版本。 */
  versions(carrierId) {
    const carrier = this.db.getCarrier(carrierId);
    if (!carrier) throw new HttpError(404, '船东不存在');
    return {
      carrier: { id: carrier.id, name: carrier.name },
      current: this.db.latestVersion(carrier.id),
      history: this.db.listVersions(carrier.id),
    };
  }

  listRuns({ limit = 20, offset = 0, q = '' } = {}) {
    return this.db.listRuns({ kind: 'schedule', limit, offset, q });
  }

  getRun(id) {
    const record = readJson(path.join(this.runDir(id), 'result.json'), null);
    if (record) return record;
    const row = this.db.getRun(id);
    if (!row) throw new HttpError(404, '对比结果不存在');
    return {
      id: row.id,
      generatedAt: row.createdAt,
      oldName: row.inputs.oldName ?? '',
      newName: row.inputs.newName ?? '',
      stats: row.stats,
      sheets: [],
    };
  }

  exportBuffer(id) {
    const result = readJson(path.join(this.runDir(id), 'result-full.json'), null);
    if (!result) throw new HttpError(404, '对比结果不存在');
    if (result.mode === 'skill') {
      return { buffer: writeXlsx(exportSkillResult(result)), filename: `船期对比-Skill-${id.slice(0, 8)}.xlsx` };
    }
    const sheets =
      result.mode === 'profile' ? exportProfileResult(result).sheets : scheduleExportSheets(result);
    return { buffer: writeXlsx(sheets), filename: `船期对比-${id.slice(0, 8)}.xlsx` };
  }

  remove(id) {
    this.db.removeRun(id);
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
  }
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[,,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * PDF → 表格 buffer;解析失败(扫描件/加密/损坏)抛 400 而不是 500。
 * excel 原样返回。
 */
async function workbookOf(buffer, name) {
  if (!isPdfFile(name ?? '')) return buffer;
  try {
    return await pdfToWorkbookBuffer(buffer);
  } catch (error) {
    throw new HttpError(400, `PDF 解析失败:${error.message}`);
  }
}


/** 把映射收成界面能显示的最小信息。 */
function summarizeMapping(mapping) {
  if (!mapping) return null;
  return { columns: mapping.columns ?? {}, note: mapping.note ?? '' };
}

/**
 * 从对比结果里抽出一份「变更清单」给模型复核。
 * 新旧两版各自的行状态不同,这里按侧取,避免同一条变更出现两次。
 */
export function buildReviewItems(result, { limit = 60 } = {}) {
  const items = [];
  for (const sheet of result.sheets ?? []) {
    const push = (item) => {
      items.push(item);
      return items.length >= limit;
    };
    if (result.mode === 'profile') {
      const header = sheet.header ?? [];
      const keyOf = (cells) =>
        (sheet.keyColumns ?? [])
          .map((column) => String(cells?.[header.indexOf(column)] ?? '').trim())
          .filter(Boolean)
          .join('/');
      for (const row of sheet.oldRows ?? []) {
        if (row.status === '变更') {
          for (const change of row.changes ?? []) {
            if (push({ sheet: sheet.name, status: '变更', key: keyOf(row.cells), field: change.column, from: change.from, to: change.to })) return items;
          }
        } else if (row.status === '删除') {
          if (push({ sheet: sheet.name, status: '删除', key: keyOf(row.cells), field: '', from: '', to: '' })) return items;
        }
      }
      for (const row of sheet.newRows ?? []) {
        if (row.status !== '新增') continue;
        if (push({ sheet: sheet.name, status: '新增', key: keyOf(row.cells), field: '', from: '', to: '' })) return items;
      }
    } else {
      const columns = sheet.columns ?? [];
      for (const row of sheet.rows ?? []) {
        if (!row.status) continue;
        const key = (sheet.keyColumns ?? [])
          .map((column) => String(row.values?.[column] ?? '').trim())
          .filter(Boolean)
          .join('/');
        if (row.status === '变更') {
          for (const change of row.changes ?? []) {
            if (push({ sheet: sheet.name, status: '变更', key, field: change.column, from: change.from, to: change.to })) return items;
          }
        } else if (push({ sheet: sheet.name, status: row.status, key, field: '', from: '', to: '' })) {
          return items;
        }
      }
    }
  }
  return items;
}
