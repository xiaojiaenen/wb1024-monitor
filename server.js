/**
 * WorkBuddy「1024 造物挑战」作品监控台 — 后端服务
 * ---------------------------------------------------------------
 * 零第三方依赖（Node 原生 http/https），便于在发布沙箱中直接运行。
 *
 * 数据来源（均为官方活动页公开数据表，经活动页同款 share 接口读取）：
 *   - 作品墙表   Sf9WvoEghtTHglyQACWKC5  已审核上架的参赛作品
 *   - 投稿收集池 P3Y1rSDQcUAZcGV15UjCND  全部投稿（含待审核/已通过/已驳回）
 *
 * 隐私边界：
 *   - 活动另设提交者联系信息隐私表（只写不读），本服务在任何代码路径下
 *     均不查询、不转发该表（ID 不落代码，避免开源仓库暴露内部标识）。
 *   - 投稿池记录仅提取白名单字段，截留任何可能的联系信息。
 *
 * 轮询策略：
 *   - 快速轮询（默认 60s）：作品墙全量 + 投稿池总量 + 最新投稿流水
 *   - 深度轮询（默认 10min）：投稿池全量扫描 → 审核状态分布 / 每日投稿趋势 / 平台分布
 *   - 快照与历史序列落盘到 data/，重启不丢
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 配置

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const UPSTREAM_BASE = 'https://www.workbuddy.link/space/api/page/share';
const PAGE_ID = '8QYARuAmZ9RgQty3FSzNUs'; // 官方活动发布页节点 ID
const DB_WALL = 'Sf9WvoEghtTHglyQACWKC5'; // 作品墙表
const DB_POOL = 'P3Y1rSDQcUAZcGV15UjCND'; // 投稿收集池
// 另有提交者联系信息隐私表（只写不读）——本项目严禁访问，不写入任何配置

const FAST_POLL_MS = parseInt(process.env.FAST_POLL_MS, 10) || 60 * 1000;
const DEEP_POLL_MS = parseInt(process.env.DEEP_POLL_MS, 10) || 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const MAX_PAGES = 80; // 分页安全上限
const HISTORY_CAP = 2880; // 历史序列上限（60s 粒度 ≈ 48 小时）

const ACTIVITY = {
  name: 'WorkBuddy「1024 造物挑战」程序员节应用创作大赛',
  submitEnd: '2026-11-01T23:59:59+08:00', // 投稿截止（北京时间）
  phases: [
    { key: 'submit', name: '投稿征集与作品展示', start: '2026-10-21T00:00:00+08:00', end: '2026-11-01T23:59:59+08:00' },
    { key: 'judge', name: '作品评审', start: '2026-11-02T00:00:00+08:00', end: '2026-11-09T23:59:59+08:00' },
    { key: 'result', name: '结果公示', start: '2026-11-10T00:00:00+08:00', end: '2026-11-10T23:59:59+08:00' },
    { key: 'award', name: '奖励发放', start: null, end: null }
  ],
  officialPage: 'https://www.workbuddy.link/p/8QYARuAmZ9RgQty3FSzNUs'
};

const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WORKS_FULL_FILE = path.join(DATA_DIR, 'works-full.json'); // 作品全量记录（含长文本/全部截图），供 /api/works 分页与 /api/work 详情

// ---------------------------------------------------------------- 工具

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function beijingDateStr(ts) {
  // 投稿池的「提交时间」为北京时间字符串，这里统一按北京时间取日期
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function atomicWriteJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    log('写盘失败', file, e.message);
  }
}

// ---------------------------------------------------------------- 上游客户端

function upstreamPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      UPSTREAM_BASE + apiPath,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'wb1024-works-monitor/1.0 (+https://www.workbuddy.link)',
          Referer: ACTIVITY.officialPage
        },
        timeout: HTTP_TIMEOUT_MS
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error('响应不是合法 JSON: ' + raw.slice(0, 120)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function withRetry(fn, label) {
  let lastErr;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // 上游限流：拉长退避，避免连续撞击
      const isRateLimit = /rate limit/i.test(e.message || '');
      const backoff = isRateLimit ? 5000 * (i + 1) : 500 * (i + 1);
      if (i < MAX_RETRIES) await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 分页拉全某张表；maxPages 可限制只拉前几页 */
