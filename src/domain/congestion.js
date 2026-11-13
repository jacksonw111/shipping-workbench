import { HttpError } from '../util/http-util.js';
import { readWorkbook, cellText } from './workbook.js';

const HEADER_ALIASES = {
  code: ['五字码', '港口代码', 'UN/LOCODE', 'LOCODE', 'CODE', 'Port Code'],
  name: ['港口', '港口英文', 'Port', 'PORT', '港口名称'],
  waitingDays: ['等泊天数', '等待天数', '锚泊天数', 'Waiting Days', 'Dwell', 'Delay'],
  level: ['拥堵等级', '拥堵', 'Congestion', 'Level', 'Status'],
  note: ['备注', '说明', 'Note', 'Remark'],
};

export const DEFAULT_CARGOACT_URL = 'https://cartadminapi.cargoact.com/api/Congestion/GetAll';

/** CargoAct 的 Status → 中文等级;顺带把「严重」程度带出来。 */
const STATUS_LEVELS = {
  HEAVILY_REDUCED: '严重',
  SLIGHTLY_REDUCED: '轻微',
  NORMAL: '正常',
  NO_DELAY: '正常',
};

const DAYS_PATTERN = /(\d+(?:\.\d+)?)\s*days?/i;

/** 一条 CargoAct 记录 → 塞港行。没有「around N days」的港口等泊天数留空,不猜。 */
export function toPortRow(item) {
  const comment = String(item?.Comment ?? '').trim();
  const match = DAYS_PATTERN.exec(comment);
  const status = String(item?.Status ?? '').trim().toUpperCase();
  return {
    code: String(item?.Code ?? '').trim().toUpperCase(),
    name: String(item?.Name ?? '').trim(),
    waitingDays: match ? Number(match[1]) : null,
    level: STATUS_LEVELS[status] ?? String(item?.Status ?? '').trim(),
    note: comment,
  };
}

/** 塞港数据仓库:CargoAct 抓取 + 手工导入,数据落在 SQLite。 */
export class CongestionStore {
  constructor(db) {
    this.db = db;
  }

  list({ q = '', limit = 50, offset = 0 } = {}) {
    const meta = this.db.congestionMeta();
    const page = this.db.listPorts({ q, limit, offset });
    return {
      updatedAt: meta.updatedAt,
      source: this.db.congestionSource(),
      ports: page.items,
      total: page.total,
      limit,
      offset,
    };
  }

  lookup(code) {
    return this.db.getPort(code);
  }

  /** 定时刷新:数据超过 maxAgeHours 才去拉,失败只记日志不影响使用。 */
  start({ maxAgeHours = 12, intervalHours = 6 } = {}) {
    const refresh = async () => {
      const meta = this.db.congestionMeta();
      const ageHours = meta.updatedAt ? (Date.now() - new Date(meta.updatedAt).getTime()) / 3_600_000 : Infinity;
      if (ageHours < maxAgeHours) return;
      try {
        await this.fetchFromCargoAct();
      } catch (error) {
        console.warn('[shipping-workbench] 塞港数据刷新失败:', error.message);
      }
    };
    const kickoff = setTimeout(refresh, 20_000);
    kickoff.unref?.();
    const timer = setInterval(refresh, Math.max(1, intervalHours) * 3_600_000);
    timer.unref?.();
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }

  /** Replace/merge a set of port rows. */
  upsert(rows, source) {
    const count = this.db.upsertPorts(rows, source);
    return count;
  }

  /** Import an uploaded spreadsheet of port congestion. */
  importWorkbook(buffer) {
    const sheets = readWorkbook(buffer);
    const rows = [];
    for (const sheet of sheets) {
      const headerIndex = sheet.rows.findIndex((row) =>
        row.some((cell) => HEADER_ALIASES.code.includes(String(cell).trim())),
      );
      if (headerIndex < 0) continue;
      const header = sheet.rows[headerIndex].map((cell) => String(cell).trim());
      const pick = (row, key) => {
        const index = header.findIndex((cell) => HEADER_ALIASES[key].includes(cell));
        return index >= 0 ? cellText(row[index]) : '';
      };
      for (let index = headerIndex + 1; index < sheet.rows.length; index += 1) {
        const row = sheet.rows[index];
        if (!row) continue;
        const code = pick(row, 'code');
        if (!code) continue;
        rows.push({
          code,
          name: pick(row, 'name'),
          waitingDays: Number(String(pick(row, 'waitingDays')).replace(/[^\d.-]/g, '')),
          level: pick(row, 'level'),
          note: pick(row, 'note'),
        });
      }
    }
    if (rows.length === 0) throw new HttpError(400, '未在表中找到「五字码」列');
    const count = this.upsert(rows, 'manual');
    return { count, total: this.db.congestionMeta().count };
  }

