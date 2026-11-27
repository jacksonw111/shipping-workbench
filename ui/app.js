const API = '/shipping-workbench/api';

const TABS = [
  ['accounts', '公众号'],
  ['track', '轨迹检测'],
  ['schedule', '船期对比'],
  ['mail', '邮件'],
  ['congestion', '塞港'],
  ['settings', '设置'],
];

const state = {
  tab: 'accounts',
  boot: null,
  accounts: {
    q: '',
    offset: 0,
    limit: 10,
    list: [],
    total: 0,
    loaded: false,
    loading: false,
    candidates: null,
    busy: null,
    detail: null,
  },
  articleList: { q: '', offset: 0, limit: 10, items: [], total: 0, accountId: '', loading: false },
  article: null,
  hotspots: {
    date: '',
    today: '',
    report: null,
    reports: [],
    articleCount: 0,
    ready: null,
    reason: '',
    loaded: false,
    loading: false,
    busy: false,
  },
  track: {
    file: null,
    busy: false,
    useLlm: null,
    progress: null,
    report: null,
    sheet: null,
    filter: 'flagged',
    runs: { q: '', offset: 0, limit: 8, items: [], total: 0, loading: false },
  },
  schedule: {
    oldFile: null,
    newFile: null,
    skillFile: null,
    executeScripts: false,
    busy: false,
    fetchingMail: false,
    fetchProgress: null,
    busyKey: '',
    recomparing: false,
    pairs: { items: [], total: 0, loading: false, loaded: false },
    result: null,
    sheet: null,
    side: 'old',
    summaryView: false,
    runs: { q: '', offset: 0, limit: 8, items: [], total: 0, loading: false },
  },
  mail: {
    busy: false,
    smtp: null,
    detection: null,
    openUid: null,
    detail: null,
    list: { q: '', offset: 0, limit: 10, items: [], total: 0, loading: false },
    progress: null,
  },
  update: { checking: false, applying: false, info: null, error: '' },
  prompts: { loaded: false, loading: false, track: { default: '', override: '', system: '' }, draft: null, saving: false },
  congestion: {
    busy: false,
    list: { q: '', offset: 0, limit: 20, items: [], total: 0, loading: false },
    meta: { updatedAt: null, source: '' },
  },
};

const main = document.getElementById('main');
const nav = document.getElementById('nav');

/* ------------------------------------------------------------------ utils */

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof FormData ? options.headers : { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let details = null;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
      else if (data?.message) message = data.message;
      details = data?.details ?? null;
    } catch {
      /* keep status text */
    }
    const error = new Error(message);
    error.details = details;
    throw error;
  }
  return contentType.includes('application/json') ? response.json() : response;
}

/** 流式事件密集时合并渲染,避免一封一重绘把页面刷爆。 */
let renderTimer = null;
function renderSoon() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 120);
}

/**
 * 逐行读取 NDJSON 响应。每条事件交给 onEvent,不必等整个请求结束。
 */
async function apiStream(path, body, onEvent) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      /* 保留状态码 */
    }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      try {
        onEvent(JSON.parse(text));
      } catch {
        // 半行/坏行跳过
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail));
    } catch {
      /* 忽略 */
    }
  }
}

function toast(message, kind = 'info') {
  const stack = document.getElementById('toasts');
  const item = document.createElement('div');
  item.className = 'toast';
  item.dataset.kind = kind;
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => item.remove(), kind === 'error' ? 9000 : 4200);
}

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtDate(value) {
  return fmtTime(value).slice(0, 10);
}

function relative(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function bytes(size) {
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function download(path) {
  const link = document.createElement('a');
  link.href = `${API}${path}`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function statusChip(status) {
  if (status === '新增') return '<span class="chip chip-ok">新增</span>';
  if (status === '删除') return '<span class="chip chip-danger">删除</span>';
  if (status === '变更') return '<span class="chip chip-warn">变更</span>';
  if (status === 'failed') return '<span class="chip chip-danger">失败</span>';
  return '<span class="chip">—</span>';
}

/**
 * 列表通用控件:搜索框 + 页码信息 + 上一页/下一页。
 * @param {string} id - 控件命名空间(页内唯一)。
 * @param {{q:string,offset:number,limit:number}} cursor - 该列表的分页状态。
 * @param {number} total - 服务端返回的总条数。
 */
function listControls(id, cursor, total, { placeholder = '搜索', unit = '条' } = {}) {
  const page = Math.floor(cursor.offset / cursor.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / cursor.limit));
  return `<div class="list-controls">
    <input class="input list-search" id="${id}-q" value="${esc(cursor.q)}" placeholder="${esc(placeholder)}" />
    <span class="spacer"></span>
    <span class="field-note">${total} ${unit} · ${page}/${pages}</span>
    <button class="btn btn-ghost" data-page="${id}" data-dir="-1" ${cursor.offset <= 0 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-ghost" data-page="${id}" data-dir="1" ${
      cursor.offset + cursor.limit >= total ? 'disabled' : ''
    }>下一页</button>
  </div>`;
}

/** 绑定搜索(回车)与翻页;reload 由调用方提供。 */
function bindListControls(view, id, cursor, reload) {
  const input = view.querySelector(`#${id}-q`);
  input?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    cursor.q = input.value.trim();
    cursor.offset = 0;
    reload();
  });
  view.querySelectorAll(`[data-page="${id}"]`).forEach((button) => {
    button.addEventListener('click', () => {
      cursor.offset = Math.max(0, cursor.offset + Number(button.dataset.dir) * cursor.limit);
      reload();
    });
  });
}

function loadingRow(columns, text = '加载中…') {
  return `<tr><td colspan="${columns}"><div class="empty">${text}</div></td></tr>`;
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    state.boot = await api('/bootstrap');
    render();
    await loadAccounts();
  } catch (error) {
    main.innerHTML = `<div class="empty">工作台加载失败:${esc(error.message)}</div>`;
  }
}

async function refreshBoot() {
  state.boot = await api('/bootstrap');
  state.accounts.loaded = false;
}

/** 公众号列表:服务端搜索 + 分页。 */
async function loadAccounts() {
  const cursor = state.accounts;
  cursor.loading = true;
  try {
    const params = new URLSearchParams({ q: cursor.q, limit: String(cursor.limit), offset: String(cursor.offset) });
    const data = await api(`/accounts?${params}`);
    cursor.list = data.accounts ?? [];
    cursor.total = data.total ?? 0;
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
  }
  render();
}

/* ------------------------------------------------------------------ render */

function render() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    if (button.dataset.tab === state.tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  try {
    renderView();
  } catch (error) {
    console.error('[shipping-workbench] 页面渲染失败:', error);
    main.innerHTML = `<div class="card"><div class="empty">页面渲染失败:${esc(error.message)}</div></div>`;
  }
}

function renderView() {
  main.innerHTML = '<div id="view"></div>';
  const view = document.getElementById('view');
  const routes = {
    accounts: renderAccounts,
    track: renderTrack,
    schedule: renderSchedule,
    mail: renderMail,
    congestion: renderCongestion,
    settings: renderSettings,
  };
  (routes[state.tab] ?? renderAccounts)(view);
  renderRailFoot();
}

function renderRailFoot() {
  const foot = document.getElementById('rail-foot');
  const accounts = state.boot?.accounts ?? [];
  const enabled = accounts.filter((account) => account.enabled).length;
  foot.innerHTML = `
    <div>${accounts.length} 个公众号 · ${enabled} 个启用</div>
    <button class="btn btn-ghost" id="theme-toggle" style="padding:4px 0">切换主题</button>
  `;
  foot.querySelector('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('workbench:theme', next);
  });
}

/* --------------------------------------------------------------- accounts */

function renderAccounts(view) {
  const sub = state.accounts.sub ?? 'tasks';
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">公众号</h1>
      <div class="page-sub">
        <div class="tabs" id="account-tabs">
          <button data-sub="tasks" aria-pressed="${sub === 'tasks'}">公众号任务</button>
          <button data-sub="hot" aria-pressed="${sub === 'hot'}">AI 热点追踪</button>
        </div>
      </div>
    </div>
    <div id="account-body"></div>
  `;
  view.querySelector('#account-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sub]');
    if (!button) return;
    state.accounts.sub = button.dataset.sub;
    render();
  });
  const body = view.querySelector('#account-body');
  if (sub === 'hot') renderHotspots(body);
  else renderAccountTasks(body);
}

/* --------------------------------------------------------- 公众号任务 */

function renderAccountTasks(view) {
  const list = state.accounts.list ?? [];
  const detail = state.accounts.detail;
  if (state.accounts.detail) {
    renderAccountDetail(view);
    return;
  }
  view.innerHTML = `
    <div class="card">
      <form id="account-form" class="row">
        <input class="input" name="name" placeholder="输入公众号名称,如 MSC地中海航运" style="flex:1;min-width:240px" required />
        <button class="btn btn-primary" type="submit" ${state.accounts.busy ? 'disabled' : ''}>${
          state.accounts.busy ? '<span class="spinner"></span> 查找中' : '查找并添加'
        }</button>
        <span class="field-note">每</span>
        <input class="input" name="intervalMinutes" type="number" min="5" value="60" style="width:72px" aria-label="抓取间隔(分钟)" />
        <span class="field-note">分钟</span>
      </form>
      ${
        state.accounts.candidates?.length
          ? `<div class="banner" style="margin-top:12px">
              <div style="margin-bottom:8px">搜到多个公众号,选一个:</div>
              ${state.accounts.candidates
                .map(
                  (candidate, index) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)">
                    <span class="strong">${esc(candidate.name)}</span>
                    <span class="mono field-note">${esc(candidate.biz)}</span>
                    <span class="spacer"></span>
                    <button class="btn" data-pick-candidate="${index}">用这个</button>
                  </div>`,
                )
                .join('')}
              <div class="row" style="margin-top:8px"><button class="btn btn-ghost" id="cancel-candidates">取消</button></div>
            </div>`
          : ''
      }
    </div>
    <div class="card" style="padding:0">
      ${listControls('accounts', state.accounts, state.accounts.total, { placeholder: '搜索公众号名称' })}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>公众号</th><th>通道</th><th class="num">文章</th><th>间隔</th><th>最近抓取</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${
              list.length === 0
                ? loadingRow(7, '还没有公众号')
                : list
                    .map(
                      (account) => `<tr>
                        <td class="strong">${esc(account.name)}</td>
                        <td><span class="chip">${account.albumId ? '合集+搜狗' : '搜狗'}</span></td>
                        <td class="num">${account.articleCount ?? 0}</td>
                        <td>${account.intervalMinutes} 分</td>
                        <td>${account.lastCollectAt ? relative(new Date(account.lastCollectAt).getTime()) : '—'}</td>
                        <td>${
                          account.lastStatus === 'failed'
                            ? `<span class="chip chip-danger" title="${esc(account.lastError ?? '')}">失败</span>`
                            : account.lastStatus === 'partial'
                              ? `<span class="chip chip-warn" title="${esc(account.lastError ?? '')}">部分失败</span>`
                              : account.lastError
                                ? `<span class="chip chip-ok" title="${esc(account.lastError)}">正常(有提示)</span>`
                                : account.enabled
                                  ? '<span class="chip chip-ok">启用</span>'
                                  : '<span class="chip">停用</span>'
                        }</td>
                        <td>
                          <div class="row">
                            <button class="btn btn-ghost" data-detail="${account.id}">详情</button>
                            <button class="btn btn-ghost" data-action="collect" data-id="${account.id}" ${
                              state.accounts.busy === account.id ? 'disabled' : ''
                            }>${state.accounts.busy === account.id ? '<span class="spinner"></span>' : '抓取'}</button>
                            <button class="btn btn-ghost" data-action="toggle" data-id="${account.id}">${
                              account.enabled ? '停用' : '启用'
                            }</button>
                            <button class="btn btn-ghost btn-danger" data-action="remove" data-id="${account.id}">删除</button>
                          </div>
                        </td>
                      </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
  bindAccountEvents(view, list);
}