async function queryAll(dbId, extra, maxPages) {
  const rows = [];
  let cursor = null;
  const limit = maxPages || MAX_PAGES;
  for (let page = 0; page < limit; page++) {
    if (page > 0) await sleep(400); // 分页节流，规避上游访问频率限制
    const body = Object.assign({ databaseId: dbId, pageId: PAGE_ID, pageSize: 100 }, extra || {});
    if (cursor) body.startCursor = cursor;
    const res = await withRetry(() => upstreamPost('/database/query', body), `query ${dbId} p${page}`);
    if (!res || res.code !== 0 || !res.data) throw new Error(`query ${dbId} 返回异常: ${JSON.stringify(res).slice(0, 160)}`);
    const d = res.data;
    if (Array.isArray(d.results)) rows.push(...d.results);
    cursor = d.hasMore ? d.nextCursor : null;
    if (!cursor) break;
  }
  return rows;
}

/** 计数（轻量） */
async function aggregateCount(dbId) {
  const res = await withRetry(
    () =>
      upstreamPost('/database/aggregate', {
        databaseId: dbId,
        pageId: PAGE_ID,
        aggregates: [{ name: 'total', type: 'count', field: '_id' }]
      }),
    `aggregate ${dbId}`
  );
  if (!res || res.code !== 0 || !res.data || !Array.isArray(res.data.results)) {
    throw new Error(`aggregate ${dbId} 返回异常: ${JSON.stringify(res).slice(0, 160)}`);
  }
  const item = res.data.results.find((x) => x && x.name === 'total');
  return item && typeof item.value === 'number' ? item.value : null;
}

// ---------------------------------------------------------------- 数据映射（白名单，隐私截留）

function firstLink(v) {
  if (!v) return null;
  const item = Array.isArray(v) ? v[0] : v;
  if (!item) return null;
  if (typeof item === 'string') return { link: item, text: '' };
  return { link: item.link || item.url || '', text: item.text || item.name || '' };
}

function mapWork(r) {
  return {
    id: r._id || '',
    cardNo: typeof r['卡片号'] === 'number' ? r['卡片号'] : 0,
    name: r['应用名称'] || '',
    author: r['作者'] || '',
    form: r['作品形态'] || '',
    tags: typeof r['标签'] === 'string' ? r['标签'] : '',
    highlight: r['一句话亮点'] || '',
    desc: r['原文描述'] || '',
    manifesto: r['我的作品宣言'] || '',
    link: firstLink(r['体验链接']),
    social: firstLink(r['社媒分享链接']),
    platform: r['上传平台'] || '',
    shots: (Array.isArray(r['作品截图']) ? r['作品截图'] : []).map((s) => ({
      url: s.imageUrl || '',
      title: s.title || ''
    }))
  };
}

/** 作品瘦身记录 —— 快照/总览/洞察页用：去掉长文本与多余截图，仅留列表所需字段 */
function slimWork(w) {
  return {
    id: w.id,
    cardNo: w.cardNo,
    name: w.name,
    author: w.author,
    form: w.form,
    tags: w.tags,
    highlight: w.highlight,
    platform: w.platform,
    link: w.link,
    shots: (w.shots || []).slice(0, 1) // 仅首图（缩略图）
  };
}

/** 作品列表行记录 —— /api/works 分页用：最小字段集 */
function worksLight(w) {
  return {
    id: w.id,
    cardNo: w.cardNo,
    name: w.name,
    author: w.author,
    form: w.form,
    platform: w.platform,
    highlight: w.highlight,
    shot: w.shots && w.shots[0] ? w.shots[0].url : '',
    link: w.link
  };
}

/** 投稿池瘦身记录 —— 仅白名单字段，杜绝任何联系信息 */
function slimPool(r) {
  return {
    id: r._id || '',
    sid: r['提交编号'] || '',
    name: r['应用名称'] || '',
    author: r['作者'] || '',
    form: r['作品形态'] || '',
    status: r['审核状态'] || '未知',
    submittedAt: r['提交时间'] || '',
    highlight: r['一句话亮点'] || '',
    cardNo: typeof r['已上架卡片号'] === 'number' ? r['已上架卡片号'] : null,
    platform: r['上传平台'] || '',
    hasSocial: !!r['社媒分享链接']
  };
}

// ---------------------------------------------------------------- 快照状态

