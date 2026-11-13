import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from '../src/domain/track-candidates.js';
import { trackSystemPrompt, BATCH_SYSTEM_PROMPT, LlmChecker } from '../src/domain/llm.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function group(id, segments, { skipped = false } = {}) {
  return {
    key: `${id}|新`,
    rotationId: String(id),
    version: '新',
    skipped,
    rows: [],
    segments: segments.map((item, index) => ({
      index,
      fromOrder: index + 1,
      toOrder: index + 2,
      fromPort: item.from ?? 'PORT A',
      toPort: item.to ?? 'PORT B',
      fromCode: 'CNAAA',
      toCode: 'CNBBB',
      days: item.days,
      rawDays: item.days,
      issues: item.issues ?? [],
      congestion: item.congestion,
    })),
  };
}

test('预筛:规则硬错、塞港冲突、统计异常都会选中,普通组跳过', () => {
  const groups = [
    group(1, [{ days: 3 }]),
    group(2, [{ days: 3, issues: [{ type: 'negative', severity: 'error' }] }]),
    group(3, [{ days: 3, issues: [{ type: 'congestion', severity: 'error' }] }]),
    group(4, [{ days: 40 }]),
    group(5, [{ days: 3 }], { skipped: true }),
  ];
  const result = selectCandidates(groups, { minDays: 18 });
  assert.equal(result.scanned, 4, '跳过未关联船队的组');
  assert.deepEqual(
    result.groups.map((item) => item.rotationId).sort(),
    ['2', '3', '4'],
  );
  assert.ok(result.reasons.rule >= 1);
  assert.ok(result.reasons.congestion >= 1);
  assert.ok(result.reasons.outlier >= 1);
});

test('预筛:相对本航线中位数的异常段也会被选中', () => {
  const groups = [
    group(1, [{ days: 2 }, { days: 2 }, { days: 2 }, { days: 2 }]),
    // 中位数 2,这一段 9 天 → 超过 2.5 倍且高于下限 7
    group(2, [{ days: 2 }, { days: 2 }, { days: 2 }, { days: 9 }]),
  ];
  const result = selectCandidates(groups, { minDays: 30 });
  assert.deepEqual(result.groups.map((item) => item.rotationId), ['2']);
});

test('预筛:候选超过上限时截断并报告', () => {
  const groups = Array.from({ length: 10 }, (_, index) =>
    group(index + 1, [{ days: 3, issues: [{ type: 'negative', severity: 'error' }] }]),
  );
  const result = selectCandidates(groups, { maxCandidates: 4 });
  assert.equal(result.candidates, 4);
  assert.equal(result.truncated, 6);
});

test('提示词:自定义优先,空值回落到内置默认', () => {
  assert.equal(trackSystemPrompt(''), BATCH_SYSTEM_PROMPT);
  assert.equal(trackSystemPrompt('   '), BATCH_SYSTEM_PROMPT);
  assert.equal(trackSystemPrompt('自定义提示词'), '自定义提示词');
});

/** 造一个只会回固定 JSON 的假模型服务。 */
function fakeCtx(reply, capture) {
  return {
    llm: {
      stream: async function* (request) {
        capture?.push(request);
        yield { type: 'text-delta', text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  };
}

test('调用次数按字符预算打包,不是固定几条一组', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-llm-'));
  const requests = [];
  const reply = JSON.stringify({ results: [] });
  const checker = new LlmChecker(home, fakeCtx(reply, requests));
  const groups = Array.from({ length: 30 }, (_, index) =>
    group(index + 1, [{ days: 3, from: `PORT-${index}-AAAAAAAAAA`, to: `PORT-${index}-BBBBBBBBBB` }]),
  );
  const result = await checker.check(groups, { charBudget: 2000, maxCalls: 100, concurrency: 1 });
  assert.equal(result.checked, 30);
  assert.ok(result.calls >= 2, `应拆成多次请求,实际 ${result.calls}`);
  assert.equal(result.requests, result.calls, '第一次跑没有缓存');
  assert.equal(requests.length, result.calls);
});

test('自定义提示词会真的发给模型', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-llm-'));
  const requests = [];
  const checker = new LlmChecker(home, fakeCtx(JSON.stringify({ results: [] }), requests));
  await checker.check([group(1, [{ days: 3 }])], { promptOverride: '只输出可疑段', concurrency: 1 });
  assert.equal(requests[0].system, '只输出可疑段');
});

test('最多请求次数是硬上限,超出部分计入 truncated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-llm-'));
  const checker = new LlmChecker(home, fakeCtx(JSON.stringify({ results: [] })));
  const groups = Array.from({ length: 30 }, (_, index) =>
    group(index + 1, [{ days: 3, from: `PORT-${index}-AAAAAAAAAA`, to: `PORT-${index}-BBBBBBBBBB` }]),
  );
  const result = await checker.check(groups, { charBudget: 2000, maxCalls: 2, concurrency: 1 });
  assert.equal(result.calls, 2);
  assert.ok(result.truncated > 0, '被上限挡掉的组要如实统计');
  assert.ok(result.checked < 30);
});

test('全量模式:所有有效组都进来,并给出覆盖行数', () => {
  const rows = (count) => Array.from({ length: count }, (_, index) => ({ order: index + 1 }));
  const groups = [
    Object.assign(group(1, [{ days: 3 }, { days: 4 }]), { rows: rows(2) }),
    Object.assign(group(2, [{ days: 3 }]), { rows: rows(1) }),
    Object.assign(group(3, [{ days: 3 }], { skipped: true }), { rows: rows(5) }),
  ];
  const result = selectCandidates(groups, { scope: 'all' });
  assert.equal(result.scope, 'all');
  assert.equal(result.candidates, 2);
  assert.equal(result.rows, 3, '组内每一行都算进去');
  assert.equal(result.rowsScanned, 3);
});

test('候选上限填 0 表示不限', () => {
  const groups = Array.from({ length: 10 }, (_, index) =>
    group(index + 1, [{ days: 3, issues: [{ type: 'negative', severity: 'error' }] }]),
  );
  const result = selectCandidates(groups, { maxCandidates: 0 });
  assert.equal(result.candidates, 10);
  assert.equal(result.truncated, 0);
});

test('单个组的 prompt 包含该组每一行挂港', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-llm-'));
  const checker = new LlmChecker(home, {});
  const target = group(7, [{ days: 2 }, { days: 3 }, { days: 4 }]);
  target.rows = [
    { order: 1, portEn: 'NINGBO', portCode: 'CNNGB', cumDays: 12, direction: 'E', terminal: 'T1' },
    { order: 2, portEn: 'BUSAN', portCode: 'KRPUS', cumDays: 14, direction: 'E', terminal: 'T2' },
    { order: 3, portEn: 'LAX', portCode: 'USLAX', cumDays: 28, direction: 'E', terminal: 'T3' },
  ];
  const prompt = checker.buildPrompt(target);
  for (const port of ['NINGBO', 'BUSAN', 'LAX']) assert.ok(prompt.includes(port), `缺 ${port}`);
  assert.ok(prompt.includes('共 3 个挂港'));
});
