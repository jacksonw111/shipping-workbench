import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createHandler } from '../src/hosting/router.js';
import { HttpError } from '../src/util/http-util.js';
import { WorkbenchDb } from '../src/domain/db.js';
import { SettingsStore } from '../src/domain/settings.js';
import { WechatService } from '../src/domain/wechat-service.js';
import { CongestionStore } from '../src/domain/congestion.js';
import { TrackService } from '../src/domain/track-service.js';
import { ScheduleService } from '../src/domain/schedule-service.js';
import { MailService } from '../src/domain/mail-service.js';
import { HotspotService } from '../src/domain/hotspot-service.js';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
}

const STUB_ARTICLE = (biz, nickname, mid) => `
<html><body><script>
var biz = "${biz}"; var nickname = "${nickname}"; var mid = "${mid}"; var idx = "1";
var ct = "1762000000"; var msg_title = "测试";
</script><div id="js_content"><p>正文</p></div></body></html>`;

function stubGateway() {
  return {
    async searchArticleLinks(name) {
      if (name === '测试号') return ['link-0'];
      const error = new HttpError(404, `没搜到「${name}」的文章`);
      throw error;
    },
    async resolveArticleUrl() {
      return 'https://mp.weixin.qq.com/s?__biz=STUB01&mid=9&idx=1';
    },
    async fetchArticle() {
      return STUB_ARTICLE('STUB01', '测试号', 9);
    },
  };
}