const state = {
  snapshot: null,
  worksFull: [], // 作品全量记录（内存缓存，/api/works 与 /api/work 的数据源）
  history: [],
  poller: {
    startedAt: new Date().toISOString(),
    fastCount: 0,
    deepCount: 0,
    lastFastAt: null,
    lastDeepAt: null,
    lastError: null,
    consecutiveErrors: 0
  }
};

function loadPersisted() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    log('创建数据目录失败', e.message);
  }
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      state.snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      log('已载入历史快照，作品数:', (state.snapshot.stats || {}).wallTotal);
    }
  } catch (e) {
    log('快照文件损坏，忽略', e.message);
  }
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(h)) state.history = h.slice(-HISTORY_CAP);
      log('已载入历史序列，点数:', state.history.length);
    }
  } catch (e) {
    log('历史文件损坏，忽略', e.message);
  }
  try {
    if (fs.existsSync(WORKS_FULL_FILE)) {
      const w = JSON.parse(fs.readFileSync(WORKS_FULL_FILE, 'utf8'));
      if (Array.isArray(w)) state.worksFull = w;
      log('已载入作品全量缓存，作品数:', state.worksFull.length);
    }
  } catch (e) {
    log('作品全量缓存损坏，忽略', e.message);
  }
  /* 没有全量缓存时，用旧快照的瘦身作品顶号（缺长文本，首次轮询后会补齐） */
  if (!state.worksFull.length && state.snapshot && Array.isArray(state.snapshot.works)) {
    state.worksFull = state.snapshot.works;
  }
}

// ---------------------------------------------------------------- 轮询逻辑

async function fastPoll() {
  const [wallCount, poolCount] = await Promise.all([aggregateCount(DB_WALL), aggregateCount(DB_POOL)]);
  const [wallRows, recentRows] = await Promise.all([
    queryAll(DB_WALL, { sorts: [{ property: '卡片号', direction: 'descending' }] }),
    queryAll(DB_POOL, { pageSize: 40, sorts: [{ property: '提交时间', direction: 'descending' }] }, 1)
  ]);

  const works = wallRows.map(mapWork).filter((w) => w.name);
  const recent = recentRows.map(slimPool);

  state.worksFull = works; // 全量进内存缓存（分页接口的数据源）
  atomicWriteJson(WORKS_FULL_FILE, works);

  const prev = state.snapshot || {};
  const prevStats = prev.stats || {};
  const prevWorks = Array.isArray(prev.works) ? prev.works : [];
  const prevIds = new Set(prevWorks.map((w) => w.id));

  // 新上架作品（按记录主键判重）
  const newOnWall = works.filter((w) => !prevIds.has(w.id));
  // 卡片号缺口检测：上架作品卡片号不连续时提示
  const cardNos = works.map((w) => w.cardNo).filter((n) => n > 0);
  const cardMax = cardNos.length ? Math.max(...cardNos) : 0;

  const webApps = works.filter((w) => w.form === '网页应用').length;
  const miniApps = works.filter((w) => w.form === '小程序应用').length;
  const withSocial = works.filter((w) => w.social && w.social.link).length;

  const now = Date.now();
  const point = { t: new Date(now).toISOString(), wall: wallCount, pool: poolCount };
  state.history.push(point);
  if (state.history.length > HISTORY_CAP) state.history = state.history.slice(-HISTORY_CAP);

  const dailyTrend =
    prev.poolBreakdown && Array.isArray(prev.poolBreakdown.dailyTrend) ? prev.poolBreakdown.dailyTrend : [];
  const todayStr = beijingDateStr(now);
  const todayEntry = dailyTrend.find((d) => d.date === todayStr);

  state.snapshot = Object.assign({}, prev, {
    generatedAt: new Date(now).toISOString(),
    activity: ACTIVITY,
    stats: Object.assign({}, prevStats, {
      wallTotal: wallCount,
      poolTotal: poolCount,
      webApps,
      miniApps,
      withSocial,
      withSocialPct: works.length ? Math.round((withSocial / works.length) * 1000) / 10 : 0,
      cardMax,
      newToday: todayEntry ? todayEntry.count : null,
      deltaWall60s: typeof prevStats.wallTotal === 'number' ? wallCount - prevStats.wallTotal : 0,
      deltaPool60s: typeof prevStats.poolTotal === 'number' ? poolCount - prevStats.poolTotal : 0
    }),
    works: works.map(slimWork), // 快照只带瘦身作品（全量走 /api/works 分页）
    recentSubmissions: recent,
    history: state.history.slice(-600)
  });

  state.poller.fastCount += 1;
  state.poller.lastFastAt = new Date(now).toISOString();
  state.poller.lastError = null;
  state.poller.consecutiveErrors = 0;

  atomicWriteJson(SNAPSHOT_FILE, state.snapshot);
  atomicWriteJson(HISTORY_FILE, state.history);

  log(
    `快速轮询 #${state.poller.fastCount} 墙上作品=${wallCount} 投稿总量=${poolCount} ` +
      `新上架=${newOnWall.length} 60s新增投稿=${state.snapshot.stats.deltaPool60s}`
  );
}

