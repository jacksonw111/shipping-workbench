import * as XLSX from 'xlsx';

/** Read an .xls/.xlsx buffer into `[{ name, rows }]` (rows are value arrays). */
export function readWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false });
    return { name, rows };
  });
}

export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  return String(value).trim();
}

/**
 * 读工作簿,并带上「隐藏行」信息。
 *
 * Skill 常按 Excel 的隐藏行剔除无效航线(如 ZIM 技能要求读 hidden="1"),
 * `sheet_to_json` 会丢掉这个属性,所以这里从 `!rows` 里补回来。
 * @returns `[{ name, rows, hiddenRows }]`;hiddenRows[i] 对应 rows[i] 是否隐藏。
 */
export function readWorkbookDetailed(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    // blankrows: true 保证行号与 `!rows` 对齐,再自己跳过空行。
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
    const meta = sheet['!rows'] ?? [];
    const rows = [];
    const hiddenRows = [];
    raw.forEach((row, index) => {
      if (!row || row.every((cell) => String(cell ?? '').trim() === '')) return;
      rows.push(row);
      hiddenRows.push(Boolean(meta[index]?.hidden));
    });
    return { name, rows, hiddenRows };
  });
}
