/**
 * 轨迹检测的「模型候选」预筛。
 *
 * 全量 11k 行 / 1.4k 组全喂模型既慢又贵,而且大部分航段本来就合理。
 * 这里先用确定性规则挑出值得模型看一眼的组,再交给模型:
 *   1. 规则层硬错(累计回退、缺字段、闭环超额);
 *   2. 塞港冲突(等泊明显长于航段,已被 1 天规则压过的不会再进来);
 *   3. 统计异常(航段天数超过全量 p99,或超过本航线中位数的若干倍)。
 * 没命中的组直接跳过 —— 不是「漏判」,是本来就按规则判过没有疑点。
 */

export const DEFAULT_CANDIDATE_RULE = {
  /** 最多送多少个组给模型,防止极端数据把一次检测拖成几百次请求。 */
  maxCandidates: 400,
  /** 航段天数绝对下限:低于它的段不进「统计异常」。 */
  minDays: 25,
  /** 相对本航线中位数的倍数。 */
  ratio: 2.5,
  /** 倍数判断的额外下限,避免短航线被中位数放大。 */
  ratioFloorDays: 7,
  /** 纯「统计异常」最多补多少个组;规则/塞港命中的不受此限。 */
  outlierTop: 120,
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index];
}

/**
 * @param groups - `applyRules` + `enrichWithCongestion` 之后的轨迹组。
 * @returns `{ groups, candidates, scanned, truncated, reasons, p99 }`
 */
export function selectCandidates(groups, rule = {}) {
  const config = { ...DEFAULT_CANDIDATE_RULE, ...(rule ?? {}) };
  const maxCandidates = Math.max(1, Number(config.maxCandidates) || DEFAULT_CANDIDATE_RULE.maxCandidates);
  const minDays = Math.max(1, Number(config.minDays) || DEFAULT_CANDIDATE_RULE.minDays);
  const ratio = Number(config.ratio) > 1 ? Number(config.ratio) : DEFAULT_CANDIDATE_RULE.ratio;
  const ratioFloor = Number(config.ratioFloorDays) > 0 ? Number(config.ratioFloorDays) : DEFAULT_CANDIDATE_RULE.ratioFloorDays;

  const active = (groups ?? []).filter((group) => group && !group.skipped);
  const allDays = active
    .flatMap((group) => group.segments.map((segment) => segment.days))
    .filter((days) => Number.isFinite(days) && days > 0)
    .sort((left, right) => left - right);
  // 用 p99 而不是 p95:长航段本来就多,p95 会把几百组都算成「异常」。
  const p99 = Math.max(minDays, percentile(allDays, 0.99));

  const picked = [];
  for (const group of active) {
    const reasons = new Set();
    let score = 0;
    const days = group.segments
      .map((segment) => segment.days)
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    const median = days.length > 0 ? days[Math.floor(days.length / 2)] : 0;
    for (const segment of group.segments) {
      if (segment.issues?.some((issue) => issue.severity === 'error' && issue.type !== 'congestion')) {
        reasons.add('rule');
        score += 100;
      }
      if (segment.issues?.some((issue) => issue.type === 'congestion')) {
        reasons.add('congestion');
        score += 60;
      }
      const absolute = segment.days >= p99;
      const relative = median > 0 && segment.days >= Math.max(ratioFloor, median * ratio);
      if (absolute || relative) {
        reasons.add('outlier');
        score += absolute ? 40 : 20;
      }
    }
    if (reasons.size > 0) picked.push({ group, score, reasons: [...reasons] });
  }

  // 硬命中(规则/塞港)全收;纯统计异常只补最慢的 outlierTop 个,避免候选被长航段占满。
  const hard = picked.filter((item) => item.reasons.includes('rule') || item.reasons.includes('congestion'));
  const soft = picked
    .filter((item) => !item.reasons.includes('rule') && !item.reasons.includes('congestion'))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, Number(config.outlierTop) || DEFAULT_CANDIDATE_RULE.outlierTop));
  const merged = [...hard, ...soft];
  merged.sort((left, right) => right.score - left.score);
  const kept = merged.slice(0, maxCandidates);
  return {
    groups: kept.map((item) => item.group),
    candidates: kept.length,
    scanned: active.length,
    truncated: Math.max(0, merged.length - kept.length),
    reasons: {
      rule: kept.filter((item) => item.reasons.includes('rule')).length,
      congestion: kept.filter((item) => item.reasons.includes('congestion')).length,
      outlier: kept.filter((item) => item.reasons.includes('outlier')).length,
    },
    p99,
  };
}
