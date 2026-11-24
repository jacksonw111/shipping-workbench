import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, contentTypeFor } from '../src/hosting/router.js';

const PDF = Buffer.from('%PDF-1.7\nfake');

/** 只提供附件下载需要的两个方法。 */
function mailStub(attachment, data) {
  return {
    listMessages: () => [],
    findMessage: () => ({ uid: '9', subject: 't', from: 'f', attachments: [attachment] }),
    readBody: () => ({ html: '', text: '' }),
    readAttachment: () => ({ attachment, data }),
    config: () => ({}),
  };
}

function start(mail) {
  const handler = createHandler({
    settings: { read: () => ({}), publicView: () => ({}) },
    wechat: {},
    track: {},
    schedule: {},
    congestion: {},
    mail,
    llm: {},
    hotspot: {},
    db: { listCarriers: () => [] },
  });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://127.0.0.1')));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('附件下载:按文件类型返回 content-type', async () => {
  const attachment = { id: '01-a.pdf', filename: '船期表.pdf', contentType: 'application/pdf', size: PDF.length };
  const server = await start(mailStub(attachment, PDF));
  const port = server.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/shipping-workbench/api/mail/attachments/9/${encodeURIComponent(attachment.id)}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF);
  } finally {
    server.close();
  }
});

test('附件下载:没有 contentType 时按扩展名推断', async () => {
  const attachment = { id: '02-a.xlsx', filename: 'a.xlsx', size: 3 };
  const server = await start(mailStub(attachment, Buffer.from('abc')));
  const port = server.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/shipping-workbench/api/mail/attachments/9/${encodeURIComponent(attachment.id)}`,
    );
    assert.match(response.headers.get('content-type'), /spreadsheetml/);
  } finally {
    server.close();
  }
});

test('contentTypeFor:常见类型映射与未知扩展名兜底', () => {
  assert.equal(contentTypeFor('a.PDF'), 'application/pdf');
  assert.equal(contentTypeFor('a.xls'), 'application/vnd.ms-excel');
  assert.equal(contentTypeFor('a.zip'), 'application/zip');
  assert.equal(contentTypeFor('a.png'), 'image/png');
  assert.equal(contentTypeFor('a.bin'), 'application/octet-stream');
  assert.equal(contentTypeFor('noext'), 'application/octet-stream');
});