function bindAccountEvents(view, list) {
  view.querySelector('#account-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return;
    state.accounts.busy = true;
    state.accounts.candidates = null;
    render();
    try {
      const data = await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({ name, intervalMinutes: Number(form.get('intervalMinutes')) || 60 }),
      });
      toast(`已添加「${data.account.name}」`, 'ok');
      await refreshBoot();
    } catch (error) {
      if (error.details?.candidates) state.accounts.candidates = error.details.candidates;
      else toast(error.message, 'error');
    } finally {
      state.accounts.busy = null;
      render();
    }
  });

  view.querySelector('#cancel-candidates')?.addEventListener('click', () => {
    state.accounts.candidates = null;
    render();
  });

  view.querySelectorAll('[data-pick-candidate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const candidate = state.accounts.candidates[Number(button.dataset.pickCandidate)];
      if (!candidate) return;
      try {
        await api('/accounts', {
          method: 'POST',
          body: JSON.stringify({ name: candidate.name, biz: candidate.biz, albumId: candidate.albumId, intervalMinutes: 60 }),
        });
        state.accounts.candidates = null;
        toast(`已添加「${candidate.name}」`, 'ok');
        await refreshBoot();
      } catch (error) {
        toast(error.message, 'error');
      }
      render();
    });
  });

  bindListControls(view, 'accounts', state.accounts, loadAccounts);
  if (!state.accounts.loaded && !state.accounts.loading) loadAccounts();

  view.querySelectorAll('[data-detail]').forEach((button) => {
    button.addEventListener('click', () => openAccountDetail(button.dataset.detail));
  });

  view.querySelector('table')?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const account = list.find((item) => item.id === button.dataset.id);
    if (!account) return;
    if (button.dataset.action === 'collect') {
      state.accounts.busy = account.id;
      render();
      try {
        const result = await api(`/accounts/${account.id}/collect`, { method: 'POST', body: '{}' });
        toast(`新增 ${result.added} 篇${result.warnings?.length ? `;${result.warnings.join(';')}` : ''}`, result.added ? 'ok' : 'info');
        await refreshBoot();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        state.accounts.busy = null;
        render();
      }
      return;
    }
    if (button.dataset.action === 'toggle') {
      try {
        await api('/accounts', { method: 'POST', body: JSON.stringify({ id: account.id, enabled: !account.enabled }) });
        await refreshBoot();
      } catch (error) {
        toast(error.message, 'error');
      }
      render();
      return;
    }
    if (button.dataset.action === 'remove') {
      if (!confirm(`删除「${account.name}」及其文章?`)) return;
      try {
        await api(`/accounts/${account.id}`, { method: 'DELETE' });
        await refreshBoot();
      } catch (error) {
        toast(error.message, 'error');
      }
      render();
    }
  });
}

/* --------------------------------------------------- 公众号详情(文章列表) */

async function openAccountDetail(accountId) {
  const account = (state.boot?.accounts ?? []).find((item) => item.id === accountId);
  if (!account) return;
  state.accounts.detail = { account, article: null };
  state.articleList = { q: '', offset: 0, limit: 10, items: [], total: 0, accountId, loading: true };
  render();
  await loadArticles();
}

