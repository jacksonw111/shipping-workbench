import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ATTACHMENT_EXTENSIONS,
  buildSchedulePairs,
  findRunForPair,
  normalizeAttachmentName,
  normalizeSubject,
} from '../src/domain/schedule-pairs.js';
import { ScheduleService } from '../src/domain/schedule-service.js';

const CARRIERS = [
  { id: 'slg', name: 'SLG', match: { subjectIncludes: ['SLG'] } },
  { id: 'nansha', name: 'NANSHA', match: { subjectIncludes: ['NANSHA'] } },
];

/** 造一封邮件:`attachments` 只填文件名,id 按位置生成。 */
function mail(uid, subject, dateIso, ...files) {
  return {
    uid: String(uid),
    subject,
    from: 'ops@example.com',
    date: Date.parse(dateIso),
    attachments: files.map((name, index) => ({ id: `${uid}-${index + 1}`, filename: name })),
  };
}

const iso = (value) => new Date(Date.parse(value)).toISOString();

test('主题/附件名归一化:日期噪声被去掉,同系列能配到一起', () => {
  assert.equal(normalizeSubject('NANSHA Monthly schedule of NOV-20261104'), 'nansha monthly schedule of nov');
  assert.equal(
    normalizeSubject('SLG schedule of NOV-2026-11-04'),
    normalizeSubject('SLG schedule of NOV-20261103'),
  );
  // 03rd / 04th 只是序号,去掉后同一系列。
  assert.equal(normalizeAttachmentName('SLG schedule-Nov 03rd.pdf'), 'slg schedule nov');
  assert.equal(normalizeAttachmentName('SLG schedule-Nov 04th.pdf'), 'slg schedule nov');
  // 括号里是补充说明,不参与系列判定。
  assert.equal(normalizeAttachmentName('SLG schedule (1).xlsx'), 'slg schedule');
  for (const ext of ['xls', 'xlsx', 'pdf', 'zip']) assert.ok(ATTACHMENT_EXTENSIONS.has(ext));
});

test('同一主题两封邮件、附件名带不同日期 → 一行,old/new 与邮件信息取最新', () => {
  const messages = [
    mail('1', 'SLG schedule of NOV-20261103', '2026-11-03T09:00:00Z', 'SLG schedule-Nov 03rd.xlsx'),
    mail('2', 'SLG schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'SLG schedule-Nov 04th.xlsx'),
  ];
  const { rows, unpaired } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.carrierId, 'slg');
  assert.equal(row.carrierName, 'SLG');
  assert.equal(row.subject, 'SLG schedule of NOV-20261104');
  assert.equal(row.emailDate, iso('2026-11-04T09:00:00Z'));
  assert.deepEqual(row.old, {
    uid: '1',
    attachmentId: '1-1',
    name: 'SLG schedule-Nov 03rd.xlsx',
    date: iso('2026-11-03T09:00:00Z'),
  });
  assert.deepEqual(row.new, {
    uid: '2',
    attachmentId: '2-1',
    name: 'SLG schedule-Nov 04th.xlsx',
    date: iso('2026-11-04T09:00:00Z'),
  });
  assert.equal(row.kind, 'excel');
  assert.equal(row.status, 'ready');
  assert.equal(row.reason, '还没对比');
  assert.equal(row.runId, '');
  assert.equal(row.stats, null);
  assert.equal(row.comparedAt, '');
  assert.equal(typeof row.key, 'string');
  assert.ok(row.key.includes('#'));
  assert.deepEqual(unpaired, { count: 0, items: [] });
});

test('同系列三封邮件 → 只取最近两封(且不受传入顺序影响)', () => {
  const messages = [
    mail('3', 'SLG schedule of NOV-20261105', '2026-11-05T09:00:00Z', 'SLG schedule-Nov 05th.xlsx'),
    mail('1', 'SLG schedule of NOV-20261103', '2026-11-03T09:00:00Z', 'SLG schedule-Nov 03rd.xlsx'),
    mail('2', 'SLG schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'SLG schedule-Nov 04th.xlsx'),
  ];
  const { rows } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].old.uid, '2');
  assert.equal(rows[0].new.uid, '3');
  assert.equal(rows[0].subject, 'SLG schedule of NOV-20261105');
});

test('附件名不同的系列不会互配(ASL daily movement 与 LTS)', () => {
  const messages = [
    mail('1', 'ASL daily movement 2026-11-03', '2026-11-03T09:00:00Z', 'ASL daily movement 03.11.2026.xlsx'),
    mail('2', 'ASL daily movement 2026-11-04', '2026-11-04T09:00:00Z', 'ASL daily movement 04.11.2026.xlsx'),
    mail('3', 'LTS schedule 2026-11-03', '2026-11-03T09:00:00Z', 'LTS schedule 03.11.2026.xlsx'),
    mail('4', 'LTS schedule 2026-11-04', '2026-11-04T09:00:00Z', 'LTS schedule 04.11.2026.xlsx'),
  ];
  const { rows, unpaired } = buildSchedulePairs({ messages, carriers: CARRIERS });
  // 两个系列各自成一行,交叉组合不会出现。
  assert.equal(rows.length, 2);
  assert.equal(unpaired.count, 0);
  for (const row of rows) {
    const family = row.new.name.startsWith('ASL') ? 'ASL' : 'LTS';
    assert.ok(row.old.name.startsWith(family));
    assert.ok(row.new.name.startsWith(family));
    // 没配到船东时也要如实留空,不瞎认。
    assert.equal(row.carrierId, '');
  }
});

