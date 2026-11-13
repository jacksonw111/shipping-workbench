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
    lookupProbeCount: 8,
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
