/**
 * 按 Skill 执行的 Agent 循环。
 *
 * 之前是「脚本模式 / 模型模式」二选一:脚本跑完就结束,模型只能凭空推断。
 * 现在把 Skill 当成流程给模型,由它自己决定读哪些文件、跑不跑技能脚本、
 * 什么时候收尾——脚本只是它手里的一个工具,不是另一条分支。
 */
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runSkillScript } from './skill-runner.js';
import { readSheets, workbookToText } from './skill-compare.js';

/** 给模型的系统提示:流程优先,工具是手段。 */
export const SKILL_AGENT_SYSTEM_PROMPT = [
  '你在执行一份「对比技能(Skill)」。Skill 正文就是你要走的流程,不是参考资料。',
  '',
  '工作方式:',
  '1. 先读懂 Skill 要求的步骤(选哪一页、隐藏行怎么处理、按什么口径判定、结果长什么样)。',
  '2. 用工具一步一步做:需要原始数据就 read_file,Skill 里有脚本且脚本就是流程的一部分就 run_script,',
  '   需要看中间结果就再 read_file。不要跳过 Skill 明确要求的步骤。',
  '3. 每一步只做一件事,拿到结果再决定下一步;脚本失败就换一种方式继续,不要假装成功。',
  '   同一个脚本最多执行一次(工具会拒绝重复执行);脚本的产出内容会直接返回给你,不需要再读一遍。',
  '4. 收尾必须调用 finish,给出 summary(中文结论),需要时给 report(Markdown,按 Skill 的版式)、',
  '   items(增删改清单)、stats(计数)、rules(依据的 Skill 规则)。',
  '',
  '约束:只依据工具返回的真实内容下结论;数字不许编;产物被截断要在 summary 里说明。',
].join('\n');

