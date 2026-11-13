import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  buildDigestPrompt,
  buildMappingPrompt,
  inspectStructure,
  mappingToOverride,
  needsModelHelp,
  parseMapping,
  proposeMapping,
  writeDigest,
} from '../src/domain/schedule-agent.js';

function workbookBuffer(rows, name = 'S') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const STANDARD = [
  ['始发港', 'SVC', '船名', '航次', '开航日期'],
  ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2026-12-01'],
  ['NINGBO', 'AAS', 'MSC BOB', '002E', '2026-12-03'],
];

// 船东换了模板:字段名全变了,靠关键词还能认出表头行,但键列对不上。
// 真正认不出的表头:内置别名字段表也匹配不到,才需要模型给映射。
const RENAMED = [
  ['A港', 'B线', 'C船', 'D次', 'E日'],
  ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2026-12-01'],
  ['NINGBO', 'AAS', 'MSC BOB', '002E', '2026-12-03'],
];

test('标准表头:结构对得上,不需要模型', () => {
  const inspection = inspectStructure(workbookBuffer(STANDARD), {});
  assert.equal(inspection.ok, true);
  assert.deepEqual(inspection.missing, []);
  assert.equal(inspection.dateMissing, false);
  assert.equal(needsModelHelp(inspection), false);
});

test('换了模板:键列对不上,要求模型介入', () => {
  const inspection = inspectStructure(workbookBuffer(RENAMED), {});
  assert.equal(inspection.ok, true);
  assert.ok(inspection.missing.length > 0, '应认出缺失的键列');
  assert.equal(needsModelHelp(inspection), true);
  assert.ok(inspection.sampleRows.length >= 2);
});

test('空文件给出可读原因,而不是空结果', () => {
  const buffer = workbookBuffer([[]]);
  const inspection = inspectStructure(buffer, {});
  assert.equal(inspection.ok, false);
  assert.ok(inspection.reason.length > 0);
});

test('映射提示词带上表头与样例,模型知道该选哪列', () => {
  const inspection = inspectStructure(workbookBuffer(RENAMED), {});
  const prompt = buildMappingPrompt({ carrier: { name: 'PIL 广州' }, inspection });
  assert.ok(prompt.includes('PIL 广州'));
  assert.ok(prompt.includes('起运港'));
  assert.ok(prompt.includes('第1行'));
  assert.ok(prompt.includes('当前对不上的字段'));
});

test('解析模型映射:只保留表头里真实存在的列', () => {
  const header = ['起运港', '航线代码', '船舶名称', '航次号', '离港日'];
  const reply = JSON.stringify({
    columns: {
      始发港: '起运港',
      SVC: '航线代码',
      船名: '船舶名称',
      航次: '航次号',
      开航日期: '离港日',
      不存在的字段: '编造的列',
    },
    note: '按列名语义对应',
  });
  const mapping = parseMapping(reply, header);
  assert.equal(mapping.columns['始发港'], '起运港');
  assert.equal(mapping.columns['不存在的字段'], undefined);
  assert.equal(mapping.note, '按列名语义对应');
});

test('模型给空映射或坏 JSON 时返回 null,调用方退回原配置', () => {
  assert.equal(parseMapping('{"columns":{}}', ['A']), null);
  assert.equal(parseMapping('这不是 JSON', ['A']), null);
  assert.equal(parseMapping('{"columns":{"始发港":"B"}}', ['A']), null);
});

test('映射转成 profile 覆盖:键留标准字段名,列名走候选', () => {
  const override = mappingToOverride({
    columns: { 始发港: '起运港', SVC: '航线代码', 船名: '船舶名称', 航次: '航次号', 开航日期: '离港日' },
  });
  // 键必须是标准字段名:旧版文件的表头是「始发港」,换成「起运港」就解析不到。
  assert.deepEqual(override.fields, ['始发港', 'SVC', '船名', '航次']);
  assert.equal(override.columns['始发港'], '起运港');
  assert.equal(override.dateColumn, '离港日');
});

test('没有模型时不调模型,直接返回 null', async () => {
  let called = false;
  const llm = {
    availability: () => ({ available: false, reason: '没有模型' }),
    complete: async () => {
      called = true;
      return '';
    },
  };
  const inspection = inspectStructure(workbookBuffer(RENAMED), {});
  const mapping = await proposeMapping({ llm, inspection });
  assert.equal(mapping, null);
  assert.equal(called, false);
});

test('有模型时把回复转成映射', async () => {
  const inspection = inspectStructure(workbookBuffer(RENAMED), {});
  const llm = {
    availability: () => ({ available: true, provider: 'p', model: 'm' }),
    complete: async () =>
      JSON.stringify({
        columns: { 始发港: 'A港', SVC: 'B线', 船名: 'C船', 航次: 'D次', 开航日期: 'E日' },
        note: '语义对应',
      }),
  };
  const mapping = await proposeMapping({ llm, inspection });
  assert.equal(mapping.columns['始发港'], 'A港');
});

test('摘要提示词包含统计与变更明细', () => {
  const prompt = buildDigestPrompt({
    carrier: { name: 'PIL 广州' },
    stats: { added: 2, removed: 1, changed: 3, skipped: 5 },
    summary: [{ sheet: '美西', status: '变更', key: 'SHANGHAI^AAS', changes: ['开航日期'] }],
  });
  assert.ok(prompt.includes('PIL 广州'));
  assert.ok(prompt.includes('新增 2 行'));
  assert.ok(prompt.includes('[变更] 美西 SHANGHAI^AAS'));
});

test('摘要失败不影响对比:返回空串而不是抛错', async () => {
  const llm = {
    availability: () => ({ available: true }),
    complete: async () => {
      throw new Error('模型挂了');
    },
  };
  const digest = await writeDigest({ llm, stats: { changed: 1 }, summary: [] });
  assert.equal(digest, '');
});

test('没有模型时不写摘要', async () => {
  const digest = await writeDigest({
    llm: { availability: () => ({ available: false }) },
    stats: { changed: 1 },
    summary: [{ status: '变更', key: 'x' }],
  });
  assert.equal(digest, '');
});
