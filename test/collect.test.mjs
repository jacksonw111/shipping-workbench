import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../src/util/http-util.js';
import { WorkbenchDb } from '../src/domain/db.js';
import { SettingsStore } from '../src/domain/settings.js';
import { WechatService } from '../src/domain/wechat-service.js';

// 每次建号用唯一的 biz/album:库里 (biz, album_id) 有唯一约束,种子号也占着真实值。
let sequence = 0;
function uniqueAccountKey() {
  sequence += 1;
  return { biz: `MzTEST${Date.now()}${sequence}`, albumId: `${Date.now()}${sequence}` };
}

function articleHtml(mid, idx, title, publishedAt = Math.floor(Date.now() / 1000)) {
  return `<html><body><script>
var biz = "MzTEST"; var nickname = "测试号"; var mid = "${mid}"; var idx = "${idx}";
var ct = "${publishedAt}"; var msg_title = "${title}";
</script><div id="js_content"><p>正文</p></div></body></html>`;
}

function albumItem(mid, publishedAt = Math.floor(Date.now() / 1000)) {
  return {
    msgid: String(mid),
    itemidx: '1',
    title: `文章 ${mid}`,
    url: `https://mp.weixin.qq.com/s?__biz=MzTEST&mid=${mid}&idx=1`,
    create_time: String(publishedAt),
  };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => JSON.stringify(payload) };
}

function htmlResponse(html) {
  return { ok: true, status: 200, headers: { get: () => null, getSetCookie: () => [] }, text: async () => html };
}

/**
 * 用全局 fetch 桩模拟公众号接口:合集 JSON + 文章页 HTML。
 * `state.articles` 控制合集返回;`state.failArticleMid` 让某一篇抓取失败。
 */
async function withFetch(state, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes('appmsgalbum')) {
      state.albumCalls += 1;
      return jsonResponse({
        getalbum_resp: {
          article_list: state.articles.map((item) => ({
            ...item,
            create_time: String(item.create_time ?? Math.floor(Date.now() / 1000)),
          })),
          continue_flag: '0',
        },
      });
    }
    if (url.includes('mp.weixin.qq.com/s')) {
      state.articleCalls += 1;
      const mid = /[?&]mid=(\d+)/.exec(url)?.[1] ?? '0';
      if (state.failArticleMid === mid) return { ok: false, status: 502, text: async () => '' };
      return htmlResponse(articleHtml(mid, '1', `文章 ${mid}`));
    }
    return real(input);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

function makeService() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-collect-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const settings = new SettingsStore(home);
  settings.save({
    wechat: {
      requestIntervalMs: 0,
      backfillDays: 7,
      sogouFallbackHours: 24,
      sogouCooldownHours: 6,
      albumCooldownMinutes: 30,
    },
  });
  const key = uniqueAccountKey();
  const account = db.insertAccount({
    id: 'mp-test',
    name: '测试号',
    biz: key.biz,
    albumId: key.albumId,
    enabled: true,
    intervalMinutes: 60,
    createdAt: new Date().toISOString(),
    channel: 'auto',
  });
  db.updateAccount(account.id, { backfilled: true });
  return { db, settings, home };
}

/** 存一篇 30 天前的文章,表示这个号断更很久。 */
function seedOldArticle(db) {
  db.upsertArticle({
    accountId: 'mp-test',
    key: 'old-1',
    title: '旧文章',
    url: 'https://mp.weixin.qq.com/s?__biz=MzTEST&mid=5&idx=1',
    publishedAt: Date.now() - 30 * 86_400_000,
    cover: '',
    summary: '',
    html: '<p>x</p>',
    collectedAt: new Date().toISOString(),
  });
}

function sogouGateway(behave = 'blocked') {
  const calls = [];
  return {
    calls,
    async searchArticleLinks(keyword) {
      calls.push(keyword);
      if (behave === 'blocked') throw new HttpError(429, '搜狗风控拦截,60 秒后重试');
      return [];
    },
    async resolveArticleUrl() {
      return 'https://mp.weixin.qq.com/s?__biz=X&mid=9&idx=1';
    },
    async fetchArticle() {
      return articleHtml(9, '1', '搜狗文章');
    },
  };
}