async function deepPoll() {
  const poolRows = await queryAll(DB_POOL);
  const pool = poolRows.map(slimPool);

  const byStatus = {};
  pool.forEach((r) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });

  const daily = {};
  pool.forEach((r) => {
    const d = (r.submittedAt || '').slice(0, 10);
    if (d) daily[d] = (daily[d] || 0) + 1;
  });
  const dailyTrend = Object.keys(daily)
    .sort()
    .map((d) => ({ date: d, count: daily[d] }));

  const platforms = {};
  pool.forEach((r) => {
    if (r.platform) platforms[r.platform] = (platforms[r.platform] || 0) + 1;
  });
  const platformList = Object.keys(platforms)
    .map((name) => ({ name, count: platforms[name] }))
    .sort((a, b) => b.count - a.count);

  const now = Date.now();
  const prev = state.snapshot || {};
  state.snapshot = Object.assign({}, prev, {
    generatedAt: new Date(now).toISOString(),
    poolBreakdown: {
      total: pool.length,
      byStatus,
      dailyTrend,
      platforms: platformList
    }
  });
  // 同步 stats 中的审核分项
  state.snapshot.stats = Object.assign({}, prev.stats, {
    poolPending: byStatus['待审核'] || 0,
    poolApproved: byStatus['已通过'] || 0,
    poolRejected: byStatus['已驳回'] || 0,
    newToday: (daily[beijingDateStr(now)] || 0)
  });

  state.poller.deepCount += 1;
  state.poller.lastDeepAt = new Date(now).toISOString();

  atomicWriteJson(SNAPSHOT_FILE, state.snapshot);
  log(`深度轮询 #${state.poller.deepCount} 投稿池=${pool.length} 状态分布=${JSON.stringify(byStatus)}`);
}

async function safePoll(kind) {
  try {
    if (kind === 'fast') await fastPoll();
    else await deepPoll();
  } catch (e) {
    state.poller.lastError = e.message;
    state.poller.consecutiveErrors += 1;
    log(`${kind} 轮询失败(连续${state.poller.consecutiveErrors}次):`, e.message);
  }
}

// ---------------------------------------------------------------- HTTP 服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(data);
  });
}

