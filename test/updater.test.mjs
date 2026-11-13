import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updater, compareVersions, isNewer } from '../src/domain/updater.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个「已安装的插件目录」。 */
function makeInstall({ version = '0.10.0', lib = 'old-backend', ui = 'old-ui' } = {}) {
  const dir = tempDir('swb-install-');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shipping-workbench', version }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), lib);
  fs.writeFileSync(path.join(dir, 'ui', 'app.js'), ui);
  return dir;
}

/** 造一个「GitHub 解压出来的新包」。 */
function makeRelease({ version = '0.11.0', lib = 'new-backend', ui = 'new-ui', name = 'shipping-workbench' } = {}) {
  const dir = tempDir('swb-release-');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), lib);
  fs.writeFileSync(path.join(dir, 'ui', 'app.js'), ui);
  fs.writeFileSync(path.join(dir, 'README.md'), '# readme');
  return dir;
}

test('版本比较', () => {
  assert.equal(compareVersions('0.10.1', '0.10.0'), 1);
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('bad', '0.1.0'), -1);
  assert.equal(isNewer('0.11.0', '0.10.0'), true);
  assert.equal(isNewer('0.10.0', '0.10.0'), false);
});

test('检查更新:只读远端 package.json', async () => {
  const appDir = makeInstall({ version: '0.10.0' });
  const calls = [];
  const updater = new Updater({
    appDir,
    home: tempDir('swb-home-'),
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify({ version: '0.11.0' }) };
    },
  });
  const info = await updater.check();
  assert.equal(info.current, '0.10.0');
  assert.equal(info.latest, '0.11.0');
  assert.equal(info.hasUpdate, true);
  assert.match(calls[0], /api\.github\.com\/repos\/jacksonw111\/shipping-workbench\/contents\/package\.json\?ref=main$/);
});

test('检查更新失败时如实返回原因,不抛', async () => {
  const updater = new Updater({
    appDir: makeInstall(),
    home: tempDir('swb-home-'),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }),
  });
  const info = await updater.check();
  assert.equal(info.hasUpdate, false);
  assert.match(info.error, /HTTP 404/);
});

test('更新:后端变了 → 要求重启,并留备份', () => {
  const appDir = makeInstall({ lib: 'old-backend' });
  const home = tempDir('swb-home-');
  const updater = new Updater({ appDir, home });
  const result = updater.applyFromDirectory(makeRelease({ lib: 'new-backend' }));

  assert.equal(result.skipped, false);
  assert.equal(result.from, '0.10.0');
  assert.equal(result.to, '0.11.0');
  assert.equal(result.backendChanged, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.uiOnly, false);
  assert.equal(fs.readFileSync(path.join(appDir, 'lib', 'index.js'), 'utf8'), 'new-backend');
  assert.equal(fs.readFileSync(path.join(appDir, 'ui', 'app.js'), 'utf8'), 'new-ui');
  assert.equal(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version, '0.11.0');
  assert.ok(fs.existsSync(path.join(home, 'plugin-backup', 'last.json')));
  assert.ok(fs.existsSync(path.join(result.backup, 'lib', 'index.js')), '备份里应有旧后端');
});

test('更新:只改了界面 → 刷新即可,不用重启', () => {
  const appDir = makeInstall({ lib: 'same-backend', ui: 'old-ui' });
  const updater = new Updater({ appDir, home: tempDir('swb-home-') });
  const result = updater.applyFromDirectory(makeRelease({ lib: 'same-backend', ui: 'new-ui' }));
  assert.equal(result.backendChanged, false);
  assert.equal(result.uiOnly, true);
  assert.equal(result.restartRequired, false);
  assert.equal(fs.readFileSync(path.join(appDir, 'ui', 'app.js'), 'utf8'), 'new-ui');
});

test('已是最新时不覆盖;force 可以强制覆盖', () => {
  const appDir = makeInstall({ version: '0.11.0', lib: 'current' });
  const updater = new Updater({ appDir, home: tempDir('swb-home-') });
  const release = makeRelease({ version: '0.11.0', lib: 'same-version' });

  const skipped = updater.applyFromDirectory(release);
  assert.equal(skipped.skipped, true);
  assert.equal(fs.readFileSync(path.join(appDir, 'lib', 'index.js'), 'utf8'), 'current');

  const forced = updater.applyFromDirectory(release, { force: true });
  assert.equal(forced.skipped, false);
  assert.equal(fs.readFileSync(path.join(appDir, 'lib', 'index.js'), 'utf8'), 'same-version');
});

test('更新包不是本插件时拒绝覆盖', () => {
  const appDir = makeInstall();
  const updater = new Updater({ appDir, home: tempDir('swb-home-') });
  assert.throws(() => updater.applyFromDirectory(makeRelease({ name: 'other-plugin' })), /不是本插件/);
});
