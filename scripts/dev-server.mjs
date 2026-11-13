// Dev server: run the workbench without installing it into a DSH profile.
// Usage: node scripts/dev-server.mjs [--port 18990] [--data ~/.dsh/shipping-workbench] [--seed]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workbenchHome } from '../src/util/paths.js';
import { WorkbenchDb } from '../src/domain/db.js';
import { SettingsStore } from '../src/domain/settings.js';
import { WechatService } from '../src/domain/wechat-service.js';
import { CongestionStore } from '../src/domain/congestion.js';
import { LlmChecker } from '../src/domain/llm.js';
import { HotspotService } from '../src/domain/hotspot-service.js';
import { TrackService } from '../src/domain/track-service.js';
import { ScheduleService } from '../src/domain/schedule-service.js';
import { MailService } from '../src/domain/mail-service.js';
import { createHandler } from '../src/hosting/router.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(option('port') ?? process.env.PORT ?? 18990);
const seed = args.includes('--seed');
const home = option('data') ?? (seed ? fs.mkdtempSync(path.join(os.tmpdir(), 'swb-dev-')) : workbenchHome());

const settings = new SettingsStore(home);
const db = new WorkbenchDb(path.join(home, 'workbench.db'));
const wechat = new WechatService(db, settings);
const congestion = new CongestionStore(db);
const mail = new MailService(home, settings);
const llm = new LlmChecker(home, {
  llm: null,
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) },
});
// 独立跑时没有宿主模型服务:热点综述会显示「没有模型」而不是报错。
const hotspot = new HotspotService(db, llm, home);
const track = new TrackService(db, home, congestion, llm);
const schedule = new ScheduleService(db, home, llm);
const handler = createHandler({ settings, wechat, track, schedule, congestion, mail, llm, hotspot, db });

if (seed) seedData(home, db, wechat);

const server = http.createServer((req, res) => {
  handler(req, res, new URL(req.url, `http://${req.headers.host}`));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`workbench: http://127.0.0.1:${port}/shipping-workbench/`);
  console.log(`data dir : ${home}`);
});

function seedData(dir, database, service) {
  const account = database.listAccounts().find((item) => item.id === 'mp-msc') ?? database.listAccounts()[0];
  const now = Date.now();
  const demo = [
    ['美西航线 12 月舱位调整', now - 3600_000],
    ['地中海航运推出厦门-长滩直航', now - 26 * 3600_000],
    ['远东-欧洲航线冬季班期', now - 3 * 86400_000],
  ];
  for (const [title, at] of demo) {
    database.upsertArticle({
      accountId: account.id,
      key: `${Math.round(at / 1000)}-1`,
      title,
      url: 'https://mp.weixin.qq.com/s/demo',
      publishedAt: at,
      cover: '',
      summary: '演示数据:这里显示正文摘要。',
      html: '<p>演示数据:这里显示正文。</p>',
      collectedAt: new Date(at).toISOString(),
    });
  }
  database.upsertPorts(
    [
      { code: 'USLAX', name: 'Los Angeles', waitingDays: 6, level: 'high', note: '演示数据' },
      { code: 'CNSHA', name: 'Shanghai', waitingDays: 1, level: 'low', note: '演示数据' },
    ],
    'seed',
  );
  console.log('seeded demo data');
}
