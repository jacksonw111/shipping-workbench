/**
 * 复用 DSH 官方 agent 循环执行 Skill 对比。
 *
 * 之前 `skill-agent.js` 自己写了一套「调模型 → 跑工具 → 再调模型」的循环,
 * 和官方 agent 循环职责重复(重试、中断、上下文、会话都没有)。
 * 这里改成:用 `agentLoop.createAgent` 建子 Agent,在它的上下文里注册
 * 本插件需要的 5 个工具并限制工具面,然后把任务交给官方循环跑完。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runSkillScript } from './skill-runner.js';
import { readSheets, workbookToText } from './skill-compare.js';
import { SKILL_AGENT_SYSTEM_PROMPT, SKILL_AGENT_TOOLS } from './skill-agent.js';

const TEXT_LIMIT = 20000;

function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

/** 工具的返回值形状对官方执行器都一致:值 + 渲染出来的内容。 */
function outputOf(render) {
  return {
    schema: { type: 'object' },
    render: (_args, value) => textBlock(render ? render(value) : (value?.text ?? '')),
  };
}

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
      } else out.push(relative);
    }
  };
  walk(root, '', 1);
  return out;
}

/**
 * 用官方 agent 循环跑一次 Skill 对比。
 *
 * @param ctx - 插件所在的 Host Context(需要 agentLoop / tools / systemPrompt)
 * @param provider - 模型路由
 * @param model - 模型名
 * @returns 与 `runSkillAgent` 同形:`{summary, markdown, stats, items, rules, steps, executions, outputs, stopped}`
 */