function startServer(home, options = {}) {
  const settings = new SettingsStore(home);
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const wechat = new WechatService(db, settings, stubGateway());
  const congestion = new CongestionStore(db);
  const llm = options.llm ?? {
    availability: () => ({ available: false, reason: '测试环境没有模型' }),
    check: async () => ({ skipped: true, reason: '测试环境没有模型' }),
    apply: () => {},
  };
  const track = new TrackService(db, home, congestion, llm);
  const schedule = new ScheduleService(db, home, llm);
  const mail = new MailService(home, settings);
  const hotspot = new HotspotService(db, llm, home);
  const handler = createHandler({ settings, wechat, track, schedule, congestion, mail, llm, hotspot, db });
  const server = http.createServer((req, res) => {
    handler(req, res, new URL(req.url, `http://${req.headers.host}`));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function workbookBuffer(rows, name = 'S') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function form(fields, files) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  for (const [key, file] of Object.entries(files)) body.append(key, file);
  return body;
}

test('HTTP 接口:设置脱敏、塞港导入、轨迹检测、导出', async () => {
  const home = tempHome();
  const server = await startServer(home);
  const base = `http://127.0.0.1:${server.address().port}/shipping-workbench/api`;
  try {
    let response = await fetch(`${base}/bootstrap`);
    let data = await response.json();
    assert.equal(data.accounts.length, 3, '内置三个公众号');
    assert.deepEqual(
      data.accounts.map((account) => account.name).sort(),
      ['JCtrans 杰西圈', 'MSC 地中海航运', '泓昀国际 STL'].sort(),
    );
    assert.equal(data.carriers.length, 8, '内置八个船东');
    assert.equal(data.settings.mail.password, '');

    response = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mail: { user: 'ops@example.com', password: 'secret-1' } }),
    });
    data = await response.json();
    assert.equal(data.settings.mail.user, 'ops@example.com');
    assert.equal(data.settings.mail.password, '••••••••');
    assert.equal(data.settings.mail.passwordSet, true);

    // Masked value must not overwrite the stored secret.
    response = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mail: { password: '••••••••' } }),
    });
    data = await response.json();
    assert.equal(data.settings.mail.passwordSet, true);

    response = await fetch(`${base}/congestion/import`, {
      method: 'POST',
      body: form({}, {
        file: new File(
          [workbookBuffer([['五字码', '港口', '等泊天数'], ['USLAX', 'LOS ANGELES', 6]])],
          'congestion.xlsx',
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        ),
      }),
    });
    data = await response.json();
    assert.equal(data.count, 1);
    assert.equal(data.congestion.ports[0].code, 'USLAX');

    const trackRows = [
      ['Rotation ID', '港口英文', '五字码', '航程', '排序', '新旧轨迹', '关联船队'],
      ['42', 'SHANGHAI', 'CNSHA', 30, 1, '新', 'F1'],
      ['42', 'LOS ANGELES,CA', 'USLAX', 40, 2, '新', 'F1'],
      ['42', 'OAKLAND,CA', 'USOAK', 18, 3, '新', 'F1'],
    ];
    response = await fetch(`${base}/track/run`, {
      method: 'POST',
      body: form({ useLlm: '0' }, {
        file: new File([workbookBuffer(trackRows, '轨迹')], 'track.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    });
    data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.report.stats.groups, 1);
    assert.equal(data.report.stats.congestionHits, 1, 'USLAX 命中塞港数据');
    assert.equal(data.report.stats.flagged, 1, '累计回退被判红');

    const reportId = data.report.id;

    // 旧格式记录(没有 sheets)应当用源文件自动重建,而不是打不开。
    const reportFile = path.join(home, 'track', 'runs', reportId, 'report.json');
    const legacy = { id: reportId, filename: 'track.xlsx', stats: { groups: 1 }, groups: [] };
    fs.writeFileSync(reportFile, JSON.stringify(legacy));
    let reopened = await fetch(`${base}/track/runs/${reportId}`).then((res) => res.json());
    assert.equal(reopened.report.formatVersion, 2);
    assert.equal(reopened.report.sheets.length, 1);
    assert.ok(reopened.report.sheets[0].rows.length > 0);
    const trackExport = await fetch(`${base}/track/runs/${reportId}/export`);
    assert.equal(trackExport.status, 200);
    assert.match(trackExport.headers.get('content-type'), /spreadsheetml/);
    const buffer = Buffer.from(await trackExport.arrayBuffer());
    const book = XLSX.read(buffer, { type: 'buffer' });
    assert.equal(book.SheetNames[0], '轨迹');
    const table = XLSX.utils.sheet_to_json(book.Sheets['轨迹'], { header: 1 });
    assert.equal(table[0].at(-1), '检测备注', '导出在原表末尾追加备注列');

    // 船东配置版:MATSON 双段键,导出旧/新两个 sheet + 汇总。
    const oldSchedule = workbookBuffer(
      [
        ['始发港', 'SVC', '船名', '航次', '开航日期', '目的港'],
        ['上海', 'A1', 'EVER', '001', '2099-01-01', '洛杉矶'],
      ],
      '美西',
    );
    const newSchedule = workbookBuffer(
      [
        ['始发港', 'SVC', '船名', '航次', '开航日期', '目的港'],
        ['宁波', 'A1', 'EVER', '001', '2099-01-03', '洛杉矶'],
      ],
      '美西',
    );
    let scheduleResponse = await fetch(`${base}/schedule/run`, {
      method: 'POST',
      body: form({ carrierId: 'matson' }, {
        oldFile: new File([oldSchedule], 'old.xlsx'),
        newFile: new File([newSchedule], 'new.xlsx'),
      }),
    });
    data = await scheduleResponse.json();
    assert.equal(data.result.mode, 'profile');
    assert.equal(data.result.stats.changed, 1, '主键变化但次键命中 → 变更');
    const scheduleExport = await fetch(`${base}/schedule/runs/${data.result.id}/export`);
    const scheduleBook = XLSX.read(Buffer.from(await scheduleExport.arrayBuffer()), { type: 'buffer' });
    assert.deepEqual(scheduleBook.SheetNames, ['汇总', '旧-美西', '新-美西']);

    // 重新对比:用留存的源文件再跑一遍,得到一条新记录,统计一致。
    const recompare = await fetch(`${base}/schedule/runs/${data.result.id}/recompare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const redone = await recompare.json();
    assert.equal(recompare.status, 200, JSON.stringify(redone));
    assert.notEqual(redone.result.id, data.result.id);
    assert.deepEqual(redone.result.stats, data.result.stats);


  } finally {
    server.close();
  }
});

test('HTTP 接口:公众号参数校验与 404', async () => {
  const home = tempHome();
  const server = await startServer(home);
  const base = `http://127.0.0.1:${server.address().port}/shipping-workbench/api`;
  try {
    let response = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(response.status, 400);

    // 只给名字:走 find-account,自动补 biz。
    response = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试号' }),
    });
    let data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.account.biz, 'STUB01');
    assert.equal(data.account.channel, 'sogou');

    // 同名重复登记。
    response = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试号' }),
    });
    assert.equal(response.status, 409);

    // 手工 biz + 合集链接仍然可用。
    response = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '手工号',
        albumUrl: 'https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzA5&album_id=123&scene=1',
      }),
    });
    data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.account.biz, 'MzA5');
    assert.equal(data.account.albumId, '123');

    response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('热点追踪:没有模型时首屏给原因,生成返回 400', async () => {
  const home = tempHome();
  const server = await startServer(home);
  const base = `http://127.0.0.1:${server.address().port}/shipping-workbench/api`;
  try {
    let response = await fetch(`${base}/hotspots/report?days=7`);
    let data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ready, false);
    assert.equal(data.report, null);
    assert.equal(data.reason, '测试环境没有模型');

    response = await fetch(`${base}/hotspots/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days: 7 }),
    });
    assert.equal(response.status, 400);
    data = await response.json();
    assert.match(data.error, /没有模型/);
  } finally {
    server.close();
  }
});

test('装配校验:少接一个服务在创建时就报错,而不是请求时 500', () => {
  assert.throws(() => createHandler({ settings: {}, wechat: {}, db: {} }), /工作台缺少服务:track、schedule/);
});

test('船期对比:结构体检认出模板变化,按模型映射对比成功', async () => {
  const home = tempHome();
  const mappingReply = JSON.stringify({
    columns: { 始发港: 'A港', SVC: 'B线', 船名: 'C船', 航次: 'D次', 开航日期: 'E日' },
    note: '按语义对应',
  });
  const llm = {
    availability: () => ({ available: true, provider: 'stub', model: 'stub' }),
    check: async () => ({ skipped: true }),
    apply: () => {},
    complete: async () => mappingReply,
  };
  const server = await startServer(home, { llm });
  const base = `http://127.0.0.1:${server.address().port}/shipping-workbench/api`;
  const carrierId = 'pil-guangzhou';
  const std = [
    ['始发港', 'SVC', '船名', '航次', '开航日期'],
    ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
  ];
  const renamed = [
    ['A港', 'B线', 'C船', 'D次', 'E日'],
    ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
    ['NINGBO', 'AAS', 'MSC BOB', '002E', '2099-12-05'],
  ];
  const xlsx = (rows) => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '美西');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  };
  try {
    // 1) 先用标准模板入库,成为基线版本。
    let response = await fetch(`${base}/schedule/ingest`, {
      method: 'POST',
      body: form({ carrierId }, {
        file: new File([xlsx(std)], 'v1.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    });
    let data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.skipped, false);
    assert.equal(data.message, '这是第一版,已存档作为基线');

    // 2) 换模板的新版:体检应该指出键列对不上,并让模型给映射。
    response = await fetch(`${base}/schedule/analyze`, {
      method: 'POST',
      body: form({ carrierId }, {
        file: new File([xlsx(renamed)], 'v2.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    });
    data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.needsModel, true);
    assert.ok(data.missing.length > 0, '应报出对不上的键列');
    assert.equal(data.mapping.columns['始发港'], 'A港');
    assert.equal(data.model.used, true);

    // 3) 带着映射入库:应该真的比出 1 条新增。
    response = await fetch(`${base}/schedule/ingest`, {
      method: 'POST',
      body: form({ carrierId, mapping: JSON.stringify(data.mapping) }, {
        file: new File([xlsx(renamed)], 'v2.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    });
    data = await response.json();
    assert.equal(response.status, 200);
    assert.ok(data.run, '应该产生对比任务');
    assert.equal(data.run.mapped, true);
    assert.equal(data.run.stats.added, 1);
    assert.equal(data.versions.current.versionNo, 2);
  } finally {
    server.close();
  }
});

test('船期对比:标准表头不需要模型介入', async () => {
  const home = tempHome();
  const server = await startServer(home);
  const base = `http://127.0.0.1:${server.address().port}/shipping-workbench/api`;
  const rows = [
    ['始发港', 'SVC', '船名', '航次', '开航日期'],
    ['SHANGHAI', 'AAS', 'MSC ANA', '001E', '2099-12-01'],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '美西');
  try {
    const response = await fetch(`${base}/schedule/analyze`, {
      method: 'POST',
      body: form({}, {
        file: new File([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })], 'ok.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.needsModel, false);
    assert.deepEqual(data.missing, []);
  } finally {
    server.close();
  }
});
