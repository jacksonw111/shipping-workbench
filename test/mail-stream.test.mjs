import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../src/hosting/router.js';

/** 只实现流式接口需要的方法,验证「逐条推送」的协议。 */
function fakeMail() {
  return {
    async fetchRecent({ onMessage }) {
      const messages = [
        { uid: '101', subject: '第一封', attachments: [] },
        { uid: '102', subject: '第二封', attachments: [] },
      ];
      for (const message of messages) {
        onMessage?.(message);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return { fetched: 2, scanned: 5, skipped: 3, newMessages: messages, timings: { total: 60 }, endpoint: { host: 'test' } };
    },
    listMessages: () => [],
    findMessage: () => null,
    readBody: () => ({ html: '', text: '' }),
    readAttachment: () => ({ data: Buffer.from('') }),
    config: () => ({}),
  };
}

function start() {
  const handler = createHandler({
    settings: { read: () => ({}), publicView: () => ({}) },
    wechat: {},
    track: {},
    schedule: {},
    congestion: {},
    mail: fakeMail(),
    llm: {},
    hotspot: {},
    db: { listCarriers: () => [] },
  });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://127.0.0.1')));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('邮件流式接口:一封一封推送,最后才 done', async () => {
  const server = await start();
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/shipping-workbench/api/mail/fetch/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /ndjson/);

    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    }
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ['start', 'message', 'message', 'result', 'done']);
    assert.deepEqual(
      events.filter((event) => event.type === 'message').map((event) => event.message.uid),
      ['101', '102'],
    );
    assert.equal(events.at(-2).fetched, 2);
  } finally {
    server.close();
  }
});
