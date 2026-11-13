import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SogouGateway, extractAlbumIds, extractBiz, extractNickname } from '../src/domain/sogou.js';
import { WechatService, articleKey } from '../src/domain/wechat-service.js';
import { WorkbenchDb } from '../src/domain/db.js';
import { SettingsStore } from '../src/domain/settings.js';

const ARTICLE = (biz, nickname, mid, idx) => `
<html><body><script>
var biz = "${biz}"; var nickname = "${nickname}"; var mid = "${mid}"; var idx = "${idx}";
var ct = "1762000000"; var msg_title = "测试文章";
</script><div id="js_content"><p>正文</p></div></body></html>`;

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ['SUID=abc; path=/'], get: () => null },
    text: async () => html,
  };
}

function fakeGateway(articles) {
  const calls = [];
  return {
    calls,
    async searchArticleLinks(keyword, { limit }) {
      calls.push(['search', keyword, limit]);
      return articles.map((_, index) => `link-${index}`);
    },
    async resolveArticleUrl(link) {
      const index = Number(link.split('-')[1]);
      return articles[index].url;
    },
    async fetchArticle(url) {
      calls.push(['fetch', url]);
      return articles.find((item) => item.url === url).html;
    },
  };
}

test('搜狗:按 biz 归并候选,并找出合集 id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-sogou-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const settings = new SettingsStore(home);
  const gateway = fakeGateway([
    {
      url: 'https://mp.weixin.qq.com/s?__biz=AAA&mid=1&idx=1',
      html: `${ARTICLE('AAA', 'MSC地中海航运', 1, 1)}<a href="https://mp.weixin.qq.com/mp/appmsgalbum?album_id=2456831253753806848">合集</a>`,
    },
    {
      url: 'https://mp.weixin.qq.com/s?__biz=AAA&mid=2&idx=1',
      html: ARTICLE('AAA', 'MSC地中海航运', 2, 1),
    },
    {
      url: 'https://mp.weixin.qq.com/s?__biz=BBB&mid=3&idx=1',
      html: ARTICLE('BBB', '别家公众号', 3, 1),
    },
  ]);
  const service = new WechatService(db, settings, gateway);
  const candidates = await service.lookup('MSC地中海航运');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].biz, 'AAA');
  assert.equal(candidates[0].matches, 2);
  assert.equal(candidates[0].name, 'MSC地中海航运');
  assert.equal(candidates[0].albumId, '2456831253753806848');
  assert.equal(candidates[1].biz, 'BBB');
  db.close();
});

test('只给名字:唯一结果直接建号,多个结果要求选择', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-sogou-'));
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const settings = new SettingsStore(home);

  const single = new WechatService(
    db,
    settings,
    fakeGateway([
      {
        url: 'https://mp.weixin.qq.com/s?__biz=NEW1&mid=1&idx=1',
        html: ARTICLE('NEW1', '新号', 1, 1),
      },
    ]),
  );
  const account = await single.saveAccount({ name: '新号' });
  assert.equal(account.biz, 'NEW1');
  assert.equal(account.channel, 'sogou');
  assert.equal(account.name, '新号');

  const multi = new WechatService(
    db,
    settings,
    fakeGateway([
      { url: 'https://mp.weixin.qq.com/s?__biz=M1&mid=1&idx=1', html: ARTICLE('M1', '同名号', 1, 1) },
      { url: 'https://mp.weixin.qq.com/s?__biz=M2&mid=2&idx=1', html: ARTICLE('M2', '同名号', 2, 1) },
    ]),
  );
  await assert.rejects(() => multi.saveAccount({ name: '同名号' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.details.candidates.length, 2);
    return true;
  });
  db.close();
});

test('文章 key 优先用 mid-idx,没有就退回 URL 指纹', () => {
  assert.equal(articleKey({ mid: '123', idx: '2', url: 'x' }), '123-2');
  assert.match(articleKey({ url: 'https://mp.weixin.qq.com/s/abc' }), /^u-[0-9a-f]{16}$/);
});

test('搜狗页面解析辅助函数', () => {
  assert.equal(extractBiz('var biz = "MzU2";'), 'MzU2');
  assert.equal(extractNickname('var nickname = "MSC";'), 'MSC');
  assert.deepEqual(
    extractAlbumIds('a?album_id=2456831253753806848 b?album_id=2456831253753806848 c?album_id=4164504117865267206'),
    ['2456831253753806848', '4164504117865267206'],
  );
  assert.deepEqual(extractAlbumIds('<p>none</p>'), []);
});

test('SogouGateway 串行请求并解析跳转页', async () => {
  const calls = [];
  const responses = [
    htmlResponse('<a href="/link?url=a&amp;b=1">1</a><a href="/link?url=c">2</a>'),
    htmlResponse("url += 'https://mp.weixin.qq.com/s?__biz=A'; url += '&mid=1';"),
  ];
  const gateway = new SogouGateway({
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      return responses.shift() ?? htmlResponse('');
    },
  });
  const links = await gateway.searchArticleLinks('MSC', { limit: 5 });
  assert.equal(links.length, 2);
  assert.equal(links[0], 'https://weixin.sogou.com/link?url=a&b=1');
  const article = await gateway.resolveArticleUrl(links[0]);
  assert.equal(article, 'https://mp.weixin.qq.com/s?__biz=A&mid=1');
});
