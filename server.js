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
const POOL_FULL_FILE = path.join(DATA_DIR, 'pool-full.json'); // 投稿池全量记录（含宣言/介绍/截图/体验链接），供 /api/submission 详情

// 云数据库（WorkBuddy Cloud，PostgREST 风格 REST）
// 仅使用可公开的 publishable key（前端同款），写权限由服务端 RLS 策略约束；
// 抓取数据以云库为持久层，data/*.json 降级为快速启动缓存与兜底。
const CLOUD_REST_BASE = 'https://wb1024-monitor.app.workbuddy.host/.cloud/database/rest';
const CLOUD_PUBLISHABLE_KEY =
  'wbpk_wQcEPpXJK77EMVCgf9VW1y_TnY0J09CvgJ3GzUnELKTylk1nyNAKcG6';
const DB_SYNC_BATCH = 100;       // 每次 REST upsert 的行数
const DB_SYNC_GAP_MS = 300;      // 批间节流
const DB_SYNC_MAX_ERRORS = 5;    // 连续失败次数达到后本轮熔断（下轮轮询自动重试）

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

// ---------------------------------------------------------------- 云库客户端（去重靠主键 upsert）

function cloudRest(method, tablePath, { query, body, prefer } = {}) {
  return new Promise((resolve, reject) => {
    const qs = query ? '?' + query : '';
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      'x-wb-webapp-access-key': CLOUD_PUBLISHABLE_KEY,
      'Content-Type': 'application/json'
    };
    if (prefer) headers.Prefer = prefer;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(
      CLOUD_REST_BASE + tablePath + qs,
      { method, headers, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`云库 ${method} ${tablePath} HTTP ${res.statusCode}: ${raw.slice(0, 160)}`));
            return;
          }
          let data = null;
          if (raw) {
            try { data = JSON.parse(raw); } catch (e) { /* 空响应/纯文本 */ }
          }
          resolve(data);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('云库请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 批量 upsert：on_conflict=id 合并去重；行内自动带 updated_at */
const dbSkipped = new Set(); // 被网关 WAF 拒绝的行 id（如个别含敏感词的描述文本），跳过并记录

async function dbUpsertRows(table, rows) {
  const payload = rows.map((r) => Object.assign({}, r, { updated_at: new Date().toISOString() }));
  try {
    await cloudRest('POST', '/' + table, {
      query: 'on_conflict=id',
      body: payload,
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    return rows.length;
  } catch (e) {
    // 网关 WAF 对个别行内容返回 403：二分隔离到单行，被拒行跳过、其余照常入库
    if (rows.length > 1 && /HTTP 403/.test(e.message)) {
      const mid = rows.length >> 1;
      let n = 0;
      n += await dbUpsertRows(table, rows.slice(0, mid));
      n += await dbUpsertRows(table, rows.slice(mid));
      return n;
    }
    if (rows.length === 1 && /HTTP 403/.test(e.message)) {
      dbSkipped.add(rows[0].id);
      log(`云库跳过被网关拦截的记录 ${table}/${rows[0].id}（WAF 403），该行仅存于 JSON 缓存`);
      return 0;
    }
    throw e;
  }
}

async function dbUpsertBatch(table, rows) {
  let total = 0;
  for (let i = 0; i < rows.length; i += DB_SYNC_BATCH) {
    const chunk = rows
      .slice(i, i + DB_SYNC_BATCH)
      .filter((r) => !dbSkipped.has(r.id));
    if (!chunk.length) continue;
    total += await dbUpsertRows(table, chunk);
    if (i + DB_SYNC_BATCH < rows.length) await sleep(DB_SYNC_GAP_MS);
  }
  return total;
}

/** 分页拉全某张云表（PostgREST limit/offset 循环，每页 1000 行） */
async function dbSelectAll(table, cols) {
  const out = [];
  const select = cols.join(',');
  for (let page = 0; page < 50; page++) {
    const rows = await cloudRest('GET', '/' + table, {
      query: `select=${select}&limit=1000&offset=${page * 1000}`
    });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// 云库行映射（内存字段 -> 表列名；desc 在表内叫 description）
function dbRowWork(w) {
  return {
    id: w.id, card_no: w.cardNo || 0, name: w.name || '', author: w.author || '',
    form: w.form || '', tags: w.tags || '', highlight: w.highlight || '',
    description: w.desc || '', manifesto: w.manifesto || '',
    link: w.link || null, social: w.social || null,
    platform: w.platform || '', shots: w.shots || []
  };
}
function dbRowSubmission(r) {
  return {
    id: r.id, sid: r.sid || '', name: r.name || '', author: r.author || '',
    form: r.form || '', status: r.status || '未知', submitted_at: r.submittedAt || '',
    reviewed_at: r.reviewedAt || '', reject_reason: r.rejectReason || '',
    highlight: r.highlight || '', manifesto: r.manifesto || '', description: r.desc || '',
    link: r.link || null, shots: r.shots || [], tags: r.tags || '',
    card_no: r.cardNo == null ? null : r.cardNo, platform: r.platform || ''
  };
}
function dbRowToWork(row) {
  return {
    id: row.id, cardNo: row.card_no || 0, name: row.name || '', author: row.author || '',
    form: row.form || '', tags: row.tags || '', highlight: row.highlight || '',
    desc: row.description || '', manifesto: row.manifesto || '',
    link: row.link || null, social: row.social || null,
    platform: row.platform || '', shots: row.shots || []
  };
}
function dbRowToSubmission(row) {
  return {
    id: row.id, sid: row.sid || '', name: row.name || '', author: row.author || '',
    form: row.form || '', status: row.status || '未知', submittedAt: row.submitted_at || '',
    reviewedAt: row.reviewed_at || '', rejectReason: row.reject_reason || '',
    highlight: row.highlight || '', manifesto: row.manifesto || '', desc: row.description || '',
    link: row.link || null, shots: row.shots || [], tags: row.tags || '',
    cardNo: row.card_no == null ? null : row.card_no, platform: row.platform || ''
  };
}

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

/** 投稿池全量记录 —— /api/submission 详情用：保留宣言/介绍/截图/体验链接等长字段 */
function richPool(r) {
  return {
    id: r._id || '',
    sid: r['提交编号'] || '',
    name: r['应用名称'] || '',
    author: r['作者'] || '',
    form: r['作品形态'] || '',
    status: r['审核状态'] || '未知',
    submittedAt: r['提交时间'] || '',
    reviewedAt: r['审核时间'] || '',
    rejectReason: r['驳回原因'] || '',
    highlight: r['一句话亮点'] || '',
    manifesto: r['我的作品宣言'] || '',
    desc: r['原文描述'] || '',
    link: Array.isArray(r['体验链接']) ? r['体验链接'] : null,
    shots: (Array.isArray(r['作品截图']) ? r['作品截图'] : []).map((s) => ({
      url: s.imageUrl || '',
      title: s.title || ''
    })),
    tags: r['标签'] || '',
    cardNo: typeof r['已上架卡片号'] === 'number' ? r['已上架卡片号'] : null,
    platform: r['上传平台'] || ''
  };
}

/** 轮询时顺手把全量投稿记录灌入内存缓存（快速轮询补最新、深度轮询补全池） */
function capturePoolFull(rows) {
  rows.forEach((r) => {
    if (r && r._id) state.poolFull[r._id] = richPool(r);
  });
}

/** 上游按主键去重（同一记录理论上不会重复返回，防御性处理） */
function dedupeById(rows) {
  const seen = new Set();
  return (rows || []).filter((r) => {
    if (!r || !r._id || seen.has(r._id)) return false;
    seen.add(r._id);
    return true;
  });
}

// ---------------------------------------------------------------- 云库同步（脏行 diff + 串行队列）

const dbSync = {
  works: {},        // id -> 内容指纹（已同步）
  submissions: {},  // id -> 内容指纹（已同步）
  queue: Promise.resolve(),
  upserted: 0,
  lastSyncAt: null,
  lastError: null,
  consecutiveErrors: 0
};

/**
 * diff 同步：与上次成功同步的内容指纹比对，只推送变化的行；
 * 成功后记录指纹，失败则清指纹等待下轮重试。全程串行，避免批间交叉。
 */
function scheduleDbSync(table, memRows, toDbRow) {
  const synced = dbSync[table];
  const dirty = [];
  const marks = [];
  for (const r of memRows) {
    if (!r || !r.id) continue;
    if (dbSkipped.has(r.id)) continue; // 已被 WAF 拒绝过的行不再重试
    const row = toDbRow(r);
    const h = JSON.stringify(row);
    if (synced[r.id] === h) continue;
    dirty.push(row);
    marks.push([r.id, h]);
  }
  if (!dirty.length) return;
  dbSync.queue = dbSync.queue
    .then(async () => {
      if (dbSync.consecutiveErrors >= DB_SYNC_MAX_ERRORS) {
        log(`云库同步熔断中（连续失败 ${dbSync.consecutiveErrors} 次），本轮跳过 ${dirty.length} 行`);
        return;
      }
      await dbUpsertBatch(table, dirty);
      marks.forEach(([id, h]) => { synced[id] = h; });
      dbSync.upserted += dirty.length;
      dbSync.lastSyncAt = new Date().toISOString();
      dbSync.lastError = null;
      dbSync.consecutiveErrors = 0;
      log(`云库同步 ${table}: 推送 ${dirty.length} 行（累计 ${dbSync.upserted}）`);
    })
    .catch((e) => {
      marks.forEach(([id]) => { delete synced[id]; });
      dbSync.lastError = e.message;
      dbSync.consecutiveErrors += 1;
      log(`云库同步失败 ${table}（连续 ${dbSync.consecutiveErrors} 次）:`, e.message);
    });
}

/** 启动 hydration：云库数据灌入内存缓存（DB 为持久层，优先于 JSON 缓存） */
async function hydrateFromDb() {
  try {
    const works = await dbSelectAll('works',
      ['id', 'card_no', 'name', 'author', 'form', 'tags', 'highlight', 'description', 'manifesto', 'link', 'social', 'platform', 'shots']);
    if (works.length) {
      const byId = {};
      works.forEach((row) => {
        const w = dbRowToWork(row);
        byId[w.id] = w;
        dbSync.works[w.id] = JSON.stringify(dbRowWork(w));
      });
      // DB 优先覆盖缓存；JSON 里有而 DB 没有的保留（尚未同步到云库的遗留数据）
      state.worksFull = state.worksFull.filter((w) => !byId[w.id]).concat(works.map(dbRowToWork));
      log('云库 hydration 作品:', works.length, '条，内存合计:', state.worksFull.length);
    }
    const subs = await dbSelectAll('submissions',
      ['id', 'sid', 'name', 'author', 'form', 'status', 'submitted_at', 'reviewed_at', 'reject_reason', 'highlight', 'manifesto', 'description', 'link', 'shots', 'tags', 'card_no', 'platform']);
    if (subs.length) {
      subs.forEach((row) => {
        const r = dbRowToSubmission(row);
        state.poolFull[r.id] = r;
        dbSync.submissions[r.id] = JSON.stringify(dbRowSubmission(r));
      });
      log('云库 hydration 投稿:', subs.length, '条，内存合计:', Object.keys(state.poolFull).length);
    }
  } catch (e) {
    log('云库 hydration 失败（继续用 JSON 缓存启动）:', e.message);
  }
}

// ---------------------------------------------------------------- 快照状态

const state = {
  snapshot: null,
  worksFull: [], // 作品全量记录（内存缓存，/api/works 与 /api/work 的数据源）
  poolFull: {}, // 投稿池全量记录（id -> 详情，/api/submission 的数据源）
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
  try {
    if (fs.existsSync(POOL_FULL_FILE)) {
      const p = JSON.parse(fs.readFileSync(POOL_FULL_FILE, 'utf8'));
      if (Array.isArray(p)) {
        p.forEach((r) => { if (r && r.id) state.poolFull[r.id] = r; });
        log('已载入投稿池全量缓存，记录数:', Object.keys(state.poolFull).length);
      }
    }
  } catch (e) {
    log('投稿池全量缓存损坏，忽略', e.message);
  }
  /* 没有全量缓存时，用旧快照的瘦身作品顶号（缺长文本，首次轮询后会补齐） */
  if (!state.worksFull.length && state.snapshot && Array.isArray(state.snapshot.works)) {
    state.worksFull = state.snapshot.works;
  }
}

// ---------------------------------------------------------------- 轮询逻辑

async function fastPoll() {
  const [wallCount, poolCount] = await Promise.all([aggregateCount(DB_WALL), aggregateCount(DB_POOL)]);
  let [wallRows, recentRows] = await Promise.all([
    queryAll(DB_WALL, { sorts: [{ property: '卡片号', direction: 'descending' }] }),
    queryAll(DB_POOL, { pageSize: 40, sorts: [{ property: '提交时间', direction: 'descending' }] }, 1)
  ]);

  wallRows = dedupeById(wallRows);
  recentRows = dedupeById(recentRows);
  const works = wallRows.map(mapWork).filter((w) => w.name);
  const recent = recentRows.map(slimPool);
  capturePoolFull(recentRows); // 最新 40 条的全量记录进缓存
  scheduleDbSync('submissions', recentRows.map(richPool), dbRowSubmission);

  state.worksFull = works; // 全量进内存缓存（分页接口的数据源）
  atomicWriteJson(WORKS_FULL_FILE, works);
  scheduleDbSync('works', works, dbRowWork);

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
  const poolRows = dedupeById(await queryAll(DB_POOL));
  const pool = poolRows.map(slimPool);
  capturePoolFull(poolRows); // 全池全量记录进缓存
  scheduleDbSync('submissions', poolRows.map(richPool), dbRowSubmission);
  atomicWriteJson(POOL_FULL_FILE, Object.values(state.poolFull)); // 持久化，重启不丢

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
      dbSync: {
        upserted: dbSync.upserted,
        lastSyncAt: dbSync.lastSyncAt,
        lastError: dbSync.lastError,
        consecutiveErrors: dbSync.consecutiveErrors,
        worksSynced: Object.keys(dbSync.works).length,
        submissionsSynced: Object.keys(dbSync.submissions).length
      },
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

  /* ---------- 投稿池分页查询（动态页/全池列表，服务端筛选 + 排序 + 分页） ---------- */
  if (pathname === '/api/submissions') {
    const q = u.searchParams;
    const per = Math.min(Math.max(parseInt(q.get('per'), 10) || 50, 1), 100);
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    const sort = q.get('sort') || 'newest';
    const status = q.get('status') || '';
    const kw = (q.get('kw') || '').trim().toLowerCase();

    let matched = Object.values(state.poolFull);
    if (status) matched = matched.filter((r) => r.status === status);
    if (kw) {
      matched = matched.filter((r) =>
        (r.name + ' ' + r.author + ' ' + r.highlight + ' ' + r.sid).toLowerCase().indexOf(kw) >= 0
      );
    }
    const sorted = matched.slice().sort((a, b) => {
      if (sort === 'oldest') return String(a.submittedAt).localeCompare(String(b.submittedAt));
      if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh');
      return String(b.submittedAt).localeCompare(String(a.submittedAt)); // newest（默认）
    });
    const total = sorted.length;
    const start = (page - 1) * per;
    sendJson(res, {
      total,
      page,
      per,
      pages: Math.max(1, Math.ceil(total / per)),
      submissions: sorted.slice(start, start + per).map((r) => ({
        id: r.id, sid: r.sid, name: r.name, author: r.author, form: r.form,
        status: r.status, submittedAt: r.submittedAt, highlight: r.highlight,
        cardNo: r.cardNo, platform: r.platform,
        rejectReason: r.rejectReason || '', reviewedAt: r.reviewedAt || ''
      }))
    });
    return;
  }

  // 投稿池单条全量详情（含宣言/介绍/截图/体验链接）—— 动态页详情弹窗用
  if (pathname === '/api/submission') {
    const pid = u.searchParams.get('id') || '';
    const found = state.poolFull[pid];
    if (!found) {
      sendJson(res, { error: 'not found' });
      return;
    }
    sendJson(res, { submission: found });
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
  // 启动即同步：先从云库 hydration（JSON 只是兜底缓存），再快速轮询（秒级出作品数据），最后深度扫描
  hydrateFromDb()
    .catch(() => {})
    .then(() => safePoll('fast'))
    .then(() => safePoll('deep'));

  setInterval(() => safePoll('fast'), FAST_POLL_MS);
  setInterval(() => safePoll('deep'), DEEP_POLL_MS);
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，保存状态后退出');
  if (state.snapshot) atomicWriteJson(SNAPSHOT_FILE, state.snapshot);
  if (state.worksFull.length) atomicWriteJson(WORKS_FULL_FILE, state.worksFull);
  if (Object.keys(state.poolFull).length) atomicWriteJson(POOL_FULL_FILE, Object.values(state.poolFull));
  atomicWriteJson(HISTORY_FILE, state.history);
  process.exit(0);
});
