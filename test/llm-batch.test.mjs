import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupAnswer, normalizeAnswers, parseBatchSuspicious } from '../src/domain/llm.js';

test('批量回复按 rotation 键回填,兼容只写 ID 的情况', () => {
  const answers = parseBatchSuspicious(
    '```json\n{"results":[{"rotation":"418|新","suspicious":[{"from":1,"to":2,"days":3,"reason":"x","confidence":0.8}]},{"rotation":"5","suspicious":[]}]}\n```',
  );
  const normalized = normalizeAnswers(answers);
  const hit = lookupAnswer(normalized, { rotationId: '418', version: '新' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].from, 1);
  const byId = lookupAnswer(normalized, { rotationId: '5', version: '旧' });
  assert.deepEqual(byId, []);
  assert.equal(lookupAnswer(normalized, { rotationId: '999', version: '新' }), null);
});

test('坏 JSON 不会抛错,返回空映射', () => {
  assert.deepEqual(parseBatchSuspicious('not json'), {});
  assert.deepEqual(parseBatchSuspicious(''), {});
});
