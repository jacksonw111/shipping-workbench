/** 按发件人/主题/附件名把一封邮件归到某个船东(命中越多越优先)。 */
export function matchCarrier(carriers, { subject = '', from = '', filename = '' } = {}) {
  const text = `${subject} ${from}`.toLowerCase();
  const file = String(filename).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const carrier of carriers ?? []) {
    const match = carrier.match ?? {};
    const senderHit = (match.senderIncludes ?? []).some((value) => text.includes(String(value).toLowerCase()));
    const subjectHit = (match.subjectIncludes ?? []).some((value) => text.includes(String(value).toLowerCase()));
    const fileHit = (match.filenameIncludes ?? []).some((value) => file.includes(String(value).toLowerCase()));
    const score = (senderHit ? 3 : 0) + (subjectHit ? 2 : 0) + (fileHit ? 2 : 0);
    if (score > bestScore) {
      best = carrier;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}
