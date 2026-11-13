import path from 'node:path';
import { workbenchHome } from './util/paths.js';
import { WorkbenchDb } from './domain/db.js';
import { SettingsStore } from './domain/settings.js';
import { WechatService } from './domain/wechat-service.js';
import { CongestionStore } from './domain/congestion.js';
import { LlmChecker } from './domain/llm.js';
import { HotspotService } from './domain/hotspot-service.js';
import { TrackService } from './domain/track-service.js';
import { ScheduleService } from './domain/schedule-service.js';
import { MailService } from './domain/mail-service.js';
import { createHandler, PREFIX } from './hosting/router.js';
import { ingestMailAttachments } from './domain/mail-ingest.js';

export const name = 'shipping-workbench';

/** Host services the workbench needs from the Web composition. */
export const inject = ['webServer'];

/**
 * Mount the shipping workbench: one HTTP prefix serving the static UI and the
 * JSON API, plus the in-process 公众号 collection timer.
 *
 * @param ctx - host cordis context (provides `webServer`).
 * @param config - optional `{ dataDir }` override for the runtime data root.
 */
export function apply(ctx, config = {}) {
  try {
    mount(ctx, config);
  } catch (error) {
    // A broken workbench must never take the whole app down: log and leave the
    // rest of the composition running without the sidebar entry.
    console.error('[shipping-workbench] 挂载失败,工作台不可用:', error);
  }
}

function mount(ctx, config = {}) {
  const home = config.dataDir ? path.resolve(config.dataDir) : workbenchHome();
  const settings = new SettingsStore(home);
  const db = new WorkbenchDb(path.join(home, 'workbench.db'));
  const wechat = new WechatService(db, settings);
  const congestion = new CongestionStore(db);
  const mail = new MailService(home, settings);
  const llm = new LlmChecker(home, ctx);
  const hotspot = new HotspotService(db, llm, home);
  const track = new TrackService(db, home, congestion, llm, settings);
  const schedule = new ScheduleService(db, home, llm);
  const handler = createHandler({ settings, wechat, track, schedule, congestion, mail, llm, hotspot, db });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
          return handler(req, res, url);
        },
      }),
    'shipping-workbench: http routes',
  );

  if (config.autoCollect !== false) {
    ctx.effect(() => {
      wechat.start();
      return () => wechat.stop();
    }, 'shipping-workbench: collect timer');
  }

  if (config.autoCongestion !== false) {
    ctx.effect(() => congestion.start(), 'shipping-workbench: congestion refresh');
  }

  // 热点每天 07:00 自动生成当天列表;模型没挂或当天没文章时静默跳过。
  if (config.autoHotspot !== false && typeof hotspot.startDaily === 'function') {
    ctx.effect(() => hotspot.startDaily({ hour: 7, minute: 0 }), 'shipping-workbench: hotspot timer');
  }

  // 邮件每天 06:30 拉一次,附件顺手入版本并对比 —— 船期对比页打开就有结果。
  if (config.autoMail !== false) {
    ctx.effect(() => startDailyMail({ db, mail, schedule }), 'shipping-workbench: mail timer');
  }

  ctx.effect(() => () => db.close(), 'shipping-workbench: database');
}

/** 本地日期 YYYY-MM-DD,用于「今天是否已经自动拉过邮件」。 */
function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 每天 06:30 自动拉一次邮件(用户可以在设置里改时间,这里先固定),
 * 拉到附件后按船东入版本并对比;失败只记日志,不阻塞插件。
 */
function startDailyMail({ db, mail, schedule, hour = 6, minute = 30, checkIntervalMs = 10 * 60_000 }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = new Date();
    const today = localDate(now);
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
    if (db.getFlag(`mail:autoFetch:${today}`)) return;
    const settings = mail.config?.() ?? {};
    if (!settings.user || !settings.password) return;
    running = true;
    try {
      const result = await mail.fetchRecent();
      await ingestMailAttachments({
        db,
        schedule,
        messages: result.messages ?? [],
        readAttachment: (uid, id) => mail.readAttachment(uid, id).data,
      });
      db.setFlag(`mail:autoFetch:${today}`, new Date().toISOString());
      console.log(`[shipping-workbench] 自动拉取邮件 ${result.fetched} 封`);
    } catch (error) {
      console.warn('[shipping-workbench] 自动拉取邮件失败:', error.message);
    } finally {
      running = false;
    }
  };
  const kickoff = setTimeout(tick, 20_000);
  kickoff.unref?.();
  const timer = setInterval(tick, Math.max(60_000, checkIntervalMs));
  timer.unref?.();
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
