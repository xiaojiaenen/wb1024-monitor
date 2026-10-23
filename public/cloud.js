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
  var FALLBACK_MODEL = 'glm-5.3-flash'; /* models.list 为空或异常时的首选；实测 auto 路由慢模型会超时，不采用 */
  /* 按优先级挑选：step-5-preview 为默认（免费 x0.00 积分，分析质量最高，约 37s/件）；
   * 若其不可用按序降级到实测可用模型（glm-5.3-flash 完整分析约 10s） */
  var PREFERRED_MODELS = ['step-5-preview', 'glm-5.3-flash', 'deepseek-v4-flash', 'hunyuan-chat'];

  var cloud = null;
  var sdkPromise = null;
  var modelId = null;

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

  /* 取模型 id：优先 PREFERRED_MODELS 中列表存在的第一个；否则首个可用；再不行用内置首选 */
  async function getModelId() {
    if (modelId) return modelId;
    var c = getCloud();
    try {
      var models = await c.llm.models.list();
      var usable = (models || []).filter(function (m) { return m.disabled !== true; });
      for (var i = 0; i < PREFERRED_MODELS.length; i++) {
        if (usable.some(function (m) { return m.id === PREFERRED_MODELS[i]; })) {
          modelId = PREFERRED_MODELS[i];
          break;
        }
      }
      if (!modelId && usable.length) modelId = usable[0].id;
    } catch (e) {
      console.warn('models.list 失败，使用内置模型', e);
    }
    if (!modelId) modelId = FALLBACK_MODEL;
    global.__aiModel = modelId;
    return modelId;
  }

  /* 一次性对话：流式收集全文。system 必须为 messages[0] */
  async function chatOnce(system, user, opts) {
    var c = getCloud();
    var model = opts && opts.model ? opts.model : await getModelId();
    var answer = '';
    var iter = c.llm.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: true,
      temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.3,
      ...(opts && opts.json ? { response_format: { type: 'json_object' } } : {})
    });
    for await (var chunk of iter) {
      var d = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (d) answer += d;
    }
    return answer;
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
    chatOnce: chatOnce,
    dbSelectAnalysis: dbSelectAnalysis,
    dbSaveAnalysis: dbSaveAnalysis,
    dbCountAnalyses: dbCountAnalyses,
    dbVote: dbVote,
    dbUnvote: dbUnvote,
    dbFavorite: dbFavorite,
    dbUnfavorite: dbUnfavorite,
    dbLoadInteractions: dbLoadInteractions
  };
})(window);
