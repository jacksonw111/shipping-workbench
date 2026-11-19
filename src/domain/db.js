import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, workbenchHome } from '../util/paths.js';
import accountsSeed from '../data/accounts.json' with { type: 'json' };
import carriersSeed from '../data/carriers.json' with { type: 'json' };

const SCHEMA_VERSION = 6;

const SCHEMA = `
create table if not exists mp_account (
  id text primary key,
  name text not null,
  biz text not null,
  album_id text not null,
  enabled integer not null default 1,
  interval_minutes integer not null default 60,
  created_at text not null,
  last_collect_at text,
  last_error text,
  last_status text not null default 'idle',
  channel text not null default 'auto',
  backfilled integer not null default 0,
  unique (biz, album_id)
);

create table if not exists mp_article (
  account_id text not null references mp_account(id) on delete cascade,
  key text not null,
  title text not null default '',
  url text not null default '',
  published_at integer not null default 0,
  cover text not null default '',
  summary text not null default '',
  html text not null default '',
  word_count integer not null default 0,
  collected_at text not null,
  primary key (account_id, key)
);
create index if not exists mp_article_published on mp_article (published_at desc);

create table if not exists compare_run (
  id text primary key,
  kind text not null,
  status text not null default 'done',
  title text not null,
  source text not null default 'upload',
  inputs text not null default '{}',
  stats text not null default '{}',
  detail text not null default '{}',
  created_at text not null,
  duration_ms integer
);
create index if not exists compare_run_created on compare_run (created_at desc);

create table if not exists carrier (
  id text primary key,
  name text not null,
  format text not null default '',
  source text not null default '',
  description text not null default '',
  key_columns text not null default '',
  builtin integer not null default 0,
  match_json text not null default '{}',
  ingest_json text not null default '{}',
  parse_json text not null default '{}',
  keys_json text not null default '[]',
  date_column text not null default '',
  output_json text not null default '{}'
);

create table if not exists carrier_version (
  id text primary key,
  carrier_id text not null references carrier(id) on delete cascade,
  version_no integer not null,
  captured_at text not null,
  filename text not null default '',
  source text not null default 'upload',
  file_path text not null default '',
  row_count integer not null default 0,
  run_id text,
  unique (carrier_id, version_no)
);
create index if not exists carrier_version_latest on carrier_version (carrier_id, version_no desc);

create table if not exists congestion_port (
  code text primary key,
  name text not null default '',
  waiting_days real,
  level text not null default '',
  note text not null default '',
  updated_at text not null
);

create table if not exists app_flag (
  key text primary key,
  value text not null,
  updated_at text not null
);
`;

/** SQLite-backed store: 公众号、文章、对比任务记录、船东配置、塞港数据。 */
export class WorkbenchDb {
  constructor(file = path.join(workbenchHome(), 'workbench.db')) {
    ensureDir(path.dirname(file));
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('pragma journal_mode = wal');
    this.db.exec('pragma foreign_keys = on');
    this.migrate();
    this.seed();
    this.refreshBuiltinCarriers();
  }

  migrate() {
    this.db.exec(SCHEMA);
    const columns = this.db.prepare('pragma table_info(mp_account)').all().map((row) => row.name);
    if (!columns.includes('channel')) {
      this.db.exec("alter table mp_account add column channel text not null default 'auto'");
    }
    if (!columns.includes('backfilled')) {
      this.db.exec('alter table mp_account add column backfilled integer not null default 0');
    }
    const carrierColumns = this.db.prepare('pragma table_info(carrier)').all().map((row) => row.name);
    for (const [name, ddl] of [
      ['match_json', "text not null default '{}'"],
      ['ingest_json', "text not null default '{}'"],
      ['parse_json', "text not null default '{}'"],
      ['keys_json', "text not null default '[]'"],
      ['date_column', "text not null default ''"],
      ['output_json', "text not null default '{}'"],
    ]) {
      if (!carrierColumns.includes(name)) this.db.exec(`alter table carrier add column ${name} ${ddl}`);
    }
    this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
  }

