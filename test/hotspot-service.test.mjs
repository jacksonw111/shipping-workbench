import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HotspotService } from '../src/domain/hotspot-service.js';

const pad = (n) => String(n).padStart(2, '0');
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const TODAY = localDate();
const YESTERDAY = localDate(new Date(Date.now() - 86_400_000));

const ARTICLES = [
  {
    key: 'k1',
    accountId: 'a',
    accountName: '泓昀国际',
    title: '红海绕行导致船期延误',
    summary: '',
    url: 'https://mp.weixin.qq.com/s?a1',
    publishedAt: Date.now() - 3_600_000,
  },
  {
    key: 'k2',
    accountId: 'b',
    accountName: 'JCtrans',
    title: 'Suez transit restricted',
    summary: '',
    url: 'https://mp.weixin.qq.com/s?a2',
    publishedAt: Date.now() - 7_200_000,
  },
];

const REPLY = {
  title: '今日航运热点',
  items: [
    {
      title: '红海绕行推高运价',
      summary: '多家船司改走好望角,欧线航程拉长。',
      impact: '欧线订舱多留 7-10 天。',
      tags: ['航线', '运价'],
      sources: [1, 2],
    },
    {
      title: '新加坡等泊创新高',
      summary: '新加坡港等泊升至 3 天。',
      impact: '东南亚中转船期顺延。',
      tags: ['塞港'],
      sources: [9],
    },
  ],
};

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hotspot-'));
}

function fakeDb(byDate = { [TODAY]: ARTICLES }) {
  return { articlesOn: (date) => byDate[date] ?? [] };
}

function fakeLlm({ available = true, reply = REPLY, error } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    availability: () =>
      available ? { available: true, provider: 'test', model: 'fake' } : { available: false, reason: '没有模型' },
    complete: async () => {
      calls += 1;
      if (error) throw new Error(error);
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
}

test('生成当天热点:条目带来源,落盘到按日期命名的文件', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const service = new HotspotService(fakeDb(), llm, home);
  const result = await service.generate({ date: TODAY });

  assert.equal(result.date, TODAY);
  assert.equal(result.reused, false);
  assert.equal(result.report.title, '今日航运热点');
  assert.equal(result.report.items.length, 2);
  assert.equal(result.report.sourceCount, 2);
  assert.equal(result.report.date, TODAY);
  assert.deepEqual(result.report.model, { provider: 'test', model: 'fake' });
  assert.deepEqual(
    result.report.items[0].sources.map((source) => source.n),
    [1, 2],
  );
  assert.equal(result.report.items[0].sources[0].url, 'https://mp.weixin.qq.com/s?a1');
  // 越界编号 9 不指向素材,来源被清空,条目本身保留。
  assert.deepEqual(result.report.items[1].sources, []);
  assert.equal(llm.calls(), 1);

  const file = path.join(home, 'hotspots', 'reports', `${TODAY}.json`);
  assert.ok(fs.existsSync(file));
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.items.length, 2);
  assert.equal(stored.digest, result.report.digest);
});

test('素材与模型没变时复用,refresh 才重新调模型', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const service = new HotspotService(fakeDb(), llm, home);

  await service.generate({ date: TODAY });
  const again = await service.generate({ date: TODAY });
  assert.equal(again.reused, true);
  assert.equal(llm.calls(), 1);

  const forced = await service.generate({ date: TODAY, refresh: true });
  assert.equal(forced.reused, false);
  assert.equal(llm.calls(), 2);
});

test('当天素材变了,指纹过期后重新生成', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const db = fakeDb({ [TODAY]: ARTICLES });
  const service = new HotspotService(db, llm, home);

  await service.generate({ date: TODAY });
  const more = { ...ARTICLES[0], key: 'k3', title: '新文章' };
  const changed = { articlesOn: () => [...ARTICLES, more] };
  const restarted = new HotspotService(changed, llm, home);
  const result = await restarted.generate({ date: TODAY });
  assert.equal(result.reused, false);
  assert.equal(llm.calls(), 2);
});

test('重启后仍能从磁盘读到同一份报告', async () => {
  const home = tempHome();
  await new HotspotService(fakeDb(), fakeLlm(), home).generate({ date: TODAY });
  const reopened = new HotspotService(fakeDb(), fakeLlm(), home).view({ date: TODAY });
  assert.ok(reopened.report);
  assert.equal(reopened.ready, true);
  assert.equal(reopened.articleCount, 2);
  assert.equal(reopened.date, TODAY);
});

