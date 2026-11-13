import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { WorkbenchDb } from '../src/domain/db.js';
import { ScheduleService, buildReviewItems } from '../src/domain/schedule-service.js';
import { buildReviewPrompt, parseReview } from '../src/domain/schedule-agent.js';

const MAPPING_REPLY = JSON.stringify({
  columns: { 始发港: 'A港', SVC: 'B线', 船名: 'C船', 航次: 'D次', 开航日期: 'E日' },
  note: '按语义对应',
});

function xlsx(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '美西');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

/** 假模型:映射请求回映射,复核请求回「第 1 条噪声、第 2 条真实」。 */
function fakeLlm({ available = true, review = true } = {}) {
  const calls = [];
  return {
    calls,
    availability: () =>
      available ? { available: true, provider: 'stub', model: 'stub-model' } : { available: false, reason: '没有模型' },
    complete: async ({ system = '', prompt = '' } = {}) => {
      calls.push(system.includes('复核') ? 'review' : 'mapping');
      if (system.includes('复核')) {
        if (!review) return '这不是 JSON';
        return JSON.stringify({
          reviews: [
            { i: 1, verdict: 'noise', reason: '日期格式不同' },
            { i: 2, verdict: 'real', reason: '开航日挪了' },
          ],
        });
      }
      return MAPPING_REPLY;
    },
  };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-auto-'));
}

const HEADER = ['A港', 'B线', 'C船', 'D次', 'E日'];
const OLD_ROWS = [
  HEADER,
  ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
  ['NINGBO', 'AAS', 'MSC BOB', '002E', '2099-12-03'],
];
const NEW_ROWS = [
  HEADER,
  // 同一天,只是日期格式不同 → 噪声
  ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099/12/01'],
  // 开航日真的挪了 → 真实变更
  ['NINGBO', 'AAS', 'MSC BOB', '002E', '2099-12-08'],
];

test('自动表头映射:认不出的模板直接问模型,不再要人确认', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const llm = fakeLlm();
  const service = new ScheduleService(db, home, llm);
  const record = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  assert.equal(record.mappings.old.columns['始发港'], 'A港');
  assert.equal(record.mappings.new.columns['开航日期'], 'E日');
  assert.equal(record.mapped, true);
  assert.ok(record.stats.changed >= 2, JSON.stringify(record.stats));
  // 映射 + 复核各调一次模型
  assert.deepEqual(llm.calls.filter((kind) => kind === 'mapping').length, 2);
});

test('自动复核:变更清单交给模型分真实变更 / 噪声', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const llm = fakeLlm();
  const service = new ScheduleService(db, home, llm);
  const record = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  assert.ok(record.agentReview, '应有 Agent 复核结论');
  assert.equal(record.agentReview.checked, 2);
  assert.equal(record.agentReview.noise, 1);
  assert.equal(record.agentReview.real, 1);
  assert.equal(record.agentReview.reviews[0].verdict, 'noise');
  assert.equal(record.agentReview.items[1].from, '2099-12-03');
  assert.equal(record.agentReview.items[1].to, '2099-12-08');
});

test('没有模型时:映射与复核都跳过,对比仍然出结果', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, fakeLlm({ available: false }));
  const record = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  assert.equal(record.mappings.old, null);
  assert.equal(record.agentReview, null);
  assert.ok(record.stats, '对比结果本身不能受影响');
});

test('模型复核返回坏 JSON 时按「全部真实」兜底', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, fakeLlm({ review: false }));
  const record = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  assert.equal(record.agentReview.noise, 0);
  assert.equal(record.agentReview.real, record.agentReview.checked);
});

test('复核清单只取有变化的行,并带上 旧 → 新', () => {
  const result = {
    mode: 'profile',
    sheets: [
      {
        name: '美西',
        header: ['始发港', 'SVC', '船名', '航次', '开航日期'],
        keyColumns: ['始发港', 'SVC', '船名', '航次'],
        oldRows: [
          { status: '变更', cells: ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2026-12-01'], changes: [{ column: '开航日期', from: '2026-12-01', to: '2026-12-03' }] },
          { status: '', cells: ['NINGBO', 'AAS', 'MSC BOB', '002E', '2026-12-03'], changes: [] },
          { status: '删除', cells: ['SHEKOU', 'AAS', 'MSC C', '003E', '2026-12-05'], changes: [] },
        ],
        newRows: [
          { status: '新增', cells: ['NANSHA', 'AAS', 'MSC D', '004E', '2026-12-09'], changes: [] },
        ],
      },
    ],
  };
  const items = buildReviewItems(result);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => [item.status, item.key, item.field, item.from, item.to]),
    [
      ['变更', 'SHANGHAI/AAS/MSC ANA/001E', '开航日期', '2026-12-01', '2026-12-03'],
      ['删除', 'SHEKOU/AAS/MSC C/003E', '', '', ''],
      ['新增', 'NANSHA/AAS/MSC D/004E', '', '', ''],
    ],
  );
});

test('复核 prompt 带船东、统计与逐条变更;解析只认清单内的序号', () => {
  const prompt = buildReviewPrompt({
    carrier: { name: 'PIL 广州' },
    stats: { added: 1, removed: 2, changed: 3 },
    items: [{ sheet: '美西', status: '变更', key: 'SHANGHAI/AAS', field: '开航日期', from: '11-01', to: '11-03' }],
  });
  assert.ok(prompt.includes('PIL 广州'));
  assert.ok(prompt.includes('新增 1、删除 2、变更 3'));
  assert.ok(prompt.includes('#1 [变更] 美西 SHANGHAI/AAS 开航日期: 11-01 → 11-03'));

  const map = parseReview(
    JSON.stringify({
      reviews: [
        { i: 1, verdict: 'noise', reason: '格式' },
        { i: 9, verdict: 'real', reason: '越界' },
      ],
    }),
    1,
  );
  assert.equal(map.get(0).verdict, 'noise');
  assert.equal(map.has(8), false);
});

test('重新对比:用留存的源文件重跑,生成一条新记录', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, fakeLlm());
  const first = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  const again = await service.recompare(first.id);
  assert.notEqual(again.id, first.id);
  assert.equal(again.oldName, first.oldName);
  assert.equal(again.newName, first.newName);
  assert.equal(again.carrierId, first.carrierId);
  assert.deepEqual(again.stats, first.stats);
  assert.ok(again.agentReview, '重新对比也会重新做复核');
});

test('重新对比:源文件已丢失时给可读的 409', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const service = new ScheduleService(db, home, fakeLlm());
  const record = await service.run({
    oldBuffer: xlsx(OLD_ROWS),
    oldName: 'v1.xlsx',
    newBuffer: xlsx(NEW_ROWS),
    newName: 'v2.xlsx',
    carrierId: 'pil-guangzhou',
    wantDigest: false,
  });
  const dir = service.runDir(record.id);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('old-') || name.startsWith('new-')) fs.rmSync(path.join(dir, name));
  }
  await assert.rejects(() => service.recompare(record.id), (error) => error.status === 409);
});