  /** First-run data: the three 公众号 from the brief plus the 船东 preset list. */
  seed() {
    const flag = this.getFlag('seed:v1');
    if (flag) return;
    const now = new Date().toISOString();
    const insertAccount = this.db.prepare(
      `insert or ignore into mp_account (id, name, biz, album_id, enabled, interval_minutes, created_at, last_status, channel)
       values (?, ?, ?, ?, ?, ?, ?, 'idle', ?)`,
    );
    for (const account of accountsSeed) {
      insertAccount.run(
        account.id,
        account.name,
        account.biz,
        account.albumId ?? '',
        account.enabled === false ? 0 : 1,
        account.intervalMinutes ?? 60,
        now,
        account.channel ?? 'auto',
      );
    }
    const insertCarrier = this.db.prepare(
      `insert or ignore into carrier (id, name, format, source, description, key_columns, builtin,
        match_json, ingest_json, parse_json, keys_json, date_column, output_json)
       values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    );
    for (const carrier of carriersSeed) {
      const profile = carrier.profile ?? {};
      insertCarrier.run(
        carrier.id,
        carrier.name,
        carrier.format ?? '',
        carrier.source ?? '',
        carrier.description ?? '',
        (carrier.keyColumns ?? []).join(','),
        JSON.stringify(profile.match ?? {}),
        JSON.stringify(profile.ingest ?? {}),
        JSON.stringify(profile.parse ?? {}),
        JSON.stringify(profile.keys ?? []),
        profile.dateColumn ?? '',
        JSON.stringify(profile.output ?? {}),
      );
    }
    this.setFlag('seed:v1', now);
  }

  /** 升级时把内置船东的配置刷新到最新版本(用户自建的配置不动)。 */
  refreshBuiltinCarriers() {
    const marker = 'seed:carriers:v5';
    if (this.getFlag(marker)) return;
    const update = this.db.prepare(
      `update carrier set match_json = ?, ingest_json = ?, parse_json = ?, keys_json = ?, date_column = ?, output_json = ?
       where id = ? and builtin = 1`,
    );
    for (const carrier of carriersSeed) {
      const profile = carrier.profile ?? {};
      update.run(
        JSON.stringify(profile.match ?? {}),
        JSON.stringify(profile.ingest ?? {}),
        JSON.stringify(profile.parse ?? {}),
        JSON.stringify(profile.keys ?? []),
        profile.dateColumn ?? '',
        JSON.stringify(profile.output ?? {}),
        carrier.id,
      );
    }
    this.setFlag(marker, new Date().toISOString());
  }

  close() {
    this.db.close();
  }

  getFlag(key) {
    return this.db.prepare('select value from app_flag where key = ?').get(key)?.value ?? null;
  }

  setFlag(key, value) {
    this.db
      .prepare('insert into app_flag (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, new Date().toISOString());
  }

  /* ------------------------------------------------------------ accounts */

  listAccounts() {
    return this.db
      .prepare(
        `select a.*,
                (select count(*) from mp_article p where p.account_id = a.id) as article_count,
                (select max(p.published_at) from mp_article p where p.account_id = a.id) as latest_article_at
         from mp_account a
         order by a.created_at asc`,
      )
      .all()
      .map(mapAccount);
  }

  getAccount(id) {
    const row = this.db.prepare('select * from mp_account where id = ?').get(id);
    return row ? mapAccount(row) : null;
  }

  findAccountByBiz(biz) {
    const row = this.db.prepare('select * from mp_account where biz = ? limit 1').get(biz);
    return row ? mapAccount(row) : null;
  }

  insertAccount(account) {
    this.db
      .prepare(
        `insert into mp_account (id, name, biz, album_id, enabled, interval_minutes, created_at, last_collect_at, last_error, last_status, channel)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.name,
        account.biz,
        account.albumId,
        account.enabled ? 1 : 0,
        account.intervalMinutes,
        account.createdAt,
        account.lastCollectAt ?? null,
        account.lastError ?? null,
        account.lastStatus ?? 'idle',
        account.channel ?? 'auto',
      );
    return this.getAccount(account.id);
  }

  updateAccount(id, patch) {
    const current = this.getAccount(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `update mp_account
         set name = ?, biz = ?, album_id = ?, enabled = ?, interval_minutes = ?,
             last_collect_at = ?, last_error = ?, last_status = ?, channel = ?, backfilled = ?
         where id = ?`,
      )
      .run(
        next.name,
        next.biz,
        next.albumId,
        next.enabled ? 1 : 0,
        next.intervalMinutes,
        next.lastCollectAt ?? null,
        next.lastError ?? null,
        next.lastStatus ?? 'idle',
        next.channel ?? 'auto',
        next.backfilled ? 1 : 0,
        id,
      );
    return this.getAccount(id);
  }

