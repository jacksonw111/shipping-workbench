import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { WorkbenchDb } from '../src/domain/db.js';
import { ScheduleService } from '../src/domain/schedule-service.js';
import {
  buildSkillPrompt,
  parseSkillFile,
  parseSkillPackage,
  parseSkillResult,
  safeEntryPath,
  skillMeta,
  workbookToText,
} from '../src/domain/skill-compare.js';
import { buildZip } from '../src/util/zip.js';
import { detectEntryScript } from '../src/domain/skill-runner.js';

function xlsx(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '美西');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const OLD_ROWS = [
  ['船名', '航次', '开航日期'],
  ['MSC ANA', '001E', '2026-12-01'],
  ['MSC BOB', '002E', '2026-12-03'],
];
const NEW_ROWS = [
  ['船名', '航次', '开航日期'],
  ['MSC ANA', '001E', '2026-12-02'],
  ['MSC CAT', '003E', '2026-12-09'],
];

const SKILL = `---
name: 简单船名航次对比
description: 按船名+航次配对,比较开航日期
---

# 简单船名航次对比

1. 用「船名 + 航次」配对。
2. 只比较开航日期。
3. 新有旧无=新增,旧有新无=删除,值不同=变更。
`;

test('解析 Skill:front-matter 取名字,正文保留', () => {
  const skill = parseSkillFile(Buffer.from(`\uFEFF${SKILL}`), 'demo.md');
  assert.equal(skill.name, '简单船名航次对比');
  assert.match(skill.description, /按船名\+航次配对/);
  assert.match(skill.body, /只比较开航日期/);
  assert.equal(skill.filename, 'demo.md');
});

test('解析 Skill:没有 front-matter 时用一级标题;空文件报错', () => {
  const skill = parseSkillFile(Buffer.from('# 我的技能\n\n按周数对比'), 'x.txt');
  assert.equal(skill.name, '我的技能');
  assert.throws(() => parseSkillFile(Buffer.from(''), 'x.md'), /空的/);
});

test('表格转文本:带表头与编号行,超长会截断', () => {
  const rows = Array.from({ length: 30 }, (_, index) => [`船 ${index}`, `00${index}E`, '2026-12-01']);
  const text = workbookToText([{ name: '美西', header: ['船名', '航次', '开航日期'], rows }], { maxRows: 10 });
  assert.match(text.text, /工作表:美西/);
  assert.match(text.text, /表头: 船名 \| 航次 \| 开航日期/);
  assert.match(text.text, /1\) 船 0 \| 000E \| 2026-12-01/);
  assert.equal(text.truncated, true);
  assert.equal(text.rows, 10);
});

test('提示词:包含 Skill 正文和两份表', () => {
  const skill = parseSkillFile(Buffer.from(SKILL), 'demo.md');
  const { prompt } = buildSkillPrompt({
    skill,
    oldName: 'old.xlsx',
    newName: 'new.xlsx',
    oldWorkbook: [{ name: '美西', header: ['船名'], rows: [['MSC ANA']] }],
    newWorkbook: [{ name: '美西', header: ['船名'], rows: [['MSC BOB']] }],
  });
  assert.match(prompt, /对比技能\(Skill:简单船名航次对比\)/);
  assert.match(prompt, /用「船名 \+ 航次」配对/);
  assert.match(prompt, /旧版文件:old\.xlsx/);
  assert.match(prompt, /MSC ANA/);
  assert.match(prompt, /MSC BOB/);
});

test('解析结果:容忍代码围栏,丢弃非法状态,stats 缺失时现算', () => {
  const parsed = parseSkillResult(
    [
      '```json',
      JSON.stringify({
        summary: '有一条改期,新增一条。',
        items: [
          { sheet: '美西', key: 'MSC ANA/001E', status: '变更', changes: [{ field: '开航日期', from: '12-01', to: '12-02' }] },
          { sheet: '美西', key: 'MSC CAT/003E', status: '新增', changes: [], note: '新航次' },
          { sheet: '美西', key: '坏数据', status: '随便写' },
        ],
        rules: ['船名+航次配对', '只比开航日期'],
      }),
      '```',
    ].join('\n'),
  );
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.stats, { added: 1, removed: 0, changed: 1, sheets: 1 });
  assert.equal(parsed.rules.length, 2);
  assert.equal(parsed.items[0].changes[0].to, '12-02');
});

test('解析结果:空内容返回 null', () => {
  assert.equal(parseSkillResult('这不是 JSON'), null);
  assert.equal(parseSkillResult(JSON.stringify({ summary: '', items: [] })), null);
});

