/* ============================================================
 * cloud.js — WorkBuddy 云服务客户端封装
 * 职责：CDN 加载 SDK、初始化客户端、LLM 一次性流式分析、数据库读写
 * 规范：LLM 必须前端直连 SDK（禁止服务端代理）；只支持 stream:true
 * ============================================================ */
(function (global) {
  'use strict';

  /* 激活云服务时由平台下发，可随前端代码发布（publishableKey 仅标识应用，无独立权限） */
  var PUBLIC_CONFIG = {
    endpoint: 'https://wb1024-monitor.app.workbuddy.host',
    publishableKey: 'wbpk_wQcEPpXJK77EMVCgf9VW1y_TnY0J09CvgJ3GzUnELKTylk1nyNAKcG6',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
  };

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  /* ---------- 免费模型调度 ----------
   * step-5-preview / hy3：全天免费（x0.00 积分），默认主力
   * hy4-preview：仅夜间 23:00–次日 08:00 活动免费窗口（9/11–10/31），夜间优先
   * 策略：按候选顺序尝试，单个失败自动切换下一个；全部不可用则暂停 30 分钟后重试 */
  var FREE_ALL_DAY = ['step-5-preview', 'hy3'];
  var NIGHT_MODELS = ['hy4-preview'];
  var NIGHT_HOURS = [23, 8];        /* 夜间免费窗口 [起, 止)，跨零点 */
  var PAUSE_MS = 30 * 60 * 1000;    /* 全部模型不可用后的暂停时长 */
  var MODELS_CACHE_MS = 5 * 60 * 1000;

  var cloud = null;
  var sdkPromise = null;
  var modelsCache = null;
  var modelsCacheAt = 0;
  var modelFailedAt = {};   /* modelId -> 失败时间戳（成功即清除） */
  var pausedUntil = 0;      /* 全部候选失败后的暂停截止时间 */

  function loadSDK() {
    if (global.WorkBuddyCloud) return Promise.resolve(global.WorkBuddyCloud);
    if (sdkPromise) return sdkPromise;
    /* 正常情况下 index.html 已静态引入 SDK；此处做轮询兜底（如被缓存拦截等异常） */
    sdkPromise = new Promise(function (resolve, reject) {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (global.WorkBuddyCloud) {
          clearInterval(timer);
          resolve(global.WorkBuddyCloud);
        } else if (tries > 50) {
          clearInterval(timer);
          reject(new Error('SDK 加载超时'));
        }
      }, 200);
    });
    return sdkPromise;
  }

  function getCloud() {
    if (!cloud) {
      if (!global.WorkBuddyCloud) throw new Error('SDK 未就绪');
      cloud = global.WorkBuddyCloud.createWorkBuddyCloud(PUBLIC_CONFIG);
    }
    return cloud;
  }

  /* 当前是否处于夜间免费窗口（23:00–08:00） */
  function isNightWindow() {
    var h = new Date().getHours();
    return h >= NIGHT_HOURS[0] || h < NIGHT_HOURS[1];
  }

  /* 拉取模型列表（带 5 分钟缓存）；失败或空列表返回 null（视为无信息，用内置候选） */
  async function fetchModels() {
    if (modelsCache && Date.now() - modelsCacheAt < MODELS_CACHE_MS) return modelsCache;
    try {
      var list = await getCloud().llm.models.list();
      modelsCache = (list && list.length) ? list : null;
      modelsCacheAt = Date.now();
    } catch (e) {
      console.warn('models.list 失败，使用内置候选', e);
      return null;
    }
    return modelsCache;
  }

  /* 按当前时间窗口组装候选模型顺序：夜间 hy4 优先，白天 step-5 优先 */
  async function getCandidates() {
    /* 清理 10 分钟前的失败记录，让恢复的模型重新参与竞争，避免粘性失败 */
    var now = Date.now();
    Object.keys(modelFailedAt).forEach(function (id) {
      if (now - modelFailedAt[id] > 10 * 60 * 1000) delete modelFailedAt[id];
    });
    var list = await fetchModels();
    var usable = (list || []).filter(function (m) { return m.disabled !== true; });
    var order = isNightWindow() ? NIGHT_MODELS.concat(FREE_ALL_DAY) : FREE_ALL_DAY.slice();
    var ids = usable.map(function (m) { return m.id; });
    var picked = order.filter(function (id) { return !list || ids.indexOf(id) >= 0; });
    /* 内置候选都不在列表里（如活动结束下架）时，自动发现列表中的全天免费模型 */
    if (!picked.length && usable.length) {
      picked = usable.filter(function (m) { return /^x0\.00/.test(String(m.credits || '')); })
        .map(function (m) { return m.id; });
    }
    /* 最近失败过的排到后面，给恢复中的模型让位 */
    picked.sort(function (a, b) {
      return (modelFailedAt[a] || 0) - (modelFailedAt[b] || 0);
    });
    return picked;
  }

  /* 当前首选模型（供展示） */
  async function getModelId() {
    var c = await getCandidates();
    return c.length ? c[0] : null;
  }

  function pausedError(retryAt) {
    var e = new Error('免费模型额度暂不可用，已暂停，' + new Date(retryAt).toLocaleTimeString('zh-CN') + ' 自动重试');
    e.paused = true;
    e.retryAt = retryAt;
    return e;
  }

  /* 单模型原始调用：流式收集全文 */
  async function rawChat(model, system, user, opts) {
    var c = getCloud();
    var answer = '';
    var iter = c.llm.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: true,
      temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.3,
      ...(opts && typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
      ...(opts && opts.json ? { response_format: { type: 'json_object' } } : {})
    });
    for await (var chunk of iter) {
      var d = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) answer += d;
    }
    return answer;
  }

  /* 一次性对话：候选模型依序尝试，失败自动切换；全部失败暂停 PAUSE_MS。
   * opts.model 强制指定时直连该模型，不参与调度 */
  async function chatOnce(system, user, opts) {
    if (opts && opts.model) return rawChat(opts.model, system, user, opts);
    if (pausedUntil > Date.now()) throw pausedError(pausedUntil);
    var candidates = await getCandidates();
    if (!candidates.length) {
      pausedUntil = Date.now() + PAUSE_MS;
      throw pausedError(pausedUntil);
    }
    var lastErr = null;
    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i];
      try {
        var text = await rawChat(id, system, user, opts);
        delete modelFailedAt[id];
        global.__aiModel = id;
        return text;
      } catch (e) {
        modelFailedAt[id] = Date.now();
        lastErr = e;
        console.warn('模型不可用，切换下一个候选', id, e && e.message);
      }
    }
    pausedUntil = Date.now() + PAUSE_MS;
    var err = lastErr || new Error('所有候选模型均不可用');
    err.paused = true;
    err.retryAt = pausedUntil;
    throw err;
  }

  /* 调度状态（供前端展示） */
  async function getModelStatus() {
    var candidates = await getCandidates();
    return {
      model: candidates.length ? candidates[0] : null,
      candidates: candidates,
      night: isNightWindow(),
      pausedUntil: pausedUntil > Date.now() ? pausedUntil : null
    };
  }

  /* ---------- 数据库 ---------- */

  async function dbSelectAnalysis(workId) {
    var c = getCloud();
    var res = await c.database.from('analyses').select('*').eq('work_id', workId).maybeSingle();
    if (res.error) throw res.error;
    return res.data || null;
  }

  async function dbSaveAnalysis(row) {
    var c = getCloud();
    var res = await c.database.from('analyses')
      .upsert(row, { onConflict: 'work_id' })
      .select();
    if (res.error) throw res.error;
    return res.data && res.data[0];
  }

  async function dbCountAnalyses() {
    var c = getCloud();
    var res = await c.database.from('analyses').select('*', { count: 'exact', head: true });
    if (res.error) throw res.error;
    return res.count || 0;
  }

  /* 一次性拉取全部分析评分（作品库 AI 排序用）：work_id(cardNo) -> total */
  async function dbSelectAllAnalysisScores() {
    var c = getCloud();
    var res = await c.database.from('analyses').select('work_id,payload');
    if (res.error) throw res.error;
    var map = {};
    (res.data || []).forEach(function (row) {
      var p = row.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
      if (p && typeof p.total === 'number') map[String(row.work_id)] = p.total;
    });
    return map;
  }

  /* 一次性拉取全部分析完整记录（启动时填充内存缓存，榜单/评分立即可见） */
  async function dbSelectAllAnalyses() {
    var c = getCloud();
    var res = await c.database.from('analyses').select('work_id,payload');
    if (res.error) throw res.error;
    return (res.data || []).map(function (row) {
      var p = row.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
      return { work_id: String(row.work_id), payload: p };
    }).filter(function (r) { return r.payload; });
  }

  /* ---------- 互动：投票 / 收藏 ---------- */

  async function dbVote(workId, voterId) {
    var c = getCloud();
    var res = await c.database.from('work_votes').insert({ work_id: workId, voter_id: voterId });
    if (res.error) throw res.error;
    return true;
  }

  async function dbUnvote(workId, voterId) {
    var c = getCloud();
    var res = await c.database.from('work_votes').delete()
      .eq('work_id', workId).eq('voter_id', voterId);
    if (res.error) throw res.error;
    return true;
  }

  async function dbFavorite(workId, voterId) {
    var c = getCloud();
    var res = await c.database.from('work_favorites').insert({ work_id: workId, voter_id: voterId });
    if (res.error) throw res.error;
    return true;
  }

  async function dbUnfavorite(workId, voterId) {
    var c = getCloud();
    var res = await c.database.from('work_favorites').delete()
      .eq('work_id', workId).eq('voter_id', voterId);
    if (res.error) throw res.error;
    return true;
  }

  /* 全量计数 + 当前访客的投票/收藏记录（行很小，客户端聚合） */
  async function dbLoadInteractions() {
    var c = getCloud();
    var out = { votes: {}, favorites: {}, mine: { votes: [], favorites: [] } };
    var vRes = await c.database.from('work_votes').select('work_id, voter_id');
    if (vRes.error) throw vRes.error;
    (vRes.data || []).forEach(function (r) {
      out.votes[r.work_id] = (out.votes[r.work_id] || 0) + 1;
      out.mine.votes.push(r.work_id + '|' + r.voter_id);
    });
    var fRes = await c.database.from('work_favorites').select('work_id, voter_id');
    if (fRes.error) throw fRes.error;
    (fRes.data || []).forEach(function (r) {
      out.favorites[r.work_id] = (out.favorites[r.work_id] || 0) + 1;
      out.mine.favorites.push(r.work_id + '|' + r.voter_id);
    });
    return out;
  }

  global.Cloud = {
    PUBLIC_CONFIG: PUBLIC_CONFIG,
    loadSDK: loadSDK,
    getCloud: getCloud,
    getModelId: getModelId,
    getModelStatus: getModelStatus,
    chatOnce: chatOnce,
    dbSelectAnalysis: dbSelectAnalysis,
    dbSaveAnalysis: dbSaveAnalysis,
    dbCountAnalyses: dbCountAnalyses,
    dbSelectAllAnalysisScores: dbSelectAllAnalysisScores,
    dbSelectAllAnalyses: dbSelectAllAnalyses,
    dbVote: dbVote,
    dbUnvote: dbUnvote,
    dbFavorite: dbFavorite,
    dbUnfavorite: dbUnfavorite,
    dbLoadInteractions: dbLoadInteractions
  };
})(window);
