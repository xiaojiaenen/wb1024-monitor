/* ============================================================
 * analysis.js — 作品 AI 分析管线
 * 流程：内存缓存 → 云数据库缓存 → 批量顺序队列调 LLM → 结果落库
 * 策略：懒加载（详情打开才分析）+ 后台预热最新 N 件 + 全量缓存不重复调用
 * 批量：每 BATCH_SIZE 件一次 LLM 调用（results 数组分发），摊薄 system prompt
 *       与每件固定开销；批量缺失/整批失败自动降级逐个重试，单件不丢
 * ============================================================ */
(function (global) {
  'use strict';

  var SYSTEM_PROMPT = '你是一位严谨的软件产品评审专家，服务于「WorkBuddy 1024 造物挑战」作品监控台。你的任务是基于官方评审细则对参赛作品做结构化分析。只输出 JSON，不要输出任何其他文字、解释或代码块标记。所有 score 必须是整数数字，不能是字符串。评分须克制、有依据，信息不足时给中等偏下分数并在 reason 中说明。';

  var SCHEMA_HINT = {
    summary: '一句话总结，30字内',
    pain_point: '它解决什么问题，50字内',
    solution: '大致怎么解决的，50字内',
    highlights: ['亮点1', '亮点2'],
    tech_stack: ['推断的技术或载体，没有信息就填「未能推断」'],
    scores: {
      creativity: { score: 0, reason: '评分依据' },
      completeness: { score: 0, reason: '评分依据' },
      experience: { score: 0, reason: '评分依据' }
    },
    social_potential: { score: 0, reason: '评分依据' },
    total: 0
  };

  var RUBRIC = '评分细则（百分制，与官方评审对齐）：创意与场景价值 creativity 满分35（新颖性、痛点真实度）；作品完成度 completeness 满分40（功能完整、能跑、细节）；使用体验 experience 满分25（易用、美观、流畅）；社媒潜力 social_potential 满分30（话题性、可分享性，仅参考不计入总分）。total 为前三项之和。';

  var BATCH_SIZE = 6;           /* 每批 LLM 调用的作品数：一次调用分析多件 */
  var MIN_INTERVAL_MS = 800;    /* 两批之间的最小间隔，防止配额被瞬间打满 */
  var WARM_COUNT = 60;          /* 后台预热最新作品数 */
  var MAX_QUEUE = 200;

  var memCache = {};            /* workId -> payload */
  var queue = [];               /* 待分析 work 对象 */
  var running = false;
  var lastCallAt = 0;
  var stats = { done: 0, failed: 0, cached: 0, queued: 0 };

  function workKey(work) { return String(work.cardNo != null ? work.cardNo : work.id); }

  function buildUserPrompt(work) {
    var info = {
      名称: work.name,
      作者: work.author,
      作品形态: work.form,
      一句话亮点: work.highlight || '',
      我的作品宣言: work.manifesto || '',
      原文描述: (work.desc || '').slice(0, 600),
      体验链接: work.link || '',
      社媒分享链接: work.social || ''
    };
    return '请分析以下参赛作品，严格按给定 JSON 结构输出（score 为整数）：\n' +
      JSON.stringify(SCHEMA_HINT) + '\n\n' + RUBRIC + '\n\n作品信息：\n' +
      JSON.stringify(info, null, 2);
  }

  /* 清洗模型输出：补默认、截断超范围分数、修正 total */
  function sanitize(payload, model) {
    var p = payload || {};
    var s = p.scores || {};
    function clamp(v, max) {
      var n = parseInt(v, 10);
      if (isNaN(n)) n = Math.round(max * 0.6);
      return Math.max(0, Math.min(max, n));
    }
    var c = clamp(s.creativity && s.creativity.score, 35);
    var m = clamp(s.completeness && s.completeness.score, 40);
    var e = clamp(s.experience && s.experience.score, 25);
    var social = clamp(p.social_potential && p.social_potential.score, 30);
    function reason(obj, max, label) {
      var r = obj && typeof obj.reason === 'string' ? obj.reason.trim() : '';
      if (!r) r = label + ' ' + (obj && obj.score) + '/' + max + '（AI 未给出依据）';
      return r.slice(0, 200);
    }
    return {
      summary: String(p.summary || '（暂无总结）').slice(0, 120),
      pain_point: String(p.pain_point || '').slice(0, 200),
      solution: String(p.solution || '').slice(0, 200),
      highlights: Array.isArray(p.highlights) ? p.highlights.slice(0, 3).map(function (x) { return String(x).slice(0, 80); }) : [],
      tech_stack: Array.isArray(p.tech_stack) ? p.tech_stack.slice(0, 6).map(function (x) { return String(x).slice(0, 40); }) : [],
      scores: {
        creativity: { score: c, reason: reason(s.creativity, 35, '创意') },
        completeness: { score: m, reason: reason(s.completeness, 40, '完成度') },
        experience: { score: e, reason: reason(s.experience, 25, '体验') }
      },
      social_potential: { score: social, reason: reason(p.social_potential, 30, '社媒潜力') },
      total: c + m + e
    };
  }

  function parseAnswer(text) {
    var raw = String(text || '').trim();
    /* 去掉可能的代码块围栏 */
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
    return JSON.parse(raw.slice(start, end + 1));
  }

  /* 批量 prompt：一次分析多件，results 数组按 work_id 分发 */
  function buildBatchPrompt(works) {
    var list = works.map(function (w) {
      return {
        work_id: workKey(w),
        名称: w.name,
        作者: w.author,
        作品形态: w.form,
        一句话亮点: w.highlight || '',
        我的作品宣言: w.manifesto || '',
        原文描述: (w.desc || '').slice(0, 600),
        体验链接: w.link || '',
        社媒分享链接: w.social || ''
      };
    });
    return '请分析以下 ' + list.length + ' 件参赛作品。\n' +
      '严格输出 JSON：{"results": [{"work_id": "<该作品的 work_id>", ' + JSON.stringify(SCHEMA_HINT).slice(1, -1) + ']}\n' +
      'results 必须且只能包含全部 ' + list.length + ' 件作品，work_id 必须原样使用输入的 work_id，不得编造或遗漏。\n\n' +
      RUBRIC + '\n\n作品列表：\n' + JSON.stringify(list, null, 2);
  }

  /* 解析批量结果：返回 work_id -> 原始 payload 的映射 */
  function parseBatchAnswer(text) {
    var raw = String(text || '').trim();
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = raw.indexOf('{');
    var end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型未返回 JSON');
    var json = JSON.parse(raw.slice(start, end + 1));
    var arr = Array.isArray(json) ? json : (json.results || json.works || json.items || null);
    if (!Array.isArray(arr) || !arr.length) throw new Error('批量结果为空或结构不符');
    var map = {};
    arr.forEach(function (r) {
      if (r && r.work_id != null) map[String(r.work_id)] = r;
    });
    return map;
  }

  /* 完成单件分析：清洗 → 内存缓存 → 落库 → 回调 */
  function finishJob(job, raw) {
    var key = workKey(job.work);
    var payload = sanitize(raw);
    memCache[key] = payload;
    Cloud.dbSaveAnalysis({
      work_id: key,
      work_name: job.work.name || '',
      payload: payload,
      model: global.__aiModel || 'step-5-preview'
    }).catch(function (dbErr) {
      console.warn('分析结果落库失败（内存缓存仍可用）', dbErr);
    });
    stats.done++;
    if (typeof job.onDone === 'function') job.onDone(payload, null);
  }

  async function runQueue() {
    if (running) return;
    running = true;
    while (queue.length) {
      var batch = queue.splice(0, BATCH_SIZE);
      stats.queued = queue.length;
      var missing = [];
      try {
        /* 节流 */
        var wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
        if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
        lastCallAt = Date.now();
        var text = await Cloud.chatOnce(SYSTEM_PROMPT, buildBatchPrompt(batch.map(function (j) { return j.work; })),
          { json: true, maxTokens: 8192 });
        var map = parseBatchAnswer(text);
        batch.forEach(function (job) {
          var key = workKey(job.work);
          var payload = map[key] != null ? map[key] : map[String(job.work.id)];
          if (payload) finishJob(job, payload);
          else missing.push(job);
        });
        if (missing.length) console.warn('批量结果缺失 ' + missing.length + ' 件，逐个补跑');
      } catch (e) {
        if (e && e.paused) {
          /* 全部免费模型暂不可用：整批回退，睡到恢复时间再继续 */
          queue = batch.concat(queue);
          stats.queued = queue.length;
          console.warn('模型暂停中，30 分钟后自动重试；队列保留', queue.length, '件');
          await new Promise(function (r) { setTimeout(r, Math.max(1000, e.retryAt - Date.now() + 1000)); });
          continue;
        }
        console.warn('批量分析失败，降级逐个重试', e);
        missing = batch.slice();
      }
      /* 批量缺失或整批失败：逐个重试，保证单件不丢 */
      for (var i = 0; i < missing.length; i++) {
        var mjob = missing[i];
        try {
          var wait2 = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
          if (wait2 > 0) await new Promise(function (r) { setTimeout(r, wait2); });
          lastCallAt = Date.now();
          var t = await Cloud.chatOnce(SYSTEM_PROMPT, buildUserPrompt(mjob.work), { json: true, maxTokens: 4096 });
          finishJob(mjob, parseAnswer(t));
        } catch (e2) {
          if (e2 && e2.paused) {
            /* 剩余未处理的回退队列，等外层统一等待恢复 */
            queue = missing.slice(i).concat(queue);
            stats.queued = queue.length;
            break;
          }
          stats.failed++;
          console.warn('分析失败', workKey(mjob.work), e2);
          if (typeof mjob.onDone === 'function') mjob.onDone(null, e2);
        }
      }
    }
    running = false;
  }

  /* 分析单件作品：缓存优先，未分析则入队 */
  async function analyze(work, onDone) {
    var key = workKey(work);
    if (memCache[key]) { stats.cached++; if (onDone) onDone(memCache[key], null); return memCache[key]; }
    var job = queue.find(function (j) { return workKey(j.work) === key; });
    if (job) { if (onDone) job.onDone = onDone; return null; }
    if (queue.length >= MAX_QUEUE) { if (onDone) onDone(null, new Error('队列已满，请稍后')); return null; }
    queue.push({ work: work, onDone: onDone });
    stats.queued = queue.length;
    runQueue();
    return null;
  }

  /* 后台预热：只补数据库里没有的最新作品 */
  async function warmLatest(works) {
    if (!works || !works.length) return;
    var latest = works.slice(0, WARM_COUNT);
    var missing = [];
    for (var i = 0; i < latest.length; i++) {
      var key = workKey(latest[i]);
      if (memCache[key]) continue;
      try {
        var row = await Cloud.dbSelectAnalysis(key);
        if (row && row.payload) memCache[key] = row.payload;
        else missing.push(latest[i]);
      } catch (e) {
        missing.push(latest[i]); /* 查库失败也试着分析 */
      }
    }
    missing.forEach(function (w) {
      if (queue.length < MAX_QUEUE) queue.push({ work: w, onDone: null });
    });
    stats.queued = queue.length;
    if (queue.length) runQueue();
  }

  function getCached(key) { return memCache[String(key)] || null; }
  function getStats() {
    return {
      done: stats.done, failed: stats.failed,
      queued: queue.length, running: running,
      cachedCount: Object.keys(memCache).length
    };
  }

  global.Analysis = {
    analyze: analyze,
    warmLatest: warmLatest,
    getCached: getCached,
    getStats: getStats,
    workKey: workKey
  };
})(window);
