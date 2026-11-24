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
  parseSkillResult,
  workbookToText,
} from '../src/domain/skill-compare.js';

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