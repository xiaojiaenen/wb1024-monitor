/* ============================================================
 * app.js — 1024 造物挑战 · 作品监控台（hash 路由多页面 SPA）
 * 页面：总览 / 作品库 / AI 评审 / 数据洞察 / 实时动态 / 关于
 * 设计系统：赛事识别（冷白纸 + 信号橙红 + 黑色状态带 + 象图轨）
 * ============================================================ */
(function () {
  'use strict';

  // ------------------------------------------------------------ 状态
  var snapshot = null;
  var filters = { keyword: '', form: '', platform: '', sort: 'cardDesc' };
  var worksPage = 1;          /* 作品库当前页码 */
  var worksPerPage = 24;      /* 作品库每页行数 */
  var worksTotal = 0;         /* 服务端返回的筛选后总数 */
  var worksReqToken = 0;      /* 请求序号：丢弃过期响应，防止快速翻页乱序 */
  var worksLoading = false;
  var aiScoresCache = { at: 0, map: null }; /* AI 评分映射（cardNo -> total），60s 缓存 */
  var dbScores = {};                        /* 评分单元格的数据库兜底（AI 排序拉取时填充） */
  var warmEnd = 60;
  var snapshotVersion = 0;    /* 快照数据版本：筛选结果缓存的失效依据 */
  var voteVersion = 0;        /* 互动数据版本：投票/收藏变化后重排的依据 */
  var route = '';
  var openId = '';
  var aiReady = false;
  var aiFault = '';
  var ratingsTimer = null;
  var ratingsSel = '';          /* 评审页当前选中的 workKey */
  var interactions = { votes: {}, favs: {}, mineVotes: {}, mineFavs: {} };
  var voterId = '';
  var lastInteractLoad = 0;
  var toastTimer = null;
  var tickerTimer = null;
  var syncSuffix = '初始化';

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ 工具
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '–';
    return Number(n).toLocaleString('zh-CN');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtHM(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  /* 访客标识：本地生成，用于互动去重（一人一票/一收藏） */
  function getVoterId() {
    if (voterId) return voterId;
    try {
      voterId = localStorage.getItem('wb1024.vid') || '';
      if (!voterId) {
        voterId = 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('wb1024.vid', voterId);
      }
    } catch (e) {
      voterId = 'v-tmp-' + Math.random().toString(36).slice(2, 10);
    }
    return voterId;
  }

  // ------------------------------------------------------------ 倒计时 & 时钟
  var SUBMIT_END = Date.parse('2026-11-01T23:59:59+08:00');
  function renderCountdown() {
    var ms = SUBMIT_END - Date.now();
    var el = $('countdown');
    if (ms <= 0) { el.textContent = '已截止'; el.classList.remove('hot'); return; }
    var d = Math.floor(ms / 86400000);
    var h = Math.floor((ms % 86400000) / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    el.textContent = 'D-' + d + ' ' + pad(h) + ':' + pad(m) + ':' + pad(s);
    el.classList.toggle('hot', d <= 3);
  }

  function renderClock() {
    var d = new Date();
    $('clock').textContent = 'LIVE ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' · ' + syncSuffix;
  }

  function currentPhase(phases, now) {
    for (var i = 0; i < phases.length; i++) {
      var p = phases[i];
      if (!p.start) continue;
      var s = Date.parse(p.start), e = Date.parse(p.end);
      if (now >= s && now <= e) return p;
    }
    var first = phases[0];
    return now < Date.parse(first.start) ? { name: '活动准备中' } : { name: '活动已收官' };
  }

  // ------------------------------------------------------------ SVG 图表
  /* 坐标轴 nice-ticks：选一个"整数感"的步长，让刻度标签干净（自适应数据量级） */
  function niceScale(max, targetTicks) {
    targetTicks = targetTicks || 5;
    if (!(max > 0)) return { top: 1, step: 1 };
    var raw = max / targetTicks;
    var exp = Math.floor(Math.log10(raw));
    var f = raw / Math.pow(10, exp);
    var mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    var step = mult * Math.pow(10, exp);
    var top = Math.ceil(max / step) * step;
    return { top: top, step: step };
  }

  /* 每日投稿柱状图：直接标注（数值飞出柱体），今日柱信号色 */
  function barChart(el, data) {
    if (!data.length) { el.innerHTML = '<div class="chart-empty">深度扫描进行中…</div>'; return; }
    var W = Math.max(el.clientWidth, 320), H = 200;
    var padL = 44, padR = 10, padT = 20, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;
    var scale = niceScale(max, 5);
    var top = scale.top, step = scale.step;
    var bw = Math.min(46, (iw / data.length) * 0.6);
    var gap = iw / data.length;
    var today = data[data.length - 1].label;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="每日投稿量">';
    function fmtTick(v) { return step >= 1 ? fmtNum(Math.round(v)) : String(Math.round(v * 10) / 10); }
    for (var v = 0; v <= top + 1e-9; v += step) {
      var y = padT + ih - (v / top) * ih;
      svg += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#E3E0D9" stroke-width="1"/>';
      svg += '<text x="' + (padL - 7) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#6B655A" font-family="Oswald">' + fmtTick(v) + '</text>';
    }
    data.forEach(function (d, i) {
      var bh = Math.max(2, (d.value / top) * ih);
      var x = padL + gap * i + (gap - bw) / 2;
      var by = padT + ih - bh;
      var isToday = d.label === today;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + (isToday ? '#E8481F' : '#16130F') + '"><title>' + esc(d.label) + '：' + fmtNum(d.value) + ' 件投稿</title></rect>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (by - 6).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#16130F" font-family="Oswald">' + fmtNum(d.value) + '</text>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#6B655A" font-family="Oswald">' + esc(d.label.slice(5)) + '</text>';
    });
    svg += '</svg>';
    el.innerHTML = svg;
  }

  /* 上架趋势折线图：双系列 + 端点直接标注 */
  function lineChart(el, data) {
    if (data.length < 2) {
      el.innerHTML = '<div class="chart-empty">趋势采样累积中（需 ≥2 个采样点，约 1 分钟后出现）</div>';
      return;
    }
    var W = Math.max(el.clientWidth, 320), H = 200;
    var padL = 40, padR = 56, padT = 18, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var n = data.length;
    var wallVals = data.map(function (d) { return d.wall; });
    var poolVals = data.map(function (d) { return d.pool; });
    var max = Math.max.apply(null, wallVals.concat(poolVals));
    var min = Math.min.apply(null, wallVals);
    if (max === min) { max = min + 1; }
    var pad = (max - min) * 0.14 || 1;
    max += pad; min = Math.max(0, min - pad);
    function X(i) { return padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1)); }
    function Y(v) { return padT + ih - ((v - min) / (max - min)) * ih; }
    function pathOf(vals) {
      return vals.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' ');
    }
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="作品墙上架趋势">';
    for (var g = 0; g <= 4; g++) {
      var y = padT + ih - (ih * g / 4);
      var val = min + ((max - min) * g) / 4;
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#E3E0D9"/>';
      svg += '<text x="' + (padL - 7) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#6B655A" font-family="Oswald">' + fmtNum(Math.round(val)) + '</text>';
    }
    var area = pathOf(wallVals) + ' L' + X(n - 1).toFixed(1) + ' ' + (padT + ih) + ' L' + X(0).toFixed(1) + ' ' + (padT + ih) + ' Z';
    svg += '<path d="' + area + '" fill="#F0EDE4"/>';
    svg += '<path d="' + pathOf(poolVals) + '" fill="none" stroke="#8A8578" stroke-width="1.6" stroke-dasharray="5 4"/>';
    svg += '<path d="' + pathOf(wallVals) + '" fill="none" stroke="#16130F" stroke-width="2.4" stroke-linejoin="round"/>';
    svg += '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(poolVals[n - 1]).toFixed(1) + '" r="3.6" fill="#8A8578"/>';
    svg += '<circle cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(wallVals[n - 1]).toFixed(1) + '" r="4.4" fill="#E8481F" stroke="#FBFAF7" stroke-width="1.6"/>';
    svg += '<text x="' + (W - padR + 8) + '" y="' + (Y(wallVals[n - 1]) + 4).toFixed(1) + '" font-size="12" font-weight="700" fill="#16130F" font-family="Oswald">' + fmtNum(wallVals[n - 1]) + '</text>';
    svg += '<text x="' + (W - padR + 8) + '" y="' + (Y(poolVals[n - 1]) + 4).toFixed(1) + '" font-size="11" fill="#6B655A" font-family="Oswald">' + fmtNum(poolVals[n - 1]) + '</text>';
    svg += '<text x="' + padL + '" y="' + (H - 8) + '" font-size="11" fill="#6B655A" font-family="Oswald">' + esc(fmtHM(data[0].t)) + '</text>';
    svg += '<text x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" fill="#6B655A" font-family="Oswald">' + esc(fmtHM(data[n - 1].t)) + '</text>';
    svg += '</svg>';
    el.innerHTML = svg +
      '<div class="chart-legend"><span><i style="background:#16130F"></i>作品墙上架数</span><span><i style="background:#8A8578"></i>投稿池总量</span></div>';
  }

  /* AI 评分分布直方图 */
  function histogram(el, scores) {
    if (!scores.length) { el.innerHTML = '<div class="chart-empty">等待首批分析完成…</div>'; return; }
    var bins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    scores.forEach(function (s) {
      var i = Math.min(9, Math.max(0, Math.floor(s / 10)));
      bins[i]++;
    });
    var data = bins.map(function (v, i) { return { label: (i * 10) + '-' + (i * 10 + 9), value: v }; });
    var W = Math.max(el.clientWidth, 320), H = 180;
    var padL = 30, padR = 10, padT = 20, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, bins) || 1;
    var bw = Math.min(40, (iw / data.length) * 0.62);
    var gap = iw / data.length;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="AI 评分分布">';
    for (var g = 0; g <= 2; g++) {
      var y = padT + ih - (ih * g / 2);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#E3E0D9"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#6B655A" font-family="Oswald">' + Math.round(max * g / 2) + '</text>';
    }
    data.forEach(function (d, i) {
      var bh = Math.max(2, (d.value / max) * ih);
      var x = padL + gap * i + (gap - bw) / 2;
      var by = padT + ih - bh;
      var modal = d.value === max && max > 0;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + (modal ? '#E8481F' : '#16130F') + '"><title>' + d.label + ' 分：' + d.value + ' 件</title></rect>';
      if (d.value > 0) {
        svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (by - 6).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#16130F" font-family="Oswald">' + d.value + '</text>';
      }
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="#6B655A" font-family="Oswald">' + d.label + '</text>';
    });
    svg += '</svg>';
    el.innerHTML = svg;
  }

  // ------------------------------------------------------------ 数据拉取
  /* 统一 GET 助手：params 中的空值自动剔除 */
  function apiGet(url, params) {
    var q = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== '' && v != null) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    var full = url + (q.length ? '?' + q.join('&') : '');
    return fetch(full, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadSnapshot() {
    fetch('/api/snapshot', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ready) {
          syncSuffix = '首次同步中';
          renderClock();
          return;
        }
        var first = !snapshot;
        snapshot = data;
        snapshotVersion++;
        renderSync();
        if (first) {
          renderPage();
          initAi();
          firstLoadDone();
        } else {
          refreshDynamic();
        }
        /* 互动数据 60s 量级刷新一次（ piggyback 快照轮询） */
        var now = Date.now();
        if (aiReady && now - lastInteractLoad > 55000) {
          lastInteractLoad = now;
          loadInteractions(false);
        }
      })
      .catch(function () {
        var dot = document.querySelector('.band .dot');
        if (dot) dot.classList.add('err');
        syncSuffix = '连接异常 · 保留最后快照';
        renderClock();
      });
  }
  function firstLoadDone() { /* 预留钩子 */ }

  // ------------------------------------------------------------ AI 初始化
  function initAi() {
    Cloud.loadSDK().then(function () {
      aiReady = true;
      getVoterId();
      loadInteractions(true);
      /* 先 hydration 全量分析缓存，再预热缺失的最新作品 */
      Analysis.hydrateFromDb().then(function () {
        warmMore(0);
        updateAiBadge();
        /* AI 就绪后立即刷新依赖 AI 的区域 */
        if (route === '') { renderStats(); renderBoard(); renderAiPanel(); }
        if (route === 'ratings') { renderRatingsMeta(); renderRatingsList(); }
      });
    }).catch(function (e) {
      aiFault = 'AI 模块加载失败：' + (e && e.message ? e.message : '网络错误');
      console.warn(aiFault);
    });
  }

  function warmMore(extra) {
    if (!snapshot || !snapshot.works) return;
    if (extra) warmEnd += extra;
    Analysis.warmLatest(snapshot.works.slice(0, warmEnd), hydrateWorks);
  }

  /* 按 ID 批量补拉作品全量记录（AI 分析的 prompt 需要 desc/manifesto/social，快照里已瘦身） */
  function hydrateWorks(ids) {
    return apiGet('/api/works', { ids: ids.join(','), full: 1 }).then(function (res) {
      return (res && res.works) || [];
    });
  }

  var lastCachedCount = -1;
  function updateAiBadge() {
    var badge = $('aiNavBadge');
    if (!badge) return;
    var n = aiReady ? Analysis.getStats().cachedCount : 0;
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    /* 后台预热有新的分析完成时，即时刷新总览的 AI 区域（榜单 / KPI / 进度） */
    if (aiReady && route === '' && n !== lastCachedCount) {
      lastCachedCount = n;
      renderStats();
      renderBoard();
      renderAiPanel();
    }
    if (aiReady && route === 'works' && n !== lastCachedCount) {
      lastCachedCount = n;
      fetchWorksPage(true);   /* AI 评分列/排序可能变化，静默重拉当前页 */
    }
    if (aiReady && route === 'insights' && n !== lastCachedCount) {
      lastCachedCount = n;
      renderHistogram();
      renderPopularity();
    }
  }

  // ------------------------------------------------------------ 互动（投票/收藏）
  function loadInteractions(initial) {
    if (!aiReady) return;
    Cloud.dbLoadInteractions().then(function (res) {
      interactions = {
        votes: res.votes || {}, favs: res.favs || {},
        mineVotes: {}, mineFavs: {}
      };
      var vid = getVoterId();
      (res.mine.votes || []).forEach(function (k) {
        var p = k.split('|');
        if (p[1] === vid) interactions.mineVotes[p[0]] = true;
      });
      (res.mine.favorites || []).forEach(function (k) {
        var p = k.split('|');
        if (p[1] === vid) interactions.mineFavs[p[0]] = true;
      });
      voteVersion++;
      if (!initial) refreshDynamic();
    }).catch(function (e) {
      console.warn('互动数据加载失败', e);
    });
  }

  function voteCount(key) { return interactions.votes[key] || 0; }
  function favCount(key) { return interactions.favs[key] || 0; }
  function voted(key) { return !!interactions.mineVotes[key]; }
  function faved(key) { return !!interactions.mineFavs[key]; }

  function toggleVote(key, btn) {
    if (!aiReady) { toast('互动功能加载中，请稍候'); return; }
    var wasVoted = voted(key);
    /* 乐观更新 */
    if (wasVoted) {
      delete interactions.mineVotes[key];
      interactions.votes[key] = Math.max(0, (interactions.votes[key] || 0) - 1);
    } else {
      interactions.mineVotes[key] = true;
      interactions.votes[key] = (interactions.votes[key] || 0) + 1;
    }
    syncPopCells(key);
    if (btn) btn.classList.toggle('on', !wasVoted);
    voteVersion++;
    var act = wasVoted ? Cloud.dbUnvote(key, getVoterId()) : Cloud.dbVote(key, getVoterId());
    act.catch(function () {
      /* 回滚 */
      if (wasVoted) {
        interactions.mineVotes[key] = true;
        interactions.votes[key] = (interactions.votes[key] || 0) + 1;
      } else {
        delete interactions.mineVotes[key];
        interactions.votes[key] = Math.max(0, (interactions.votes[key] || 0) - 1);
      }
      syncPopCells(key);
      voteVersion++;
      if (btn) btn.classList.toggle('on', wasVoted);
      toast('操作失败，请稍后重试');
    });
  }

  function toggleFav(key, btn) {
    if (!aiReady) { toast('互动功能加载中，请稍候'); return; }
    var wasFaved = faved(key);
    if (wasFaved) {
      delete interactions.mineFavs[key];
      interactions.favs[key] = Math.max(0, (interactions.favs[key] || 0) - 1);
    } else {
      interactions.mineFavs[key] = true;
      interactions.favs[key] = (interactions.favs[key] || 0) + 1;
    }
    syncPopCells(key);
    if (btn) btn.classList.toggle('on', !wasFaved);
    voteVersion++;
    var act = wasFaved ? Cloud.dbUnfavorite(key, getVoterId()) : Cloud.dbFavorite(key, getVoterId());
    act.catch(function () {
      if (wasFaved) {
        interactions.mineFavs[key] = true;
        interactions.favs[key] = (interactions.favs[key] || 0) + 1;
      } else {
        delete interactions.mineFavs[key];
        interactions.favs[key] = Math.max(0, (interactions.favs[key] || 0) - 1);
      }
      syncPopCells(key);
      voteVersion++;
      if (btn) btn.classList.toggle('on', wasFaved);
      toast('操作失败，请稍后重试');
    });
  }

  /* 页面上所有该作品的计数单元格同步刷新 */
  function syncPopCells(key) {
    document.querySelectorAll('[data-pop="' + key + '"]').forEach(function (el) {
      el.innerHTML = popCellHtml(key);
    });
    var vb = document.querySelector('[data-act="vote"][data-id="' + key + '"] .n');
    if (vb) vb.textContent = voteCount(key);
  }

  var ICON_VOTE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12M15 5.88L14 10h5.5a2 2 0 0 1 2 2.2l-1.4 7A2 2 0 0 1 18.1 21H7m0-11V4a2 2 0 0 1 2-2h.4a2 2 0 0 1 1.9 1.4L15 10"/></svg>';
  var ICON_FAV = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.2-5.6-3.1-5.6 3.1 1.2-6.2L3 9.6l6.3-.8z"/></svg>';

  function popCellHtml(key) {
    var v = voteCount(key), f = favCount(key);
    return '<span class="pop-cell' + (voted(key) ? ' mine' : '') + '">' + ICON_VOTE + '<b>' + v + '</b></span>' +
      '<span class="pop-cell" style="margin-left:8px' + (faved(key) ? ';color:var(--signal-text);font-weight:700' : '') + '">' + ICON_FAV + '<b>' + f + '</b></span>';
  }

  // ------------------------------------------------------------ 路由
  var PAGES = {
    '': { title: '总览', desc: '大赛实时全景 · AI 评审进度', render: renderOverview },
    works: { title: '作品库', desc: '已上架作品全表 · 搜索筛选排序 · 点击行查看 AI 画像', render: renderWorksPage },
    ratings: { title: 'AI 评审', desc: '按官方评分细则生成的模拟评审排行（非官方结果）', render: renderRatingsPage },
    insights: { title: '数据洞察', desc: '投稿趋势 · 审核结构 · 形态与平台分布 · AI 评分分布', render: renderInsightsPage },
    feed: { title: '实时动态', desc: '投稿池全量流水 · 分页浏览 · 状态筛选', render: renderFeedPage },
    about: { title: '关于', desc: '数据来源 · 隐私声明 · 风险提示', render: renderAboutPage }
  };

  function currentRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    var qIdx = h.indexOf('?');
    openId = '';
    if (qIdx >= 0) {
      var q = h.slice(qIdx + 1);
      h = h.slice(0, qIdx);
      var m = q.match(/(?:^|&)open=([^&]+)/);
      if (m) openId = decodeURIComponent(m[1]);
      /* 作品库分页深链：page / per */
      if (h === 'works') {
        var mp = q.match(/(?:^|&)page=(\d+)/);
        var mpr = q.match(/(?:^|&)per=(\d+)/);
        if (mp) worksPage = Math.max(1, parseInt(mp[1], 10) || 1);
        if (mpr) worksPerPage = [24, 48, 96].indexOf(parseInt(mpr[1], 10)) >= 0 ? parseInt(mpr[1], 10) : 24;
      }
    }
    return PAGES[h] ? h : '';
  }

  function navigate() {
    route = currentRoute();
    var links = document.querySelectorAll('.rail .it');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('on', links[i].getAttribute('data-route') === route);
    }
    if (ratingsTimer) { clearInterval(ratingsTimer); ratingsTimer = null; }
    renderPage();
    if (openId) setTimeout(function () { openModal(openId); }, 80);
    if (route === 'ratings') {
      ratingsTimer = setInterval(function () {
        if (currentRoute() === 'ratings') { renderRatingsMeta(); renderRatingsList(); }
      }, 3000);
    }
  }

  function renderPage() {
    if (!snapshot) { $('page').innerHTML = '<div class="empty">数据加载中…</div>'; return; }
    PAGES[route].render();
    updateAiBadge();
  }

  /* 快照刷新时只更新动态区域，保留筛选输入与滚动 */
  function refreshDynamic() {
    renderSync();
    if (route === '') { renderStats(); renderCharts(); renderAiPanel(); renderBoard(); renderWall(); renderTicker(); }
    else if (route === 'works') { fetchWorksPage(true); }
    else if (route === 'ratings') { renderRatingsMeta(); renderRatingsList(); }
    else if (route === 'insights') { renderCharts(); renderBreakdown(); renderHistogram(); renderPopularity(); }
    else if (route === 'feed') { fetchFeedPage(); }
    updateAiBadge();
  }

  // ------------------------------------------------------------ 同步状态
  function renderSync() {
    var p = (snapshot && snapshot.poller) || {};
    var phase = currentPhase((snapshot && snapshot.activity && snapshot.activity.phases) || [], Date.now());
    var dot = document.querySelector('.band .dot');
    if (dot) dot.classList.remove('err');
    if (p.consecutiveErrors && p.consecutiveErrors > 0) {
      if (dot) dot.classList.add('err');
      syncSuffix = '同步异常 · 保留最后快照';
    } else {
      syncSuffix = (phase.name || '') + ' · 快轮 ' + fmtNum(p.fastCount) + ' / 深扫 ' + fmtNum(p.deepCount);
    }
    renderClock();
  }

  // ============================================================ 页面：总览
  function renderOverview() {
    $('page').innerHTML =
      '<div class="kpis" id="kpis"></div>' +
      '<div class="row">' +
        '<div class="panel grow" style="flex:1.6">' +
          '<div class="panel-h"><h2>AI 评审结果榜</h2><div class="rule"></div><span class="meta">按官方细则：创意35 / 完成度40 / 体验25，点击行查看评审依据</span></div>' +
          '<div class="board-wrap"><table class="board" id="board"></table></div>' +
        '</div>' +
        '<div class="panel grow">' +
          '<div class="panel-h"><h2>最新上架</h2><div class="rule"></div><span class="meta">作品墙实时</span></div>' +
          '<div class="panel-b"><div class="wall" id="wall"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-h"><h2>AI 评审团</h2><div class="rule"></div><span class="meta" id="aiMeta"></span></div>' +
        '<div id="aiPanel"></div>' +
      '</div>' +
      '<div class="ticker">' +
        '<div class="lb">实时流水</div>' +
        '<div class="track" id="ticker"></div>' +
      '</div>';
    renderStats();
    renderBoard();
    renderWall();
    renderAiPanel();
    renderTicker();
  }

  /* 签名跳过：数据没变就不重建 DOM（30s 轮询/2s 徽标刷新时不闪烁、不重排） */
  var sigStats = '';
  function renderStats() {
    var s = (snapshot && snapshot.stats) || {};
    var el = $('kpis');
    if (!el) return;
    var totalVotes = 0;
    Object.keys(interactions.votes).forEach(function (k) { totalVotes += interactions.votes[k]; });
    var st = Analysis.getStats();
    var sig = [s.wallTotal, s.newToday, s.poolTotal, s.poolPending, st.cachedCount, totalVotes, s.deltaPool60s].join(',');
    if (sig === sigStats) return;
    sigStats = sig;
    var defs = [
      { k: '已上架作品', v: fmtNum(s.wallTotal), s: '网页 ' + fmtNum(s.webApps) + ' / 小程序 ' + fmtNum(s.miniApps) },
      { k: '今日投稿', v: '+' + fmtNum(s.newToday), s: '北京时间 · 当日投稿池新增', hot: true },
      { k: '投稿总量', v: fmtNum(s.poolTotal), s: '已通过 ' + fmtNum(s.poolApproved) + ' / 已驳回 ' + fmtNum(s.poolRejected) },
      { k: '待审核', v: fmtNum(s.poolPending), s: '较上次 +' + (s.deltaPool60s > 0 ? s.deltaPool60s : 0) + ' 条' },
      { k: 'AI 已评审', v: fmtNum(st.cachedCount), s: '预热最新 ' + warmEnd + ' 件 · 点击作品详情可触发' },
      { k: '社区人气', v: fmtNum(totalVotes), s: '访客投票累计 · 可给自己喜欢的作品投票' }
    ];
    el.innerHTML = defs.map(function (d) {
      return '<div class="kpi"><span class="k">' + d.k + '</span>' +
        '<span class="v num' + (d.hot ? ' hot' : '') + '">' + d.v + '</span>' +
        '<span class="s">' + d.s + '</span></div>';
    }).join('');
  }

  var sigBoard = '';
  function renderBoard() {
    var el = $('board');
    if (!el) return;
    var list = analyzedWorks().slice(0, 10);
    if (!list.length) {
      if (sigBoard !== 'empty') {
        el.innerHTML = '<tr><td style="padding:18px 12px;color:var(--muted);font-size:14px">AI 评审准备中，首批分析完成后这里会出现结果榜…</td></tr>';
        sigBoard = 'empty';
      }
      return;
    }
    var sig = list.map(function (w) {
      var p = Analysis.getCached(Analysis.workKey(w));
      return w.id + ':' + p.total;
    }).join(',');
    if (sig === sigBoard) return;
    sigBoard = sig;
    el.innerHTML = list.map(function (w, i) {
      var p = Analysis.getCached(Analysis.workKey(w));
      return '<tr data-open="' + esc(w.id) + '">' +
        '<td class="rk' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</td>' +
        '<td><div class="nm">' + esc(w.name) + '<span class="no">#' + (w.cardNo || '') + '</span></div>' +
        '<div class="sub">@' + esc(w.author) + ' · ' + esc(w.form) + '</div></td>' +
        '<td class="sub">' + p.scores.creativity.score + ' / ' + p.scores.completeness.score + ' / ' + p.scores.experience.score + '</td>' +
        '<td class="pop" data-pop="' + esc(Analysis.workKey(w)) + '">' + popCellHtml(Analysis.workKey(w)) + '</td>' +
        '<td class="sc num">' + p.total + '<small> /100</small></td></tr>';
    }).join('');
  }

  var sigWall = '';
  function renderWall() {
    var el = $('wall');
    if (!el) return;
    var list = (snapshot.works || []).slice().sort(function (a, b) { return b.cardNo - a.cardNo; }).slice(0, 6);
    var sig = list.map(function (w) {
      var p = Analysis.getCached(Analysis.workKey(w));
      return w.id + ':' + (p ? p.total : '-');
    }).join(',');
    if (sig === sigWall) return;
    sigWall = sig;
    el.innerHTML = list.map(function (w, i) {
      var p = Analysis.getCached(Analysis.workKey(w));
      var shot = w.shots && w.shots[0] && w.shots[0].url;
      return '<div class="wcard" data-open="' + esc(w.id) + '">' +
        '<div class="shot"' + (shot ? ' style="background-image:url(\'' + esc(shot) + '\')"' : '') + '>' +
        (shot ? '<img src="' + esc(shot) + '" alt="" loading="lazy">' : '') +
        '<span class="no">#' + (w.cardNo || '') + '</span>' +
        (i < 2 ? '<span class="new">NEW</span>' : '') +
        (p ? '<span class="ai">' + p.total + '</span>' : '') +
        '</div>' +
        '<div class="info"><div class="nm">' + esc(w.name) + '</div>' +
        '<div class="au">' + esc(w.author) + ' / ' + esc(w.form) + '</div></div></div>';
    }).join('');
  }

  /* 流水 ticker：CSS 无缝滚动（一份内容重复两遍），数据变化才重建 */
  var sigTicker = '';
  function renderTicker() {
    var el = $('ticker');
    if (!el) return;
    var recent = snapshot.recentSubmissions || [];
    if (!recent.length) {
      if (sigTicker !== 'empty') {
        el.innerHTML = '<div style="padding:0 16px;font-size:14px;color:var(--muted)">投稿流水采集中…</div>';
        sigTicker = 'empty';
      }
      return;
    }
    var sig = recent.map(function (r) { return (r.id || r.name) + ':' + r.status; }).join(',');
    if (sig === sigTicker) return;
    sigTicker = sig;
    var item = function (r) {
      var cls = r.status === '待审核' ? 'p' : (r.status === '已通过' ? 'a' : 'r');
      return '<div class="tick-item"><span class="nm">' + esc(r.name) + '</span>' +
        '<span class="au">@' + esc(r.author) + '</span>' +
        '<span class="st ' + cls + '">' + esc(r.status) + '</span>' +
        '<span class="t">' + esc((r.submittedAt || '').slice(11)) + '</span></div>';
    };
    el.innerHTML = '<div class="tick-rail">' + recent.map(item).join('') + recent.map(item).join('') + '</div>';
  }

  var sigAiPanel = '';
  function renderAiPanel() {
    var el = $('aiPanel');
    if (!el) return;
    var metaEl = $('aiMeta');
    var works = snapshot.works || [];
    var st = Analysis.getStats();
    if (metaEl) metaEl.textContent = (window.__aiModel ? '模型 ' + window.__aiModel : '模型加载中') + ' · 每件约 30-40 秒';
    var sig = [aiReady ? 1 : 0, aiFault || '', window.__aiModel || '', st.cachedCount, st.queued, works.length].join(',');
    if (sig === sigAiPanel) return;
    sigAiPanel = sig;
    if (!aiReady) {
      el.innerHTML = '<div class="ai-note">' + (aiFault ? esc(aiFault) + '，AI 功能暂不可用，数据看板不受影响。' : 'AI 模块加载中…') + '</div>';
      return;
    }
    var analyzed = works.filter(function (w) { return Analysis.getCached(Analysis.workKey(w)); });
    var pct = works.length ? Math.min(100, (st.cachedCount / works.length) * 100) : 0;
    var html = '<div class="ai-progress"><span>已分析 <b>' + st.cachedCount + '</b> / ' + fmtNum(works.length) + ' 件</span>' +
      '<div class="track"><div class="fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      (st.queued ? '<span>队列 ' + st.queued + ' · 分析中</span>' : '<span>空闲</span>') +
      '<button class="btn sm" id="warmMoreBtn">分析下一批 +30</button></div>';
    if (analyzed.length) {
      var sum = analyzed.reduce(function (acc, w) { return acc + Analysis.getCached(Analysis.workKey(w)).total; }, 0);
      var avg = Math.round(sum / analyzed.length);
      var top3 = analyzed.slice().sort(function (a, b) {
        return Analysis.getCached(Analysis.workKey(b)).total - Analysis.getCached(Analysis.workKey(a)).total;
      }).slice(0, 3);
      html += '<div class="ai-note" style="padding-top:0">已分析作品平均分 <b>' + avg + '</b> / 100，前三名：</div><ul class="d-sec" style="border-top:0;padding-top:0;list-style:none">';
      top3.forEach(function (w, i) {
        var p = Analysis.getCached(Analysis.workKey(w));
        html += '<li><b>' + esc(w.name) + '</b> · ' + p.total + ' 分 · ' + esc(p.summary) + '</li>';
      });
      html += '</ul>';
    } else {
      html += '<div class="ai-note" style="padding-top:0">按官方评分细则（创意 35 + 完成度 40 + 体验 25）逐件生成模拟评分、技术栈推断与痛点分析。打开任意作品详情即可触发，最新 ' + warmEnd + ' 件正在后台预热。</div>';
    }
    el.innerHTML = html;
    var btn = $('warmMoreBtn');
    if (btn) btn.addEventListener('click', function () { warmMore(30); renderAiPanel(); toast('已加入队列，将逐件分析'); });
  }

  // ============================================================ 页面：作品库
  function renderWorksPage() {
    worksRowMap = {};   /* 新 tbody，旧行引用全部作废 */
    sigPager = '';
    $('page').innerHTML =
      '<div class="panel" style="height:calc(100vh - 150px);min-height:420px">' +
      '<div class="panel-h"><h2>作品库</h2><div class="rule"></div><span class="meta" id="worksCountNote">–</span></div>' +
      '<div class="filters">' +
      '<input type="search" id="fKeyword" class="input" placeholder="搜索作品名 / 作者 / 亮点 / 标签…" value="' + esc(filters.keyword) + '">' +
      '<select id="fForm" class="input"><option value="">全部形态</option><option value="网页应用"' + (filters.form === '网页应用' ? ' selected' : '') + '>网页应用</option><option value="小程序应用"' + (filters.form === '小程序应用' ? ' selected' : '') + '>小程序应用</option></select>' +
      '<select id="fPlatform" class="input"><option value="">全部平台</option></select>' +
      '<select id="fSort" class="input">' +
      '<option value="cardDesc"' + (filters.sort === 'cardDesc' ? ' selected' : '') + '>卡片号 ↓ 最新</option>' +
      '<option value="cardAsc"' + (filters.sort === 'cardAsc' ? ' selected' : '') + '>卡片号 ↑</option>' +
      '<option value="aiDesc"' + (filters.sort === 'aiDesc' ? ' selected' : '') + '>AI 评分 ↓</option>' +
      '<option value="popDesc"' + (filters.sort === 'popDesc' ? ' selected' : '') + '>社区人气 ↓</option>' +
      '<option value="name"' + (filters.sort === 'name' ? ' selected' : '') + '>名称 A→Z</option>' +
      '</select>' +
      '</div>' +
      '<div class="table-wrap"><table class="works"><colgroup>' +
      '<col style="width:46px"><col style="width:84px"><col><col style="width:120px"><col style="width:86px"><col style="width:110px"><col style="width:76px"><col style="width:96px"><col style="width:72px">' +
      '</colgroup><thead><tr>' +
      '<th class="c-no">#</th><th class="c-shot">截图</th><th>作品</th><th>作者</th><th class="c-form">形态</th><th class="c-plat">平台</th><th class="c-ai">AI 评分</th><th class="c-pop">人气</th><th class="c-link"></th>' +
      '</tr></thead><tbody id="worksBody"></tbody></table>' +
      '<div class="empty" id="worksEmpty" hidden>没有符合条件的作品</div></div>' +
      '<div class="table-foot"><span id="worksShown">–</span><div class="pager" id="worksPager"></div></div>' +
      '</div>';
    buildPlatformOptions();
    bindWorksFilters();
    fetchWorksPage();
  }

  function buildPlatformOptions() {
    var sel = $('fPlatform');
    if (!sel || sel.options.length > 1) return;
    var plats = {};
    (snapshot.works || []).forEach(function (w) { if (w.platform) plats[w.platform] = 1; });
    Object.keys(plats).sort().forEach(function (p) {
      var o = document.createElement('option');
      o.value = p; o.textContent = p;
      sel.appendChild(o);
    });
    if (filters.platform) sel.value = filters.platform;
  }

  function bindWorksFilters() {
    var kw = $('fKeyword'), timer = null;
    kw.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        filters.keyword = kw.value;
        worksPage = 1;
        fetchWorksPage();
        syncWorksUrl();
      }, 200);
    });
    $('fForm').addEventListener('change', function () { filters.form = this.value; worksPage = 1; fetchWorksPage(); syncWorksUrl(); });
    $('fPlatform').addEventListener('change', function () { filters.platform = this.value; worksPage = 1; fetchWorksPage(); syncWorksUrl(); });
    $('fSort').addEventListener('change', function () { filters.sort = this.value; worksPage = 1; fetchWorksPage(); syncWorksUrl(); });
    bindPager();
  }

  /* 分页参数同步进 hash（replaceState 不触发 hashchange，不打断当前页面） */
  function syncWorksUrl() {
    var pages = Math.max(1, Math.ceil(worksTotal / worksPerPage));
    var q = 'page=' + Math.min(worksPage, pages) + '&per=' + worksPerPage;
    history.replaceState(null, '', '#/works?' + q);
  }

  /* 翻页：越界钳制；页码变化只重拉当前页 */
  function gotoWorksPage(p) {
    var pages = Math.max(1, Math.ceil(worksTotal / worksPerPage));
    var next = Math.min(pages, Math.max(1, p));
    if (next === worksPage) return;
    worksPage = next;
    fetchWorksPage();
    syncWorksUrl();
  }

  /* 作品库列表：服务端分页 + DOM diff（只拉当前页；复用行节点，刷新/分析完成不整表重建） */
  var worksRowMap = {};   /* workId -> tr 元素 */

  /* 拉取当前页并渲染（token 防止快速翻页时旧响应覆盖新页；silent=静默刷新不显示加载态） */
  function fetchWorksPage(silent) {
    var token = ++worksReqToken;
    var foot = $('worksShown');
    if (foot && !silent) foot.textContent = '加载中…';
    var base = {
      page: worksPage, per: worksPerPage,
      kw: filters.keyword.trim(), form: filters.form, platform: filters.platform,
      sort: filters.sort
    };
    var chain;
    if (filters.sort === 'aiDesc' || filters.sort === 'popDesc') {
      /* AI 评分/人气排序：先拿全量 ID 列表（轻量），客户端算序后按 ID 取当前页 */
      chain = apiGet('/api/works', Object.assign({}, base, { only: 'ids' }))
        .then(function (idRes) {
          return orderWorksClient((idRes && idRes.ids) || [], filters.sort).then(function (ordered) {
            worksTotal = ordered.length;
            var start = (worksPage - 1) * worksPerPage;
            var pageIds = ordered.slice(start, start + worksPerPage);
            return pageIds.length ? apiGet('/api/works', { ids: pageIds.join(',') }) : { works: [] };
          });
        })
        .then(function (res) { return (res && res.works) || []; });
    } else {
      chain = apiGet('/api/works', base).then(function (res) {
        worksTotal = (res && res.total) || 0;
        return (res && res.works) || [];
      });
    }
    return chain.then(function (works) {
      if (token !== worksReqToken) return;   /* 过期响应丢弃 */
      renderWorksRows(works);
      renderPager(worksTotal);
      updateWorksFoot();
      syncWorksUrl();
    }).catch(function (e) {
      if (token !== worksReqToken) return;
      if (foot) foot.textContent = '加载失败：' + (e && e.message ? e.message : '网络错误');
      console.warn('作品页加载失败', e);
    });
  }

  /* 客户端排序：AI 评分（一次库查询，60s 缓存）/ 社区人气（本地投票数据） */
  function orderWorksClient(pairs, sort) {
    var keyFn;
    var ready = sort === 'popDesc'
      ? Promise.resolve()
      : getAiScores().then(function (map) {
        keyFn = function (x) { return map[String(x.cardNo)] != null ? map[String(x.cardNo)] : -1; };
      });
    if (sort === 'popDesc') keyFn = function (x) { return voteCount(String(x.cardNo)); };
    return ready.then(function () {
      return pairs.slice().sort(function (a, b) {
        var d = keyFn(b) - keyFn(a);
        return d !== 0 ? d : b.cardNo - a.cardNo;   /* 同分按卡片号新的在前 */
      }).map(function (x) { return x.id; });
    });
  }

  /* 全量 AI 评分映射（cardNo -> total），作品库 AI 排序用 */
  function getAiScores() {
    if (aiScoresCache.map && Date.now() - aiScoresCache.at < 60000) {
      return Promise.resolve(aiScoresCache.map);
    }
    return Cloud.dbSelectAllAnalysisScores().then(function (map) {
      aiScoresCache = { at: Date.now(), map: map };
      dbScores = map;   /* 同步供评分单元格兜底显示 */
      return map;
    }).catch(function (e) {
      console.warn('AI 评分映射拉取失败，退回卡片号排序', e);
      aiScoresCache = { at: Date.now() - 50000, map: null }; /* 10s 后重试，不长期缓存失败 */
      return {};
    });
  }

  function renderWorksRows(works) {
    var tbody = $('worksBody');
    if (!tbody) return;
    var nextMap = {};
    var frag = document.createDocumentFragment();
    works.forEach(function (w) {
      var tr = worksRowMap[w.id];
      if (tr && tr.parentNode === tbody) updateWorkRow(tr, w);
      else tr = htmlToElement(workRow(w));
      nextMap[w.id] = tr;
      frag.appendChild(tr);
    });
    Object.keys(worksRowMap).forEach(function (k) {
      if (!nextMap[k] && worksRowMap[k].parentNode) worksRowMap[k].parentNode.removeChild(worksRowMap[k]);
    });
    tbody.appendChild(frag);   /* 复用行随 frag 落到本页顺序，一次重排 */
    worksRowMap = nextMap;
    var empty = $('worksEmpty');
    if (empty) empty.hidden = worksTotal > 0;
  }

  function updateWorksFoot() {
    var el = $('worksShown');
    if (!el) return;
    if (!worksTotal) { el.textContent = '没有符合条件的作品'; return; }
    var start = (worksPage - 1) * worksPerPage;
    el.textContent = '显示 ' + fmtNum(start + 1) + '–' + fmtNum(Math.min(start + worksPerPage, worksTotal)) +
      ' / 共 ' + fmtNum(worksTotal) + ' 件';
    var note = $('worksCountNote');
    if (note) note.textContent = '作品墙共 ' + fmtNum((snapshot.works || []).length) + ' 件 · 当前筛选 ' + fmtNum(worksTotal) + ' 件';
  }

  function aiCell(w) {
    var key = Analysis.workKey(w);
    var p = Analysis.getCached(key);
    if (p) return '<span class="ai-score">' + p.total + '<small> /100</small></span>';
    /* 内存没有但数据库有（往期会话分析的）：用排序时拉取的评分兜底显示 */
    if (dbScores[key] != null) return '<span class="ai-score">' + dbScores[key] + '<small> /100</small></span>';
    return '<span class="ai-score pending">待分析</span>';
  }

  function htmlToElement(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content.firstElementChild;
  }

  /* 行内动态单元格更新（AI 评分 / 人气），供 DOM diff 复用行时调用 */
  function updateWorkRow(tr, w) {
    var key = Analysis.workKey(w);
    var aiTd = tr.querySelector('.c-ai');
    if (aiTd) aiTd.innerHTML = aiCell(w);
    var popTd = tr.querySelector('.c-pop');
    if (popTd) {
      popTd.setAttribute('data-pop', key);
      popTd.innerHTML = popCellHtml(key);
    }
  }

  function workRow(w) {
    var key = Analysis.workKey(w);
    var shot = w.shot || (w.shots && w.shots[0] && w.shots[0].url);
    var formChip = w.form === '小程序应用' ? '<span class="chip mini">小程序</span>' : '<span class="chip web">网页</span>';
    var link = w.link && w.link.link
      ? '<a class="link-btn" href="' + esc(w.link.link) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">体验</a>'
      : '<span class="link-btn disabled">暂无</span>';
    return '<tr data-open="' + esc(w.id) + '">' +
      '<td class="c-no no">' + (w.cardNo || '–') + '</td>' +
      '<td>' + (shot
        ? '<img class="shot" loading="lazy" decoding="async" src="' + esc(shot) + '" alt="">'
        : '<div class="shot-ph">无图</div>') + '</td>' +
      '<td><div class="w-name">' + esc(w.name) + '</div>' +
      '<div class="w-hl">' + esc(w.highlight) + '</div></td>' +
      '<td class="c-au"><span class="w-au">' + esc(w.author) + '</span></td>' +
      '<td class="c-form">' + formChip + '</td>' +
      '<td class="c-plat">' + (w.platform ? '<span class="chip">' + esc(w.platform) + '</span>' : '<span style="color:var(--muted)">–</span>') + '</td>' +
      '<td class="c-ai">' + aiCell(w) + '</td>' +
      '<td class="c-pop" data-pop="' + esc(key) + '">' + popCellHtml(key) + '</td>' +
      '<td class="c-link">' + link + '</td>' +
      '</tr>';
  }

  /* 页码器：首页/上一页/当前±1/末页 + 每页条数 */
  var sigPager = '';
  function renderPager(total) {
    var el = $('worksPager');
    if (!el) return;
    var pages = Math.max(1, Math.ceil(total / worksPerPage));
    var p = Math.min(worksPage, pages);
    var sig = [total, pages, p, worksPerPage].join(',');
    if (sig === sigPager) return;
    sigPager = sig;
    var html = '<button class="pg-btn" data-pg="1"' + (p <= 1 ? ' disabled' : '') + '>首页</button>' +
      '<button class="pg-btn" data-pg="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + '>上一页</button>';
    var nums = [];
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - p) <= 1) nums.push(i);
    }
    var last = 0;
    nums.forEach(function (n) {
      if (n - last > 1) html += '<span class="pg-ell">…</span>';
      html += '<button class="pg-btn' + (n === p ? ' on' : '') + '" data-pg="' + n + '">' + n + '</button>';
      last = n;
    });
    html += '<button class="pg-btn" data-pg="' + (p + 1) + '"' + (p >= pages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="pg-btn" data-pg="' + pages + '"' + (p >= pages ? ' disabled' : '') + '>末页 ' + pages + '</button>' +
      '<span class="pg-per">每页<select id="worksPerPage" aria-label="每页条数">' +
      [24, 48, 96].map(function (n) { return '<option value="' + n + '"' + (worksPerPage === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select>条</span>';
    el.innerHTML = html;
  }

  /* 分页器事件委托（容器不变，只绑一次） */
  function bindPager() {
    var el = $('worksPager');
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.pg-btn[data-pg]');
      if (b && !b.disabled) gotoWorksPage(parseInt(b.getAttribute('data-pg'), 10));
    });
    el.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'worksPerPage') {
        worksPerPage = parseInt(e.target.value, 10) || 24;
        worksPage = 1;
        fetchWorksPage();
        syncWorksUrl();
      }
    });
  }

  // ============================================================ 页面：AI 评审
  function renderRatingsPage() {
    $('page').innerHTML =
      '<div class="row" style="height:calc(100vh - 150px);min-height:480px">' +
        '<div class="panel grow" style="flex:1">' +
          '<div class="panel-h"><h2>评审排行</h2><div class="rule"></div><span class="meta" id="ratingsCount"></span><span class="meta" id="modelTag" style="margin-left:10px"></span></div>' +
          '<div class="board-wrap"><table class="board" id="boardFull"></table></div>' +
        '</div>' +
        '<div class="panel detail grow" style="flex:1.15"><div class="detail-scroll" id="ratingsDetail"></div></div>' +
      '</div>';
    renderRatingsMeta();
    renderRatingsList();
  }

  function renderRatingsMeta() {
    var el = $('ratingsCount');
    if (!el) return;
    var works = snapshot.works || [];
    var st = Analysis.getStats();
    var list = analyzedWorks();
    var avg = list.length
      ? (list.reduce(function (s, w) { return s + Analysis.getCached(Analysis.workKey(w)).total; }, 0) / list.length).toFixed(1)
      : '–';
    el.innerHTML = '已评审 <b style="color:var(--ink)">' + st.cachedCount + '</b> / ' + fmtNum(works.length) +
      ' · 均值 ' + avg + ' 分' + (st.queued ? ' · 队列 ' + st.queued : '');
    if (Cloud.getModelStatus) {
      Cloud.getModelStatus().then(function (ms) {
        var tag = $('modelTag');
        if (!tag) return;
        if (ms.pausedUntil) {
          tag.textContent = '免费模型暂停中 · ' + fmtTime(ms.pausedUntil) + ' 恢复';
          tag.style.color = 'var(--warn)';
        } else {
          tag.textContent = '模型 ' + (ms.model || '–') + (ms.night ? ' · 夜间 hy4 优先' : '');
          tag.style.color = '';
        }
      }).catch(function () {});
    }
    var btn = $('warmMoreBtn');
    if (btn) btn.addEventListener('click', function () { warmMore(30); toast('已加入队列，将逐件分析'); });
  }

  function analyzedWorks() {
    var works = (snapshot.works || []).filter(function (w) { return Analysis.getCached(Analysis.workKey(w)); });
    works.sort(function (a, b) {
      return Analysis.getCached(Analysis.workKey(b)).total - Analysis.getCached(Analysis.workKey(a)).total;
    });
    return works;
  }

  var sigRatings = '';
  function renderRatingsList() {
    var el = $('boardFull');
    if (!el) return;
    var list = analyzedWorks().slice(0, 120);
    if (!list.length) {
      if (sigRatings !== 'empty') {
        el.innerHTML = '<tr><td style="padding:18px 12px;color:var(--muted);font-size:14px">' +
          (aiReady ? '还没有已完成分析的作品。打开任意作品详情即可触发分析。' : 'AI 模块加载中…') + '</td></tr>';
        $('ratingsDetail').innerHTML = '<div class="empty">选择左侧榜单中的作品查看完整评审依据</div>';
        sigRatings = 'empty';
      }
      return;
    }
    var selKey = ratingsSel && list.some(function (w) { return Analysis.workKey(w) === ratingsSel; }) ? ratingsSel : Analysis.workKey(list[0]);
    ratingsSel = selKey;
    /* 签名：榜单 id+分数+选中行；3s 定时器命中即跳过，用户点选/新分析完成才重建 */
    var sig = selKey + '|' + list.map(function (w) {
      var p = Analysis.getCached(Analysis.workKey(w));
      return w.id + ':' + p.total;
    }).join(',');
    if (sig === sigRatings) return;
    sigRatings = sig;
    el.innerHTML = list.map(function (w, i) {
      var p = Analysis.getCached(Analysis.workKey(w));
      var key = Analysis.workKey(w);
      return '<tr data-open="' + esc(w.id) + '"' + (key === selKey ? ' class="sel"' : '') + '>' +
        '<td class="rk' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</td>' +
        '<td><div class="nm">' + esc(w.name) + '<span class="no">#' + (w.cardNo || '') + '</span></div>' +
        '<div class="sub">' + p.scores.creativity.score + ' / ' + p.scores.completeness.score + ' / ' + p.scores.experience.score + '</div></td>' +
        '<td class="pop" data-pop="' + esc(key) + '">' + popCellHtml(key) + '</td>' +
        '<td class="sc num">' + p.total + '<small> /100</small></td></tr>';
    }).join('');
    var selWork = list.filter(function (w) { return Analysis.workKey(w) === selKey; })[0];
    if (selWork) renderDetail(selWork);
  }

  function renderDetail(w) {
    var el = $('ratingsDetail');
    if (!el) return;
    var p = Analysis.getCached(Analysis.workKey(w));
    if (!p) { el.innerHTML = '<div class="empty">分析中…</div>'; return; }
    var bars = [
      { lb: '创意与场景', v: p.scores.creativity.score, max: 35, reason: p.scores.creativity.reason },
      { lb: '作品完成度', v: p.scores.completeness.score, max: 40, reason: p.scores.completeness.reason },
      { lb: '使用体验', v: p.scores.experience.score, max: 25, reason: p.scores.experience.reason }
    ];
    el.innerHTML =
      '<div class="d-head"><div class="no">#' + (w.cardNo || '') + ' / ' + esc(w.form) + '</div>' +
      '<h1>' + esc(w.name) + '</h1>' +
      '<div class="au">作者 <b>' + esc(w.author) + '</b></div></div>' +
      '<div class="d-total"><span class="v num">' + p.total + '<small> /100</small></span>' +
      '<span class="tag">创意35 / 完成度40 / 体验25 · ' + esc(window.__aiModel || 'AI') + '</span></div>' +
      '<div class="d-sec" style="border-top:0"><div class="bars">' + bars.map(function (b) {
        var pct = Math.round(b.v / b.max * 100);
        return '<div class="bar-row"><span class="lb">' + b.lb + '</span>' +
          '<div class="track"><div class="fill' + (pct >= 75 ? ' sig' : '') + '" style="width:' + pct + '%"></div></div>' +
          '<span class="val num">' + b.v + '<small>/' + b.max + '</small></span></div>';
      }).join('') + '</div></div>' +
      '<div class="d-sec"><h3>一句话总结</h3><p>' + esc(p.summary) + '</p></div>' +
      '<div class="d-sec"><h3>评审依据</h3><div class="reasons">' + bars.map(function (b) {
        return '<div class="reason"><b>' + b.lb + ' ' + b.v + '/' + b.max + '</b> · ' + esc(b.reason) + '</div>';
      }).join('') + '</div></div>' +
      '<div class="d-sec"><h3>亮点</h3><ul>' + (p.highlights.length
        ? p.highlights.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('')
        : '<li style="color:var(--muted)">AI 未提炼出明确亮点</li>') + '</ul></div>' +
      '<div class="d-sec"><h3>痛点与解法</h3><dl class="kv">' +
      '<dt>痛点</dt><dd>' + (esc(p.pain_point) || '–') + '</dd>' +
      '<dt>解法</dt><dd>' + (esc(p.solution) || '–') + '</dd></dl></div>' +
      '<div class="d-sec"><h3>推断技术栈</h3><div class="chips">' + (p.tech_stack.length
        ? p.tech_stack.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('')
        : '<span>未能推断</span>') + '</div></div>' +
      '<div class="d-sec" style="border-bottom:0"><div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn sm" data-act="vote" data-id="' + esc(Analysis.workKey(w)) + '">' + ICON_VOTE + '<span class="n">' + voteCount(Analysis.workKey(w)) + '</span></button>' +
      '<button class="btn sm" data-act="fav" data-id="' + esc(Analysis.workKey(w)) + '">' + ICON_FAV + '<span class="n">' + favCount(Analysis.workKey(w)) + '</span></button>' +
      '<button class="btn sm" data-open="' + esc(w.id) + '">查看作品详情 →</button>' +
      '</div></div>';
  }

  // ============================================================ 页面：数据洞察
  function renderInsightsPage() {
    $('page').innerHTML =
      '<div class="grid-2">' +
        '<div class="panel"><div class="panel-h"><h2>每日投稿量</h2><div class="rule"></div><span class="meta">投稿池按提交日期统计（北京时间）</span></div><div class="chart-box" id="dailyChart"></div></div>' +
        '<div class="panel"><div class="panel-h"><h2>作品墙上架趋势</h2><div class="rule"></div><span class="meta">本站上线后持续采样</span></div><div class="chart-box" id="trendChart"></div></div>' +
      '</div>' +
      '<div class="grid-2" style="margin-top:12px">' +
        '<div class="panel"><div class="panel-h"><h2>AI 评分分布</h2><div class="rule"></div><span class="meta" id="histMeta"></span></div><div class="chart-box" id="histChart"></div></div>' +
        '<div class="panel"><div class="panel-h"><h2>社区人气 TOP</h2><div class="rule"></div><span class="meta">访客投票实时累计</span></div><div class="panel-b" id="popList"></div></div>' +
      '</div>' +
      '<div class="grid-2" style="margin-top:12px">' +
        '<div class="panel"><div class="panel-h"><h2>投稿池审核结构</h2><div class="rule"></div><span class="meta" id="poolTotalNote">–</span></div><div class="panel-b"><div class="bars" id="statusBars"></div><div class="chart-note" id="poolCountNote"></div></div></div>' +
        '<div class="panel"><div class="panel-h"><h2>社媒平台分布</h2><div class="rule"></div><span class="meta">投稿时选择的分享平台</span></div><div class="panel-b"><div class="bars" id="platformList"></div></div></div>' +
      '</div>' +
      '<div class="grid-2" style="margin-top:12px">' +
        '<div class="panel"><div class="panel-h"><h2>作品形态</h2><div class="rule"></div><span class="meta">作品墙已上架</span></div><div class="panel-b"><div class="bars" id="formBars"></div></div></div>' +
        '<div class="panel"><div class="panel-h"><h2>热门标签</h2><div class="rule"></div><span class="meta">作品墙标签频次 TOP 12</span></div><div class="panel-b"><div class="bars" id="tagList"></div></div></div>' +
      '</div>';
    renderCharts();
    renderBreakdown();
    renderHistogram();
    renderPopularity();
  }

  var sigCharts = '';
  function renderCharts() {
    var pb = snapshot.poolBreakdown;
    var daily = (pb && pb.dailyTrend) || [];
    var hist = snapshot.history || [];
    var sig = daily.map(function (d) { return d.date + d.count; }).join(',') + '|' +
      hist.map(function (h) { return h.wall; }).join(',');
    if (sig === sigCharts) return;
    sigCharts = sig;
    if (daily.length) {
      barChart($('dailyChart'), daily.map(function (d) { return { label: d.date, value: d.count }; }));
    } else if ($('dailyChart')) {
      $('dailyChart').innerHTML = '<div class="chart-empty">深度扫描进行中…</div>';
    }
    if ($('trendChart')) lineChart($('trendChart'), hist);
  }

  var sigBreakdown = '';
  function renderBreakdown() {
    var pb = snapshot.poolBreakdown;
    var works = snapshot.works || [];
    /* 标签频次只算一次，签名与渲染共用 */
    var tags = {};
    works.forEach(function (w) {
      if (!w.tags) return;
      String(w.tags).split(/[、,，/#\s]+/).forEach(function (t) {
        t = t.trim();
        if (t && t.length >= 2) tags[t] = (tags[t] || 0) + 1;
      });
    });
    var tagKey = Object.keys(tags).map(function (k) { return k + tags[k]; }).sort().join(',');
    /* 签名：审核结构 + 平台分布 + 作品数 + 标签频次（作品新增/变化即失效） */
    var sig = snapshotVersion + '|' + (pb ? [pb.total, JSON.stringify(pb.byStatus || {}), (pb.platforms || []).map(function (p) { return p.name + p.count; }).join(',')].join(',') : '') +
      '|' + works.length + '|' + tagKey;
    if (sig === sigBreakdown) return;
    sigBreakdown = sig;
    var sb = $('statusBars');
    if (sb) {
      if (pb && pb.byStatus) {
        var total = pb.total || 1;
        var defs = [
          { k: '待审核', v: pb.byStatus['待审核'] || 0, c: 'sig', note: '' },
          { k: '已通过', v: pb.byStatus['已通过'] || 0, c: 'ok', note: '' },
          { k: '已驳回', v: pb.byStatus['已驳回'] || 0, c: '', note: '' }
        ];
        sb.innerHTML = defs.map(function (d) {
          var pct = Math.round((d.v / total) * 1000) / 10;
          return '<div class="bar-row"><span class="lb">' + d.k + '</span>' +
            '<div class="track"><div class="fill ' + d.c + '" style="width:' + pct + '%"></div></div>' +
            '<span class="val num">' + fmtNum(d.v) + '</span></div>';
        }).join('');
        $('poolTotalNote').textContent = '投稿池总量 ' + fmtNum(pb.total) + ' · 深度扫描每 10 分钟';
        var wallN = works.length;
        var noteEl = $('poolCountNote');
        if (noteEl && wallN) {
          noteEl.textContent = '注：作品墙 ' + fmtNum(wallN) + ' 件为官方展示表，与投稿池已通过数口径可能存在差异';
        }
      } else {
        sb.innerHTML = '<div class="chart-empty">深度扫描进行中…</div>';
      }
    }
    var pl = $('platformList');
    if (pl) {
      if (pb && pb.platforms && pb.platforms.length) {
        var max = pb.platforms[0].count || 1;
        pl.innerHTML = pb.platforms.slice(0, 8).map(function (p) {
          return '<div class="bar-row"><span class="lb" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(p.name) + '</span>' +
            '<div class="track"><div class="fill" style="width:' + Math.round((p.count / max) * 100) + '%"></div></div>' +
            '<span class="val num">' + fmtNum(p.count) + '</span></div>';
        }).join('');
      } else {
        pl.innerHTML = '<div class="chart-empty">深度扫描进行中…</div>';
      }
    }
    var fb = $('formBars');
    if (fb) {
      var web = works.filter(function (w) { return w.form === '网页应用'; }).length;
      var mini = works.length - web;
      var rows = [
        { k: '网页应用', v: web, c: '' },
        { k: '小程序应用', v: mini, c: 'sig' }
      ];
      var maxV = Math.max(web, mini, 1);
      fb.innerHTML = rows.map(function (r) {
        return '<div class="bar-row"><span class="lb">' + r.k + '</span>' +
          '<div class="track"><div class="fill ' + r.c + '" style="width:' + Math.round((r.v / maxV) * 100) + '%"></div></div>' +
          '<span class="val num">' + fmtNum(r.v) + '</span></div>';
      }).join('');
    }
    var tl = $('tagList');
    if (tl) {
      var top = Object.keys(tags).map(function (k) { return { k: k, v: tags[k] }; })
        .sort(function (a, b) { return b.v - a.v; }).slice(0, 12);
      if (top.length) {
        var maxT = top[0].v;
        tl.innerHTML = top.map(function (t) {
          return '<div class="bar-row"><span class="lb" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#' + esc(t.k) + '</span>' +
            '<div class="track"><div class="fill" style="width:' + Math.round((t.v / maxT) * 100) + '%"></div></div>' +
            '<span class="val num">' + t.v + '</span></div>';
        }).join('');
      } else {
        tl.innerHTML = '<div class="chart-empty">暂无标签数据</div>';
      }
    }
  }

  function analyzedScores() {
    return (snapshot.works || []).map(function (w) { return Analysis.getCached(Analysis.workKey(w)); })
      .filter(Boolean).map(function (p) { return p.total; });
  }

  var sigHist = '';
  function renderHistogram() {
    var el = $('histChart');
    if (!el) return;
    var scores = analyzedScores();
    var sig = scores.slice().sort(function (a, b) { return a - b; }).join(',');
    if (sig === sigHist) return;
    sigHist = sig;
    if (scores.length) {
      var avg = (scores.reduce(function (a, b) { return a + b; }, 0) / scores.length).toFixed(1);
      $('histMeta').textContent = scores.length + ' 件已评审 · 均值 ' + avg + ' 分';
    } else {
      $('histMeta').textContent = '等待首批分析';
    }
    histogram(el, scores);
  }

  var sigPop = '';
  function renderPopularity() {
    var el = $('popList');
    if (!el) return;
    var works = snapshot.works || [];
    var scored = works.map(function (w) {
      return { w: w, key: Analysis.workKey(w), v: voteCount(Analysis.workKey(w)) };
    }).filter(function (x) { return x.v > 0; });
    scored.sort(function (a, b) { return b.v - a.v; });
    var sig = voteVersion + '|' + scored.slice(0, 8).map(function (x) { return x.key + x.v; }).join(',');
    if (sig === sigPop) return;
    sigPop = sig;
    if (!scored.length) {
      el.innerHTML = '<div class="chart-empty">还没有访客投票。打开作品详情，给你喜欢的作品投票，就会出现在这里。</div>';
      return;
    }
    var max = scored[0].v;
    el.innerHTML = '<div class="bars">' + scored.slice(0, 8).map(function (x, i) {
      return '<div class="bar-row" data-open="' + esc(x.w.id) + '" style="cursor:pointer">' +
        '<span class="lb" style="font-family:var(--font-disp);font-weight:600">' + (i + 1) + '</span>' +
        '<div class="track"><div class="fill' + (i === 0 ? ' sig' : '') + '" style="width:' + Math.round((x.v / max) * 100) + '%"></div></div>' +
        '<span class="val num">' + x.v + ' <small>票</small></span></div>' +
        '<div style="font-size:12px;color:var(--muted);margin:-6px 0 2px 98px;cursor:pointer" data-open="' + esc(x.w.id) + '">' + esc(x.w.name) + ' · @' + esc(x.w.author) + '</div>';
    }).join('') + '</div>';
  }

  // ============================================================ 页面：实时动态
  var feedFilter = '';      /* 动态页状态筛选：'' 全部 / 待审核 / 已通过 / 已驳回 */
  var feedPage = 1;         /* 当前页码 */
  var feedPerPage = 50;     /* 每页条数 */
  var feedReqSeq = 0;       /* 请求序号，防乱序覆盖 */
  var feedRowCache = {};    /* 当前页行缓存 id -> 行对象（点击详情用） */

  function renderFeedPage() {
    $('page').innerHTML =
      '<div class="panel">' +
      '<div class="panel-h"><h2>投稿流水</h2><div class="rule"></div>' +
      '<span class="feed-tabs" id="feedTabs">' +
        '<button class="feed-tab on" data-fst="">全部</button>' +
        '<button class="feed-tab" data-fst="待审核">待审核</button>' +
        '<button class="feed-tab" data-fst="已通过">已通过</button>' +
        '<button class="feed-tab" data-fst="已驳回">已驳回</button>' +
      '</span></div>' +
      '<ul class="stream" id="recentStream"></ul>' +
      '<div class="table-foot"><span id="feedShown">–</span><div class="pager" id="feedPager"></div></div></div>';
    feedPage = 1;
    fetchFeedPage();
  }

  function fetchFeedPage() {
    var seq = ++feedReqSeq;
    apiGet('/api/submissions', { page: feedPage, per: feedPerPage, status: feedFilter }).then(function (res) {
      if (seq !== feedReqSeq || route !== 'feed') return; /* 过期响应丢弃 */
      var pages = res.pages || 1;
      if (feedPage > pages) { feedPage = pages; fetchFeedPage(); return; }
      paintFeed(res);
    }).catch(function () {
      /* 服务暂不可用：退回快照里的最新流水 */
      var el = $('recentStream');
      if (el) el.innerHTML = '<li style="cursor:default;color:var(--muted)">投稿流水加载失败，稍后自动重试</li>';
    });
  }

  function paintFeed(res) {
    var el = $('recentStream');
    if (!el) return;
    var list = res.submissions || [];
    feedRowCache = {};
    list.forEach(function (r) { feedRowCache[r.id] = r; });
    var statusMap = { '待审核': 'st-pending', '已通过': 'st-approved', '已驳回': 'st-rejected' };
    var tabs = document.querySelectorAll('#feedTabs .feed-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-fst') === feedFilter);
    if (!list.length) {
      el.innerHTML = '<li style="cursor:default;color:var(--muted)">该条件下暂无记录（数据采集中…）</li>';
    } else {
      el.innerHTML = list.map(function (r) {
        var t = (r.submittedAt || '').slice(5);
        return '<li data-feed="' + esc(r.id || '') + '">' +
          '<span class="s-time">' + esc(t) + '</span>' +
          '<span class="s-name">' + esc(r.name) + (r.highlight ? '<span class="hl">' + esc(r.highlight) + '</span>' : '') + '</span>' +
          '<span class="s-author">@' + esc(r.author) + '</span>' +
          '<span class="s-st"><span class="chip ' + (statusMap[r.status] || '') + '">' + esc(r.status) + '</span></span>' +
          '</li>';
      }).join('');
    }
    var shown = $('feedShown');
    if (shown) shown.textContent = '共 ' + res.total + ' 条 · 第 ' + res.page + '/' + res.pages + ' 页';
    renderFeedPager(res);
  }

  /* 投稿池页码器（复用作品库样式） */
  function renderFeedPager(res) {
    var el = $('feedPager');
    if (!el) return;
    var pages = res.pages || 1;
    var p = Math.min(feedPage, pages);
    var html = '<button class="pg-btn" data-fpg="1"' + (p <= 1 ? ' disabled' : '') + '>首页</button>' +
      '<button class="pg-btn" data-fpg="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + '>上一页</button>';
    var nums = [];
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - p) <= 1) nums.push(i);
    }
    var last = 0;
    nums.forEach(function (n) {
      if (n - last > 1) html += '<span class="pg-ell">…</span>';
      html += '<button class="pg-btn' + (n === p ? ' on' : '') + '" data-fpg="' + n + '">' + n + '</button>';
      last = n;
    });
    html += '<button class="pg-btn" data-fpg="' + (p + 1) + '"' + (p >= pages ? ' disabled' : '') + '>下一页</button>' +
      '<button class="pg-btn" data-fpg="' + pages + '"' + (p >= pages ? ' disabled' : '') + '>末页 ' + pages + '</button>';
    el.innerHTML = html;
  }

  // ============================================================ 页面：关于
  function renderAboutPage() {
    $('page').innerHTML =
      '<div class="panel"><div class="panel-h"><h2>关于本站</h2><div class="rule"></div><span class="meta">1024 造物挑战 · 开发网站赛道参赛作品</span></div>' +
      '<div class="panel-b prose">' +
      '<p class="lede">「1024 造物挑战 · 作品监控台」是一个<b>非官方</b>数据监控与智能分析应用：实时同步官方活动页公开的作品墙与投稿池数据，并用大模型按官方评审细则为每件作品生成模拟评分、技术栈推断与痛点分析，帮助参赛者了解竞争格局、帮助围观者快速发现好应用。</p>' +
      '<h3>数据来源与同步原理</h3>' +
      '<p>数据来源于官方活动页公开的数据表（作品墙、投稿收集池）。服务端每 60 秒快速轮询一次、每 10 分钟对投稿池做一次全量深度扫描，结果以快照形式存储；您浏览的页面读取的是最近一次快照，<b>不会因每位访客而重复抓取上游</b>，避免对官方服务造成压力。</p>' +
      '<p>合规说明：本站仅调用官方活动页的<b>公开分享接口</b>（与浏览器正常访问官方页面等价，无任何登录态或越权数据），并以克制频率采集；仅展示官方已公开展示的作品信息，不含、不猜、不存任何投稿者联系信息。<b>如官方对本站数据采集有任何异议，将第一时间调整或停止。</b></p>' +
      '<h3>风险提示</h3>' +
      '<p>本应用依赖对官方活动页数据接口的解析。<b>若官方调整页面结构或接口，部分功能可能暂时失效</b>；此时本站将以最后一次成功快照继续展示，并尽快修复。</p>' +
      '<h3>隐私声明</h3>' +
      '<p>本站仅采集活动公开的作品与投稿信息。<b>不查询、不展示、不存储任何提交者联系信息</b>——官方存放联系电话的隐私表不在本站采集范围内（代码层面已隔离）。互动功能（投票/收藏）仅在浏览器本地生成一个随机访客 ID 用于去重，不采集任何个人身份信息。</p>' +
      '<h3>AI 评分说明</h3>' +
      '<p>AI 评分与画像是大模型基于作品公开信息生成的<b>模拟评审</b>，按官方细则拆分为创意（35）、完成度（40）、体验（25）三个维度并附依据，社媒潜力（30）仅作参考。<b>该评分与官方评审结果无关，不构成任何获奖预测</b>；分析结果缓存于云端数据库，全站访客共享，不会重复消耗算力。</p>' +
      '<h3>技术栈</h3>' +
      '<ul>' +
      '<li>后端：Node.js 原生 HTTP 服务（零第三方依赖），定时轮询 + 快照存储 + 静态托管</li>' +
      '<li>前端：原生 HTML / CSS / JS 多页面应用，hash 路由，手写 SVG 图表，无构建步骤</li>' +
      '<li>云服务（WorkBuddy Cloud）：免密钥大模型调用（免费模型调度：白天 Step-5-Preview / 夜间 Hy4-Preview / Hy3 兜底，每批 6 件一次调用）生成作品分析，云数据库（PostgreSQL + RLS）持久化分析结果与社区互动数据</li>' +
      '</ul>' +
      '<h3>开源地址</h3>' +
      '<p>本项目代码已在 GitHub 开源（MIT 许可）：<a href="https://github.com/xiaojiaenen/wb1024-monitor" target="_blank" rel="noopener">github.com/xiaojiaenen/wb1024-monitor</a>。欢迎提交 Issue 与 PR。</p>' +
      '<h3>参赛信息</h3>' +
      '<p>WorkBuddy 1024 造物挑战 · 开发网站赛道。官方活动页：<a href="https://www.workbuddy.link/p/8QYARuAmZ9RgQty3FSzNUs" target="_blank" rel="noopener">workbuddy.link/p/8QYARuAmZ9RgQty3FSzNUs</a></p>' +
      '</div></div>';
  }

  // ============================================================ 详情抽屉
  var STAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.2-5.6-3.1-5.6 3.1 1.2-6.2L3 9.6l6.3-.8z"/></svg>';
  var SHARE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v14"/></svg>';

  function findWork(id) {
    return (snapshot.works || []).find(function (x) { return x.id === id; });
  }

  function aiSectionHtml(w) {
    var key = Analysis.workKey(w);
    var p = Analysis.getCached(key);
    if (p) return aiResultHtml(p, w);
    if (!aiReady) {
      return '<div class="ai-box"><div class="ai-box-head"><span class="ai-box-title">' + STAR_SVG + ' AI 作品画像</span><span class="ai-tag">非官方评审 · 仅供参考</span></div>' +
        '<p class="ai-note">' + (aiFault ? esc(aiFault) + '，AI 分析暂不可用。' : 'AI 模块加载中…') + '</p></div>';
    }
    return '<div class="ai-box" id="aiBox">' +
      '<div class="ai-box-head"><span class="ai-box-title">' + STAR_SVG + ' AI 作品画像</span><span class="ai-tag">非官方评审 · 仅供参考</span></div>' +
      '<p class="ai-note">按官方评分细则（创意 35 + 完成度 40 + 体验 25）生成模拟评分、技术栈推断与痛点分析，约 30-40 秒；结果全站共享。</p>' +
      '<button class="btn primary" style="margin:0 12px 12px" data-act="analyze" data-id="' + esc(w.id) + '">AI 分析此作品</button>' +
      '</div>';
  }

  function aiScoreRow(label, score, max, reason) {
    return '<div class="ai-score-row"><span class="lb">' + label + '</span>' +
      '<div class="track"><div class="fill' + (score / max >= 0.75 ? ' sig' : '') + '" style="width:' + Math.round((score / max) * 100) + '%"></div></div>' +
      '<span class="val num">' + score + '<small>/' + max + '</small></span>' +
      '<span class="ai-reason">' + esc(reason) + '</span></div>';
  }

  function aiResultHtml(p, w) {
    return '<div class="ai-box" id="aiBox">' +
      '<div class="ai-box-head"><span class="ai-box-title">' + STAR_SVG + ' AI 作品画像</span><span class="ai-tag">非官方评审 · 仅供参考</span></div>' +
      '<p class="ai-summary">' + esc(p.summary) + '</p>' +
      '<dl class="ai-note" style="display:grid;grid-template-columns:76px 1fr;gap:4px 12px;padding-top:0">' +
      '<dt style="color:var(--muted);font-size:12px">解决痛点</dt><dd>' + (esc(p.pain_point) || '–') + '</dd>' +
      '<dt style="color:var(--muted);font-size:12px">实现方式</dt><dd>' + (esc(p.solution) || '–') + '</dd>' +
      '<dt style="color:var(--muted);font-size:12px">技术栈</dt><dd>' + (p.tech_stack && p.tech_stack.length ? esc(p.tech_stack.join('，')) : '未能推断') + '</dd>' +
      '</dl>' +
      (p.highlights && p.highlights.length ? '<ul class="d-sec" style="border-top:0;padding-top:4px;list-style:none">' + p.highlights.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="ai-scores">' +
      aiScoreRow('创意 / 35', p.scores.creativity.score, 35, p.scores.creativity.reason) +
      aiScoreRow('完成度 / 40', p.scores.completeness.score, 40, p.scores.completeness.reason) +
      aiScoreRow('体验 / 25', p.scores.experience.score, 25, p.scores.experience.reason) +
      aiScoreRow('社媒潜力 / 30', p.social_potential.score, 30, p.social_potential.reason) +
      '</div>' +
      '<div class="ai-total"><b>' + p.total + '</b><span>/ 100 · 前三项之和 · 由 ' + esc(window.__aiModel || 'AI') + ' 生成</span></div>' +
      '</div>';
  }

  function drawerFootHtml(w) {
    var key = Analysis.workKey(w);
    var links = '';
    if (w.link && w.link.link) links += '<a class="btn primary" href="' + esc(w.link.link) + '" target="_blank" rel="noopener">立即体验</a>';
    if (w.social && w.social.link) links += '<a class="btn" href="' + esc(w.social.link) + '" target="_blank" rel="noopener">社媒分享</a>';
    return '<button class="btn vote-btn' + (voted(key) ? ' on' : '') + '" data-act="vote" data-id="' + esc(key) + '">' + ICON_VOTE + '投票 <span class="n">' + voteCount(key) + '</span></button>' +
      '<button class="btn fav-btn' + (faved(key) ? ' on' : '') + '" data-act="fav" data-id="' + esc(key) + '">' + ICON_FAV + '收藏 <span class="n">' + favCount(key) + '</span></button>' +
      '<button class="btn" data-act="share" data-id="' + esc(w.id) + '">' + SHARE_SVG + '分享战报</button>' +
      '<span class="sp"></span>' + links;
  }

  /* 全量作品缓存（详情模态框按需拉取，快照里只有瘦身记录） */
  var fullWorkCache = {};

  /* 打开详情：优先全量缓存，否则异步拉取（拉取期间展示加载态） */
  function openModal(id) {
    var w = fullWorkCache[id];
    if (w) { paintModal(w); return; }
    $('modalBody').innerHTML = '<div class="m-loading"><span class="ai-spinner"></span>作品详情加载中…</div>';
    $('modalFoot').innerHTML = '';
    $('modalMask').hidden = false;
    document.body.style.overflow = 'hidden';
    apiGet('/api/work', { id: id }).then(function (res) {
      if (res && res.work) {
        fullWorkCache[id] = res.work;
        paintModal(res.work);
      } else {
        var slim = findWork(id);
        if (slim) paintModal(slim);
        else closeModal();
      }
    }).catch(function () {
      var slim2 = findWork(id);
      if (slim2) paintModal(slim2);
      else closeModal();
    });
  }

  function paintModal(w) {
    var chips = '';
    chips += w.form === '小程序应用' ? '<span class="chip mini">小程序应用</span>' : '<span class="chip web">网页应用</span>';
    if (w.platform) chips += '<span class="chip">' + esc(w.platform) + '</span>';
    if (w.social && w.social.link) chips += '<span class="chip st-approved">已提交社媒分享</span>';
    if (w.tags) chips += '<span class="chip">#' + esc(w.tags) + '</span>';

    /* 截图：点击弹灯箱看大图（不再新开标签页） */
    var shots = (w.shots || []).map(function (s) {
      return '<img class="m-shot" data-shot="' + esc(s.url) + '" src="' + esc(s.url) + '" alt="' + esc(s.title) + '" loading="lazy" decoding="async">';
    }).join('');

    $('modalBody').innerHTML =
      '<div class="m-head">' +
        '<span class="m-no">#' + (w.cardNo || '–') + '</span>' +
        '<div><div class="m-title">' + esc(w.name) + '</div>' +
        '<div class="m-author">作者：' + esc(w.author) + ' · ' + esc(w.form) + '</div></div>' +
        '<button class="m-close" data-act="close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="m-chips">' + chips + '</div>' +
      aiSectionHtml(w) +
      (w.highlight ? '<div class="m-sec"><h3>一句话亮点</h3><p>' + esc(w.highlight) + '</p></div>' : '') +
      (w.manifesto ? '<div class="m-sec"><h3>我的作品宣言</h3><p>' + esc(w.manifesto) + '</p></div>' : '') +
      (w.desc ? '<div class="m-sec"><h3>作品介绍</h3><p>' + esc(w.desc) + '</p></div>' : '') +
      (shots ? '<div class="m-sec"><h3>作品截图（' + (w.shots || []).length + '）· 点击看大图</h3><div class="m-shots">' + shots + '</div></div>' : '');
    $('modalFoot').innerHTML = drawerFootHtml(w);
    $('modalMask').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('modalMask').hidden = true;
    document.body.style.overflow = '';
  }

  /* 投稿详情：先用列表数据立即展示，再异步补全量（宣言/介绍/截图/体验链接） */
  function openSubmissionModal(sub) {
    paintSubmissionModal(sub);
    apiGet('/api/submission', { id: sub.id }).then(function (res) {
      if (res && res.submission && !$('modalMask').hidden) paintSubmissionFull(res.submission);
    }).catch(function () { /* 补拉失败保持列表版 */ });
  }

  /* 投稿池记录详情：未上架的投稿没有作品页，直接展示投稿信息 */
  function paintSubmissionModal(r) {
    var stMap = { '待审核': 'st-pending', '已通过': 'st-approved', '已驳回': 'st-rejected' };
    $('modalBody').innerHTML =
      '<div class="m-head">' +
        '<span class="m-no">' + esc(r.sid || '投稿') + '</span>' +
        '<div><div class="m-title">' + esc(r.name) + '</div>' +
        '<div class="m-author">作者：' + esc(r.author) + ' · ' + esc(r.form || '–') + '</div></div>' +
        '<button class="m-close" data-act="close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="m-chips">' +
        '<span class="chip ' + (stMap[r.status] || '') + '">' + esc(r.status) + '</span>' +
        (r.cardNo != null ? '<span class="chip">已上架 · 卡片号 #' + r.cardNo + '</span>' : '') +
        (r.platform ? '<span class="chip">' + esc(r.platform) + '</span>' : '') +
      '</div>' +
      (r.highlight ? '<div class="m-sec"><h3>一句话亮点</h3><p>' + esc(r.highlight) + '</p></div>' : '') +
      '<div class="m-sec"><h3>投稿信息</h3><p>提交时间：' + esc((r.submittedAt || '').slice(0, 19)) + '</p></div>' +
      (r.status === '待审核' ? '<div class="m-sec"><p style="color:var(--muted)">该投稿正在等待官方审核，通过后将出现在作品墙并获得卡片号。</p></div>' : '') +
      (r.status === '已驳回' ? '<div class="m-sec"><p style="color:var(--muted)">该投稿未通过官方审核，未上架作品墙。</p></div>' : '');
    $('modalFoot').innerHTML = '';
    $('modalMask').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  /* 投稿详情全量版：宣言 / 完整介绍 / 截图灯箱 / 体验链接 */
  function paintSubmissionFull(r) {
    var stMap = { '待审核': 'st-pending', '已通过': 'st-approved', '已驳回': 'st-rejected' };
    var shots = (r.shots || []).map(function (s) {
      return '<img class="m-shot" data-shot="' + esc(s.url) + '" src="' + esc(s.url) + '" alt="' + esc(s.title) + '" loading="lazy" decoding="async">';
    }).join('');
    var hl = r.highlight ? '<div class="m-sec"><h3>一句话亮点</h3><p>' + esc(r.highlight) + '</p></div>' : '';
    var mf = r.manifesto && r.manifesto !== r.highlight
      ? '<div class="m-sec"><h3>我的作品宣言</h3><p>' + esc(r.manifesto) + '</p></div>' : '';
    $('modalBody').innerHTML =
      '<div class="m-head">' +
        '<span class="m-no">' + esc(r.sid || '投稿') + '</span>' +
        '<div><div class="m-title">' + esc(r.name) + '</div>' +
        '<div class="m-author">作者：' + esc(r.author) + ' · ' + esc(r.form || '–') + '</div></div>' +
        '<button class="m-close" data-act="close" aria-label="关闭">✕</button>' +
      '</div>' +
      '<div class="m-chips">' +
        '<span class="chip ' + (stMap[r.status] || '') + '">' + esc(r.status) + '</span>' +
        (r.cardNo != null ? '<span class="chip">已上架 · 卡片号 #' + r.cardNo + '</span>' : '') +
        (r.platform ? '<span class="chip">' + esc(r.platform) + '</span>' : '') +
        (r.tags ? '<span class="chip">#' + esc(r.tags) + '</span>' : '') +
      '</div>' +
      hl + mf +
      (r.desc ? '<div class="m-sec"><h3>作品介绍</h3><p>' + esc(r.desc) + '</p></div>' : '') +
      (shots ? '<div class="m-sec"><h3>作品截图（' + (r.shots || []).length + '）· 点击看大图</h3><div class="m-shots">' + shots + '</div></div>' : '') +
      (r.status === '待审核' ? '<div class="m-sec"><p style="color:var(--muted)">该投稿正在等待官方审核，通过后将出现在作品墙并获得卡片号。</p></div>' : '') +
      (r.status === '已驳回' ? '<div class="m-sec"><p style="color:var(--muted)">该投稿未通过官方审核，未上架作品墙。</p></div>' : '');
    $('modalFoot').innerHTML = (r.link && r.link[0] && r.link[0].link)
      ? '<div class="m-links"><a class="link-btn" href="' + esc(r.link[0].link) + '" target="_blank" rel="noopener">打开体验链接 ↗</a></div>'
      : '';
    $('modalMask').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  /* ---------- 截图灯箱：点击看大图，点空白处 / Esc 关闭 ---------- */
  function openLightbox(url) {
    if (!url) return;
    $('lightboxImg').src = url;
    $('lightboxMask').hidden = false;
  }

  function closeLightbox() {
    $('lightboxMask').hidden = true;
    $('lightboxImg').src = '';
  }

  function triggerAnalyze(btn) {
    var wid = btn.getAttribute('data-id');
    var w = fullWorkCache[wid] || findWork(wid);
    if (!w) return;
    var box = $('aiBox');
    if (box) {
      box.innerHTML =
        '<div class="ai-box-head"><span class="ai-box-title">' + STAR_SVG + ' AI 作品画像</span><span class="ai-tag">非官方评审 · 仅供参考</span></div>' +
        '<div class="ai-loading"><span class="ai-spinner"></span>AI 分析中，约 30-40 秒…（结果将缓存，全站共享）</div>';
    }
    Analysis.analyze(w, function (payload, err) {
      if (err) {
        if (box) {
          box.innerHTML =
            '<div class="ai-box-head"><span class="ai-box-title">' + STAR_SVG + ' AI 作品画像</span><span class="ai-tag">非官方评审 · 仅供参考</span></div>' +
            '<p class="ai-error">分析失败：' + esc(err.message || '未知错误') + '</p>' +
            '<button class="btn" style="margin:0 12px 12px" data-act="analyze" data-id="' + esc(w.id) + '">重试</button>';
        }
        return;
      }
      if (box) box.outerHTML = aiResultHtml(payload, w);
      updateAiBadge();
      refreshDynamic();
      toast('分析完成，结果已缓存');
    });
  }

  // ------------------------------------------------------------ 分享战报（Canvas）
  function shareCard(w) {
    var key = Analysis.workKey(w);
    var p = Analysis.getCached(key);
    var W = 1200, H = 630;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var BG = '#FBFAF7', INK = '#16130F', SIGNAL = '#E8481F', MUTED = '#6B655A', HAIR = '#E3E0D9';

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    /* 顶部黑带 */
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, 74);
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(0, 0, 168, 74);
    ctx.fillStyle = '#fff';
    ctx.font = '600 30px Oswald, "Arial Narrow", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('1024', 24, 38);
    ctx.font = '400 20px "Noto Sans SC", sans-serif';
    ctx.fillText('造物挑战 · 作品监控台', 208, 40);

    /* 卡片号 + 形态 */
    ctx.fillStyle = SIGNAL;
    ctx.font = '600 22px Oswald, sans-serif';
    ctx.fillText('#' + (w.cardNo || ''), 56, 128);
    ctx.fillStyle = MUTED;
    ctx.font = '400 20px "Noto Sans SC", sans-serif';
    ctx.fillText(w.form + (w.platform ? ' · ' + w.platform : ''), 56 + (w.cardNo ? String(w.cardNo).length * 16 + 34 : 44), 130);

    /* 作品名（自动换行） */
    ctx.fillStyle = INK;
    ctx.font = '600 46px Oswald, "Noto Sans SC", sans-serif';
    var nameY = 190;
    wrapText(ctx, w.name, 56, nameY, W - 112, 54, 2);

    /* 亮点 */
    if (w.highlight) {
      ctx.fillStyle = MUTED;
      ctx.font = '400 22px "Noto Sans SC", sans-serif';
      wrapText(ctx, w.highlight, 56, nameY + 118, W - 112, 32, 2);
    }

    /* 作者 */
    ctx.fillStyle = INK;
    ctx.font = '400 22px "Noto Sans SC", sans-serif';
    ctx.fillText('作者 @' + (w.author || '匿名'), 56, nameY + 176);

    /* AI 评分块（右下） */
    if (p) {
      var bx = W - 300, by = 250, bw2 = 244, bh2 = 190;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = HAIR;
      ctx.lineWidth = 2;
      ctx.fillRect(bx, by, bw2, bh2);
      ctx.strokeRect(bx, by, bw2, bh2);
      ctx.fillStyle = MUTED;
      ctx.font = '400 18px "Noto Sans SC", sans-serif';
      ctx.fillText('AI 模拟评审总分', bx + 24, by + 40);
      ctx.fillStyle = INK;
      ctx.font = '700 84px Oswald, sans-serif';
      ctx.fillText(String(p.total), bx + 22, by + 128);
      ctx.fillStyle = MUTED;
      ctx.font = '400 24px Oswald, sans-serif';
      ctx.fillText('/ 100', bx + 24 + String(p.total).length * 48 + 12, by + 128);
      ctx.font = '400 17px "Noto Sans SC", sans-serif';
      ctx.fillText('创意 ' + p.scores.creativity.score + ' · 完成度 ' + p.scores.completeness.score + ' · 体验 ' + p.scores.experience.score, bx + 24, by + 168);
    }

    /* 底部 */
    ctx.fillStyle = HAIR;
    ctx.fillRect(56, H - 96, W - 112, 2);
    ctx.fillStyle = MUTED;
    ctx.font = '400 19px "Noto Sans SC", sans-serif';
    ctx.fillText('社区非官方监控台 · AI 评分仅供参考，与官方评审结果无关', 56, H - 58);
    ctx.fillText('数据截至 ' + new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 56, H - 28);

    function wrapText(c, text, x, y, maxW, lineH, maxLines) {
      var lines = [];
      var line = '';
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        var test = line + ch;
        if (c.measureText(test).width > maxW && line) {
          lines.push(line);
          line = ch;
          if (lines.length >= maxLines) break;
        } else {
          line = test;
        }
      }
      if (lines.length < maxLines && line) lines.push(line);
      lines.forEach(function (l, i) { c.fillText(l, x, y + i * lineH); });
    }

    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob) { resolve(null); return; }
        var file = new File([blob], 'wb1024-work-' + (w.cardNo || w.id) + '.png', { type: 'image/png' });
        /* 优先系统分享 */
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: w.name, text: '我在 1024 造物挑战监控台发现了这件作品' }).then(function () { resolve('shared'); }).catch(function () { downloadBlob(blob, w); resolve('downloaded'); });
        } else {
          downloadBlob(blob, w);
          resolve('downloaded');
        }
      }, 'image/png');
    });
  }

  function downloadBlob(blob, w) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wb1024-work-' + (w.cardNo || w.id) + '.png';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('战报图片已生成，正在下载');
  }

  // ------------------------------------------------------------ 事件
  document.addEventListener('click', function (e) {
    var t = e.target;
    var actEl = t.closest('[data-act]');
    if (actEl) {
      var act = actEl.getAttribute('data-act');
      var id = actEl.getAttribute('data-id');
      if (act === 'analyze') { triggerAnalyze(actEl); return; }
      if (act === 'close') { closeModal(); return; }
      if (act === 'vote') { toggleVote(id, actEl); return; }
      if (act === 'fav') { toggleFav(id, actEl); return; }
      if (act === 'share') {
        var sw = fullWorkCache[id] || findWork(id);
        if (sw) shareCard(sw).then(function (r) { if (r === 'shared') toast('已调用系统分享'); });
        return;
      }
    }
    /* 评审页榜单行选择（不打开抽屉，只切详情） */
    if (route === 'ratings') {
      var row = t.closest('#boardFull tr[data-open]');
      if (row) {
        var w2 = findWork(row.getAttribute('data-open'));
        if (w2) {
          ratingsSel = Analysis.workKey(w2);
          renderRatingsList();
          return;
        }
      }
    }
    /* 截图灯箱：点击缩略图看大图 */
    var shotEl = t.closest('[data-shot]');
    if (shotEl) { openLightbox(shotEl.getAttribute('data-shot')); return; }
    /* 动态页投稿行：已上架的跳作品完整详情，其余展示投稿信息 */
    var feedEl = t.closest('[data-feed]');
    if (feedEl) {
      var fid = feedEl.getAttribute('data-feed');
      var sub = feedRowCache[fid] || null;
      if (!sub) (snapshot.recentSubmissions || []).forEach(function (r) { if (r.id === fid) sub = r; });
      if (sub) {
        if (sub.cardNo != null) {
          var fw = null;
          (snapshot.works || []).forEach(function (w) { if (w.cardNo === sub.cardNo) fw = w; });
          if (fw) { openModal(fw.id); return; }
        }
        openSubmissionModal(sub);
      }
      return;
    }
    /* 投稿池页码器 */
    var fpgEl = t.closest('.pg-btn[data-fpg]');
    if (fpgEl && !fpgEl.disabled) {
      var fp = parseInt(fpgEl.getAttribute('data-fpg'), 10);
      if (fp >= 1 && fp !== feedPage) { feedPage = fp; fetchFeedPage(); window.scrollTo(0, 0); }
      return;
    }
    /* 投稿流水状态筛选 */
    var fstEl = t.closest('[data-fst]');
    if (fstEl) { feedFilter = fstEl.getAttribute('data-fst'); feedPage = 1; fetchFeedPage(); return; }
    var opener = t.closest('[data-open]');
    if (opener) {
      var oid = opener.getAttribute('data-open');
      if (oid) { openModal(oid); return; }
    }
  });

  $('modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  /* 灯箱：点空白处关闭（点图片本身不关） */
  $('lightboxMask').addEventListener('click', function (e) { if (e.target === this) closeLightbox(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeLightbox(); closeModal(); return; }
    /* 作品库键盘翻页（输入框聚焦时不拦截） */
    if (route === 'works' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      gotoWorksPage(worksPage + (e.key === 'ArrowRight' ? 1 : -1));
    }
  });
  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------ 启动
  renderCountdown();
  renderClock();
  /* 秒级定时器合并为一个：倒计时 + 时钟 */
  setInterval(function () { renderCountdown(); renderClock(); }, 1000);
  loadSnapshot();
  setInterval(loadSnapshot, 30000);
  setInterval(updateAiBadge, 2000);
  navigate();
})();