test('已有同名附件的对比记录 → status done,带 stats/runId/comparedAt', () => {
  const messages = [
    mail('1', 'SLG schedule of NOV-20261103', '2026-11-03T09:00:00Z', 'SLG schedule-Nov 03rd.xlsx'),
    mail('2', 'SLG schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'SLG schedule-Nov 04th.xlsx'),
  ];
  const runs = [
    {
      id: 'run-1',
      // 用户上传时旧/新顺序可能是反的,命中规则要容忍。
      inputs: { oldName: 'SLG schedule-Nov 04th.xlsx', newName: 'SLG schedule-Nov 03rd.xlsx' },
      stats: { added: 1, removed: 2, changed: 3, skipped: 0, sheets: 1 },
      createdAt: '2026-11-05T01:02:03.000Z',
    },
  ];
  const { rows } = buildSchedulePairs({ messages, carriers: CARRIERS, runs });
  const row = rows[0];
  assert.equal(row.status, 'done');
  assert.equal(row.runId, 'run-1');
  assert.deepEqual(row.stats, { added: 1, removed: 2, changed: 3, skipped: 0, sheets: 1 });
  assert.equal(row.comparedAt, '2026-11-05T01:02:03.000Z');
  assert.equal(row.reason, '');
});

test('PDF 两版 → ready,可以进入对比', () => {
  const messages = [
    mail('1', 'NANSHA Monthly schedule of NOV-20261103', '2026-11-03T09:00:00Z', 'NANSHA schedule-Nov 03rd.pdf'),
    mail('2', 'NANSHA Monthly schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'NANSHA schedule-Nov 04th.pdf'),
  ];
  const { rows } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'pdf');
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].reason, '还没对比');
  assert.equal(rows[0].carrierId, 'nansha');
});

test('zip 两版 → unsupported,不假装能对比', () => {
  const messages = [
    mail('1', 'MSC 船期表 2026-11-03', '2026-11-03T09:00:00Z', 'MSC schedule 20261103.zip'),
    mail('2', 'MSC 船期表 2026-11-04', '2026-11-04T09:00:00Z', 'MSC schedule 20261104.zip'),
  ];
  const { rows } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'zip');
  assert.equal(rows[0].status, 'unsupported');
});

test('只有一封的系列不进 rows,只进 unpaired 摘要', () => {
  const messages = [mail('9', 'SLG schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'SLG schedule-Nov 04th.xlsx')];
  const { rows, unpaired } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 0);
  assert.equal(unpaired.count, 1);
  assert.equal(unpaired.items.length, 1);
  assert.equal(unpaired.items[0].name, 'SLG schedule-Nov 04th.xlsx');
});

test('png/jpg 之类的签名附件不参与配对', () => {
  const messages = [
    mail('1', 'SLG schedule of NOV-20261103', '2026-11-03T09:00:00Z', 'signature.png'),
    mail('2', 'SLG schedule of NOV-20261104', '2026-11-04T09:00:00Z', 'signature.jpg'),
  ];
  const { rows, unpaired } = buildSchedulePairs({ messages, carriers: CARRIERS });
  assert.equal(rows.length, 0);
  assert.equal(unpaired.count, 0);
});

test('findRunForPair:正反顺序都命中,不相关/缺名返回 null', () => {
  const runs = [
    { id: 'r1', inputs: { oldName: 'dir/A.xlsx', newName: 'B.xlsx' } },
    { id: 'r2', inputs: { oldName: '其它.xlsx', newName: '别的.xlsx' } },
  ];
  assert.equal(findRunForPair(runs, 'a.xlsx', 'b.xlsx').id, 'r1');
  assert.equal(findRunForPair(runs, 'B.XLSX', 'A.xlsx').id, 'r1');
  assert.equal(findRunForPair(runs, 'a.xlsx', 'c.xlsx'), null);
  assert.equal(findRunForPair(runs, '', ''), null);
  assert.equal(findRunForPair([], 'a.xlsx', 'b.xlsx'), null);
});

/** 造一个只够 compareVersions 错误分支用的假 db,不碰真实数据目录。 */
function fakeDb(overrides = {}) {
  return {
    getCarrier: (id) => ({ id, name: 'SLG' }),
    listVersions: () => [],
    attachRunToVersion: () => null,
    ...overrides,
  };
}

function serviceWith(db) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-pairs-'));
  return { service: new ScheduleService(db, home), home };
}

test('compareVersions:不足两版报 400', async () => {
  const db = fakeDb({ listVersions: () => [{ id: 'v1', filename: 'a.xlsx', filePath: '/tmp/never-a.xlsx' }] });
  const { service, home } = serviceWith(db);
  try {
    await assert.rejects(
      () => service.compareVersions('slg'),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /还没有两版/);
        return true;
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('compareVersions:存档文件丢失报可读 400', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-pairs-'));
  const db = fakeDb({
    listVersions: () => [
      { id: 'v2', filename: 'new.xlsx', filePath: path.join(home, 'missing-new.xlsx'), source: 'mail' },
      { id: 'v1', filename: 'old.xlsx', filePath: path.join(home, 'missing-old.xlsx'), source: 'mail' },
    ],
  });
  const service = new ScheduleService(db, home);
  try {
    await assert.rejects(
      () => service.compareVersions('slg'),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /文件已不在/);
        return true;
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('compareVersions:船东不存在报 404', async () => {
  const db = fakeDb({ getCarrier: () => null });
  const { service, home } = serviceWith(db);
  try {
    await assert.rejects(
      () => service.compareVersions('nope'),
      (error) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