async function loadArticles() {
  const cursor = state.articleList;
  try {
    const params = new URLSearchParams({
      accountId: cursor.accountId,
      q: cursor.q,
      limit: String(cursor.limit),
      offset: String(cursor.offset),
    });
    const data = await api(`/articles?${params}`);
    cursor.items = data.articles ?? [];
    cursor.total = data.total ?? 0;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

function renderAccountDetail(view) {
  const detail = state.accounts.detail;
  const cursor = state.articleList;
  if (detail.article) {
    view.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">${esc(detail.article.title)}</h1>
        <div class="page-sub">
          <a href="${esc(detail.article.url)}" target="_blank" rel="noreferrer" style="color:var(--accent)">原文</a>
          <button class="btn btn-ghost" id="back-to-articles">返回列表</button>
        </div>
      </div>
      <div class="card">
        <div class="reader-meta">
          <span>${esc(detail.article.accountName ?? detail.account.name)}</span>
          <span>${fmtTime(detail.article.publishedAt)}</span>
        </div>
        <div class="reader-body">${detail.article.html || `<p>${esc(detail.article.summary ?? '')}</p>`}</div>
      </div>
    `;
    view.querySelector('#back-to-articles').addEventListener('click', () => {
      detail.article = null;
      render();
    });
    return;
  }
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">${esc(detail.account.name)}</h1>
      <div class="page-sub">
        <span>${detail.account.articleCount ?? 0} 篇</span>
        <button class="btn btn-ghost" id="back-to-accounts">返回公众号</button>
      </div>
    </div>
    <div class="card" style="padding:0">
      ${listControls('articles', cursor, cursor.total, { placeholder: '搜索标题/摘要' })}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>标题</th><th>发布时间</th><th class="num">字数</th></tr></thead>
          <tbody>
            ${
              cursor.loading
                ? loadingRow(3)
                : cursor.items.length === 0
                  ? loadingRow(3, '没有匹配的文章')
                  : cursor.items
                      .map(
                        (article) => `<tr class="row-link" data-article="${esc(article.key)}">
                          <td class="strong">${esc(article.title)}</td>
                          <td>${fmtTime(article.publishedAt)}</td>
                          <td class="num">${article.wordCount ?? 0}</td>
                        </tr>`,
                      )
                      .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
  view.querySelector('#back-to-accounts').addEventListener('click', () => {
    state.accounts.detail = null;
    render();
  });
  bindListControls(view, 'articles', cursor, loadArticles);
  view.querySelectorAll('[data-article]').forEach((row) => {
    row.addEventListener('click', () => openArticle(cursor.accountId, row.dataset.article));
  });
}

async function openArticle(accountId, key) {
  try {
    const data = await api(`/article/${encodeURIComponent(accountId)}/${encodeURIComponent(key)}`);
    state.accounts.detail = { ...state.accounts.detail, article: data.article };
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* --------------------------------------------------------- AI 热点追踪 */

/** 正文里的 [n] 变成链到原文的角标;解析不出来的编号只留文字,不当链接。 */
function hotspotTagHtml(tags = []) {
  const list = (Array.isArray(tags) ? tags : []).map((tag) => String(tag).trim()).filter(Boolean);
  if (list.length === 0) return '';
  return `<div class="row" style="gap:4px;margin-top:6px">${list
    .slice(0, 4)
    .map((tag) => `<span class="chip">${esc(tag)}</span>`)
    .join('')}</div>`;
}

/** 条目下的来源角标:编号就是素材编号,点开原文。 */
function hotspotSourcesHtml(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  if (list.length === 0) return '<span class="field-note">—</span>';
  return list
    .map((source) => {
      const tip = `${source.accountName ?? ''} · ${fmtDate(source.publishedAt)} · ${source.title ?? ''}`;
      return source.url
        ? `<a class="hot-cite" href="${esc(source.url)}" target="_blank" rel="noreferrer" title="${esc(tip)}">[${source.n}]</a>`
        : `<span class="hot-cite" title="${esc(tip)}">[${source.n}]</span>`;
    })
    .join(' ');
}

/** 当天的热点条目列表:每条 = 标题 + 要点 + 影响 + 来源。 */
function renderHotspotItems(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  if (items.length === 0) {
    return `<div class="card"><div class="empty">这天没有筛出热点</div></div>`;
  }
  return `
    <div class="card" style="padding:0">
      <div class="list-controls" style="padding:12px 12px 4px">
        <strong>${esc(report.title || '今日航运热点')}</strong>
        <span class="spacer"></span>
        <span class="field-note">${esc(report.date)} · ${items.length} 条 · 更新于 ${fmtTime(report.generatedAt)}</span>
      </div>
      <div class="table-scroll">
        <table class="table hot-table">
          <thead><tr><th class="num">#</th><th>热点</th><th>要点</th><th>影响</th><th>来源</th></tr></thead>
          <tbody>
            ${items
              .map(
                (item, index) => `<tr>
                  <td class="num">${index + 1}</td>
                  <td class="strong">${esc(item.title)}${hotspotTagHtml(item.tags)}</td>
                  <td>${esc(item.summary)}</td>
                  <td>${esc(item.impact)}</td>
                  <td class="hot-sources-cell">${hotspotSourcesHtml(item.sources)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function hotspotDateLabel(date, today) {
  if (!date) return '';
  return date === today ? '今天' : date.slice(5);
}

function renderHotspots(view) {
  const cursor = state.hotspots;
  const report = cursor.report;
  const dates = [
    ...new Set([cursor.today, ...(cursor.reports ?? []).map((item) => item.date), cursor.date].filter(Boolean)),
  ]
    .sort()
    .reverse();
  const counts = new Map((cursor.reports ?? []).map((item) => [item.date, item.itemCount ?? 0]));
  const canGenerate = cursor.ready !== false;
  const button = `<button class="btn ${report ? 'btn-ghost' : 'btn-primary'}" id="hot-generate" ${
    cursor.busy || !canGenerate ? 'disabled' : ''
  }>${cursor.busy ? '正在整理…' : report ? '重新生成' : '生成当天热点'}</button>`;

  let body;
  if (!cursor.loaded) {
    body = `<div class="card"><div class="empty">加载中…</div></div>`;
  } else if (cursor.busy && !report) {
    body = `<div class="card"><div class="empty">正在读 ${esc(cursor.date || cursor.today)} 的文章…</div></div>`;
  } else if (report) {
    body = renderHotspotItems(report);
  } else {
    body = `<div class="card"><div class="empty">${esc(
      cursor.reason || `${cursor.date || cursor.today} 还没有生成热点`,
    )}</div></div>`;
  }

  view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="tabs" id="hotspot-dates">
          ${dates
            .map(
              (date) =>
                `<button data-hot-date="${date}" aria-pressed="${date === (cursor.date || cursor.today)}">${hotspotDateLabel(
                  date,
                  cursor.today,
                )}${counts.has(date) ? ` · ${counts.get(date)}` : ''}</button>`,
            )
            .join('')}
        </div>
        <span class="spacer"></span>
        ${button}
      </div>
    </div>
    ${body}
  `;

  view.querySelector('#hotspot-dates')?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-hot-date]');
    if (!target || target.dataset.hotDate === (cursor.date || cursor.today)) return;
    cursor.date = target.dataset.hotDate;
    cursor.report = null;
    cursor.loaded = false;
    loadHotspots();
  });
  view.querySelector('#hot-generate')?.addEventListener('click', () => generateHotspot({ refresh: Boolean(report) }));
  if (!cursor.loaded && !cursor.loading) loadHotspots();
}

async function loadHotspots() {
  const cursor = state.hotspots;
  cursor.loading = true;
  render();
  try {
    const query = cursor.date ? `?date=${encodeURIComponent(cursor.date)}` : '';
    const data = await api(`/hotspots/report${query}`);
    cursor.date = data.date ?? cursor.date;
    cursor.today = data.today ?? cursor.today;
    cursor.report = data.report ?? null;
    cursor.reports = data.reports ?? [];
    cursor.articleCount = data.articleCount ?? 0;
    cursor.ready = data.ready !== false;
    cursor.reason = data.reason ?? '';
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
    cursor.loaded = true;
  } finally {
    cursor.loading = false;
    render();
  }
}

async function generateHotspot({ refresh = false } = {}) {
  const cursor = state.hotspots;
  if (cursor.busy) return;
  cursor.busy = true;
  render();
  try {
    const data = await api('/hotspots/report', {
      method: 'POST',
      body: JSON.stringify({ date: cursor.date, refresh }),
    });
    cursor.report = data.report ?? null;
    cursor.articleCount = data.articleCount ?? cursor.articleCount;
    cursor.loaded = true;
    const count = data.report?.items?.length ?? 0;
    toast(data.reused ? '素材没变,用的是已有热点' : `已整理 ${count} 条热点`, 'ok');
    await loadHotspots();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.busy = false;
    render();
  }
}

/* ------------------------------------------------------------------ track */

function progressText(progress) {
  if (!progress) return '检测中';
  if (progress.phase === 'parse') return '解析表格';
  if (progress.phase === 'rules') return '规则检查';
  if (progress.phase === 'model') return `Agent 判定 ${progress.done ?? 0}/${progress.total ?? 0}`;
  if (progress.phase === 'report') return '生成报告';
  if (progress.phase === 'failed') return `失败:${progress.error}`;
  return '检测中';
}

const FINDING_KIND = { rule: '规则', congestion: '塞港', agent: 'Agent' };

/** 需要人工处理的不合理点:规则硬错 + 塞港/Agent 可疑(≤1 天已被后端抑制)。 */
function findingsHtml(report) {
  const findings = Array.isArray(report.findings) ? report.findings : null;
  const stats = report.stats ?? {};
  const model = stats.model ?? {};
  const suppressed = stats.suppressed ?? 0;
  const chips = `
      <span class="chip ${(findings?.length ?? 0) > 0 ? 'chip-danger' : 'chip-ok'}">${
        findings ? `${findings.length} 处不合理` : '结论未生成'
      }</span>
      <span class="chip ${model.checked ? 'chip-new' : 'chip-warn'}">Agent 判定 ${
        model.checked ?? 0
      }/${model.total ?? 0}</span>
      ${
        model.calls
          ? `<span class="chip">${model.candidates ?? 0} 个候选 · ${model.calls} 次请求${
              model.truncated ? ` · 截断 ${model.truncated}` : ''
            }</span>`
          : ''
      }
      ${
        model.rowsScanned
          ? `<span class="chip" title="送模型的航段行 / 全部有效行">覆盖 ${model.rowsSent ?? 0}/${
              model.rowsScanned
            } 行${model.scope === 'all' ? '(全量)' : ''}</span>`
          : ''
      }
      ${suppressed ? `<span class="chip">${suppressed} 处 ≤1 天不提醒</span>` : ''}
      <span class="chip">塞港命中 ${stats.congestionHits ?? 0}</span>
  `;
  if (!findings) {
    return `<div class="card"><div class="row">${chips}</div></div>`;
  }
  return `
    <div class="card" style="padding:0">
      <div class="row" style="padding:12px 12px 0">${chips}</div>
      <div class="table-scroll" style="max-height:320px">
        <table class="table" style="margin-top:8px">
          <thead><tr><th>Rotation</th><th>版本</th><th>航段</th><th class="num">天数</th><th>依据</th><th>说明</th></tr></thead>
          <tbody>
            ${
              findings.length === 0
                ? `<tr><td colspan="6"><div class="empty">没有需要提醒的不合理点</div></td></tr>`
                : findings
                    .map(
                      (item) => `<tr>
                        <td class="strong">${esc(item.rotationId)}${item.rotationName ? ` · ${esc(item.rotationName)}` : ''}</td>
                        <td>${esc(item.version)}</td>
                        <td>${esc(item.fromPort)} → ${esc(item.toPort)}<div class="field-note">排序 ${item.fromOrder} → ${item.toOrder}</div></td>
                        <td class="num">${item.days}</td>
                        <td>${statusChipFinding(item.kind)}</td>
                        <td>${esc(item.reason ?? '')}${
                          item.confidence ? `<span class="field-note">置信度 ${Number(item.confidence).toFixed(2)}</span>` : ''
                        }</td>
                      </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function statusChipFinding(kind) {
  const label = FINDING_KIND[kind] ?? kind ?? '—';
  return `<span class="chip ${kind === 'rule' ? 'chip-danger' : kind === 'congestion' ? 'chip-warn' : 'chip-new'}">${esc(label)}</span>`;
}


function renderTrack(view) {
  if (state.track.report) {
    view.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">轨迹检测</h1>
        <div class="page-sub">
          <span>${esc(state.track.report.filename ?? '')}</span>
          <button class="btn btn-ghost" id="track-back">返回任务列表</button>
        </div>
      </div>
      ${reportHtml(state.track.report)}
    `;
    view.querySelector('#track-back').addEventListener('click', () => {
      state.track.report = null;
      render();
    });
    bindReport(view);
    return;
  }

  const runs = state.track.runs;
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">轨迹检测</h1>
      <div class="page-sub">
        <span>${
          state.boot?.congestion?.updatedAt ? `塞港数据 ${relative(new Date(state.boot.congestion.updatedAt).getTime())}` : '塞港数据未就绪'
        }</span>
        <span>${esc(state.boot?.model?.available ? `Agent:${state.boot.model.model}` : 'Agent 不可用')}</span>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <label class="file-drop" style="flex:1" id="track-drop">
          <input type="file" id="track-file" accept=".xls,.xlsx" hidden />
          <div><strong>选择轨迹文件</strong> 或拖进来</div>
          <div class="field-note" id="track-file-name">${esc(state.track.file?.name ?? '.xls / .xlsx')}</div>
        </label>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:190px">
          <label class="switch" title="${esc(state.boot?.model?.reason ?? '')}">
            <input type="checkbox" id="track-llm"
              ${(state.track.useLlm ?? state.boot?.model?.available) ? 'checked' : ''}
              ${state.boot?.model?.available === false ? 'disabled' : ''} />
            用 DSH Agent 判定
          </label>
          <span class="field-note">${esc(state.boot?.model?.available === false ? state.boot.model.reason : state.boot?.model?.model ?? '')}</span>
          <button class="btn btn-primary" id="track-run" ${state.track.busy ? 'disabled' : ''}>${
            state.track.busy ? `<span class="spinner"></span> ${esc(progressText(state.track.progress))}` : '开始检测'
          }</button>
        </div>
      </div>
    </div>
    <div class="card" style="padding:0">
      <div class="card-title" style="padding:12px 12px 0"><strong>最近任务</strong></div>
      ${listControls('track-runs', runs, runs.total, { placeholder: '搜索文件名' })}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>时间</th><th>文件</th><th class="num">异常</th><th class="num">模型</th><th></th></tr></thead>
          <tbody>
            ${
              runs.loading
                ? loadingRow(5)
                : runs.items.length === 0
                  ? loadingRow(5, '还没有检测记录')
                  : runs.items
                      .map(
                        (run) => `<tr>
                          <td>${fmtTime(run.createdAt)}</td>
                          <td class="strong">${esc(run.title)}
                            ${
                              run.inputs?.oldRef?.date || run.inputs?.newRef?.date
                                ? `<div class="field-note">${fmtDate(run.inputs.oldRef?.date)} → ${fmtDate(
                                    run.inputs.newRef?.date,
                                  )}</div>`
                                : ''
                            }
                          </td>
                          <td class="num">${run.stats?.flagged ?? 0}/${run.stats?.checked ?? 0}</td>
                          <td class="num">${run.stats?.model?.checked ?? 0}</td>
                          <td style="text-align:right"><button class="btn btn-ghost" data-open-track="${run.id}">打开</button></td>
                        </tr>`,
                      )
                      .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  const fileInput = view.querySelector('#track-file');
  view.querySelector('#track-drop').addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer.files[0]) {
      state.track.file = event.dataTransfer.files[0];
      render();
    }
  });
  view.querySelector('#track-drop').addEventListener('dragover', (event) => event.preventDefault());
  fileInput.addEventListener('change', () => {
    state.track.file = fileInput.files[0];
    render();
  });
  view.querySelector('#track-llm').addEventListener('change', (event) => {
    state.track.useLlm = event.target.checked;
  });
  view.querySelector('#track-run').addEventListener('click', runTrack);
  bindListControls(view, 'track-runs', runs, loadTrackRuns);
  view.querySelectorAll('[data-open-track]').forEach((button) => {
    button.addEventListener('click', () => openTrackRun(button.dataset.openTrack));
  });
  if (!runs.loaded && !runs.loading) loadTrackRuns();
}

async function loadTrackRuns() {
  const cursor = state.track.runs;
  cursor.loading = true;
  render();
  try {
    const params = new URLSearchParams({ q: cursor.q, limit: String(cursor.limit), offset: String(cursor.offset) });
    const data = await api(`/track/runs?${params}`);
    cursor.items = data.items ?? [];
    cursor.total = data.total ?? 0;
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

async function openTrackRun(id) {
  try {
    const data = await api(`/track/runs/${id}`);
    state.track.report = data.report;
    state.track.sheet = data.report.sheets?.[0]?.name;
    state.track.filter = 'flagged';
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runTrack() {
  if (!state.track.file) return toast('先选择轨迹文件', 'error');
  state.track.busy = true;
  state.track.progress = null;
  render();
  try {
    const form = new FormData();
    form.append('file', state.track.file);
    form.append('useLlm', (state.track.useLlm ?? state.boot?.model?.available) ? '1' : '0');
    const start = await api('/track/start', { method: 'POST', body: form });
    const id = start.status.id;
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const data = await api(`/track/runs/${id}/progress`);
          state.track.progress = data.status;
          render();
          if (data.status.phase === 'done') {
            clearInterval(timer);
            resolve();
          } else if (data.status.phase === 'failed') {
            clearInterval(timer);
            reject(new Error(data.status.error ?? '检测失败'));
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, 2000);
    });
    const report = await api(`/track/runs/${id}`);
    state.track.report = report.report;
    state.track.sheet = report.report.sheets?.[0]?.name;
    state.track.filter = 'flagged';
    state.track.runs.loaded = false;
    const model = report.report.stats?.model;
    if (model?.checked) toast(`Agent 判定 ${model.checked}/${model.total} 条,可疑 ${model.suspicious} 段`, 'ok');
    await refreshBoot();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.track.busy = false;
    state.track.progress = null;
    render();
  }
}

function reportHtml(report) {
  const stats = report.stats;
  const sheetName = state.track.sheet ?? report.sheets[0]?.name;
  const sheet = report.sheets.find((item) => item.name === sheetName) ?? report.sheets[0];
  if (!sheet) return '';
  const abnormalOnly = state.track.filter === 'flagged';
  const visible = abnormalOnly ? sheet.rows.filter((row) => row.red.length > 0 || row.comment) : sheet.rows;
  const rows = visible.slice(0, 2000);
  return `
    <div class="card">
      <div class="row">
        <span class="chip">${stats.rows} 行</span>
        <span class="chip">${stats.groups} 条轨迹</span>
        <span class="chip ${stats.flagged ? 'chip-danger' : 'chip-ok'}">${stats.flagged} 条异常</span>
        <span class="chip ${stats.model?.checked ? 'chip-new' : 'chip-warn'}">${
          stats.model?.checked
            ? `Agent ${stats.model.checked}/${stats.model.total}${
                stats.model.calls ? ` · ${stats.model.calls} 次请求` : ''
              }`
            : '未跑 Agent'
        }</span>
        <span class="chip">${stats.comments} 条备注</span>
        <span class="spacer"></span>
        <div class="tabs">
          <button data-filter="flagged" aria-pressed="${abnormalOnly}">仅异常 (${
            sheet.rows.filter((row) => row.red.length > 0 || row.comment).length
          })</button>
          <button data-filter="all" aria-pressed="${!abnormalOnly}">整张表 (${sheet.rows.length})</button>
        </div>
        <button class="btn" data-export-track>导出 xlsx</button>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="tabs">
          ${report.sheets
            .map(
              (item) =>
                `<button data-sheet="${esc(item.name)}" aria-pressed="${item.name === sheetName}">${esc(item.name)}</button>`,
            )
            .join('')}
        </div>
        ${visible.length > 2000 ? '<span class="field-note">只显示前 2000 行,完整内容看导出</span>' : ''}
      </div>
    </div>
    ${findingsHtml(report)}
    <div class="card" style="padding:0">
      <div class="table-scroll" style="max-height:620px">
        <table class="table sheet-table">
          <thead><tr>${sheet.header.map((header) => `<th>${esc(header)}</th>`).join('')}<th class="comment-cell">检测备注</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (row) => `<tr>
                  ${row.cells
                    .map(
                      (cell, index) =>
                        `<td class="${row.red.includes(index) ? 'strong' : ''}" style="${
                          row.red.includes(index) ? 'color:var(--danger)' : ''
                        }">${esc(cell)}</td>`,
                    )
                    .join('')}
                  <td class="comment-cell" style="${row.comment ? 'color:var(--text)' : 'color:var(--text-3)'}">${esc(
                    row.comment,
                  )}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindReport(view) {
  view.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.track.filter = button.dataset.filter;
      render();
    });
  });
  view.querySelectorAll('[data-sheet]').forEach((button) => {
    button.addEventListener('click', () => {
      state.track.sheet = button.dataset.sheet;
      render();
    });
  });
  view.querySelector('[data-export-track]')?.addEventListener('click', () => {
    if (state.track.report) download(`/track/runs/${state.track.report.id}/export`);
  });
}