  removeAccount(id) {
    this.db.prepare('delete from mp_account where id = ?').run(id);
  }

  /* ------------------------------------------------------------ articles */

  upsertArticle(article) {
    this.db
      .prepare(
        `insert into mp_article (account_id, key, title, url, published_at, cover, summary, html, word_count, collected_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(account_id, key) do update set
           title = excluded.title, url = excluded.url, published_at = excluded.published_at,
           cover = excluded.cover, summary = excluded.summary, html = excluded.html,
           word_count = excluded.word_count, collected_at = excluded.collected_at`,
      )
      .run(
        article.accountId,
        article.key,
        article.title ?? '',
        article.url ?? '',
        Number(article.publishedAt) || 0,
        article.cover ?? '',
        article.summary ?? '',
        article.html ?? '',
        Number(article.wordCount) || 0,
        article.collectedAt ?? new Date().toISOString(),
      );
  }

  /** 某账号最新一篇文章的发布时间(毫秒);没有文章返回 0。 */
  latestArticleAt(accountId) {
    const row = this.db
      .prepare('select max(published_at) as at from mp_article where account_id = ?')
      .get(accountId);
    return Number(row?.at ?? 0);
  }

  articleKeys(accountId) {
    return new Set(
      this.db
        .prepare('select key from mp_article where account_id = ?')
        .all(accountId)
        .map((row) => row.key),
    );
  }

