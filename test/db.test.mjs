import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchDb } from '../src/domain/db.js';

function freshDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-db-'));
  return { home, db: new WorkbenchDb(path.join(home, 'workbench.db')) };
}

test('首次启动内置公众号与船东,重开不重复', () => {
  const { home, db } = freshDb();
  assert.equal(db.listAccounts().length, 3);
  assert.equal(db.listCarriers().length, 8);
  const carriers = db.listCarriers();
  assert.ok(carriers.every((carrier) => carrier.keyColumns.length > 0));
  assert.ok(carriers.some((carrier) => carrier.id === 'matson' && carrier.format === 'pdf'));
  db.close();
  const reopened = new WorkbenchDb(path.join(home, 'workbench.db'));
  assert.equal(reopened.listAccounts().length, 3);
  assert.equal(reopened.listCarriers().length, 8);
  reopened.close();
});

test('文章按账号与时间查询', () => {
  const { db } = freshDb();
  const [account] = db.listAccounts();
  db.upsertArticle({
    accountId: account.id,
    key: '1-1',
    title: '旧文',
    url: 'https://mp.weixin.qq.com/s/a',
    publishedAt: 1000,
    summary: 's',
    html: '<p>a</p>',
  });
  db.upsertArticle({
    accountId: account.id,
    key: '2-1',
    title: '新文',
    url: 'https://mp.weixin.qq.com/s/b',
    publishedAt: 2000,
    summary: 's',
    html: '<p>b</p>',
  });
  const page = db.listArticles({ limit: 10 });
  assert.deepEqual(page.items.map((row) => row.title), ['新文', '旧文']);
  assert.equal(page.total, 2);
  assert.equal(page.items[0].accountName, account.name);
  assert.equal(db.getArticle(account.id, '2-1').html, '<p>b</p>');
  assert.equal(db.listArticles({ limit: 10, since: 1500 }).total, 1);
  assert.equal(db.listArticles({ limit: 10, q: '旧' }).total, 1, '按标题搜索');
  assert.equal(db.listArticles({ limit: 1, offset: 1 }).items[0].title, '旧文', '分页');
  assert.equal(db.listAccounts()[0].articleCount, 2);
  db.close();
});

test('对比任务记录可写入、按类型查询、可删除', () => {
  const { db } = freshDb();
  db.insertRun({
    id: 'r1',
    kind: 'track',
    title: '轨迹.xls',
    source: 'upload',
    inputs: { filename: '轨迹.xls' },
    stats: { groups: 2, flagged: 1 },
    detail: { llm: { skipped: true } },
  });
  db.insertRun({ id: 'r2', kind: 'schedule', title: 'PIL · 旧 → 新', stats: { added: 1 } });
  assert.equal(db.listRuns({ limit: 10 }).total, 2);
  assert.deepEqual(db.listRuns({ kind: 'track' }).items.map((run) => run.id), ['r1']);
  assert.equal(db.listRuns({ q: '轨迹' }).total, 1, '按标题搜索');
  assert.equal(db.listRuns({ limit: 1, offset: 1 }).items.length, 1, '分页');
  const run = db.getRun('r1');
  assert.equal(run.stats.flagged, 1);
  assert.equal(run.detail.llm.skipped, true);
  db.removeRun('r1');
  assert.equal(db.listRuns({ limit: 10 }).total, 1);
  db.close();
});

test('塞港数据落库并可按五字码查', () => {
  const { db } = freshDb();
  db.upsertPorts([{ code: 'uslax', name: 'Los Angeles', waitingDays: 6, level: 'high' }], 'manual');
  assert.equal(db.getPort('USLAX').waitingDays, 6);
  assert.equal(db.congestionMeta().count, 1);
  assert.equal(db.congestionSource(), 'manual');
  db.close();
});

test('版本指针:每次入库版本号递增,可查历史', () => {
  const { db } = freshDb();
  const carrier = db.listCarriers().find((item) => item.id === 'matson');
  assert.equal(db.latestVersion(carrier.id), null);
  const first = db.insertVersion({ carrierId: carrier.id, filename: 'a.xlsx', source: 'mail', filePath: '/tmp/a', rowCount: 3 });
  const second = db.insertVersion({ carrierId: carrier.id, filename: 'b.xlsx', source: 'mail', filePath: '/tmp/b', rowCount: 4 });
  assert.equal(first.versionNo, 1);
  assert.equal(second.versionNo, 2);
  assert.equal(db.latestVersion(carrier.id).filename, 'b.xlsx');
  assert.deepEqual(db.listVersions(carrier.id).map((v) => v.versionNo), [2, 1]);
  db.attachRunToVersion(carrier.id, 'run-1');
  assert.equal(db.latestVersion(carrier.id).runId, 'run-1');
  db.close();
});