/* --------------------------------------------------------------- schedule */

/* --------------------------------------------------------------- schedule */

function pairResultHtml(row) {
  if (row.status === 'done') {
    const stats = row.stats ?? {};
    return `<div class="row" style="gap:6px">
        <span class="chip chip-ok">新增 ${stats.added ?? 0}</span>
        <span class="chip chip-danger">删除 ${stats.removed ?? 0}</span>
        <span class="chip chip-warn">变更 ${stats.changed ?? 0}</span>
      </div>
      <div class="field-note">${fmtTime(row.comparedAt)}</div>`;
  }
  if (row.status === 'ready') return '<span class="chip">未对比</span>';
  return `<span class="chip chip-warn" title="${esc(row.reason ?? '')}">${esc(row.reason || '不支持')}</span>`;
}

/** 一行 = 邮件 + 旧附件 + 新附件 + 已有对比结果。 */
function schedulePairRow(row) {
  const action =
    row.status === 'done'
      ? `<div class="row" style="justify-content:flex-end;gap:6px">
           <button class="btn btn-ghost" data-open-schedule="${esc(row.runId)}">打开</button>
           <button class="btn btn-ghost" data-compare-pair="${esc(row.key)}" ${
             state.schedule.busyKey === row.key ? 'disabled' : ''
           }>${state.schedule.busyKey === row.key ? '<span class="spinner"></span>' : '重新对比'}</button>
         </div>`
      : row.status === 'ready'
        ? `<button class="btn" data-compare-pair="${esc(row.key)}" ${
            state.schedule.busyKey === row.key ? 'disabled' : ''
          }>${state.schedule.busyKey === row.key ? '<span class="spinner"></span> 对比中' : '对比'}</button>`
        : '<span class="field-note">—</span>';
  return `<tr>
    <td class="strong">${esc(row.subject)}${
      row.kind && row.kind !== 'excel' ? ` <span class="chip">${esc(String(row.kind).toUpperCase())}</span>` : ''
    }
      <div class="field-note">${esc(row.from ?? '')} · ${fmtTime(row.emailDate)}</div>
    </td>
    <td><span class="mono">${esc(row.old?.name ?? '')}</span>
      <div class="field-note">${row.old?.date ? fmtDate(row.old.date) : ''}</div>
    </td>
    <td><span class="mono">${esc(row.new?.name ?? '')}</span>
      <div class="field-note">${row.new?.date ? fmtDate(row.new.date) : ''}</div>
    </td>
    <td>${pairResultHtml(row)}</td>
    <td style="text-align:right">${action}</td>
  </tr>`;
}

