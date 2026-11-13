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