function sendJson(res, obj, cacheControl) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl || 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(u.pathname);

  if (pathname === '/api/snapshot') {
    if (!state.snapshot) {
      sendJson(res, { ready: false, message: '首次数据同步中，请稍后刷新' });
      return;
    }
    sendJson(
      res,
      Object.assign({ ready: true }, state.snapshot, {
        poller: {
          fastCount: state.poller.fastCount,
          deepCount: state.poller.deepCount,
          lastFastAt: state.poller.lastFastAt,
          lastDeepAt: state.poller.lastDeepAt,
          lastError: state.poller.lastError,
          consecutiveErrors: state.poller.consecutiveErrors,
          fastPollMs: FAST_POLL_MS,
          deepPollMs: DEEP_POLL_MS,
          startedAt: state.poller.startedAt
        }
      })
    );
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, {
      ok: true,
      uptime: process.uptime(),
      hasSnapshot: !!state.snapshot,
      poller: state.poller
    });
    return;
  }

  /* ---------- 作品库分页查询（列表页只拉当前页，不全量） ---------- */
  if (pathname === '/api/works') {
    const q = u.searchParams;
    const per = Math.min(Math.max(parseInt(q.get('per'), 10) || 24, 1), 100);
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    const sort = q.get('sort') || 'cardDesc';
    const idsParam = (q.get('ids') || '').trim();
    const kw = (q.get('kw') || '').trim().toLowerCase();
    const form = q.get('form') || '';
    const platform = q.get('platform') || '';

    /* 筛选（关键词覆盖名称/作者/亮点/标签/宣言/描述，服务端全量内存匹配） */
    let matched = state.worksFull;
    if (kw) {
      matched = matched.filter((w) =>
        (w.name + ' ' + w.author + ' ' + w.highlight + ' ' + w.tags + ' ' + w.manifesto + ' ' + w.desc)
          .toLowerCase()
          .indexOf(kw) >= 0
      );
    }
    if (form) matched = matched.filter((w) => w.form === form);
    if (platform) matched = matched.filter((w) => w.platform === platform);

    /* 模式 1：仅取 {id, cardNo} 列表（供前端按 AI 评分/人气排序） */
    if (q.get('only') === 'ids') {
      const all = matched.slice().sort((a, b) => b.cardNo - a.cardNo);
      sendJson(res, { total: all.length, ids: all.map((w) => ({ id: w.id, cardNo: w.cardNo })) });
      return;
    }

    /* 模式 2：按前端给定的 ID 顺序取当前页（full=1 时返回全量记录，供分析管线补数据） */
    if (idsParam) {
      const want = idsParam.split(',').filter(Boolean).slice(0, 200);
      const byId = {};
      state.worksFull.forEach((w) => {
        byId[w.id] = w;
      });
      const picked = want.map((id) => byId[id]).filter(Boolean);
      const full = q.get('full') === '1';
      sendJson(res, {
        total: picked.length,
        works: picked.map((w) => (full ? w : worksLight(w)))
      });
      return;
    }

    /* 模式 3：服务端筛选 + 排序 + 分页 */
    const sorted = matched.slice().sort((a, b) => {
      if (sort === 'cardAsc') return a.cardNo - b.cardNo;
      if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      return b.cardNo - a.cardNo; // cardDesc（默认）
    });
    const total = sorted.length;
    const start = (page - 1) * per;
    sendJson(res, {
      total,
      page,
      per,
      pages: Math.max(1, Math.ceil(total / per)),
      works: sorted.slice(start, start + per).map(worksLight)
    });
    return;
  }

  /* ---------- 单件作品全量（详情模态框按需拉取） ---------- */
  if (pathname === '/api/work') {
    const wid = u.searchParams.get('id') || '';
    const found = state.worksFull.find((w) => w.id === wid);
    if (!found) {
      sendJson(res, { error: 'not found' });
      return;
    }
    sendJson(res, { work: found });
    return;
  }

  // 调试端点：接收前端探针日志，追加落盘（仅本地开发排查用）
  if (pathname === '/_debug/log') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', function () {
      const line = '[' + new Date().toISOString() + '] ' + String(body).replace(/\n/g, ' ') + '\n';
      fs.appendFile(path.join(__dirname, 'data', 'probe.log'), line, function () {});
      res.writeHead(204); res.end();
    });
    return;
  }

  // 设计初稿目录（三方向探索期产物，从项目根目录提供，仅本地开发用）
  if (pathname.startsWith('/design-demos/')) {
    const rel = path.normalize(pathname.slice('/design-demos/'.length)).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(__dirname, 'design-demos', rel);
    if (!abs.startsWith(path.join(__dirname, 'design-demos'))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(abs, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"code":404,"msg":"not found"}');
    return;
  }

  serveStatic(req, res, pathname);
});

// ---------------------------------------------------------------- 启动

loadPersisted();

server.listen(PORT, HOST, () => {
  log(`监控台服务已启动: http://${HOST}:${PORT}`);
  log(`快速轮询间隔 ${FAST_POLL_MS}ms，深度轮询间隔 ${DEEP_POLL_MS}ms`);
  // 启动即同步：先快速轮询（秒级出作品数据），再深度扫描
  safePoll('fast').then(() => safePoll('deep'));

  setInterval(() => safePoll('fast'), FAST_POLL_MS);
  setInterval(() => safePoll('deep'), DEEP_POLL_MS);
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，保存状态后退出');
  if (state.snapshot) atomicWriteJson(SNAPSHOT_FILE, state.snapshot);
  if (state.worksFull.length) atomicWriteJson(WORKS_FULL_FILE, state.worksFull);
  atomicWriteJson(HISTORY_FILE, state.history);
  process.exit(0);
});