  /**
   * 文章列表:支持按账号、时间、关键词过滤并分页。
   * @returns `{ items, total, limit, offset }`
   */
  listArticles({ limit = 30, offset = 0, accountId = '', since = 0, q = '' } = {}) {
    const where = [];
    const params = [];
    if (accountId) {
      where.push('p.account_id = ?');
      params.push(accountId);
    }
    if (since > 0) {
      where.push('p.published_at >= ?');
      params.push(since);
    }
    const keyword = String(q ?? '').trim();
    if (keyword) {
      where.push('(p.title like ? or p.summary like ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const total = this.db
      .prepare(`select count(*) as n from mp_article p join mp_account a on a.id = p.account_id ${clause}`)
      .get(...params).n;
    const rows = this.db
      .prepare(
        `select p.key, p.account_id, p.title, p.url, p.published_at, p.cover, p.summary,
                p.word_count, p.collected_at, a.name as account_name
         from mp_article p join mp_account a on a.id = p.account_id
         ${clause}
         order by p.published_at desc
         limit ? offset ?`,
      )
      .all(...params, Math.max(1, limit), Math.max(0, offset));
    return {
      items: rows.map((row) => ({
        key: row.key,
        accountId: row.account_id,
        accountName: row.account_name,
        title: row.title,
        url: row.url,
        publishedAt: row.published_at,
        cover: row.cover,
        summary: row.summary,
        wordCount: row.word_count,
        collectedAt: row.collected_at,
      })),
      total,
      limit,
      offset,
    };
  }

  /** 热点追踪用:最近 N 天的文章(标题/摘要/账号/原文链接),不分页。 */
  recentArticles({ days = 7, limit = 400 } = {}) {
    const since = Date.now() - Math.max(1, days) * 86_400_000;
    return this.db
      .prepare(
        `select p.key, p.account_id, p.title, p.summary, p.url, p.published_at, a.name as account_name
         from mp_article p join mp_account a on a.id = p.account_id
         where p.published_at >= ?
         order by p.published_at desc
         limit ?`,
      )
      .all(since, limit)
      .map((row) => ({
        key: row.key,
        accountId: row.account_id,
        accountName: row.account_name,
        title: row.title,
        summary: row.summary,
        url: row.url,
        publishedAt: row.published_at,
      }));
  }

  /** 热点追踪用:某一天(本地时区 00:00–24:00)发布的文章,字段与 recentArticles 一致。 */
  articlesOn(date, { limit = 400 } = {}) {
    const [year, month, dayOfMonth] = String(date ?? '')
      .split('-')
      .map(Number);
    const start = new Date(year, (month || 1) - 1, dayOfMonth || 1, 0, 0, 0, 0);
    if (Number.isNaN(start.getTime())) return [];
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return this.db
      .prepare(
        `select p.key, p.account_id, p.title, p.summary, p.url, p.published_at, a.name as account_name
         from mp_article p join mp_account a on a.id = p.account_id
         where p.published_at >= ? and p.published_at < ?
         order by p.published_at desc
         limit ?`,
      )
      .all(start.getTime(), end.getTime(), limit)
      .map((row) => ({
        key: row.key,
        accountId: row.account_id,
        accountName: row.account_name,
        title: row.title,
        summary: row.summary,
        url: row.url,
        publishedAt: row.published_at,
      }));
  }

  getArticle(accountId, key) {
    const row = this.db
      .prepare(
        `select p.*, a.name as account_name from mp_article p
         join mp_account a on a.id = p.account_id
         where p.account_id = ? and p.key = ?`,
      )
      .get(accountId, key);
    if (!row) return null;
    return {
      key: row.key,
      accountId: row.account_id,
      accountName: row.account_name,
      title: row.title,
      url: row.url,
      publishedAt: row.published_at,
      cover: row.cover,
      summary: row.summary,
      html: row.html,
      wordCount: row.word_count,
      collectedAt: row.collected_at,
    };
  }

  /* ---------------------------------------------------------- comparisons */

  insertRun(run) {
    this.db
      .prepare(
        `insert into compare_run (id, kind, status, title, source, inputs, stats, detail, created_at, duration_ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.kind,
        run.status ?? 'done',
        run.title,
        run.source ?? 'upload',
        JSON.stringify(run.inputs ?? {}),
        JSON.stringify(run.stats ?? {}),
        JSON.stringify(run.detail ?? {}),
        run.createdAt ?? new Date().toISOString(),
        run.durationMs ?? null,
      );
    return this.getRun(run.id);
  }

  getRun(id) {
    const row = this.db.prepare('select * from compare_run where id = ?').get(id);
    return row ? mapRun(row) : null;
  }

  /**
   * 对比任务记录:按类型/关键词过滤并分页。
   * @returns `{ items, total, limit, offset }`
   */
  listRuns({ kind = '', limit = 20, offset = 0, q = '' } = {}) {
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    const keyword = String(q ?? '').trim();
    if (keyword) {
      where.push('(title like ? or source like ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const total = this.db.prepare(`select count(*) as n from compare_run ${clause}`).get(...params).n;
    const rows = this.db
      .prepare(`select * from compare_run ${clause} order by created_at desc limit ? offset ?`)
      .all(...params, Math.max(1, limit), Math.max(0, offset));
    return { items: rows.map(mapRun), total, limit, offset };
  }

  removeRun(id) {
    this.db.prepare('delete from compare_run where id = ?').run(id);
  }

  /* ----------------------------------------------------- carrier versions */

  latestVersion(carrierId) {
    const row = this.db
      .prepare('select * from carrier_version where carrier_id = ? order by version_no desc limit 1')
      .get(carrierId);
    return row ? mapVersion(row) : null;
  }

  listVersions(carrierId, limit = 20) {
    return this.db
      .prepare('select * from carrier_version where carrier_id = ? order by version_no desc limit ?')
      .all(carrierId, limit)
      .map(mapVersion);
  }

  /** 新版本号 = 当前最大 + 1;返回插入后的记录。 */
  insertVersion({ carrierId, filename, source, filePath, rowCount, runId }) {
    const latest = this.latestVersion(carrierId);
    const versionNo = (latest?.versionNo ?? 0) + 1;
    const id = `v-${carrierId}-${versionNo}`;
    this.db
      .prepare(
        `insert into carrier_version (id, carrier_id, version_no, captured_at, filename, source, file_path, row_count, run_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, carrierId, versionNo, new Date().toISOString(), filename, source, filePath, rowCount, runId ?? null);
    return this.latestVersion(carrierId);
  }

  attachRunToVersion(carrierId, runId) {
    const latest = this.latestVersion(carrierId);
    if (!latest) return null;
    this.db.prepare('update carrier_version set run_id = ? where id = ?').run(runId, latest.id);
    return this.latestVersion(carrierId);
  }

  /* ------------------------------------------------------------- carriers */

  listCarriers() {
    return this.db.prepare('select * from carrier order by builtin desc, name asc').all().map(mapCarrier);
  }

  getCarrier(id) {
    const row = this.db.prepare('select * from carrier where id = ?').get(id);
    return row ? mapCarrier(row) : null;
  }

  /* ----------------------------------------------------------- congestion */

  congestionMeta() {
    const row = this.db
      .prepare('select count(*) as count, max(updated_at) as updated_at from congestion_port')
      .get();
    return { count: row?.count ?? 0, updatedAt: row?.updated_at ?? null };
  }

  /**
   * 塞港港口:按五字码/港口名搜索并分页。
   * @returns `{ items, total, limit, offset }`
   */
  listPorts({ q = '', limit = 50, offset = 0 } = {}) {
    const keyword = String(q ?? '').trim();
    const clause = keyword ? 'where code like ? or name like ?' : '';
    const params = keyword ? [`%${keyword.toUpperCase()}%`, `%${keyword}%`] : [];
    const total = this.db.prepare(`select count(*) as n from congestion_port ${clause}`).get(...params).n;
    const rows = this.db
      .prepare(`select * from congestion_port ${clause} order by code asc limit ? offset ?`)
      .all(...params, Math.max(1, limit), Math.max(0, offset));
    return {
      items: rows.map((row) => ({
        code: row.code,
        name: row.name,
        waitingDays: row.waiting_days,
        level: row.level,
        note: row.note,
        updatedAt: row.updated_at,
      })),
      total,
      limit,
      offset,
    };
  }

  getPort(code) {
    if (!code) return null;
    const row = this.db.prepare('select * from congestion_port where code = ?').get(String(code).toUpperCase());
    if (!row) return null;
    return {
      code: row.code,
      name: row.name,
      waitingDays: row.waiting_days,
      level: row.level,
      note: row.note,
      updatedAt: row.updated_at,
    };
  }

  upsertPorts(rows, source) {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `insert into congestion_port (code, name, waiting_days, level, note, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(code) do update set
         name = excluded.name, waiting_days = excluded.waiting_days,
         level = excluded.level, note = excluded.note, updated_at = excluded.updated_at`,
    );
    let count = 0;
    for (const row of rows) {
      const code = String(row.code ?? '').toUpperCase().trim();
      if (!code) continue;
      statement.run(code, row.name ?? '', Number.isFinite(Number(row.waitingDays)) ? Number(row.waitingDays) : null, row.level ?? '', row.note ?? '', now);
      count += 1;
    }
    if (count > 0) this.setFlag('congestion:source', source ?? 'manual');
    return count;
  }

  congestionSource() {
    return this.getFlag('congestion:source') ?? '';
  }
}

function mapVersion(row) {
  return {
    id: row.id,
    carrierId: row.carrier_id,
    versionNo: row.version_no,
    capturedAt: row.captured_at,
    filename: row.filename,
    source: row.source,
    filePath: row.file_path,
    rowCount: row.row_count,
    runId: row.run_id,
  };
}

function mapCarrier(row) {
  const safe = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    source: row.source,
    description: row.description,
    keyColumns: row.key_columns ? row.key_columns.split(',').filter(Boolean) : [],
    builtin: Boolean(row.builtin),
    match: safe(row.match_json, {}),
    ingest: safe(row.ingest_json, {}),
    parse: safe(row.parse_json, {}),
    keys: safe(row.keys_json, []),
    dateColumn: row.date_column ?? '',
    output: safe(row.output_json, {}),
  };
}

function mapAccount(row) {
  return {
    id: row.id,
    name: row.name,
    biz: row.biz,
    albumId: row.album_id,
    enabled: Boolean(row.enabled),
    intervalMinutes: row.interval_minutes,
    createdAt: row.created_at,
    lastCollectAt: row.last_collect_at,
    lastError: row.last_error,
    lastStatus: row.last_status,
    channel: row.channel ?? 'auto',
    backfilled: Boolean(row.backfilled),
    articleCount: Number(row.article_count ?? 0),
    latestArticleAt: row.latest_article_at ?? 0,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    source: row.source,
    inputs: safeJson(row.inputs),
    stats: safeJson(row.stats),
    detail: safeJson(row.detail),
    createdAt: row.created_at,
    durationMs: row.duration_ms,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