test('没生成过的日期 report 为 null,并带上历史列表', async () => {
  const home = tempHome();
  const service = new HotspotService(fakeDb({ [YESTERDAY]: ARTICLES }), fakeLlm(), home);
  const view = service.view({ date: YESTERDAY });
  assert.equal(view.report, null);
  assert.equal(view.articleCount, 2);
  assert.deepEqual(view.reports, []);
  // date 缺省为今天。
  assert.equal(service.view().date, TODAY);
});

test('list 按日期倒序,只返回存在的文件', async () => {
  const home = tempHome();
  const service = new HotspotService(
    fakeDb({ [TODAY]: ARTICLES, [YESTERDAY]: ARTICLES }),
    fakeLlm(),
    home,
  );
  await service.generate({ date: YESTERDAY });
  await service.generate({ date: TODAY });

  const list = service.list();
  assert.equal(list.today, TODAY);
  assert.equal(list.ready, true);
  assert.deepEqual(
    list.reports.map((report) => report.date),
    [TODAY, YESTERDAY],
  );
  assert.equal(list.reports[0].title, '今日航运热点');
  assert.equal(list.reports[0].itemCount, 2);
  assert.equal(list.reports[0].model.model, 'fake');
  assert.equal(service.list({ limit: 1 }).reports.length, 1);
});

test('没有模型时首屏给原因、生成直接报 400', async () => {
  const home = tempHome();
  const service = new HotspotService(fakeDb(), fakeLlm({ available: false }), home);
  const view = service.view({ date: TODAY });
  assert.equal(view.ready, false);
  assert.equal(view.reason, '没有模型');
  assert.equal(view.report, null);
  assert.equal(service.list().ready, false);

  await assert.rejects(
    () => service.generate({ date: TODAY }),
    (error) => error.status === 400 && /没有模型/.test(error.message),
  );
});

test('当天没有文章时不调模型,报 400', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const service = new HotspotService(fakeDb(), llm, home);
  await assert.rejects(
    () => service.generate({ date: YESTERDAY }),
    (error) => error.status === 400 && /这天没有文章/.test(error.message),
  );
  assert.equal(llm.calls(), 0);
});

test('模型没有返回条目时报错,不写文件', async () => {
  const home = tempHome();
  const service = new HotspotService(fakeDb(), fakeLlm({ reply: '今天没什么事。' }), home);
  await assert.rejects(() => service.generate({ date: TODAY }), /没有返回热点条目/);
  assert.equal(service.stored(TODAY), null);
});

test('日期格式不对报 400', () => {
  const service = new HotspotService(fakeDb(), fakeLlm(), tempHome());
  assert.throws(() => service.view({ date: '11/12' }), (error) => error.status === 400);
});

test('ensureDaily:没文章 / 没模型时只返回原因', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const empty = new HotspotService(fakeDb({}), llm, home);
  assert.deepEqual(await empty.ensureDaily(), { generated: false, reason: '今天还没有文章' });

  const noModel = new HotspotService(fakeDb(), fakeLlm({ available: false }), tempHome());
  assert.deepEqual(await noModel.ensureDaily(), { generated: false, reason: '没有模型' });
  assert.equal(llm.calls(), 0);
});

test('ensureDaily:今天缺报告就生成,已是最新就不再调模型', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  const service = new HotspotService(fakeDb(), llm, home);

  assert.deepEqual(await service.ensureDaily(), { generated: true, date: TODAY });
  assert.equal(llm.calls(), 1);
  assert.ok(service.stored(TODAY));

  const again = await service.ensureDaily();
  assert.equal(again.generated, false);
  assert.equal(llm.calls(), 1);
});

test('ensureDaily:素材变了会补生成', async () => {
  const home = tempHome();
  const llm = fakeLlm();
  await new HotspotService(fakeDb(), llm, home).generate({ date: TODAY });

  const changed = new HotspotService(
    { articlesOn: () => [...ARTICLES, { ...ARTICLES[0], key: 'k3' }] },
    llm,
    home,
  );
  assert.deepEqual(await changed.ensureDaily(), { generated: true, date: TODAY });
  assert.equal(llm.calls(), 2);
});

test('ensureDaily:模型报错不抛,只记日志', async () => {
  const home = tempHome();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const service = new HotspotService(fakeDb(), fakeLlm({ error: '网关超时' }), home);
    const result = await service.ensureDaily();
    assert.deepEqual(result, { generated: false, reason: '网关超时' });
    assert.ok(warnings.some((line) => line.includes('网关超时')));
  } finally {
    console.warn = original;
  }
});

test('startDaily 返回停止函数,定时器不拖住进程', () => {
  const service = new HotspotService(fakeDb(), fakeLlm(), tempHome());
  const stop = service.startDaily({ hour: 7, minute: 0, checkIntervalMs: 1 });
  assert.equal(typeof stop, 'function');
  stop();
});