  /**
   * 从 CargoAct 塞港接口拉全量数据。
   *
   * GET https://cartadminapi.cargoact.com/api/Congestion/GetAll
   * 返回 Items[]:{ Code(五字码), Name, Status, Comment, Modified }
   * Comment 里写着 "average vessel waiting time is around 1.5 days",等泊天数从里面解析。
   */
  async fetchFromCargoAct(url = DEFAULT_CARGOACT_URL) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new HttpError(502, `塞港接口返回 HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    const items = payload?.Items ?? payload?.items ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpError(502, '塞港接口没有返回港口数据');
    }
    const rows = items.map(toPortRow).filter((row) => row.code);
    if (rows.length === 0) throw new HttpError(502, '塞港接口返回的数据里没有五字码');
    const count = this.upsert(rows, 'cargoact');
    return {
      count,
      total: this.db.congestionMeta().count,
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * 把塞港数据挂到航段上,只在「等泊明显长于本段航程」时判冲突。
 *
 * 亚洲近洋短航段(0–1 天)碰上 1–2 天等泊是常态,不能一律标红;
 * 默认要求:等泊 ≥ 2 天,且比航段天数多 ≥ 2 天。
 * suppressWithinDays:航段天数不超过该值时,即使等泊再长也「不提醒」(产品口径:1 天)。
 */
export const DEFAULT_CONGESTION_RULE = { minWaitDays: 2, minGapDays: 2, suppressWithinDays: 1 };

/** 纯阈值判定(不含「1 天内不提醒」的抑制),供抑制统计复用。 */
function thresholdConflict(segment, congestion, rule = DEFAULT_CONGESTION_RULE) {
  const wait = Number(congestion?.waitingDays);
  if (!Number.isFinite(wait) || wait <= 0) return null;
  const minWait = Number(rule.minWaitDays ?? DEFAULT_CONGESTION_RULE.minWaitDays);
  const minGap = Number(rule.minGapDays ?? DEFAULT_CONGESTION_RULE.minGapDays);
  if (wait < minWait) return null;
  const gap = wait - segment.days;
  if (gap < minGap) return null;
  return { wait, gap };
}

export function congestionConflict(segment, congestion, rule = DEFAULT_CONGESTION_RULE) {
  const days = Number(segment?.days);
  const suppressWithinDays = Number(rule?.suppressWithinDays ?? DEFAULT_CONGESTION_RULE.suppressWithinDays);
  // 满足阈值但天数在抑制窗口内:产品明确 1 天内的可疑点不提醒。
  if (Number.isFinite(days) && Number.isFinite(suppressWithinDays) && days <= suppressWithinDays) return null;
  return thresholdConflict(segment, congestion, rule);
}

export function enrichWithCongestion(groups, store, rule = DEFAULT_CONGESTION_RULE) {
  let hits = 0;
  const suppressWithinDays = Number(rule?.suppressWithinDays ?? DEFAULT_CONGESTION_RULE.suppressWithinDays);
  for (const group of groups) {
    if (group.skipped) continue;
    for (const segment of group.segments) {
      const congestion = store.lookup(segment.toCode);
      if (!congestion) continue;
      hits += 1;
      // 塞港数据一律挂到 segment 上:模型 prompt 要把它当「到港等泊天数」用。
      segment.congestion = {
        code: congestion.code,
        name: congestion.name,
        waitingDays: congestion.waitingDays,
        level: congestion.level,
        note: congestion.note,
      };
      const conflict = congestionConflict(segment, congestion, rule);
      if (conflict) {
        segment.issues.push({
          type: 'congestion',
          label: `塞港等待 ${conflict.wait} 天 > 航段 ${segment.days} 天`,
          severity: 'error',
        });
        segment.suspicious = true;
        segment.reason = `${segment.toPort} 等泊约 ${conflict.wait} 天,航段只有 ${segment.days} 天`;
        continue;
      }
      // 阈值本身成立、只因「1 天内不提醒」被抑制:打标记,结论列表据此统计 suppressed。
      const days = Number(segment.days);
      if (
        Number.isFinite(days) &&
        Number.isFinite(suppressWithinDays) &&
        days <= suppressWithinDays &&
        thresholdConflict(segment, congestion, rule)
      ) {
        segment.suppressed = true;
        segment.suppressReason = `航段仅 ${days} 天,1 天内的可疑点不提醒`;
      }
    }
    if (group.segments.some((segment) => segment.issues.some((issue) => issue.severity === 'error'))) {
      group.abnormal = true;
    }
  }
  return hits;
}
