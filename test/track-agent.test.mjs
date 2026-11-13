import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  parseTrackWorkbook,
  buildTrackGroups,
  applyRules,
  buildTrackReport,
  collectFindings,
} from '../src/domain/track.js';
import { DEFAULT_CONGESTION_RULE, enrichWithCongestion } from '../src/domain/congestion.js';
import { LlmChecker } from '../src/domain/llm.js';
import { TrackService } from '../src/domain/track-service.js';
import { WorkbenchDb } from '../src/domain/db.js';
import { DEFAULT_SETTINGS } from '../src/domain/settings.js';

const HEADER = [
  'Rotation ID',
  'Rotation名称',
  '港口英文',
  '五字码',
  '码头名称',
  '航向',
  '航程',
  '开始时间',
  '排序',
  '新旧轨迹',
  '关联船队',
  '港口变更备注',
];

function sheetBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, '轨迹');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** 一行轨迹:累计航程 + 排序,其它列给足,避免触发规则层缺字段。 */
function row(rotationId, portEn, portCode, cumDays, order, version = '新', fleet = 'F1') {
  return [rotationId, '航线', portEn, portCode, '', '', cumDays, '2026-09-01', order, version, fleet, ''];
}

function prepare(rows) {
  const parsed = parseTrackWorkbook(sheetBuffer(rows));
  const groups = applyRules(buildTrackGroups(parsed.records));
  return { parsed, groups };
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-track-agent-'));
}

/** 塞港仓库桩:按五字码返回等泊数据。 */
function congestionStore(map) {
  return { lookup: (code) => map[code] ?? null };
}

test('塞港:航段 1 天 + 等泊 3 天不标红、不出结论,计入 suppressed', () => {
  const { parsed, groups } = prepare([
    row(21, 'A', 'AAAAA', 0, 1),
    row(21, 'B', 'BBBBB', 1, 2),
    row(21, 'C', 'CCCCC', 4, 3),
  ]);
  const hits = enrichWithCongestion(groups, congestionStore({
    BBBBB: { code: 'BBBBB', name: 'B', waitingDays: 3, level: '严重', note: '' },
  }), DEFAULT_CONGESTION_RULE);
  assert.equal(hits, 1);
  const [segment] = groups[0].segments;
  assert.equal(segment.days, 1);
  assert.deepEqual(segment.issues, [], '1 天内不产生规则/塞港 issue');
  assert.ok(!segment.suspicious, '1 天内不标可疑');
  assert.equal(segment.suppressed, true, '打上被抑制标记');
  assert.equal(segment.congestion.waitingDays, 3, '塞港数据仍挂在 segment 上供 prompt 使用');

  const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: 1 });
  assert.deepEqual(findings, [], '不产生结论');
  assert.equal(suppressed, 1, '计入被抑制数量');

  const report = buildTrackReport(parsed, groups, { findings, suppressed });
  assert.equal(report.stats.flagged, 0, '不标红');
  assert.deepEqual(report.findings, []);
  assert.equal(report.stats.suppressed, 1);
});

test('塞港:航段 3 天 + 等泊 6 天标红并产出 congestion 结论', () => {
  const { parsed, groups } = prepare([
    row(22, 'A', 'AAAAA', 0, 1),
    row(22, 'B', 'BBBBB', 3, 2),
    row(22, 'C', 'CCCCC', 9, 3),
  ]);
  enrichWithCongestion(groups, congestionStore({
    BBBBB: { code: 'BBBBB', name: 'B', waitingDays: 6, level: '严重', note: '' },
  }), DEFAULT_CONGESTION_RULE);
  const [segment] = groups[0].segments;
  assert.equal(segment.days, 3);
  assert.ok(segment.suspicious, '超过 1 天要标可疑');
  assert.ok(segment.issues.some((issue) => issue.type === 'congestion'));

  const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: 1 });
  assert.equal(suppressed, 0);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'congestion');
  assert.equal(String(findings[0].rotationId), '22');
  assert.equal(findings[0].fromOrder, 1);
  assert.equal(findings[0].toOrder, 2);
  assert.equal(findings[0].days, 3);
  assert.match(findings[0].reason, /等泊约 6 天/);

  const report = buildTrackReport(parsed, groups, { findings, suppressed });
  assert.equal(report.stats.flagged, 1);
  const rotationColumn = HEADER.indexOf('Rotation ID');
  assert.ok(report.sheets[0].rows.every((item) => item.red.includes(rotationColumn)), 'Rotation ID 整列标红');
  assert.match(report.sheets[0].rows.find((item) => item.comment).comment, /等泊约 6 天/);
});

