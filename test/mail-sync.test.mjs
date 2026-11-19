import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailService, newMessageUids } from '../src/domain/mail-service.js';
import { SettingsStore } from '../src/domain/settings.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swb-mail-'));
}

function rawMail(subject, body = 'hello') {
  return [
    'From: "Sender" <sender@example.com>',
    `Subject: ${subject}`,
    'Date: Tue, 19 Nov 2026 08:00:00 +0800',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

/** 假的 IMAP 客户端:只实现 fetchRecent 用到的几个方法。 */
function fakeClient({ uids = [], onFetch } = {}) {
  const calls = { search: [], fetch: [] };
  return {
    calls,
    async select() {
      return { lines: [], status: 'OK' };
    },
    async uidSearch(criteria) {
      calls.search.push(criteria);
      return uids;
    },
    async uidFetch(wanted) {
      calls.fetch.push(wanted);
      onFetch?.(wanted);
      return wanted.map((uid) => ({ uid, raw: rawMail(`邮件 ${uid}`, `正文 ${uid}`) }));
    },
    async logout() {},
    socket: { destroy() {} },
  };
}

test('newMessageUids:只留未入库的,并按最新截断', () => {
  const existing = new Set(['1', '2']);
  assert.deepEqual(newMessageUids(['1', '2', '3', '4'], existing, 40), ['3', '4']);
  assert.deepEqual(newMessageUids(['1', '2', '3', '4'], existing, 1), ['4']);
  assert.deepEqual(newMessageUids(['1', '2'], existing, 40), []);
  assert.deepEqual(newMessageUids(undefined, existing, 40), []);
});

test('fetchRecent:只下载没入库的邮件,并给出计时', async () => {
  const home = tempHome();
  const settings = new SettingsStore(home);
  const service = new MailService(home, settings);
  // 先把 uid=1 存进去,模拟历史邮件
  service.storeMessages([{ uid: '1', raw: rawMail('历史邮件') }]);

  const client = fakeClient({ uids: ['1', '2', '3'] });
  service.connectClient = async () => ({ client, endpoint: { host: 'imap.test', port: 993, secure: true } });
  service.login = async () => true;

  const seen = [];
  const result = await service.fetchRecent({ limit: 40, onMessage: (message) => seen.push(message.uid) });
  assert.deepEqual(client.calls.fetch, [['2'], ['3']], '逐封下载,且只下 uid 2、3');
  assert.deepEqual(seen, ['2', '3'], '每入库一封就回调一次(界面逐条显示)');
  assert.equal(result.fetched, 2);
  assert.equal(result.scanned, 3);
  assert.equal(result.skipped, 1);
  assert.ok(result.timings && typeof result.timings.fetch === 'number');
  assert.deepEqual(
    result.newMessages.map((message) => message.uid).sort(),
    ['2', '3'],
  );
});

test('fetchRecent:没有新邮件时完全不发 FETCH', async () => {
  const home = tempHome();
  const service = new MailService(home, new SettingsStore(home));
  service.storeMessages([
    { uid: '1', raw: rawMail('a') },
    { uid: '2', raw: rawMail('b') },
  ]);
  const client = fakeClient({ uids: ['1', '2'] });
  service.connectClient = async () => ({ client, endpoint: { host: 'imap.test', port: 993, secure: true } });
  service.login = async () => true;

  const result = await service.fetchRecent();
  assert.equal(client.calls.fetch.length, 0, '没有新邮件就不该下载正文');
  assert.equal(result.fetched, 0);
  assert.equal(result.skipped, 2);
});

test('storeMessages:批量入库只留一份,重复 uid 覆盖而不是重复', () => {
  const home = tempHome();
  const service = new MailService(home, new SettingsStore(home));
  service.storeMessages([
    { uid: '1', raw: rawMail('第一封') },
    { uid: '2', raw: rawMail('第二封') },
  ]);
  assert.equal(service.listMessages().length, 2);

  service.storeMessages([{ uid: '2', raw: rawMail('第二封-更新') }]);
  const messages = service.listMessages();
  assert.equal(messages.length, 2, '同一个 uid 不能出现两条');
  assert.ok(messages.some((message) => message.subject === '第二封-更新'));
});

test('storeMessages:空输入不写文件、不报错', () => {
  const home = tempHome();
  const service = new MailService(home, new SettingsStore(home));
  assert.deepEqual(service.storeMessages([]), []);
  assert.equal(service.listMessages().length, 0);
});