/** 暴露给模型的工具声明。 */
export const SKILL_AGENT_TOOLS = [
  {
    name: 'list_files',
    description: '列出技能包与本次运行目录里的文件。用于确认 Skill 里有哪些脚本/参考资料、已经产出了什么。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['skill', 'run', 'all'], description: 'skill=技能包, run=本次运行目录, all=两者' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: '读取文件内容。表格(xlsx/xls)会解析成逐行文本;文本文件原样返回。路径可用 old/new 指代本次对比的两份表。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'old | new | skill:<技能包内相对路径> | <运行目录内相对路径>' },
        sheet: { type: 'string', description: '只读某个 sheet(可选)' },
        maxRows: { type: 'number', description: '每个 sheet 最多读多少行,默认 300' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_script',
    description: '执行技能包里的脚本(Skill 要求用脚本产出时使用)。脚本会拿到旧版/新版文件路径与输出目录。',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '技能包内脚本相对路径,如 scripts/compare.py' },
        args: { type: 'array', items: { type: 'string' }, description: '额外参数(可选)' },
      },
      required: ['script'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: '把文本写到本次运行目录(用于生成中间结果或报告文件)。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名,如 result.md' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: '收尾:给出本次对比的结论。必须调用一次。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '中文结论,3-6 句' },
        report: { type: 'string', description: '可选:按 Skill 版式排版的 Markdown' },
        stats: {
          type: 'object',
          properties: {
            added: { type: 'number' },
            removed: { type: 'number' },
            changed: { type: 'number' },
          },
          additionalProperties: false,
        },
        items: {
          type: 'array',
          description: '增删改清单(仅当 Skill 要求逐条列出时)',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' },
              key: { type: 'string' },
              status: { type: 'string', enum: ['新增', '删除', '变更'] },
              note: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        rules: { type: 'array', items: { type: 'string' }, description: '依据的 Skill 规则,最多 5 条' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

const MAX_STEPS = 10;
const TEXT_LIMIT = 20000;

function listTree(root, { depth = 2, limit = 80 } = {}) {
  const out = [];
  const walk = (dir, prefix, level) => {
    if (out.length >= limit || level > depth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${relative}/`);
        walk(path.join(dir, entry.name), relative, level + 1);
      } else {
        out.push(relative);
      }
    }
  };
  walk(root, '', 1);
  return out;
}

/**
 * 跑一次 Agent 循环。
 *
 * @param llm - 需要有 `streamAgent({system, messages, tools})` → `{text, toolCalls}`
 * @returns `{summary, markdown, stats, items, rules, steps, executions, outputs, stopped}`
 */
export async function runSkillAgent({
  llm,
  skill,
  skillDir = '',
  oldPath = '',
  newPath = '',
  runDir,
  outDir,
  maxSteps = MAX_STEPS,
  onEvent = () => {},
}) {
  mkdirSync(outDir, { recursive: true });
  const executions = [];
  const steps = [];
  const ranScripts = new Set();

  const skillFiles = skillDir && existsSync(skillDir) ? listTree(skillDir) : (skill.files ?? []).map((file) => file.path);
  const task = [
    `本次要对比两份船期表:`,
    `- 旧版:old(运行目录内文件名 ${path.basename(oldPath) || '未知'})`,
    `- 新版:new(运行目录内文件名 ${path.basename(newPath) || '未知'})`,
    '',
    `技能包目录:${skillDir || '(未落盘)'}`,
    `技能包内文件:${skillFiles.join(', ') || '(无)'}`,
    `可用脚本:${(skill.scripts ?? []).join(', ') || '(无)'}`,
    `输出目录:${outDir}`,
    '',
    '===== 技能正文 =====',
    skill.body,
    '',
    '按技能正文的流程开始工作,完成后调用 finish。',
  ].join('\n');

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: task }],
    },
  ];

  const resolvePath = (target) => {
    const value = String(target ?? '').trim();
    if (value === 'old') return oldPath;
    if (value === 'new') return newPath;
    if (value.startsWith('skill:')) return path.join(skillDir, value.slice(6));
    if (path.isAbsolute(value)) return value;
    return path.join(runDir, value);
  };

  const readTable = (file, sheetName, maxRows) => {
    if (!file || !existsSync(file)) return null;
    const buffer = readFileSync(file);
    const sheets = readSheets(buffer).map((sheet) => ({
      name: sheet.name,
      rows: maxRows ? sheet.rows.slice(0, maxRows) : sheet.rows,
      hiddenRows: sheet.hiddenRows,
    }));
    const picked = sheetName ? sheets.filter((sheet) => sheet.name === sheetName) : sheets;
    if (!picked.length) return `没有 sheet:${sheetName}`;
    return workbookToText(picked, { maxRows: maxRows || 300, maxChars: TEXT_LIMIT }).text;
  };

  const execute = async (call) => {
    const name = call.name;
    let args = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { text: `参数不是合法 JSON:${String(call.arguments).slice(0, 200)}`, isError: true };
    }
    if (name === 'list_files') {
      const scope = args.scope ?? 'all';
      const lines = [];
      if (scope !== 'run' && skillDir) lines.push(`技能包(${skillDir}):`, ...listTree(skillDir), '');
      if (scope !== 'skill') lines.push(`运行目录(${runDir}):`, ...listTree(runDir, { depth: 3 }), `产出目录(${outDir}):`, ...listTree(outDir, { depth: 2 }));
      return { text: lines.join('\n') || '(空)' };
    }
    if (name === 'read_file') {
      const file = resolvePath(args.path);
      if (!file || !existsSync(file)) return { text: `文件不存在:${args.path}`, isError: true };
      const extension = path.extname(file).toLowerCase();
      if (['.xlsx', '.xls'].includes(extension)) {
        const text = readTable(file, args.sheet, args.maxRows);
        return { text: text ?? `${args.path} 读不出表格` };
      }
      const raw = readFileSync(file, 'utf8').slice(0, TEXT_LIMIT);
      return { text: raw || '(空文件)' };
    }
    if (name === 'run_script') {
      if (!skillDir) return { text: '技能包没有落盘,无法执行脚本', isError: true };
      const script = String(args.script ?? '').trim();
      if (!script) return { text: '缺少 script', isError: true };
      if (ranScripts.has(script)) {
        return { text: `脚本 ${script} 本次已经执行过,不要重复执行。产物在 out/ 目录,直接读取产物或调用 finish 收尾。` };
      }
      ranScripts.add(script);
      const extra = Array.isArray(args.args) ? args.args.map(String) : [];
      const execution = await runSkillScript({
        skillDir,
        script,
        oldFile: oldPath,
        newFile: newPath,
        outDir,
        extraArgs: extra,
      });
      executions.push(execution);
      steps.push({ tool: 'run_script', target: script, ok: execution.code === 0 });
      onEvent({ type: 'script', execution });
      const lines = [
        `退出码:${execution.code}`,
        execution.stdout ? `stdout:\n${execution.stdout}` : '',
        execution.stderr ? `stderr:\n${execution.stderr}` : '',
        `产出:${(execution.outputs ?? []).map((file) => `${file.name}(${file.size} 字节)`).join(', ') || '(无)'}`,
      ].filter(Boolean);
      // 产物内容直接回灌:模型不必再为了「看看结果」多走一步。
      for (const file of execution.outputs ?? []) {
        const extension = path.extname(file.name).toLowerCase();
        if (['.xlsx', '.xls'].includes(extension)) {
          const text = readTable(file.path, '', 120);
          if (text) lines.push(`\n${file.name} 内容(前 120 行/页):\n${text.slice(0, 8000)}`);
        } else if (['.csv', '.txt', '.json', '.md', '.tsv'].includes(extension)) {
          lines.push(`\n${file.name} 内容:\n${readFileSync(file.path, 'utf8').slice(0, 6000)}`);
        }
      }
      return { text: lines.join('\n'), isError: execution.code !== 0 };
    }
    if (name === 'write_file') {
      const target = path.join(outDir, path.basename(String(args.name ?? 'output.txt')));
      writeFileSync(target, String(args.content ?? ''), 'utf8');
      return { text: `已写入 ${target}` };
    }
    return { text: `未知工具:${name}`, isError: true };
  };

  let finish = null;
  for (let step = 0; step < maxSteps; step += 1) {
    const lastChance = step === maxSteps - 1;
    if (lastChance) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '步骤快用完了。现在只调用 finish,给出 summary(以及 report/stats/items),不要再调用其他工具。' }],
      });
    }
    const reply = await llm.streamAgent({
      system: SKILL_AGENT_SYSTEM_PROMPT,
      messages,
      // 最后一步只留 finish,逼出结论。
      tools: lastChance ? SKILL_AGENT_TOOLS.filter((tool) => tool.name === 'finish') : SKILL_AGENT_TOOLS,
    });
    const calls = reply.toolCalls ?? [];
    const content = [];
    if (reply.text) content.push({ type: 'text', text: reply.text });
    for (const call of calls) {
      content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
    }
    messages.push({ role: 'assistant', content, source: { kind: 'model' } });
    if (!calls.length) {
      // 没调工具又没收尾:把这段文字当结论,避免空转。
      if (reply.text) finish = { summary: reply.text.trim().slice(0, 1200) };
      break;
    }
    for (const call of calls) {
      if (call.name === 'finish') {
        try {
          finish = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          finish = { summary: String(call.arguments ?? '').slice(0, 1200) };
        }
        steps.push({ tool: 'finish', ok: true });
        messages.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: '已记录结论' }] });
        break;
      }
      const result = await execute(call);
      if (call.name !== 'run_script') steps.push({ tool: call.name, target: String(argsTarget(call)), ok: !result.isError });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        isError: Boolean(result.isError),
        content: [{ type: 'text', text: String(result.text ?? '').slice(0, TEXT_LIMIT) }],
      });
    }
    if (finish) break;
  }

  const outputs = executions.flatMap((execution) => execution.outputs ?? []);
  return {
    summary: String(finish?.summary ?? '').trim() || 'Agent 没有给出结论。',
    markdown: String(finish?.report ?? '').trim(),
    stats: {
      added: Number(finish?.stats?.added ?? 0) || 0,
      removed: Number(finish?.stats?.removed ?? 0) || 0,
      changed: Number(finish?.stats?.changed ?? 0) || 0,
    },
    items: Array.isArray(finish?.items) ? finish.items : [],
    rules: Array.isArray(finish?.rules) ? finish.rules.slice(0, 5) : [],
    steps,
    executions,
    outputs,
    stopped: finish ? 'finish' : 'max-steps',
  };
}

function argsTarget(call) {
  try {
    const args = JSON.parse(call.arguments || '{}');
    return args.path ?? args.name ?? '';
  } catch {
    return '';
  }
}