function renderSchedule(view) {
  if (state.schedule.result) {
    const result = state.schedule.result;
    view.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">船期对比</h1>
        <div class="page-sub">
          <span class="mono">${esc(result.oldName)}</span> → <span class="mono">${esc(result.newName)}</span>
          ${
            result.oldRef?.date || result.newRef?.date
              ? `<span class="chip">${fmtDate(result.oldRef?.date)} → ${fmtDate(result.newRef?.date)}</span>`
              : ''
          }
          ${result.carrierName ? `<span class="chip chip-new">${esc(result.carrierName)}</span>` : ''}
          <button class="btn btn-ghost" id="schedule-recompare" ${
            state.schedule.recomparing ? 'disabled' : ''
          }>${state.schedule.recomparing ? '<span class="spinner"></span> 重新对比中' : '重新对比'}</button>
          <button class="btn btn-ghost" id="schedule-back">返回对比任务</button>
        </div>
      </div>
      ${result.digest ? `<div class="card schedule-digest">${esc(result.digest)}</div>` : ''}
      ${mappingHtml(result)}
      ${agentReviewHtml(result)}
      ${scheduleResultHtml(result)}
    `;
    view.querySelector('#schedule-back').addEventListener('click', () => {
      state.schedule.result = null;
      state.schedule.pairs.loaded = false;
      render();
    });
    view.querySelector('#schedule-recompare')?.addEventListener('click', recompareRun);
    bindScheduleResult(view);
    return;
  }

  const cursor = state.schedule;
  const pairs = cursor.pairs;
  const runs = cursor.runs;
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">船期对比</h1>
      <div class="page-sub">${esc(state.boot?.settings?.mail?.user || '邮件未配置')}</div>
    </div>
    <div class="card" style="padding:0">
      <div class="list-controls" style="padding:12px 12px 4px">
        <strong>新旧对比</strong>
        <span class="spacer"></span>
        <button class="btn btn-ghost" id="pairs-refresh" ${pairs.loading ? 'disabled' : ''}>刷新</button>
        <button class="btn btn-primary" id="mail-fetch" ${cursor.fetchingMail ? 'disabled' : ''}>${
          cursor.fetchingMail ? '<span class="spinner"></span> 拉取中' : '拉取邮件'
        }</button>
        ${
          cursor.fetchProgress
            ? `<span class="field-note">扫描 ${cursor.fetchProgress.scanned} · 新增 ${cursor.fetchProgress.fetched} · 识别 ${cursor.fetchProgress.ingested}</span>`
            : ''
        }
      </div>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>邮件</th><th>旧附件</th><th>新附件</th><th>对比结果</th><th></th></tr></thead>
          <tbody>
            ${
              pairs.loading
                ? loadingRow(5)
                : pairs.items.length === 0
                  ? loadingRow(5, '还没有可对比的邮件附件')
                  : pairs.items.map((row) => schedulePairRow(row)).join('')
            }
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="row"><strong>手工对比</strong><span class="spacer"></span></div>
      <div class="grid-2" style="margin-top:12px">
        <label class="file-drop" id="schedule-old-drop">
          <input type="file" id="schedule-old" accept=".xls,.xlsx,.pdf" hidden />
          <div><strong>旧版</strong></div>
          <div class="field-note">${esc(cursor.oldFile?.name ?? '选择文件')}</div>
        </label>
        <label class="file-drop" id="schedule-new-drop">
          <input type="file" id="schedule-new" accept=".xls,.xlsx,.pdf" hidden />
          <div><strong>新版</strong></div>
          <div class="field-note">${esc(cursor.newFile?.name ?? '选择文件')}</div>
        </label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="file-drop" id="schedule-skill-drop" style="flex:1">
          <input type="file" id="schedule-skill" accept=".zip,.md,.markdown,.txt" hidden />
          <div><strong>对比 Skill</strong>${cursor.skillFile ? ' · 已导入' : ''}</div>
          <div class="field-note">${esc(cursor.skillFile?.name ?? '导入 Skill 包 .zip 或 .md(可选)')}</div>
        </label>
        <button class="btn btn-primary" id="schedule-upload" ${
          !cursor.oldFile || !cursor.newFile || cursor.busy ? 'disabled' : ''
        }>${
          cursor.busy
            ? '<span class="spinner"></span> 对比中'
            : cursor.skillFile
              ? '用 Agent 按 Skill 对比'
              : '对比这两份'
        }</button>
        ${cursor.skillFile ? '<button class="btn btn-ghost" id="schedule-skill-clear">移除 Skill</button>' : ''}
      </div>
      ${
        cursor.skillFile
          ? `<label class="switch" style="margin-top:10px">
              <input type="checkbox" id="schedule-exec" ${cursor.executeScripts ? 'checked' : ''} />
              执行技能包脚本(有 scripts/ 时强烈建议开启,产物格式由脚本决定)
            </label>`
          : ''
      }
    </div>
    <div class="card" style="padding:0">
      <div class="list-controls" style="padding:12px 12px 4px"><strong>最近对比</strong></div>
      ${listControls('schedule-runs', runs, runs.total, { placeholder: '搜索文件/船东' })}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>时间</th><th>任务</th><th class="num">新增</th><th class="num">删除</th><th class="num">变更</th><th></th></tr></thead>
          <tbody>
            ${
              runs.loading
                ? loadingRow(6)
                : runs.items.length === 0
                  ? loadingRow(6, '还没有对比记录')
                  : runs.items
                      .map(
                        (run) => `<tr>
                          <td>${fmtTime(run.createdAt)}</td>
                          <td class="strong">${esc(run.title)}</td>
                          <td class="num">${run.stats?.added ?? 0}</td>
                          <td class="num">${run.stats?.removed ?? 0}</td>
                          <td class="num">${run.stats?.changed ?? 0}</td>
                          <td style="text-align:right"><button class="btn btn-ghost" data-open-schedule="${run.id}">打开</button></td>
                        </tr>`,
                      )
                      .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  view.querySelector('#schedule-old').addEventListener('change', (event) => {
    state.schedule.oldFile = event.target.files[0] ?? null;
    render();
  });
  view.querySelector('#schedule-new').addEventListener('change', (event) => {
    state.schedule.newFile = event.target.files[0] ?? null;
    render();
  });
  view.querySelector('#schedule-skill').addEventListener('change', (event) => {
    const file = event.target.files[0] ?? null;
    state.schedule.skillFile = file;
    // 技能包(zip)通常自带脚本,默认执行;单个 .md 没有脚本可执行。
    state.schedule.executeScripts = Boolean(file && /\.zip$/i.test(file.name));
    render();
  });
  view.querySelector('#schedule-skill-clear')?.addEventListener('click', () => {
    state.schedule.skillFile = null;
    state.schedule.executeScripts = false;
    render();
  });
  view.querySelector('#schedule-exec')?.addEventListener('change', (event) => {
    state.schedule.executeScripts = event.target.checked;
  });
  view.querySelector('#schedule-upload').addEventListener('click', () =>
    state.schedule.skillFile ? runSkillCompare() : runUploadCompare(),
  );
  view.querySelector('#pairs-refresh').addEventListener('click', () => loadPairs());
  view.querySelector('#mail-fetch').addEventListener('click', fetchMailForPairs);
  view.querySelectorAll('[data-compare-pair]').forEach((button) => {
    button.addEventListener('click', () => comparePair(button.dataset.comparePair));
  });
  view.querySelectorAll('[data-open-schedule]').forEach((button) => {
    button.addEventListener('click', () => openScheduleRun(button.dataset.openSchedule));
  });
  bindListControls(view, 'schedule-runs', runs, loadScheduleRuns);
  if (!runs.loaded && !runs.loading) loadScheduleRuns();
  if (!pairs.loaded && !pairs.loading) loadPairs();
}

async function loadPairs() {
  const cursor = state.schedule.pairs;
  cursor.loading = true;
  render();
  try {
    const data = await api('/schedule/pairs');
    cursor.items = data.rows ?? [];
    cursor.total = cursor.items.length;
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

/** 对某一条邮件配对跑对比;已有结果的行点「打开」直接看,不重跑。 */
async function comparePair(key) {
  if (!key || state.schedule.busyKey) return;
  state.schedule.busyKey = key;
  render();
  try {
    const data = await api('/schedule/pairs/compare', { method: 'POST', body: JSON.stringify({ key }) });
    state.schedule.result = data.result;
    state.schedule.sheet = data.result.sheets?.[0]?.name;
    state.schedule.side = 'old';
    state.schedule.summaryView = false;
    if (data.pairs?.rows) {
      state.schedule.pairs.items = data.pairs.rows;
      state.schedule.pairs.total = data.pairs.rows.length;
    }
    state.schedule.runs.loaded = false;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.schedule.busyKey = '';
    render();
  }
}

/** 结果页「重新对比」:拿这条记录留存的源文件重跑(映射/复核/摘要都会重算)。 */
async function recompareRun() {
  const result = state.schedule.result;
  if (!result?.id || state.schedule.recomparing) return;
  state.schedule.recomparing = true;
  render();
  try {
    const data = await api(`/schedule/runs/${encodeURIComponent(result.id)}/recompare`, {
      method: 'POST',
      body: '{}',
    });
    state.schedule.result = data.result;
    state.schedule.sheet = data.result.sheets?.[0]?.name;
    state.schedule.side = 'old';
    state.schedule.summaryView = false;
    state.schedule.runs.loaded = false;
    state.schedule.pairs.loaded = false;
    toast('已重新对比', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.schedule.recomparing = false;
    render();
  }
}

async function fetchMailForPairs() {
  const cursor = state.schedule;
  if (cursor.fetchingMail) return;
  cursor.fetchingMail = true;
  cursor.fetchProgress = { scanned: 0, fetched: 0, ingested: 0 };
  render();
  let failure = '';
  try {
    await apiStream('/mail/fetch/stream', { limit: 40 }, (event) => {
      if (event.type === 'result') cursor.fetchProgress.scanned = event.scanned ?? 0;
      if (event.type === 'message') cursor.fetchProgress.fetched += 1;
      if (event.type === 'ingested') cursor.fetchProgress.ingested += 1;
      if (event.type === 'error') failure = event.error || '拉取失败';
      renderSoon();
    });
  } catch (error) {
    failure = error.message;
  }
  const progress = cursor.fetchProgress;
  cursor.fetchingMail = false;
  cursor.fetchProgress = null;
  cursor.pairs.loaded = false;
  cursor.runs.loaded = false;
  render();
  if (failure) toast(failure, 'error');
  else toast(`新增 ${progress?.fetched ?? 0} 封 · 识别 ${progress?.ingested ?? 0} 个附件`, 'ok');
  await refreshBoot();
  render();
}

/** 带 Skill 的对比:交给模型按 Skill 规则比,结果是一份结构化差异清单。 */
async function runSkillCompare() {
  const cursor = state.schedule;
  if (!cursor.oldFile || !cursor.newFile) return toast('旧版与新版都要有', 'error');
  if (!cursor.skillFile) return toast('先导入 Skill 文件', 'error');
  cursor.busy = true;
  render();
  try {
    const form = new FormData();
    form.append('oldFile', cursor.oldFile);
    form.append('newFile', cursor.newFile);
    form.append('skillFile', cursor.skillFile);
    if (cursor.carrierId) form.append('carrierId', cursor.carrierId);
    form.append('executeScripts', cursor.executeScripts ? '1' : '0');
    const data = await api('/schedule/skill', { method: 'POST', body: form });
    cursor.result = data.result;
    cursor.sheet = '';
    cursor.side = 'old';
    cursor.summaryView = false;
    cursor.runs.loaded = false;
    cursor.pairs.loaded = false;
    toast(`Skill 对比完成:${data.result.stats.added} 新增 / ${data.result.stats.removed} 删除 / ${data.result.stats.changed} 变更`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.busy = false;
    render();
  }
}

async function runUploadCompare() {
  const cursor = state.schedule;
  if (!cursor.oldFile || !cursor.newFile) return toast('旧版与新版都要有', 'error');
  cursor.busy = true;
  render();
  try {
    const form = new FormData();
    form.append('oldFile', cursor.oldFile);
    form.append('newFile', cursor.newFile);
    const data = await api('/schedule/run', { method: 'POST', body: form });
    cursor.result = data.result;
    cursor.sheet = data.result.sheets?.[0]?.name;
    cursor.side = 'old';
    cursor.summaryView = false;
    cursor.oldFile = null;
    cursor.newFile = null;
    cursor.runs.loaded = false;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.busy = false;
    render();
  }
}

async function loadScheduleRuns() {
  const cursor = state.schedule.runs;
  cursor.loading = true;
  render();
  try {
    const params = new URLSearchParams({ q: cursor.q, limit: String(cursor.limit), offset: String(cursor.offset) });
    const data = await api(`/schedule/runs?${params}`);
    cursor.items = data.items ?? [];
    cursor.total = data.total ?? 0;
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

async function openScheduleRun(id) {
  try {
    const data = await api(`/schedule/runs/${id}`);
    state.schedule.result = data.result;
    state.schedule.sheet = data.result.sheets?.[0]?.name;
    state.schedule.side = 'old';
    state.schedule.summaryView = false;
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/** 自动表头映射:这次对比是不是靠模型认出的列跑的。 */
function mappingHtml(result) {
  const mappings = result.mappings ?? {};
  const sides = [
    ['旧版', mappings.old],
    ['新版', mappings.new],
  ].filter(([, mapping]) => mapping && Object.keys(mapping.columns ?? {}).length > 0);
  if (sides.length === 0) return '';
  return `<div class="card">
      <div class="row">
        <span class="chip chip-new">AI 识别表头</span>
        ${sides
          .map(([label, mapping]) => {
            const count = Object.keys(mapping.columns ?? {}).length;
            return `<span class="chip">${label} ${count} 列</span>`;
          })
          .join('')}
      </div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:6px">
        ${sides
          .flatMap(([label, mapping]) =>
            Object.entries(mapping.columns ?? {}).map(
              ([field, column]) =>
                `<span class="chip" title="${esc(mapping.note ?? '')}">${label} · ${esc(field)} ← ${esc(column)}</span>`,
            ),
          )
          .join('')}
      </div>
    </div>`;
}

/** Agent 复核:把变更分成真实变更 / 解析噪声。 */
function agentReviewHtml(result) {
  const review = result.agentReview;
  if (!review) return '';
  const items = Array.isArray(review.items) ? review.items : [];
  const verdicts = new Map((review.reviews ?? []).map((item) => [item.i, item]));
  return `<div class="card" style="padding:0">
      <div class="row" style="padding:12px 12px 4px">
        <span class="chip chip-new">Agent 复核</span>
        <span class="chip chip-danger">真实 ${review.real ?? 0}</span>
        <span class="chip">噪声 ${review.noise ?? 0}</span>
        <span class="spacer"></span>
        <span class="field-note">${esc(review.model?.model ?? '')}</span>
      </div>
      <div class="table-scroll" style="max-height:300px">
        <table class="table">
          <thead><tr><th class="num">#</th><th>sheet</th><th>类型</th><th>对比键</th><th>字段</th><th>旧 → 新</th><th>结论</th></tr></thead>
          <tbody>
            ${items
              .map((item, index) => {
                const verdict = verdicts.get(index + 1);
                const noise = verdict?.verdict === 'noise';
                return `<tr style="${noise ? 'opacity:.65' : ''}">
                  <td class="num">${index + 1}</td>
                  <td>${esc(item.sheet ?? '')}</td>
                  <td>${statusChip(item.status)}</td>
                  <td class="mono">${esc(item.key ?? '')}</td>
                  <td>${esc(item.field ?? '')}</td>
                  <td>${esc(item.from ?? '')} → ${esc(item.to ?? '')}</td>
                  <td>${
                    noise
                      ? `<span class="chip">噪声</span><span class="field-note">${esc(verdict.reason ?? '')}</span>`
                      : `<span class="chip chip-warn">真实变更</span>`
                  }</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function scheduleResultHtml(result) {
  if (result.mode === 'skill') return skillResultHtml(result);
  return result.mode === 'profile' ? profileResultHtml(result) : genericResultHtml(result);
}

/** Skill 对比结果:摘要 + 统计 + 用到的规则 + 逐条差异。 */
function skillResultHtml(result) {
  const items = result.items ?? [];
  const skill = result.skill ?? {};
  return `
    <div class="card">
      <div class="row">
        <span class="chip chip-new">Skill · ${esc(skill.name ?? '')}</span>
        ${
          (skill.files ?? []).length
            ? `<span class="chip">${skill.files.length} 个文件${
                (skill.scripts ?? []).length ? ` · ${skill.scripts.length} 个脚本(未执行)` : ''
              }</span>`
            : ''
        }
        <span class="chip">${result.stats.added} 新增</span>
        <span class="chip">${result.stats.removed} 删除</span>
        <span class="chip ${result.stats.changed ? 'chip-warn' : ''}">${result.stats.changed} 变更</span>
        ${result.truncated ? '<span class="chip chip-warn">表格有截断</span>' : ''}
        <span class="spacer"></span>
        <button class="btn" data-export-schedule>导出 xlsx</button>
      </div>
      ${
        result.analysisSkipped
          ? `<div class="banner banner-warn" style="margin-top:12px">
              脚本产物已生成,但 AI 总结没有出来:${esc(result.analysisSkipped)}
            </div>`
          : ''
      }
      ${
        result.execution?.skipped
          ? `<div class="banner banner-warn" style="margin-top:12px">
              技能包里检测到脚本 <span class="mono">${esc(result.execution.script ?? '')}</span>,但本次没有执行——
              结果是模型按文档推断的,可能和 Skill 要求的产物不一致。重新对比时勾选「执行技能包脚本」。
            </div>`
          : ''
      }
      ${
        result.execution && !result.execution.skipped
          ? `<div class="banner ${result.execution.code === 0 ? 'banner-ok' : 'banner-warn'}" style="margin-top:12px">
              <div class="row">
                <span class="chip ${result.execution.code === 0 ? 'chip-ok' : 'chip-danger'}">脚本退出码 ${result.execution.code}</span>
                <span class="mono">${esc(result.execution.script ?? '')}</span>
                <span class="field-note">${(result.execution.durationMs ?? 0) / 1000}s</span>
                <span class="spacer"></span>
                ${(result.outputFiles ?? [])
                  .map(
                    (file) =>
                      `<a class="btn" href="${API}/schedule/runs/${encodeURIComponent(result.id)}/outputs/${encodeURIComponent(
                        file.name,
                      )}" download="${esc(file.name)}">下载 ${esc(file.name)}</a>`,
                  )
                  .join(' ')}
              </div>
              ${
                result.execution.stdout || result.execution.stderr || result.execution.error
                  ? `<pre class="field-note" style="white-space:pre-wrap;margin:8px 0 0;max-height:180px;overflow:auto">${esc(
                      result.execution.error || result.execution.stdout || result.execution.stderr,
                    )}</pre>`
                  : ''
              }
            </div>`
          : ''
      }
      ${
        result.markdown
          ? `<div class="reader-body hot-body" style="margin-top:12px">${renderHotspotBody(result.markdown, [])}</div>`
          : ''
      }
      ${
        (result.rules ?? []).length
          ? `<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
              ${result.rules.map((rule) => `<span class="chip">${esc(rule)}</span>`).join('')}
            </div>`
          : ''
      }
    </div>
    <div class="card" style="padding:0">
      <div class="table-scroll" style="max-height:620px">
        <table class="table">
          <thead><tr><th>工作表</th><th>对比键</th><th>结果</th><th>字段</th><th>旧 → 新</th><th>说明</th></tr></thead>
          <tbody>
            ${
              items.length === 0
                ? `<tr><td colspan="6"><div class="empty">Skill 判定没有差异</div></td></tr>`
                : items
                    .map(
                      (item) => `<tr>
                        <td>${esc(item.sheet ?? '')}</td>
                        <td class="mono">${esc(item.key ?? '')}</td>
                        <td>${statusChip(item.status)}</td>
                        <td>${esc((item.changes ?? []).map((change) => change.field).filter(Boolean).join('、'))}</td>
                        <td>${(item.changes ?? [])
                          .map(
                            (change) =>
                              `<div>${esc(change.from ?? '')} → <span class="strong">${esc(change.to ?? '')}</span></div>`,
                          )
                          .join('')}</td>
                        <td>${esc(item.note ?? '')}</td>
                      </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function profileResultHtml(result) {
  const showSummary = state.schedule.summaryView && (result.summary ?? []).length > 0;
  const active = state.schedule.sheet ?? result.sheets[0]?.name;
  const sheet = result.sheets.find((item) => item.name === active) ?? result.sheets[0];
  const side = state.schedule.side ?? 'old';
  const rows = side === 'old' ? sheet.oldRows : sheet.newRows;
  return `
    <div class="card">
      <div class="row">
        ${result.carrierName ? `<span class="chip chip-new">${esc(result.carrierName)}</span>` : ''}
        <span class="chip">${result.stats.added} 新增</span>
        <span class="chip">${result.stats.removed} 删除</span>
        <span class="chip ${result.stats.changed ? 'chip-warn' : ''}">${result.stats.changed} 变更</span>
        <span class="chip">${result.stats.skipped} 过期跳过</span>
        <span class="spacer"></span>
        <div class="tabs">
          ${result.sheets
            .map(
              (item) =>
                `<button data-sheet="${esc(item.name)}" aria-pressed="${!showSummary && item.name === sheet.name}">${esc(
                  item.name,
                )}</button>`,
            )
            .join('')}
          ${
            (result.summary ?? []).length
              ? `<button data-summary="1" aria-pressed="${showSummary}">汇总 (${result.summary.length})</button>`
              : ''
          }
        </div>
        <button class="btn" data-export-schedule>导出 xlsx</button>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="field-note">对比键:${esc((sheet.keyColumns ?? []).join(' + '))}</span>
        ${
          showSummary
            ? ''
            : `<span class="spacer"></span>
               <div class="tabs">
                 <button data-side="old" aria-pressed="${side === 'old'}">旧版</button>
                 <button data-side="new" aria-pressed="${side === 'new'}">新版</button>
               </div>`
        }
      </div>
    </div>
    ${
      showSummary
        ? `<div class="card" style="padding:0"><div class="table-scroll" style="max-height:620px">
            <table class="table sheet-table">
              <thead><tr><th>sheet</th><th>对比结果</th><th>对比键</th><th>变化列</th></tr></thead>
              <tbody>${result.summary
                .map(
                  (item) => `<tr>
                    <td>${esc(item.sheet)}</td>
                    <td>${statusChip(item.status)}</td>
                    <td class="mono">${esc(String(item.key).replaceAll('\\u0001', ' / '))}</td>
                    <td>${esc((item.changes ?? []).join('、'))}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>
          </div></div>`
        : `<div class="card" style="padding:0"><div class="table-scroll" style="max-height:620px">
            <table class="table sheet-table">
              <thead><tr>${sheet.header.map((header) => `<th>${esc(header)}</th>`).join('')}<th>对比结果</th></tr></thead>
              <tbody>${rows
                .map(
                  (row) => `<tr>
                    ${sheet.header
                      .map((_, index) => {
                        const change = (row.changes ?? []).find((item) => item.index === index);
                        const red = row.red.includes(index);
                        if (change && side === 'old') {
                          return `<td class="strong" style="color:var(--danger)">${esc(change.from)} → <span style="color:var(--text)">${esc(
                            change.to,
                          )}</span></td>`;
                        }
                        if (change && side === 'new') {
                          return `<td class="strong" style="color:var(--text)">${esc(change.to)}</td>`;
                        }
                        return `<td style="${red ? 'color:var(--danger)' : ''}">${esc(row.cells[index] ?? '')}</td>`;
                      })
                      .join('')}
                    <td>${statusChip(row.status)}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>
          </div></div>`
    }
  `;
}

function genericResultHtml(result) {
  const active = state.schedule.sheet ?? result.sheets[0]?.name;
  const sheet = result.sheets.find((item) => item.name === active) ?? result.sheets[0];
  return `
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="stat-value">${result.stats.added}</div><div class="stat-label">新增</div></div>
        <div class="stat"><div class="stat-value">${result.stats.removed}</div><div class="stat-label">删除</div></div>
        <div class="stat"><div class="stat-value">${result.stats.changed}</div><div class="stat-label">变更</div></div>
        <div class="stat"><div class="stat-value">${result.stats.skipped}</div><div class="stat-label">已过期跳过</div></div>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="tabs">
          ${result.sheets
            .map(
              (item) => `<button data-sheet="${esc(item.name)}" aria-pressed="${item.name === active}">${esc(item.name)}</button>`,
            )
            .join('')}
        </div>
        <span class="spacer"></span>
        <button class="btn" data-export-schedule>导出 xlsx</button>
      </div>
    </div>
    <div class="card" style="padding:0">
      <div class="table-scroll" style="max-height:620px">
        <table class="table">
          <thead><tr>${sheet.columns.map((column) => `<th>${esc(column)}</th>`).join('')}<th>对比结果</th></tr></thead>
          <tbody>
            ${sheet.rows
              .map(
                (row) => `<tr>
                  ${sheet.columns
                    .map((column) => {
                      const change = (row.changes ?? []).find((item) => item.column === column);
                      if (change) {
                        return `<td class="strong" style="color:var(--danger)">${esc(change.from)} → <span style="color:var(--text)">${esc(
                          change.to,
                        )}</span></td>`;
                      }
                      return `<td style="${row.red && row.status !== '变更' ? 'color:var(--danger)' : ''}">${esc(
                        row.values[column] ?? '',
                      )}</td>`;
                    })
                    .join('')}
                  <td>${statusChip(row.status)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindScheduleResult(view) {
  view.querySelectorAll('[data-sheet]').forEach((button) => {
    button.addEventListener('click', () => {
      state.schedule.sheet = button.dataset.sheet;
      state.schedule.summaryView = false;
      render();
    });
  });
  view.querySelectorAll('[data-side]').forEach((button) => {
    button.addEventListener('click', () => {
      state.schedule.side = button.dataset.side;
      render();
    });
  });
  view.querySelector('[data-summary]')?.addEventListener('click', () => {
    state.schedule.summaryView = true;
    render();
  });
  view.querySelector('[data-export-schedule]')?.addEventListener('click', () => {
    if (state.schedule.result) download(`/schedule/runs/${state.schedule.result.id}/export`);
  });
}

/* ------------------------------------------------------------------- mail */

function renderMail(view) {
  const cursor = state.mail.list;
  const config = state.boot?.settings?.mail ?? {};
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">邮件</h1>
      <div class="page-sub">${esc(config.user || '未配置账号')} · ${esc(config.host || '')}</div>
    </div>
    <div class="card">
      <div class="row">
        <button class="btn" id="mail-test" ${state.mail.busy ? 'disabled' : ''}>测试连接</button>
        <button class="btn" id="mail-detect" ${state.mail.busy ? 'disabled' : ''}>自动探测</button>
        <button class="btn" id="mail-smtp" ${state.mail.busy ? 'disabled' : ''}>SMTP 检查</button>
        <button class="btn btn-primary" id="mail-fetch" ${state.mail.busy ? 'disabled' : ''}>${
          state.mail.busy ? '<span class="spinner"></span> 拉取中' : '拉取邮件'
        }</button>
        <span class="spacer"></span>
        <span class="field-note">${
          state.mail.progress
            ? `扫描 ${state.mail.progress.scanned} · 新增 ${state.mail.progress.fetched} · 已识别 ${
                state.mail.progress.ingested
              } · ${((Date.now() - state.mail.progress.startedAt) / 1000).toFixed(1)}s`
            : esc(config.folder || 'INBOX')
        }</span>
      </div>
      ${
        state.mail.smtp
          ? `<div class="banner ${state.mail.smtp.authenticated ? '' : 'banner-warn'}" style="margin-top:12px">
              <div style="margin-bottom:6px">${esc(state.mail.smtp.hint)}</div>
              ${(state.mail.smtp.results ?? [])
                .map(
                  (item) => `<div class="row" style="padding:4px 0">
                    <span class="mono ${item.ok ? 'strong' : ''}">${esc(item.host)}:${item.port}${item.secure ? ' TLS' : ''}</span>
                    <span class="chip ${item.ok ? 'chip-ok' : 'chip-danger'}">${item.ok ? '认证通过' : '认证失败'}</span>
                    <span class="field-note truncate" style="max-width:520px">${esc(item.ok ? item.banner : item.error)}</span>
                  </div>`,
                )
                .join('')}
            </div>`
          : ''
      }
      ${
        state.mail.detection
          ? `<div class="banner" style="margin-top:12px">
              ${(state.mail.detection.results ?? [])
                .map(
                  (item) => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)">
                    <span class="mono ${item.ok ? 'strong' : ''}">${esc(item.host)}:${item.port}</span>
                    <span class="chip ${item.ok ? 'chip-ok' : 'chip-danger'}">${item.ok ? '可用' : '不可用'}</span>
                    <span class="field-note truncate" style="max-width:520px">${esc(item.ok ? item.banner : item.error)}</span>
                    <span class="spacer"></span>
                    ${item.ok ? `<button class="btn btn-ghost" data-adopt-mail="${esc(item.host)}|${item.port}|${item.secure ? 1 : 0}">用这个</button>` : ''}
                  </div>`,
                )
                .join('')}
            </div>`
          : ''
      }
    </div>
    <div class="card" style="padding:0">
      ${listControls('mail', cursor, cursor.total, { placeholder: '搜索主题/发件人' })}
      <div class="table-scroll">
        <table class="table mail-table">
          <thead><tr><th>主题</th><th>发件人</th><th>时间</th><th class="num">附件</th></tr></thead>
          <tbody>
            ${
              cursor.loading
                ? loadingRow(4)
                : cursor.items.length === 0
                  ? loadingRow(4, '还没有邮件')
                  : cursor.items
                      .map(
                        (message) => `<tr data-mail="${message.uid}" class="mail-row" ${
                          state.mail.openUid === message.uid ? 'data-open="true"' : ''
                        }>
                          <td class="strong">${esc(message.subject)}</td>
                          <td class="truncate" style="max-width:260px">${esc(message.from)}</td>
                          <td>${fmtTime(message.date)}</td>
                          <td class="num">${message.attachments.length || ''}</td>
                        </tr>
                        ${
                          state.mail.openUid === message.uid
                            ? `<tr class="mail-detail"><td colspan="4">${mailDetailHtml(message)}</td></tr>`
                            : ''
                        }`,
                      )
                      .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  view.querySelectorAll('.mail-row').forEach((row) => {
    row.addEventListener('click', () => toggleMail(row.dataset.mail));
  });
  view.querySelector('#mail-test').addEventListener('click', () => mailAction('test', '/mail/test'));
  view.querySelector('#mail-smtp').addEventListener('click', () => mailAction('smtp', '/mail/smtp-check'));
  view.querySelector('#mail-detect').addEventListener('click', () => mailAction('detect', '/mail/detect'));
  view.querySelector('#mail-fetch').addEventListener('click', fetchMailStreaming);
  bindListControls(view, 'mail', cursor, loadMailList);
  if (!cursor.loaded && !cursor.loading) loadMailList();
}

/** 拉邮件:服务端逐封推送,界面收到一封就插一行。 */
async function fetchMailStreaming() {
  const cursor = state.mail;
  if (cursor.busy) return;
  cursor.busy = true;
  cursor.progress = { fetched: 0, scanned: 0, ingested: 0, startedAt: Date.now() };
  render();
  let failure = '';
  try {
    await apiStream('/mail/fetch/stream', { limit: 30 }, (event) => {
      if (event.type === 'message') {
        const message = event.message;
        cursor.progress.fetched += 1;
        cursor.list.items = [message, ...(cursor.list.items ?? []).filter((item) => String(item.uid) !== String(message.uid))];
        cursor.list.total = (cursor.list.total ?? 0) + 1;
        renderSoon();
      } else if (event.type === 'result') {
        cursor.progress.scanned = event.scanned ?? cursor.progress.scanned;
        renderSoon();
      } else if (event.type === 'ingested') {
        cursor.progress.ingested += 1;
        renderSoon();
      } else if (event.type === 'error') {
        failure = event.error || '拉取失败';
      }
    });
  } catch (error) {
    failure = error.message;
  }
  const progress = cursor.progress;
  cursor.progress = null;
  cursor.busy = false;
  cursor.list.loaded = false;
  state.schedule.runs.loaded = false;
  state.schedule.pairs.loaded = false;
  render();
  if (failure) toast(failure, 'error');
  else
    toast(
      `新增 ${progress?.fetched ?? 0} 封 · 识别 ${progress?.ingested ?? 0} 个附件 · ${(
        (Date.now() - (progress?.startedAt ?? Date.now())) /
        1000
      ).toFixed(1)}s`,
      'ok',
    );
  await refreshBoot();
  render();
}

async function mailAction(kind, path) {
  state.mail.busy = true;
  render();
  try {
    const data = await api(path, { method: 'POST', body: '{}' });
    if (kind === 'test') toast(`连接成功 · ${data.mailbox} ${data.exists ?? ''}`, 'ok');
    if (kind === 'smtp') {
      state.mail.smtp = data;
      toast(data.authenticated ? 'SMTP 认证通过' : 'SMTP 认证失败', data.authenticated ? 'ok' : 'error');
    }
    if (kind === 'detect') {
      state.mail.detection = data;
      toast(data.recommended ? `可用端点:${data.recommended.host}:${data.recommended.port}` : '没探测到可用端点', data.recommended ? 'ok' : 'error');
    }
  } catch (error) {
    toast(error.details?.server ? `${error.message} · ${error.details.server}` : error.message, 'error');
  } finally {
    state.mail.busy = false;
    render();
  }
}

async function loadMailList() {
  const cursor = state.mail.list;
  cursor.loading = true;
  render();
  try {
    const params = new URLSearchParams({ q: cursor.q, limit: String(cursor.limit), offset: String(cursor.offset) });
    const data = await api(`/mail/messages?${params}`);
    cursor.items = data.messages ?? [];
    cursor.total = data.total ?? 0;
    cursor.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

async function toggleMail(uid) {
  if (state.mail.openUid === uid) {
    state.mail.openUid = null;
    state.mail.detail = null;
    render();
    return;
  }
  state.mail.openUid = uid;
  state.mail.detail = null;
  render();
  try {
    state.mail.detail = await api(`/mail/messages/${encodeURIComponent(uid)}`);
  } catch (error) {
    toast(error.message, 'error');
    state.mail.openUid = null;
  }
  render();
}

function matchCarrierLocal({ subject = '', from = '', filename = '' }) {
  const text = `${subject} ${from}`.toLowerCase();
  const name = String(filename).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const carrier of state.boot?.carriers ?? []) {
    const match = carrier.match ?? {};
    const score =
      ((match.senderIncludes ?? []).some((value) => text.includes(String(value).toLowerCase())) ? 3 : 0) +
      ((match.subjectIncludes ?? []).some((value) => text.includes(String(value).toLowerCase())) ? 2 : 0) +
      ((match.filenameIncludes ?? []).some((value) => name.includes(String(value).toLowerCase())) ? 2 : 0);
    if (score > bestScore) {
      best = carrier;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function attachmentButtons(message, file) {
  const matched = matchCarrierLocal({ subject: message.subject, from: message.from, filename: file.filename });
  return `<div class="row" style="gap:6px">
    <span class="chip" title="${esc(file.filename)}">${esc(file.filename)} · ${bytes(file.size)}</span>
    ${matched ? `<span class="chip chip-new">${esc(matched.name)}</span>` : ''}
    <a class="btn btn-ghost" href="${API}/mail/attachments/${encodeURIComponent(message.uid)}/${encodeURIComponent(
      file.id,
    )}" download="${esc(file.filename)}">下载</a>
    <button class="btn btn-ghost" data-attach="${message.uid}" data-file="${esc(file.id)}" data-mode="track"
      data-subject="${esc(message.subject)}" data-from="${esc(message.from)}">轨迹检测</button>
    <button class="btn btn-ghost" data-attach="${message.uid}" data-file="${esc(file.id)}" data-mode="old"
      data-subject="${esc(message.subject)}" data-from="${esc(message.from)}">设为旧版</button>
    <button class="btn btn-ghost" data-attach="${message.uid}" data-file="${esc(file.id)}" data-mode="new"
      data-subject="${esc(message.subject)}" data-from="${esc(message.from)}">设为新版</button>
  </div>`;
}

function mailDetailHtml(message) {
  const detail = state.mail.detail;
  if (!detail) return '<div class="empty">正在读取正文…</div>';
  const body = detail.body ?? {};
  const text = body.text || message.textPreview || '';
  const html = body.html
    ? `<div class="mail-body">${body.html}</div>`
    : text
      ? `<div class="mail-body"><pre style="white-space:pre-wrap;margin:0">${esc(text)}</pre></div>`
      : '<div class="mail-body field-note">这封邮件没有正文,只有附件。</div>';
  return `
    ${html}
    ${
      message.attachments.length
        ? `<div class="row" style="margin-top:12px;flex-direction:column;align-items:stretch;gap:6px">
            ${message.attachments.map((file) => attachmentButtons(message, file)).join('')}
          </div>`
        : ''
    }
  `;
}

/** 附件按钮:下载后送进轨迹检测或船期对比。 */
function bindAttachmentButtons(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-attach]');
    if (!button) return;
    event.stopPropagation();
    const url = `${API}/mail/attachments/${encodeURIComponent(button.dataset.attach)}/${encodeURIComponent(button.dataset.file)}`;
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('附件下载失败');
      const blob = await response.blob();
      const chip = button.closest('.row')?.querySelector('.chip');
      const name = chip ? chip.textContent.split(' · ')[0] : 'attachment';
      const file = new File([blob], name, { type: blob.type });
      if (button.dataset.mode === 'track') {
        state.track.file = file;
        state.tab = 'track';
        render();
        toast('已放入轨迹检测,点开始检测', 'ok');
      } else {
        state.schedule[button.dataset.mode === 'old' ? 'oldFile' : 'newFile'] = file;
        const matched = matchCarrierLocal({ subject: button.dataset.subject, from: button.dataset.from, filename: name });
        state.tab = 'schedule';
        render();
        toast(`已设为${button.dataset.mode === 'old' ? '旧' : '新'}版${matched ? ` · ${matched.name}` : ''}`, 'ok');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

/* ------------------------------------------------------------- congestion */

function renderCongestion(view) {
  const cursor = state.congestion.list;
  const meta = state.congestion.meta;
  view.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">塞港</h1>
      <div class="page-sub">${
        meta.updatedAt ? `更新于 ${fmtTime(meta.updatedAt)} · 来源 ${esc(meta.source)}` : '尚未抓取'
      }</div>
    </div>
    <div class="card">
      <div class="row">
        <label class="btn" style="position:relative;overflow:hidden">
          导入塞港表
          <input type="file" id="congestion-file" accept=".xls,.xlsx,.csv" hidden />
        </label>
        <button class="btn btn-primary" id="congestion-fetch" ${state.congestion.busy ? 'disabled' : ''}>${
          state.congestion.busy ? '<span class="spinner"></span> 抓取中' : '从 CargoAct 抓取'
        }</button>
        <span class="spacer"></span>
        <span class="field-note">表头:五字码 / 等泊天数</span>
      </div>
    </div>
    <div class="card" style="padding:0">
      ${listControls('ports', cursor, cursor.total, { placeholder: '搜索五字码/港口', unit: '个港口' })}
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>五字码</th><th>港口</th><th class="num">等泊天数</th><th>拥堵等级</th><th>备注</th></tr></thead>
          <tbody>
            ${
              cursor.loading
                ? loadingRow(5)
                : cursor.items.length === 0
                  ? loadingRow(5, '还没有塞港数据')
                  : cursor.items
                      .map(
                        (port) => `<tr>
                          <td class="mono strong">${esc(port.code)}</td>
                          <td>${esc(port.name)}</td>
                          <td class="num">${port.waitingDays ?? '—'}</td>
                          <td>${port.level ? `<span class="chip chip-warn">${esc(port.level)}</span>` : '—'}</td>
                          <td class="truncate" style="max-width:320px" title="${esc(port.note)}">${esc(port.note)}</td>
                        </tr>`,
                      )
                      .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
  view.querySelector('#congestion-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await api('/congestion/import', { method: 'POST', body: form });
      toast(`导入 ${data.count} 个港口`, 'ok');
      cursor.loaded = false;
      await refreshBoot();
      await loadCongestion();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  view.querySelector('#congestion-fetch').addEventListener('click', async () => {
    state.congestion.busy = true;
    render();
    try {
      const data = await api('/congestion/fetch', { method: 'POST', body: '{}' });
      toast(`抓到 ${data.count} 个港口`, 'ok');
      cursor.loaded = false;
      await refreshBoot();
      await loadCongestion();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.congestion.busy = false;
      render();
    }
  });
  bindListControls(view, 'ports', cursor, loadCongestion);
  if (!cursor.loaded && !cursor.loading) loadCongestion();
}

async function loadCongestion() {
  const cursor = state.congestion.list;
  cursor.loading = true;
  render();
  try {
    const params = new URLSearchParams({ q: cursor.q, limit: String(cursor.limit), offset: String(cursor.offset) });
    const data = await api(`/congestion?${params}`);
    cursor.items = data.ports ?? [];
    cursor.total = data.total ?? 0;
    cursor.loaded = true;
    state.congestion.meta = { updatedAt: data.updatedAt, source: data.source };
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    cursor.loading = false;
    render();
  }
}

/* --------------------------------------------------------------- settings */

const SETTING_FIELDS = {
  wechat: [
    ['defaultIntervalMinutes', '默认抓取间隔(分钟)', 'number'],
    ['backfillDays', '回填天数', 'number'],
    ['firstRunMaxArticles', '首次最多回填篇数', 'number'],
    ['sogouMaxArticles', '搜狗每次最多篇数', 'number'],
    ['sogouFallbackHours', '合集断更多久才试搜狗(小时)', 'number'],
    ['sogouCooldownHours', '搜狗风控冷却(小时)', 'number'],
    ['albumCooldownMinutes', '合集风控冷却(分钟)', 'number'],
  ],
  track: [
    ['congestionMinWaitDays', '塞港冲突:最少等泊天数', 'number'],
    ['congestionGapDays', '塞港冲突:至少多出天数', 'number'],
    ['llmScope', '判定范围', 'select', [
      ['candidates', '只判疑点(推荐)'],
      ['all', '全量送模型'],
    ]],
    ['llmConcurrency', '模型并发', 'number'],
    ['llmCharBudget', '单次请求字符预算', 'number'],
    ['llmMaxCalls', '最多请求次数(0=不限)', 'number'],
    ['llmMaxCandidates', '候选上限(0=不限)', 'number'],
    ['llmOutlierMinDays', '统计异常:航段天数下限', 'number'],
    ['llmOutlierRatio', '统计异常:本航线中位数倍数', 'number'],
  ],
  mail: [
    ['host', 'IMAP 服务器', 'text'],
    ['port', 'IMAP 端口', 'number'],
    ['user', '账号', 'text'],
    ['password', '密码/客户端专用密码', 'password'],
    ['folder', '文件夹', 'text'],
    ['smtpHost', 'SMTP 服务器', 'text'],
    ['smtpPort', 'SMTP 端口', 'number'],
    ['lookbackDays', '回溯天数', 'number'],
    ['maxMessages', '每次最多邮件数', 'number'],
  ],
};

function renderSettings(view) {
  const settings = state.boot?.settings ?? {};
  const version = state.boot?.version ?? '';
  const update = state.update;
  const info = update.info;
  view.innerHTML = `
    <div class="page-head"><h1 class="page-title">设置</h1></div>
    <div class="card">
      <div class="row">
        <span class="chip">当前 v${esc(version || '未知')}</span>
        ${
          info?.error
            ? `<span class="chip chip-danger" title="${esc(info.error)}">检查失败</span>`
            : info?.hasUpdate
              ? `<span class="chip chip-new">最新 v${esc(info.latest)}</span>`
              : info
                ? '<span class="chip chip-ok">已是最新</span>'
                : ''
        }
        <span class="spacer"></span>
        <button class="btn btn-ghost" id="update-check" ${update.checking || update.applying ? 'disabled' : ''}>${
          update.checking ? '检查中…' : '检查更新'
        }</button>
        <button class="btn btn-primary" id="update-apply" ${
          !info?.hasUpdate || update.applying ? 'disabled' : ''
        }>${update.applying ? '<span class="spinner"></span> 更新中' : '一键更新'}</button>
      </div>
      ${
        update.error
          ? `<div class="banner banner-warn" style="margin-top:10px">${esc(update.error)}</div>`
          : ''
      }
    </div>
    <div class="card">
      <div class="card-title"><strong>轨迹判定提示词</strong></div>
      <textarea id="track-prompt" class="input" rows="12" style="width:100%;font-family:var(--mono,monospace);line-height:1.6">${esc(
        state.prompts.draft ?? (state.prompts.track.override || state.prompts.track.default || ''),
      )}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-primary" id="prompt-save" ${state.prompts.saving ? 'disabled' : ''}>保存提示词</button>
        <button class="btn btn-ghost" id="prompt-reset" ${state.prompts.saving ? 'disabled' : ''}>恢复默认</button>
        <span class="spacer"></span>
        <span class="field-note">${state.prompts.track.override ? '正在使用自定义提示词' : '正在使用内置默认'}</span>
      </div>
    </div>
    ${Object.entries(SETTING_FIELDS)
      .map(
        ([section, fields]) => `
      <div class="card">
        <div class="card-title"><strong>${{ wechat: '公众号', track: '轨迹检测', mail: '邮件' }[section]}</strong></div>
        <form data-section="${section}" class="grid-2">
          ${fields
            .map(([key, label, type, options]) => {
              const value = settings[section]?.[key] ?? '';
              if (type === 'select') {
                return `<label class="field"><span>${label}</span><select class="select" name="${key}">
                  ${(options ?? [])
                    .map(
                      ([optionValue, text]) =>
                        `<option value="${esc(optionValue)}" ${
                          String(value) === String(optionValue) ? 'selected' : ''
                        }>${esc(text)}</option>`,
                    )
                    .join('')}
                </select></label>`;
              }
              return `<label class="field"><span>${label}</span><input class="input" type="${type}" name="${key}" value="${esc(
                value,
              )}" ${type === 'password' ? 'autocomplete="new-password"' : ''} /></label>`;
            })
            .join('')}
          <div class="row" style="grid-column:1/-1"><button class="btn btn-primary" type="submit">保存</button></div>
        </form>
      </div>`,
      )
      .join('')}
  `;
  view.querySelectorAll('form[data-section]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const section = form.dataset.section;
      const payload = {};
      for (const element of form.elements) {
        if (!element.name) continue;
        payload[element.name] = element.type === 'number' ? Number(element.value) : element.value;
      }
      try {
        const data = await api('/settings', { method: 'POST', body: JSON.stringify({ [section]: payload }) });
        state.boot.settings = data.settings;
        toast('已保存', 'ok');
        render();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  view.querySelector('#update-check')?.addEventListener('click', checkUpdate);
  view.querySelector('#update-apply')?.addEventListener('click', applyUpdate);
  const promptBox = view.querySelector('#track-prompt');
  promptBox?.addEventListener('input', () => {
    state.prompts.draft = promptBox.value;
  });
  view.querySelector('#prompt-save')?.addEventListener('click', saveTrackPrompt);
  view.querySelector('#prompt-reset')?.addEventListener('click', resetTrackPrompt);
  if (!state.prompts.loaded && !state.prompts.loading) loadPrompts();
}

async function loadPrompts() {
  state.prompts.loading = true;
  try {
    const data = await api('/prompts');
    state.prompts.track = data.track ?? state.prompts.track;
    state.prompts.loaded = true;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.prompts.loading = false;
    render();
  }
}

async function savePromptOverride(value) {
  state.prompts.saving = true;
  render();
  try {
    const data = await api('/settings', { method: 'POST', body: JSON.stringify({ track: { promptOverride: value } }) });
    state.boot.settings = data.settings;
    state.prompts.loaded = false;
    state.prompts.draft = null;
    toast(value ? '已保存自定义提示词' : '已恢复默认提示词', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.prompts.saving = false;
    render();
  }
}

function saveTrackPrompt() {
  const box = document.getElementById('track-prompt');
  const value = box ? box.value : state.prompts.draft;
  return savePromptOverride(String(value ?? ''));
}

function resetTrackPrompt() {
  state.prompts.draft = null;
  return savePromptOverride('');
}

async function checkUpdate() {
  const cursor = state.update;
  cursor.checking = true;
  cursor.error = '';
  render();
  try {
    cursor.info = await api('/update');
    if (cursor.info.error) cursor.error = `检查更新失败:${cursor.info.error}`;
  } catch (error) {
    cursor.error = error.message;
  } finally {
    cursor.checking = false;
    render();
  }
}

async function applyUpdate() {
  const cursor = state.update;
  cursor.applying = true;
  cursor.error = '';
  render();
  try {
    const result = await api('/update', { method: 'POST', body: '{}' });
    if (result.skipped) {
      toast(result.reason ?? '已是最新版本', 'info');
    } else {
      toast(`已更新到 v${result.to}`, 'ok');
      withRestart(cursor, result);
    }
    cursor.info = { ...(cursor.info ?? {}), current: result.to, hasUpdate: false };
    await refreshBoot();
  } catch (error) {
    cursor.error = error.message;
  } finally {
    cursor.applying = false;
    render();
  }
}

/** 后端换了就得重启;只换了界面刷新页面即可。 */
function withRestart(cursor, result) {
  if (result.restartRequired) {
    cursor.error = `已更新到 v${result.to},后端代码需要重启 DeepSeek Harness 后生效(界面刷新即可看到新 UI)`;
    return;
  }
  cursor.error = `已更新到 v${result.to} 的界面文件,刷新页面即可看到`;
}

/* ------------------------------------------------------------------ wiring */

nav.innerHTML = TABS.map(
  ([key, label], index) =>
    `<button class="nav-item${key === 'settings' ? ' nav-item-quiet' : ''}" data-tab="${key}"
      data-emoji="${['✳', '↗', '⇄', '✉', '⚓', '⚙'][index]}">${label}</button>`,
).join('');

nav.addEventListener('click', (event) => {
  const button = event.target.closest('.nav-item');
  if (!button) return;
  state.tab = button.dataset.tab;
  if (location.hash !== `#${state.tab}`) history.replaceState(null, '', `#${state.tab}`);
  render();
});

bindAttachmentButtons(main);

document.documentElement.dataset.theme = localStorage.getItem('workbench:theme') ?? 'dark';
if (new URLSearchParams(location.search).get('embed') === '1') {
  document.body.dataset.embed = '1';
}
const initialTab = location.hash.replace('#', '');
if (TABS.some(([key]) => key === initialTab)) state.tab = initialTab;

// 浏览器前进/后退或外部改 hash 时同步页签(否则只有刷新才生效)。
window.addEventListener('hashchange', () => {
  const tab = location.hash.replace('#', '');
  if (tab && tab !== state.tab && TABS.some(([key]) => key === tab)) {
    state.tab = tab;
    render();
  }
});

boot();