test('服务层:按 Skill 生成对比记录并可导出', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-skill-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const calls = [];
  const llm = {
    availability: () => ({ available: true, provider: 'stub', model: 'stub' }),
    complete: async ({ system, prompt }) => {
      calls.push({ system, prompt });
      return JSON.stringify({
        summary: 'MSC ANA 开航推迟 1 天,另新增 MSC CAT。',
        stats: { added: 1, removed: 0, changed: 1 },
        items: [
          { sheet: '美西', key: 'MSC ANA/001E', status: '变更', changes: [{ field: '开航日期', from: '2026-12-01', to: '2026-12-02' }] },
          { sheet: '美西', key: 'MSC CAT/003E', status: '新增', changes: [], note: '新航次' },
        ],
        rules: ['船名+航次配对'],
      });
    },
  };
  const service = new ScheduleService(db, home, llm);
  const skill = parseSkillFile(Buffer.from(SKILL), 'demo.md');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill,
  });
  assert.equal(record.mode, 'skill');
  assert.equal(record.skill.name, '简单船名航次对比');
  assert.deepEqual(record.stats, { added: 1, removed: 0, changed: 1, skipped: 0, sheets: 1 });
  assert.equal(record.items.length, 2);
  assert.match(calls[0].system, /船期表对比专家/);
  assert.match(calls[0].prompt, /只比较开航日期/);

  const exported = service.exportBuffer(record.id);
  const book = XLSX.read(exported.buffer, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Agent 对比', '摘要']);
  assert.equal(db.getRun(record.id).source, 'skill');
});

test('服务层:没有模型时给可读的 400', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-skill-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, { availability: () => ({ available: false, reason: '没有模型' }) });
  await assert.rejects(
    () =>
      service.compareWithSkill({
        oldBuffer: xlsx(OLD_ROWS),
        oldName: 'old.xlsx',
        newBuffer: xlsx(NEW_ROWS),
        newName: 'new.xlsx',
        skill: parseSkillFile(Buffer.from(SKILL), 'demo.md'),
      }),
    (error) => error.status === 400 && /没有模型/.test(error.message),
  );
});

function skillZip() {
  return buildZip([
    { name: 'SKILL.md', data: SKILL },
    { name: 'references/rule.md', data: '# 细则\n\n周数滚动的旧周不标删除。' },
    { name: 'notes/readme.txt', data: '补充说明:ETD 以当地时间为准。' },
    { name: 'scripts/panda_compare.py', data: 'print("compare")' },
    { name: '../evil.md', data: '越界文件' },
  ]);
}

test('技能包:zip 里找 SKILL.md,收参考资料,列脚本,过滤越界路径', async () => {
  const pkg = await parseSkillPackage(skillZip(), 'panda-skill.zip');
  assert.equal(pkg.kind, 'zip');
  assert.equal(pkg.name, '简单船名航次对比');
  assert.deepEqual(
    pkg.references.map((item) => item.path).sort(),
    ['notes/readme.txt', 'references/rule.md'],
  );
  assert.deepEqual(pkg.scripts, ['scripts/panda_compare.py']);
  assert.ok(!pkg.files.some((file) => file.path.includes('evil')), '越界路径必须被丢掉');
  assert.ok(pkg.files.some((file) => file.path === 'SKILL.md'));

  const meta = skillMeta(pkg);
  assert.equal(meta.kind, 'zip');
  assert.equal(meta.referenceCount, 2);
  assert.equal(meta.scripts.length, 1);
  assert.ok(!('entries' in meta), '接口元信息不带 Buffer');
});

test('safeEntryPath:拒绝绝对路径与 ..', () => {
  assert.equal(safeEntryPath('../a.md'), '');
  assert.equal(safeEntryPath('/etc/passwd'), 'etc/passwd');
  assert.equal(safeEntryPath('a/../../b.md'), '');
  assert.equal(safeEntryPath('a//b/./c.md'), 'a/b/c.md');
});

test('技能包:没有 SKILL.md 报可读错误', async () => {
  const zip = buildZip([{ name: 'readme.md', data: '# 没有技能文档' }]);
  await assert.rejects(() => parseSkillPackage(zip, 'x.zip'), /缺少 SKILL\.md/);
});

test('提示词带上技能包文件清单、参考资料与脚本说明', async () => {
  const pkg = await parseSkillPackage(skillZip(), 'panda-skill.zip');
  const { prompt } = buildSkillPrompt({
    skill: pkg,
    oldName: 'old.xlsx',
    newName: 'new.xlsx',
    oldWorkbook: [{ name: '美西', header: ['船名'], rows: [['MSC ANA']] }],
    newWorkbook: [{ name: '美西', header: ['船名'], rows: [['MSC BOB']] }],
  });
  assert.match(prompt, /技能包文件:SKILL\.md/);
  assert.match(prompt, /本次不执行/);
  assert.match(prompt, /参考资料 =====/);
  assert.match(prompt, /周数滚动的旧周不标删除/);
});

test('服务层:zip 技能包会落盘留档', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-skill-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const llm = {
    availability: () => ({ available: true, provider: 'stub', model: 'stub' }),
    complete: async () => JSON.stringify({ summary: '无变化。', stats: { added: 0, removed: 0, changed: 0 }, items: [] }),
  };
  const service = new ScheduleService(db, home, llm);
  const pkg = await parseSkillPackage(skillZip(), 'panda-skill.zip');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill: pkg,
  });
  assert.equal(record.skill.kind, 'zip');
  assert.equal(record.skill.scripts.length, 1);
  assert.ok(record.skill.dir.includes('skills'));
  assert.ok(fs.existsSync(path.join(record.skill.dir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(record.skill.dir, 'scripts/panda_compare.py')));
  assert.ok(fs.existsSync(path.join(record.skill.dir, 'meta.json')));
});


