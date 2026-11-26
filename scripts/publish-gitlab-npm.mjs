#!/usr/bin/env node
/**
 * 把插件发布到 GitLab npm Registry(项目级)。
 *
 * 用法:
 *   GITLAB_HOST=git.witranscn.com \
 *   GITLAB_PROJECT=internal-tools/shipping-workbench \
 *   GITLAB_TOKEN=<有 api 或 write_package_registry 的 token> \
 *   node scripts/publish-gitlab-npm.mjs [--version 0.12.2]
 *
 * 做三件事:
 * 1. 校验项目存在且开启了 Package Registry;
 * 2. 复制一份发布目录,把包名改成 scoped(@scope/name)、同步 cordis.patch.yml 的 name;
 * 3. npm pack + npm publish 到 `https://<host>/api/v4/projects/<id>/packages/npm/`。
 *
 * 不落任何凭据:token 只通过环境变量传入,临时 .npmrc 写在临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const host = process.env.GITLAB_HOST ?? 'git.witranscn.com';
const projectPath = process.env.GITLAB_PROJECT ?? 'internal-tools/shipping-workbench';
const token = process.env.GITLAB_TOKEN ?? '';
const scope = process.env.NPM_SCOPE ?? '@internal-tools';
const versionArg = process.argv.indexOf('--version') >= 0 ? process.argv[process.argv.indexOf('--version') + 1] : '';

if (!token) {
  console.error('缺少 GITLAB_TOKEN(需要 api 或 write_package_registry 权限)');
  process.exit(1);
}

const api = `https://${host}/api/v4`;
const headers = { 'PRIVATE-TOKEN': token, accept: 'application/json' };

async function apiJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const encoded = encodeURIComponent(projectPath);
const project = await apiJson(`${api}/projects/${encoded}`);
if (!project?.id) throw new Error('拿不到项目信息');
if (project.packages_enabled === false) {
  throw new Error('项目没有开启 Package Registry:Settings → General → Visibility 里打开 Packages');
}
console.log(`项目 ${project.path_with_namespace} (id=${project.id}) · Package Registry ${project.packages_enabled ? '已开启' : '未知'}`);

// ---- 准备发布目录 ----
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-npm-'));
const skipped = new Set(['node_modules', '.git', '.verify-data', 'screenshots', 'dist']);
for (const entry of fs.readdirSync(root)) {
  if (skipped.has(entry)) continue;
  fs.cpSync(path.join(root, entry), path.join(temp, entry), { recursive: true });
}

const packageFile = path.join(temp, 'package.json');
const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const version = versionArg || manifest.version;
manifest.name = `${scope}/shipping-workbench`;
manifest.version = version;
manifest.private = false;
manifest.publishConfig = { registry: `${api}/projects/${project.id}/packages/npm/` };
fs.writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);

// 插件入口的 name 必须和包名一致,否则 loader 解析不到。
const patchFile = path.join(temp, 'cordis.patch.yml');
if (fs.existsSync(patchFile)) {
  const patched = fs
    .readFileSync(patchFile, 'utf8')
    .replace(/name:\s*["']?shipping-workbench["']?/g, `name: "${manifest.name}"`);
  fs.writeFileSync(patchFile, patched);
}

// 客户端插件按**包名**注册;scoped 化之后必须同步 lib/client.js 的 id/name,
// 否则宿主侧能加载(接口 200),但侧栏入口注册不上。
const clientFile = path.join(temp, 'lib', 'client.js');
if (fs.existsSync(clientFile)) {
  const patchedClient = fs
    .readFileSync(clientFile, 'utf8')
    .replace(/id:\s*["']shipping-workbench["']/g, `id: "${manifest.name}"`)
    .replace(/name:\s*["']shipping-workbench["']/g, `name: "${manifest.name}"`);
  fs.writeFileSync(clientFile, patchedClient);
}

// ---- 发布 ----
const npmrc = path.join(temp, '.npmrc');
const registry = `${api}/projects/${project.id}/packages/npm/`;
fs.writeFileSync(
  npmrc,
  [
    `${scope}:registry=${registry}`,
    `//${host}/api/v4/projects/${project.id}/packages/npm/:_authToken=${token}`,
    'always-auth=true',
    '',
  ].join('\n'),
  { mode: 0o600 },
);

const run = (args) =>
  execFileSync('npm', args, { cwd: temp, stdio: 'inherit', env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc } });

run(['pack']);
const tarball = fs.readdirSync(temp).find((name) => name.endsWith('.tgz'));
if (!tarball) throw new Error('npm pack 没有产出 tgz');
console.log(`打包:${tarball}`);
run(['publish', path.join(temp, tarball), '--registry', registry, '--access', 'restricted']);
fs.rmSync(temp, { recursive: true, force: true });

console.log('\n发布完成。用户侧安装:');
console.log(`  1) 在 ~/.dsh/profiles/desktop/.npmrc 写:`);
console.log(`     ${scope}:registry=${registry}`);
console.log(`     //${host}/api/v4/projects/${project.id}/packages/npm/:_authToken=<只读 token>`);
console.log(`  2) DSH 设置 → 插件 → 安装,填:${manifest.name}@${version}`);
console.log(`     或 ${manifest.name}@latest`);