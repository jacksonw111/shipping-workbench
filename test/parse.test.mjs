import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticleHtml, extractElementById, sanitizeHtml, parseAlbumUrl, looksBlocked } from '../src/domain/wechat.js';
import { parseMime, parseHeaders, decodeWords, quotedPrintable } from '../src/domain/mime.js';
import { toPortRow } from '../src/domain/congestion.js';

const ARTICLE_HTML = `
<html><head>
<meta property="og:title" content="MSC 新增美西航线" />
<meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg" />
<script>var biz = "MzU2";</script>
</head><body>
<h1 id="activity-name">MSC 新增美西航线</h1>
<div class="rich_media_meta"><span>发布于 2026-11-01</span></div>
<div id="js_content" class="rich_media_content">
  <p>自 12 月起新增<b>厦门-长滩</b>直航。</p>
  <div><p>挂港:厦门、釜山、长滩。</p><img src="https://mmbiz.qpic.cn/a.png" /></div>
  <script>alert(1)</script>
</div>
<script>var nickname = "MSC地中海航运"; var ct = "1762000000";</script>
</body></html>`;

test('解析公众号文章正文与发布时间', () => {
  const parsed = parseArticleHtml(ARTICLE_HTML, 'https://mp.weixin.qq.com/s/x');
  assert.equal(parsed.title, 'MSC 新增美西航线');
  assert.equal(parsed.account, 'MSC地中海航运');
  assert.equal(new Date(parsed.publishedAt).getFullYear(), 2025);
  assert.ok(parsed.html.includes('厦门-长滩'));
  assert.ok(!parsed.html.includes('<script'));
  assert.ok(parsed.html.includes('<img'));
  assert.ok(parsed.summary.includes('直航'));
});

test('嵌套 div 提取不截断', () => {
  const html = '<div id="js_content"><div><p>A</p></div><p>B</p></div><div>tail</div>';
  assert.equal(extractElementById(html, 'js_content'), '<div><p>A</p></div><p>B</p>');
});

test('清洗事件属性与 javascript: 协议', () => {
  const clean = sanitizeHtml('<p onclick="x()" onmouseover=\'y()\'>hi <a href="javascript:bad()">a</a></p>');
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onmouseover'));
  assert.ok(!clean.includes('javascript:'));
});

test('合集链接解析', () => {
  assert.deepEqual(parseAlbumUrl('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzA5&album_id=9'), {
    biz: 'MzA5',
    albumId: '9',
  });
  assert.deepEqual(parseAlbumUrl('not-a-url'), { biz: '', albumId: '' });
});

test('风控文案识别', () => {
  assert.equal(looksBlocked('<html>环境异常</html>'), true);
  assert.equal(looksBlocked('<html>正常文章</html>'), false);
});

test('MIME: base64 附件与 RFC2047 文件名', () => {
  const raw = Buffer.from(
    [
      'From: "PIL" <schedule@pil.com>',
      'Subject: =?utf-8?B?6Ii55pyf6KGo?=',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '见附件',
      '--B',
      'Content-Type: application/vnd.ms-excel; name="=?utf-8?B?6Ii55pyf6KGoLnhscw==?="',
      'Content-Disposition: attachment; filename="=?utf-8?B?6Ii55pyf6KGoLnhscw==?="',
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8=',
      '--B--',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const parsed = parseMime(raw);
  assert.equal(parsed.text.trim(), '见附件');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, '船期表.xls');
  assert.equal(parsed.attachments[0].data.toString(), 'hello');
  const headers = parseHeaders('Subject: =?utf-8?B?6Ii55pyf6KGo?=\r\nX-Y: 1');
  assert.equal(decodeWords(headers.subject), '船期表');
});

test('MIME: RFC2231 编码的文件名', () => {
  const encoded = encodeURIComponent('船期表.xlsx');
  const raw = Buffer.from(
    [
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '--B',
      'Content-Type: application/octet-stream',
      `Content-Disposition: attachment; filename*=UTF-8''${encoded}`,
      'Content-Transfer-Encoding: base64',
      '',
      'aGk=',
      '--B--',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const parsed = parseMime(raw);
  assert.equal(parsed.attachments[0].filename, '船期表.xlsx');
});

test('quoted-printable 解码', () => {
  assert.equal(quotedPrintable(Buffer.from('a=3Db=0A')).toString(), 'a=b\n');
});

test('CargoAct 记录 → 塞港行:解析等泊天数与拥堵等级', () => {
  const heavy = toPortRow({
    Code: 'SADMM',
    Name: 'Dammam',
    Status: 'HEAVILY_REDUCED',
    Comment: 'The 7-day average vessel waiting time is around 3 days. Delays continue.',
  });
  assert.deepEqual(
    { code: heavy.code, name: heavy.name, waitingDays: heavy.waitingDays, level: heavy.level },
    { code: 'SADMM', name: 'Dammam', waitingDays: 3, level: '严重' },
  );

  const slight = toPortRow({
    Code: 'ausyd',
    Name: 'Sydney',
    Status: 'SLIGHTLY_REDUCED',
    Comment: 'The 7-day average vessel waiting time is around 1.5 days.',
  });
  assert.equal(slight.code, 'AUSYD');
  assert.equal(slight.waitingDays, 1.5);
  assert.equal(slight.level, '轻微');

  const unknown = toPortRow({ Code: 'CNNGB', Name: 'Ningbo', Status: '', Comment: 'No data.' });
  assert.equal(unknown.waitingDays, null, '没有天数就不猜');
  assert.equal(unknown.level, '');
});

test('CargoAct:小时级措辞不会误判成天数', () => {
  const row = toPortRow({ Code: 'CNSHA', Name: 'Shanghai', Status: 'SLIGHTLY_REDUCED', Comment: 'waiting around 12 hours' });
  assert.equal(row.waitingDays, null);
});