test('模型:1 天段被抑制、3 天段生效,结论与统计同步', () => {
  const { groups } = prepare([
    row(31, 'A', 'AAAAA', 0, 1),
    row(31, 'B', 'BBBBB', 1, 2),
    row(31, 'C', 'CCCCC', 4, 3),
  ]);
  const checker = new LlmChecker(tempHome(), {});
  const result = new Map([
    [`31|新`, [
      { from: 1, to: 2, days: 1, reason: '偏长', confidence: 0.9 },
      { from: 2, to: 3, days: 3, reason: '明显偏长', confidence: 0.8 },
    ]],
  ]);
  const outcome = checker.applySuspicious(groups, result, { suppressWithinDays: 1 });
  assert.deepEqual(outcome, { applied: 1, suppressed: 1 });

  const [shortSegment, longSegment] = groups[0].segments;
  assert.ok(!shortSegment.suspicious, '1 天段不标可疑');
  assert.equal(shortSegment.suppressed, true);
  assert.ok(longSegment.suspicious, '3 天段生效');
  assert.equal(longSegment.reason, '明显偏长');
  assert.equal(longSegment.confidence, 0.8);
  assert.ok(longSegment.issues.some((issue) => issue.type === 'llm'));

  const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: 1 });
  assert.equal(suppressed, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'agent');
  assert.equal(findings[0].days, 3);
  assert.equal(findings[0].confidence, 0.8);
});

