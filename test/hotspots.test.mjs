import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCitations,
  buildHotspotPrompt,
  buildSources,
  citedNumbers,
  digestOf,
  parseHotspotReport,
} from '../src/domain/hotspots.js';

const at = (days) => Date.now() - days * 86_400_000;
const T = [at(1), at(2), at(3)];

const ARTICLES = [
  {
    key: 'k1',
    accountId: 'a',
    accountName: '泓昀国际',
    title: '红海绕行导致船期延误',
    summary: '多家船司改走好望角',
    url: 'https://mp.weixin.qq.com/s?a1',
    publishedAt: T[0],
  },
  {
    key: 'k2',
    accountId: 'b',
    accountName: 'JCtrans',
    title: 'Suez transit restricted as rates climb',
    summary: '',
    url: 'https://mp.weixin.qq.com/s?a2',
    publishedAt: T[1],
  },
  {
    key: 'k3',
    accountId: 'c',
    accountName: 'MSC',
    title: '塞港加剧:新加坡等泊创新高',
    summary: '',
    url: '',
    publishedAt: T[2],
  },
];

const REPLY = {
  title: '今日航运热点',
  items: [
    {
      title: '红海绕行推高运价',
      summary: '多家船司改走好望角,欧线航程普遍拉长。',
      impact: '欧线订舱需预留 7-10 天。',
      tags: ['航线', '运价'],
      sources: [1, 2],
    },
    {
      title: '新加坡等泊创新高',
      summary: '新加坡港等泊时间升至 3 天。',
      impact: '东南亚中转船期可能顺延。',
      tags: ['塞港', '挂港'],
      sources: [3],
    },
  ],
};

test('素材按时间倒序编号,最新的是 [1]', () => {
  const sources = buildSources(ARTICLES);
  assert.deepEqual(
    sources.map((source) => source.n),
    [1, 2, 3],
  );
  assert.equal(sources[0].title, '红海绕行导致船期延误');
  assert.equal(sources[2].accountName, 'MSC');
  assert.equal(sources[2].url, '');
});

test('素材清单带日期、编号、账号、标题与摘要', () => {
  const prompt = buildHotspotPrompt({ sources: buildSources(ARTICLES), date: '2026-11-12' });
  assert.ok(prompt.includes('日期:2026-11-12') && prompt.includes('共 3 篇'));
  assert.match(prompt, /\[1\] \d{4}-\d{2}-\d{2} 泓昀国际:红海绕行导致船期延误——多家船司改走好望角/);
  assert.match(prompt, /\[2\] .*JCtrans:Suez transit restricted as rates climb/);
});

test('解析 JSON 回复:标题与条目列表', () => {
  const report = parseHotspotReport(JSON.stringify(REPLY));
  assert.equal(report.title, '今日航运热点');
  assert.equal(report.items.length, 2);
  assert.equal(report.items[0].title, '红海绕行推高运价');
  assert.equal(report.items[0].summary, '多家船司改走好望角,欧线航程普遍拉长。');
  assert.equal(report.items[0].impact, '欧线订舱需预留 7-10 天。');
  assert.deepEqual(report.items[0].tags, ['航线', '运价']);
  assert.deepEqual(report.items[0].sources, [1, 2]);
});

test('模型带代码围栏也能解析', () => {
  const reply = `\`\`\`json\n${JSON.stringify({ title: 't', items: [{ title: '条目', summary: '事实', sources: [1] }] })}\n\`\`\``;
  const report = parseHotspotReport(reply);
  assert.equal(report.title, 't');
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].title, '条目');
});

test('JSON 前后有多余文字也能解析', () => {
  const reply = `下面是今天的整理:\n${JSON.stringify(REPLY)}\n以上,请查收。`;
  const report = parseHotspotReport(reply);
  assert.equal(report.items.length, 2);
});

test('模型直接返回数组时也当条目列表', () => {
  const reply = JSON.stringify([{ title: '只有一条', summary: '事实', sources: [1] }]);
  const report = parseHotspotReport(reply);
  assert.equal(report.title, '');
  assert.equal(report.items.length, 1);
});

test('没有 JSON 时返回空列表,不抛', () => {
  const report = parseHotspotReport('今天没有什么特别的事。 [1]');
  assert.deepEqual(report, { title: '', items: [] });
  assert.deepEqual(parseHotspotReport(''), { title: '', items: [] });
  assert.deepEqual(parseHotspotReport(JSON.stringify({ title: 'x' })), { title: '', items: [] });
});

test('条目字段归一:编号去重升序、非法编号丢掉、空标题摘要的条目丢掉', () => {
  const reply = JSON.stringify({
    title: 't',
    items: [
      { title: '甲', summary: '事实', sources: [2, 2, 1, 0, -3, 'x'] },
      { title: '', summary: '', sources: [1] },
      { summary: '只有摘要也算一条', tags: ['航线', '航线', ''] },
    ],
  });
  const report = parseHotspotReport(reply);
  assert.equal(report.items.length, 2);
  assert.deepEqual(report.items[0].sources, [1, 2]);
  assert.equal(report.items[1].title, '');
  assert.equal(report.items[1].impact, '');
  assert.deepEqual(report.items[1].tags, ['航线']);
});

test('引用对账:只保留真实编号,输出素材对象', () => {
  const sources = buildSources(ARTICLES);
  const items = applyCitations(REPLY, sources);
  assert.deepEqual(
    items[0].sources.map((source) => source.n),
    [1, 2],
  );
  assert.equal(items[0].sources[0].title, '红海绕行导致船期延误');
  assert.equal(items[0].sources[0].accountName, '泓昀国际');
  assert.equal(items[0].sources[0].url, 'https://mp.weixin.qq.com/s?a1');
  assert.equal(items[0].sources[0].publishedAt, T[0]);
  assert.equal(items[0].sources[0].zh, '');
  assert.equal(items[1].sources[0].n, 3);
});

test('引用对账:越界编号与重复编号被去掉', () => {
  const sources = buildSources(ARTICLES);
  const items = applyCitations(
    { items: [{ title: '甲', summary: '事实', sources: [9, 3, 3, 1, 0] }] },
    sources,
  );
  assert.deepEqual(
    items[0].sources.map((source) => source.n),
    [1, 3],
  );
});

test('引用对账:条目本身保留,没有合法来源时 sources 为空数组', () => {
  const items = applyCitations({ items: [{ title: '甲', summary: '事实', sources: [9] }] }, buildSources(ARTICLES));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].sources, []);
});

test('文本编号辅助函数按出现顺序去重', () => {
  assert.deepEqual(citedNumbers('甲 [3] 乙 [1] 丙 [9] 丁 [3]'), [1, 3, 9]);
});

test('素材指纹是 sha1,随日期、素材和模型变化', () => {
  const sources = buildSources(ARTICLES);
  const base = digestOf({ date: '2026-11-12', sources, provider: 'p', model: 'm' });
  assert.match(base, /^[0-9a-f]{40}$/);
  const otherModel = digestOf({ date: '2026-11-12', sources, provider: 'p', model: 'm2' });
  const otherDate = digestOf({ date: '2026-11-13', sources, provider: 'p', model: 'm' });
  const fewer = digestOf({ date: '2026-11-12', sources: sources.slice(0, 2), provider: 'p', model: 'm' });
  assert.notEqual(base, otherModel);
  assert.notEqual(base, otherDate);
  assert.notEqual(base, fewer);
  assert.equal(base, digestOf({ date: '2026-11-12', sources: buildSources(ARTICLES), provider: 'p', model: 'm' }));
});
