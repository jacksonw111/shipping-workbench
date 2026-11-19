import path from 'node:path';
import { readJson, writeJson } from '../util/json-store.js';
import { ensureDir, workbenchHome } from '../util/paths.js';

export const SECRET_MASK = '••••••••';

export const DEFAULT_SETTINGS = {
  track: {
    modelByDefault: true,
    congestionMinWaitDays: 2,
    congestionGapDays: 2,
    // 航段天数不超过该值时,塞港/模型判出的可疑点不提醒(产品口径:1 天)。
    suppressWithinDays: 1,
    llmConcurrency: 4,
    // 调用预算:按字符打包 + 请求次数兜底,不再「每条请求判几条轨迹」。
    llmCharBudget: 30000,
    llmMaxCalls: 12,
    // 判定范围:candidates 只判疑点;all 全量送模型(慢但覆盖 100%)。
    llmScope: 'candidates',
    // 本地预筛:最多送多少组(0=不限)、多少天算统计异常。
    llmMaxCandidates: 400,
    llmOutlierMinDays: 25,
    llmOutlierRatio: 2.5,
    // 自定义判定提示词;空串表示用内置默认。
    promptOverride: '',
    // 兼容旧配置,已不再使用。
    llmBatchSize: 4,
    llmMaxGroups: 0,
  },
  wechat: {
    requestIntervalMs: 1500,
    defaultIntervalMinutes: 60,
    maxPages: 10,
    backfillDays: 5,
    firstRunMaxArticles: 60,
    sogouEnabled: true,
    sogouMaxArticles: 12,
    // 搜狗只是补充通道:合集断更超过 N 小时才试一次;被风控后冷却 N 小时。
    sogouFallbackHours: 24,
    sogouCooldownHours: 6,
    // 合集命中风控后,全局暂停 N 分钟,避免三个号轮流去撞。
    albumCooldownMinutes: 30,
    lookupProbeCount: 8,
  },
  // 跟随更新的源;默认就是本仓库的 main 分支。
  update: {
    owner: 'jacksonw111',
    repo: 'shipping-workbench',
    branch: 'main',
  },
  mail: {
    host: 'imap.exmail.qq.com',
    port: 993,
    secure: true,
    user: '',
    password: '',
    smtpHost: 'smtp.exmail.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    folder: 'INBOX',
    maxMessages: 40,
    lookbackDays: 30,
  },
};

const SECRET_PATHS = [
  ['mail', 'password'],
];

function envSecret(section, key) {
  const env = process.env;
  if (section === 'mail' && key === 'password') return env.SHIPPING_MAIL_PASSWORD ?? '';
  return '';
}

function envValue(section, key) {
  const env = process.env;
  if (section === 'mail' && key === 'user') return env.SHIPPING_MAIL_USER ?? '';
  return '';
}

export class SettingsStore {
  constructor(home = workbenchHome()) {
    this.home = home;
    this.file = path.join(home, 'settings.json');
    ensureDir(home);
  }

  /** Stored settings merged over defaults (secrets included). */
  read() {
    const stored = readJson(this.file, {});
    const merged = structuredClone(DEFAULT_SETTINGS);
    for (const [section, values] of Object.entries(stored ?? {})) {
      if (!merged[section] || typeof values !== 'object') continue;
      merged[section] = { ...merged[section], ...values };
    }
    for (const [section, key] of SECRET_PATHS) {
      if (!merged[section][key]) merged[section][key] = envSecret(section, key);
    }
    for (const [section, key] of [['mail', 'user']]) {
      if (!merged[section][key]) merged[section][key] = envValue(section, key);
    }
    return merged;
  }

  /** Settings safe for the browser: secrets replaced with a mask + presence flags. */
  publicView() {
    const settings = this.read();
    const view = structuredClone(settings);
    for (const [section, key] of SECRET_PATHS) {
      const present = Boolean(settings[section][key]);
      view[section][key] = present ? SECRET_MASK : '';
      view[section][`${key}Set`] = present;
    }
    return view;
  }

  /** Merge a patch; masked or blank secrets keep the stored value. */
  save(patch) {
    const current = this.read();
    const next = structuredClone(current);
    for (const [section, values] of Object.entries(patch ?? {})) {
      if (!next[section] || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) {
        if (value === SECRET_MASK) continue;
        if (typeof value === 'string' && value.trim() === '' && SECRET_PATHS.some(([s, k]) => s === section && k === key)) continue;
        next[section][key] = value;
      }
    }
    writeJson(this.file, next);
    return this.publicView();
  }
}
