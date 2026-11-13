import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { isPdfFile, parsePdfTextItems, pdfToWorkbookBuffer, readPdfWorkbook } from '../src/domain/pdf.js';
import { readWorkbook } from '../src/domain/workbook.js';

/**
 * 最小 PDF 生成器:用 Courier 定宽字体写几行文本,坐标可以精确算。
 * 不依赖任何外部样本文件,仓库里不需要放真实船期表。
 */
function buildPdf(pageOps) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageOps.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageOps.length} >>`,
  ];
  pageOps.forEach((ops, index) => {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${
        3 + pageOps.length * 2
      } 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  let file = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, index) => {
    offsets.push(Buffer.byteLength(file, 'latin1'));
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(file, 'latin1');
  file += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    file += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  file += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, 'latin1');
}

/** 一行文本操作符;x/y 是基线坐标。 */
const op = (x, y, text) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;

test('PDF 文件名判定', () => {
  assert.equal(isPdfFile('a.PDF'), true);
  assert.equal(isPdfFile('a.xlsx'), false);
  assert.equal(isPdfFile(''), false);
});

test('两行表头合并:港口名铺到 ETA / ETD 两列', async () => {
  // 上排 PORT / BUSAN,下排 ETA / ETD,数据行 NINGBO + 两个日期。
  const pdf = buildPdf([
    [op(50, 700, 'PORT'), op(200, 700, 'BUSAN'), op(200, 688, 'ETA'), op(260, 688, 'ETD'), op(50, 676, 'NINGBO'), op(200, 676, '12-Oct'), op(260, 676, '14-Oct')].join('\n'),
  ]);
  const sheets = await readPdfWorkbook(pdf);
  assert.equal(sheets.length, 1);
  const rows = sheets[0].rows;
  const headerIndex = rows.findIndex((row) => row.join('|').includes('BUSAN ETA'));
  assert.ok(headerIndex >= 0, `应合并出 BUSAN ETA,实际:${JSON.stringify(rows)}`);
  assert.deepEqual(rows[headerIndex].filter(Boolean), ['PORT', 'BUSAN ETA', 'BUSAN ETD']);
  assert.deepEqual(rows[headerIndex + 1].filter(Boolean), ['NINGBO', '12-Oct', '14-Oct']);
});

test('同一格被拆成两截时拼回一个词', async () => {
  // Courier 12pt 每字符 7.2pt:BUS 宽 21.6,AN 紧接在后面 → 拼回 BUSAN。
  const pdf = buildPdf([
    [op(50, 700, 'VESSEL'), op(180, 700, 'VOYAGE'), op(50, 676, 'BUS'), op(71.6, 676, 'AN'), op(200, 676, '007E')].join('\n'),
  ]);
  const sheets = await readPdfWorkbook(pdf);
  const flat = sheets[0].rows.map((row) => row.filter(Boolean).join('|'));
  assert.ok(flat.some((line) => line.includes('BUSAN')), `应拼回 BUSAN,实际:${JSON.stringify(flat)}`);
});

test('pdfToWorkbookBuffer 的产物能被 readWorkbook 读回', async () => {
  const pdf = buildPdf([
    [op(50, 700, 'VESSEL'), op(150, 700, 'VOYAGE'), op(50, 676, 'A'), op(150, 676, '001')].join('\n'),
  ]);
  const buffer = await pdfToWorkbookBuffer(pdf);
  const book = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['第 1 页']);
  const sheets = readWorkbook(buffer);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, '第 1 页');
  const cells = sheets[0].rows.flat().filter(Boolean);
  assert.ok(cells.includes('VESSEL') && cells.includes('001'), JSON.stringify(sheets[0].rows));
});

test('parsePdfTextItems 可以直接喂坐标(不需要 PDF 文件)', () => {
  const sheets = parsePdfTextItems([
    [
      { str: '船名', x: 50, y: 700, width: 24, size: 12 },
      { str: '航次', x: 150, y: 700, width: 24, size: 12 },
      { str: 'SHENG TANG', x: 50, y: 680, width: 72, size: 12 },
      { str: '2601W', x: 150, y: 680, width: 36, size: 12 },
    ],
  ]);
  assert.equal(sheets[0].name, '第 1 页');
  const flat = sheets[0].rows.map((row) => row.filter(Boolean));
  assert.ok(flat.some((row) => row[0] === 'SHENG TANG' && row[1] === '2601W'), JSON.stringify(flat));
});

test('没有文字层的 PDF 报「可能是扫描件」', async () => {
  const pdf = buildPdf([[op(50, 50, ' ')].join('\n')]);
  await assert.rejects(() => readPdfWorkbook(pdf), /没有可提取的文字/);
});

test('损坏的 PDF 报可读错误', async () => {
  await assert.rejects(() => readPdfWorkbook(Buffer.from('not a pdf')), (error) => {
    assert.match(error.message, /PDF/);
    assert.ok(!error.message.includes('at '), '不要把堆栈甩给用户');
    return true;
  });
});
