/**
 * Skill 执行所需的提示词与工具声明。
 *
 * 真正的循环由 DSH 官方 agent 循环驱动(`skill-agent-dsh.js` 负责接入),
 * 这里只放「给模型看什么」,不放执行逻辑,避免再和官方循环重复。
 */
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