export async function runSkillWithDshAgent({
  ctx,
  provider,
  model,
  skill,
  skillDir = '',
  oldPath = '',
  newPath = '',
  runDir,
  outDir,
  timeoutMs = 5 * 60_000,
}) {
  const agentLoop = ctx.get('agentLoop');
  const tools = ctx.get('tools');
  if (!agentLoop?.createAgent || !tools?.register) throw new Error('当前 profile 没有挂载 agentLoop/tools,无法复用官方 agent 循环');

  mkdirSync(outDir, { recursive: true });
  const executions = [];
  const steps = [];
  const ranScripts = new Set();
  let finish = null;
  let disposeTools = [];

  const skillFiles = skillDir && existsSync(skillDir) ? listTree(skillDir) : (skill.files ?? []).map((file) => file.path);
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
    const sheets = readSheets(readFileSync(file)).map((sheet) => ({
      name: sheet.name,
      rows: maxRows ? sheet.rows.slice(0, maxRows) : sheet.rows,
      hiddenRows: sheet.hiddenRows,
    }));
    const picked = sheetName ? sheets.filter((sheet) => sheet.name === sheetName) : sheets;
    if (!picked.length) return `没有 sheet:${sheetName}`;
    return workbookToText(picked, { maxRows: maxRows || 300, maxChars: TEXT_LIMIT }).text;
  };

  const definitions = [
    {
      name: 'list_files',
      description: SKILL_AGENT_TOOLS[0].description,
      parameters: SKILL_AGENT_TOOLS[0].parameters,
      output: outputOf(),
      isConcurrencySafe: () => true,
      execute: async (args = {}) => {
        const scope = args.scope ?? 'all';
        const lines = [];
        if (scope !== 'run' && skillDir) lines.push(`技能包(${skillDir}):`, ...listTree(skillDir), '');
        if (scope !== 'skill') lines.push(`运行目录(${runDir}):`, ...listTree(runDir, { depth: 3 }), `产出目录(${outDir}):`, ...listTree(outDir, { depth: 2 }));
        steps.push({ tool: 'list_files', target: '', ok: true });
        return { text: lines.join('\n') || '(空)' };
      },
    },
    {
      name: 'read_file',
      description: SKILL_AGENT_TOOLS[1].description,
      parameters: SKILL_AGENT_TOOLS[1].parameters,
      output: outputOf(),
      isConcurrencySafe: () => true,
      execute: async (args = {}) => {
        const file = resolvePath(args.path);
        if (!file || !existsSync(file)) {
          steps.push({ tool: 'read_file', target: String(args.path ?? ''), ok: false });
          return { text: `文件不存在:${args.path}` };
        }
        const extension = path.extname(file).toLowerCase();
        const text = ['.xlsx', '.xls'].includes(extension)
          ? (readTable(file, args.sheet, args.maxRows) ?? `${args.path} 读不出表格`)
          : readFileSync(file, 'utf8').slice(0, TEXT_LIMIT);
        steps.push({ tool: 'read_file', target: String(args.path ?? ''), ok: true });
        return { text: text || '(空文件)' };
      },
    },
    {
      name: 'run_script',
      description: SKILL_AGENT_TOOLS[2].description,
      parameters: SKILL_AGENT_TOOLS[2].parameters,
      output: outputOf(),
      execute: async (args = {}) => {
        const script = String(args.script ?? '').trim();
        if (!skillDir || !script) return { text: '缺少脚本或技能包未落盘' };
        if (ranScripts.has(script)) {
          return { text: `脚本 ${script} 已执行过,不要重复执行;直接读取产物或调用 finish 收尾。` };
        }
        ranScripts.add(script);
        const execution = await runSkillScript({
          skillDir,
          script,
          oldFile: oldPath,
          newFile: newPath,
          outDir,
          extraArgs: Array.isArray(args.args) ? args.args : [],
        });
        executions.push(execution);
        steps.push({ tool: 'run_script', target: script, ok: execution.code === 0 });
        const lines = [
          `退出码:${execution.code}`,
          execution.stdout ? `stdout:\n${execution.stdout}` : '',
          execution.stderr ? `stderr:\n${execution.stderr}` : '',
          `产出:${(execution.outputs ?? []).map((file) => `${file.name}(${file.size} 字节)`).join(', ') || '(无)'}`,
        ].filter(Boolean);
        for (const file of execution.outputs ?? []) {
          const extension = path.extname(file.name).toLowerCase();
          if (['.xlsx', '.xls'].includes(extension)) {
            const text = readTable(file.path, '', 120);
            if (text) lines.push(`\n${file.name} 内容(前 120 行/页):\n${text.slice(0, 8000)}`);
          } else if (['.csv', '.txt', '.json', '.md', '.tsv'].includes(extension)) {
            lines.push(`\n${file.name} 内容:\n${readFileSync(file.path, 'utf8').slice(0, 6000)}`);
          }
        }
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'write_file',
      description: SKILL_AGENT_TOOLS[3].description,
      parameters: SKILL_AGENT_TOOLS[3].parameters,
      output: outputOf(),
      execute: async (args = {}) => {
        const target = path.join(outDir, path.basename(String(args.name ?? 'output.txt')));
        writeFileSync(target, String(args.content ?? ''), 'utf8');
        steps.push({ tool: 'write_file', target: path.basename(target), ok: true });
        return { text: `已写入 ${target}` };
      },
    },
    {
      name: 'finish',
      description: SKILL_AGENT_TOOLS[4].description,
      parameters: SKILL_AGENT_TOOLS[4].parameters,
      output: outputOf(() => '结论已记录'),
      execute: async (args = {}, exec) => {
        finish = args ?? {};
        steps.push({ tool: 'finish', ok: true });
        exec?.concludeTurn?.();
        return { text: '已记录结论' };
      },
    },
  ];

  const sessionId = randomUUID();
  const userMessage = {
    id: randomUUID(),
    role: 'user',
    time: Date.now(),
    content: textBlock(
      [
        '本次要对比两份船期表:',
        `- 旧版:old(文件名 ${path.basename(oldPath) || '未知'})`,
        `- 新版:new(文件名 ${path.basename(newPath) || '未知'})`,
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
      ].join('\n'),
    ),
    source: { kind: 'user' },
  };

  const handle = await agentLoop.createAgent(ctx, {
    sessionId,
    meta: { cwd: runDir, origin: 'subagent' },
    agentOptions: { provider, model },
    setup: (agentCtx) => {
      // 只保留本次对比需要的工具:官方循环 + 受限工具面。
      for (const definition of definitions) disposeTools.push(agentCtx.tools.register(definition));
      try {
        agentCtx.tools.restrict({ allow: definitions.map((definition) => definition.name) });
      } catch {
        // 限制失败不致命:工具面变大,但流程仍由官方循环驱动。
      }
      // 提示词段落必须注册在这个子 Agent 的上下文里,不能污染全局。
      try {
        disposeTools.push(agentCtx.systemPrompt.section({ name: 'shipping-workbench-skill', order: 900, text: SKILL_AGENT_SYSTEM_PROMPT }));
      } catch {
        /* 注册失败时,任务消息里已经写了同样的流程要求 */
      }
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    handle.agent.followup(userMessage);
    await handle.agent.whenIdle();
  } finally {
    for (const dispose of disposeTools.reverse()) {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
    }
    await handle.dispose?.();
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
    stopped: finish ? 'finish' : 'idle',
    engine: 'dsh-agent-loop',
  };
}