test('合集无新增 + 搜狗风控:不判失败,记冷却', async () => {
  const { db, settings } = makeService();
  seedOldArticle(db);
  const gateway = sogouGateway('blocked');
  const service = new WechatService(db, settings, gateway);
  const state = { articles: [], albumCalls: 0, articleCalls: 0 };

  await withFetch(state, async () => {
    const result = await service.collect('mp-test');
    assert.equal(result.added, 0, '这一轮合集没有新文章');
    const account = db.getAccount('mp-test');
    assert.notEqual(account.lastStatus, 'failed', '搜狗风控不能把账号判成失败');
    assert.equal(account.lastStatus, 'ok');
    assert.match(account.lastError, /搜狗/);
    assert.ok(Number(db.getFlag('wechat:sogouBlockedUntil')) > Date.now(), '要落冷却时间');
  });
});

test('搜狗冷却期内不再请求搜狗', async () => {
  const { db, settings } = makeService();
  db.setFlag('wechat:sogouBlockedUntil', String(Date.now() + 3_600_000));
  const gateway = sogouGateway('blocked');
  const service = new WechatService(db, settings, gateway);
  const state = { articles: [], albumCalls: 0, articleCalls: 0 };

  await withFetch(state, async () => {
    const result = await service.collect('mp-test');
    assert.equal(result.added, 0);
    assert.equal(gateway.calls.length, 0, '冷却期内不应该再打搜狗');
    assert.ok(result.warnings.some((item) => item.includes('冷却中')));
  });
});

test('合集有新文章时不触发搜狗', async () => {
  const { db, settings } = makeService();
  const gateway = sogouGateway('blocked');
  const service = new WechatService(db, settings, gateway);
  const state = { articles: [albumItem(2)], albumCalls: 0, articleCalls: 0 };

  await withFetch(state, async () => {
    await service.collect('mp-test');
    assert.equal(gateway.calls.length, 0, '合集能收到就不该碰搜狗');
  });
});

test('合集断更超过阈值才试搜狗', async () => {
  const { db, settings } = makeService();
  seedOldArticle(db);
  const gateway = sogouGateway('blocked');
  const service = new WechatService(db, settings, gateway);
  const state = { articles: [], albumCalls: 0, articleCalls: 0 };

  await withFetch(state, async () => {
    await service.collect('mp-test');
    assert.equal(gateway.calls.length, 1, '断更超过 24 小时要试一次搜狗');
  });
});

test('单篇文章抓取失败不影响其它文章', async () => {
  const { db, settings } = makeService();
  const service = new WechatService(db, settings, sogouGateway('blocked'));
  const state = {
    articles: [albumItem(11), albumItem(12)],
    albumCalls: 0,
    articleCalls: 0,
    failArticleMid: '11',
  };

  await withFetch(state, async () => {
    const result = await service.collect('mp-test');
    assert.equal(result.added, 1, '第二篇仍然要入库');
    assert.ok(result.warnings.some((item) => item.includes('文章')), '失败的篇要留 warning');
    assert.equal(db.getAccount('mp-test').lastStatus, 'ok');
  });
});

test('合集命中风控:进冷却,账号不反复撞', async () => {
  const { db, settings } = makeService();
  const service = new WechatService(db, settings, sogouGateway('blocked'));
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    if (url.includes('appmsgalbum')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<html>环境异常</html>' };
    return real(input);
  };
  try {
    const result = await service.collect('mp-test');
    assert.ok(result.warnings.some((item) => item.includes('合集')));
    assert.ok(Number(db.getFlag('wechat:albumBlockedUntil')) > Date.now());
    assert.notEqual(db.getAccount('mp-test').lastStatus, 'failed');
  } finally {
    globalThis.fetch = real;
  }
});
