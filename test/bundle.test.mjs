import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';

/** The bundled host must work as plain ESM — that is how the DSH loader imports it. */
test('打包后的 lib/index.js 能挂载并跑完一次轨迹检测', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function');
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-bundle-'));
  mod.apply(ctx, { dataDir: home, autoCollect: false });
  assert.equal(routes.length, 1);

  const server = http.createServer((req, res) => routes[0].handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const bootstrap = await fetch(`http://127.0.0.1:${port}/shipping-workbench/api/bootstrap`).then((r) => r.json());
    assert.equal(bootstrap.model.available, false);

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['Rotation ID', '港口英文', '五字码', '航程', '排序', '新旧轨迹', '关联船队'],
        ['77', 'SHANGHAI', 'CNSHA', 20, 1, '新', 'F1'],
        ['77', 'BUSAN', 'KRPUS', 22, 2, '新', 'F1'],
      ]),
      '轨迹',
    );
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const body = new FormData();
    body.append('file', new File([buffer], 'track.xlsx'));
    const response = await fetch(`http://127.0.0.1:${port}/shipping-workbench/api/track/run`, {
      method: 'POST',
      body,
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.report.stats.groups, 1);
  } finally {
    server.close();
  }
});