function scriptZip() {
  return buildZip([
    { name: 'SKILL.md', data: SKILL },
    { name: 'scripts/compare.mjs', data: [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.SKILL_OUT_DIR + '/result.txt', '对比完成');",
      "console.log('script done');",
    ].join('\n') },
  ]);
}

test('入口脚本选择:优先 compare/cmp,跳过 setup 类', () => {
  assert.equal(detectEntryScript({ scripts: ['scripts/setup.py', 'scripts/compare.mjs'] }), 'scripts/compare.mjs');
  assert.equal(detectEntryScript({ scripts: ['scripts/a.sh'] }), null);
});

test('执行技能脚本:产出文件落 out/,可下载', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-run-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, null);
  const pkg = await parseSkillPackage(scriptZip(), 'zim-skill.zip');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill: pkg,
    executeScripts: true,
  });
  assert.equal(record.execution.code, 0, JSON.stringify(record.execution));
  assert.equal(record.outputFiles.length, 1);
  assert.equal(record.outputFiles[0].name, 'result.txt');
  assert.match(record.summary, /已执行技能脚本/);
  const file = service.outputFile(record.id, 'result.txt');
  assert.equal(file.buffer.toString('utf8'), '对比完成');
  assert.throws(() => service.outputFile(record.id, '../result.json'), /不存在/);
});



test('默认行为:技能包有脚本就直接执行,不需要前端传开关', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-run-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, null); // 没有模型也能跑
  const pkg = await parseSkillPackage(scriptZip(), 'zim-skill.zip');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill: pkg,
  });
  assert.equal(record.execution.code, 0, JSON.stringify(record.execution));
  assert.equal(record.outputFiles.length, 1);
});





function agentStub(replies) {
  let index = 0;
  return {
    availability: () => ({ available: true, provider: 'stub', model: 'stub' }),
    streamAgent: async () => {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply;
    },
  };
}

test('没有模型且技能包没有脚本时,给可读的 400', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-run-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, { availability: () => ({ available: false, reason: '没有模型' }) });
  const pkg = await parseSkillPackage(buildZip([{ name: 'SKILL.md', data: SKILL }]), 'text-skill.zip');
  await assert.rejects(
    () =>
      service.compareWithSkill({
        oldBuffer: xlsx(OLD_ROWS),
        oldName: 'old.xlsx',
        newBuffer: xlsx(NEW_ROWS),
        newName: 'new.xlsx',
        skill: pkg,
      }),
    (error) => error.status === 400 && /没有模型/.test(error.message),
  );
});

test('Agent 流程:自己调脚本、自己收尾,记录工具步骤', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-run-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const llm = agentStub([
    { text: '先按 Skill 跑对比脚本', toolCalls: [{ id: 'c1', name: 'run_script', arguments: JSON.stringify({ script: 'scripts/compare.mjs' }) }] },
    {
      text: '',
      toolCalls: [
        {
          id: 'c2',
          name: 'finish',
          arguments: JSON.stringify({
            summary: '脚本产出 NOV-DEC 与 NOV-NOV 两页,NOV 无差异。',
            report: '## 结论\n- NOV-NOV:无差异',
            stats: { added: 0, removed: 0, changed: 0 },
            rules: ['按 Skill 的变动1-4'],
          }),
        },
      ],
    },
  ]);
  const service = new ScheduleService(db, home, llm);
  const pkg = await parseSkillPackage(scriptZip(), 'zim-skill.zip');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill: pkg,
  });
  assert.match(record.summary, /NOV 无差异/);
  assert.match(record.markdown, /NOV-NOV/);
  assert.equal(record.execution.code, 0);
  assert.ok(record.steps.some((step) => step.tool === 'run_script' && step.ok));
  assert.equal(record.outputFiles.length, 1);
  const out = service.outputFile(record.id, 'result.txt');
  assert.equal(out.buffer.toString('utf8'), '对比完成');
});


test('Agent 不会重复执行同一脚本,产物去重', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-run-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const replies = [
    { text: '', toolCalls: [{ id: 'c1', name: 'run_script', arguments: JSON.stringify({ script: 'scripts/compare.mjs' }) }] },
    { text: '', toolCalls: [{ id: 'c2', name: 'run_script', arguments: JSON.stringify({ script: 'scripts/compare.mjs' }) }] },
    { text: '', toolCalls: [{ id: 'c3', name: 'finish', arguments: JSON.stringify({ summary: '同一脚本没有跑第二遍。' }) }] },
  ];
  const llm = agentStub(replies);
  const service = new ScheduleService(db, home, llm);
  const pkg = await parseSkillPackage(scriptZip(), 'zim-skill.zip');
  const record = await service.compareWithSkill({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'old.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'new.xlsx',
    skill: pkg,
  });
  assert.match(record.summary, /同一脚本/);
  assert.equal(record.executions ?? 1, 1);
  assert.equal(record.outputFiles.length, 1);
  assert.equal(record.steps.filter((step) => step.tool === 'run_script').length, 1);
});
