/** Tiny date/format helpers shared by the workbench domain code. */

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toIsoDate(value) {
  if (!value) return '';
  if (value instanceof Date) return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  if (typeof value === 'number') return excelSerialToIsoDate(value);
  const text = String(value).trim();
  if (!text) return '';
  const normalized = text.replace(/[./]/g, '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(normalized);
  if (match) return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : toIsoDate(parsed);
}

export function excelSerialToIsoDate(serial) {
  // Excel epoch starts 1899-12-30 (accounting for the 1900 leap-year bug).
  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function todayIso(now = new Date()) {
  return toIsoDate(now);
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${toIsoDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