test('模型:prompt 带上塞港等泊天数与口径说明,系统提示要求纳入考虑', async () => {
  const { groups } = prepare([
    row(41, 'A', 'AAAAA', 0, 1),
    row(41, 'B', 'BBBBB', 3, 2),
    row(41, 'C', 'CCCCC', 9, 3),
  ]);
  enrichWithCongestion(groups, congestionStore({
    BBBBB: { code: 'BBBBB', name: 'B', waitingDays: 3, level: '严重', note: '' },
  }), DEFAULT_CONGESTION_RULE);

  const checker = new LlmChecker(tempHome(), {});
  const prompt = checker.buildPrompt(groups[0]);
  assert.match(prompt, /塞港数据为到港等泊天数,判断时要把等泊算进航段时间/);
  assert.match(prompt, /目的港等泊 3 天\(等级:严重\)/);

  const captured = [];
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
    llm: {
      async *stream(request) {
        captured.push(request);
        yield { type: 'text-delta', text: JSON.stringify({ results: [{ rotation: '41|新', suspicious: [] }] }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  const fake = new LlmChecker(tempHome(), ctx);
  const checked = await fake.check(groups);
  assert.equal(checked.skipped, false);
  assert.equal(captured.length, 1);
  assert.match(captured[0].system, /塞港等泊数据会一起给到,判断时纳入考虑/);
  assert.match(captured[0].messages[0].content[0].text, /目的港等泊 3 天/);
});

/** 手工拼一条结论用的 segment,避免为纯排序测试造表。 */
function segment({
  fromOrder,
  toOrder,
  days,
  issues = [],
  suspicious = false,
  suppressed = false,
  reason = '',
  confidence = null,
}) {
  return {
    fromOrder,
    toOrder,
    fromPort: `P${fromOrder}`,
    toPort: `P${toOrder}`,
    fromDays: fromOrder - 1,
    toDays: fromOrder - 1 + days,
    days,
    issues,
    suspicious,
    suppressed,
    reason,
    confidence,
  };
}

function fakeGroup(rotationId, segments, version = '新') {
  return {
    key: `${rotationId}|${version}`,
    rotationId,
    rotationName: '航线',
    version,
    rows: [],
    skipped: false,
    segments,
  };
}

test('collectFindings:规则错误始终收集、同段去重、按 Rotation/版本/顺序排序', () => {
  const groups = [
    fakeGroup(10, [
      // 同时有规则错误与塞港 issue:只出一条,且优先级 rule
      segment({
        fromOrder: 1,
        toOrder: 2,
        days: 3,
        issues: [
          { type: 'negative', label: '累计航程回退', severity: 'error' },
          { type: 'congestion', label: '塞港', severity: 'error' },
        ],
        suspicious: true,
        reason: '塞港理由',
      }),
      // 上游未抑制但天数在窗口内:不收集,计入 suppressed
      segment({
        fromOrder: 2,
        toOrder: 3,
        days: 1,
        issues: [{ type: 'congestion', label: '塞港', severity: 'error' }],
        suspicious: true,
      }),
      // 塞港 + 模型同时可疑:只出一条 congestion
      segment({
        fromOrder: 3,
        toOrder: 4,
        days: 5,
        issues: [
          { type: 'congestion', label: '塞港', severity: 'error' },
          { type: 'llm', label: '模型判为可疑', severity: 'warning' },
        ],
        suspicious: true,
        reason: '塞港理由',
      }),
    ]),
    fakeGroup(2, [
      segment({
        fromOrder: 6,
        toOrder: 7,
        days: 0,
        issues: [{ type: 'missing-code', label: '缺少五字码', severity: 'error' }],
      }),
      segment({
        fromOrder: 1,
        toOrder: 2,
        days: 4,
        issues: [{ type: 'llm', label: '模型判为可疑', severity: 'warning' }],
        suspicious: true,
        reason: '模型理由',
        confidence: 0.7,
      }),
    ]),
    fakeGroup(2, [segment({ fromOrder: 1, toOrder: 2, days: 9, issues: [{ type: 'missing-port', label: '缺少港口英文', severity: 'error' }] })], '旧'),
    { ...fakeGroup(99, []), skipped: true },
  ];

  const { findings, suppressed } = collectFindings(groups, { suppressWithinDays: 1 });
  assert.equal(suppressed, 1);
  // Rotation ID 自然序:2 排在 10 前面;同一组内按 fromOrder 升序。
  const order = (prefix) =>
    findings.filter((finding) => `${finding.rotationId}|${finding.version}` === prefix).map((finding) => finding.fromOrder);
  assert.deepEqual(order('2|新'), [1, 6], '组内按 fromOrder 排序');
  assert.deepEqual(order('2|旧'), [1]);
  assert.deepEqual(order('10|新'), [1, 3]);
  assert.equal(String(findings[0].rotationId), '2', 'Rotation ID 按数值自然序');
  assert.equal(String(findings.at(-1).rotationId), '10');
  const keys = findings.map((finding) => `${finding.rotationId}|${finding.version}|${finding.fromOrder}->${finding.toOrder}`);
  const byKey = new Map(keys.map((key, index) => [key, findings[index]]));
  assert.equal(byKey.get('10|新|1->2').kind, 'rule', '规则优先于塞港');
  assert.match(byKey.get('10|新|1->2').reason, /累计航程回退/);
  assert.equal(byKey.get('10|新|3->4').kind, 'congestion');
  assert.equal(byKey.get('2|新|1->2').kind, 'agent');
  assert.equal(byKey.get('2|新|1->2').confidence, 0.7);
  assert.equal(byKey.get('2|新|6->7').kind, 'rule');
  assert.equal(byKey.get('2|旧|1->2').kind, 'rule');
  assert.ok(findings.every((finding) => finding.rotationId !== 99), '跳过的组不出结论');
});

test('settings 默认开 1 天抑制窗口', () => {
  assert.equal(DEFAULT_SETTINGS.track.suppressWithinDays, 1);
});

test('TrackService:report 直接带 findings 与 stats.suppressed(旧记录重建同口径)', async () => {
  const home = tempHome();
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  try {
    const congestion = congestionStore({
      BBBBB: { code: 'BBBBB', name: 'B', waitingDays: 3, level: '严重', note: '' },
    });
    const llm = {
      availability: () => ({ available: false, reason: '测试环境没有模型' }),
      check: async () => ({ skipped: true, reason: '测试环境没有模型' }),
      apply: () => ({ applied: 0, suppressed: 0 }),
    };
    const settings = { read: () => ({ track: { suppressWithinDays: 1 } }) };
    const service = new TrackService(db, home, congestion, llm, settings);
    const buffer = sheetBuffer([
      row(51, 'A', 'AAAAA', 0, 1),
      row(51, 'B', 'BBBBB', 1, 2),
      row(51, 'C', 'CCCCC', 4, 3),
      row(51, 'D', 'DDDDD', 2, 4),
    ]);
    const report = await service.run(buffer, { filename: 's.xlsx', useLlm: false });
    assert.equal(report.stats.suppressed, 1, '1 天段的塞港可疑被抑制');
    assert.equal(report.findings.length, 1, '累计航程回退仍进结论');
    assert.equal(report.findings[0].kind, 'rule');

    // 旧格式记录:重建后同样有 findings / suppressed
    const id = report.id;
    fs.writeFileSync(
      path.join(home, 'track', 'runs', id, 'report.json'),
      JSON.stringify({ id, filename: 's.xlsx', formatVersion: 1 }),
    );
    const rebuilt = service.getReport(id);
    assert.equal(rebuilt.formatVersion, 2);
    assert.equal(rebuilt.stats.suppressed, 1);
    assert.equal(rebuilt.findings.length, 1);
    assert.equal(rebuilt.findings[0].kind, 'rule');
  } finally {
    db.close();
  }
});
