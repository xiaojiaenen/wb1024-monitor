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
  var visibleCount = 60;
  var warmEnd = 60;
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
      warmMore(0);
      updateAiBadge();
      /* AI 就绪后立即刷新依赖 AI 的区域 */
      if (route === '') { renderStats(); renderBoard(); renderAiPanel(); }
      if (route === 'ratings') { renderRatingsMeta(); renderRatingsList(); }
    }).catch(function (e) {
      aiFault = 'AI 模块加载失败：' + (e && e.message ? e.message : '网络错误');
      console.warn(aiFault);
    });
  }

  function warmMore(extra) {
    if (!snapshot || !snapshot.works) return;
    if (extra) warmEnd += extra;
    Analysis.warmLatest(snapshot.works.slice(0, warmEnd));
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
      renderWorksBody();
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
    feed: { title: '实时动态', desc: '投稿池最新提交流水', render: renderFeedPage },
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
    else if (route === 'works') { renderWorksBody(); }
    else if (route === 'ratings') { renderRatingsMeta(); renderRatingsList(); }
    else if (route === 'insights') { renderCharts(); renderBreakdown(); renderHistogram(); renderPopularity(); }
    else if (route === 'feed') { renderStream(); }
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
    if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
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
    tickerTimer = setInterval(renderTicker, 4000);
  }

  var tickerTimer = null;

  function renderStats() {
    var s = (snapshot && snapshot.stats) || {};
    var el = $('kpis');
    if (!el) return;
    var totalVotes = 0;
    Object.keys(interactions.votes).forEach(function (k) { totalVotes += interactions.votes[k]; });
    var st = Analysis.getStats();
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

  function renderBoard() {
    var el = $('board');
    if (!el) return;
    var list = analyzedWorks().slice(0, 10);
    if (!list.length) {
      el.innerHTML = '<tr><td style="padding:18px 12px;color:var(--muted);font-size:14px">AI 评审准备中，首批分析完成后这里会出现结果榜…</td></tr>';
      return;
    }
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

  function renderWall() {
    var el = $('wall');
    if (!el) return;
    var list = (snapshot.works || []).slice().sort(function (a, b) { return b.cardNo - a.cardNo; }).slice(0, 6);
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

  var tickIdx = 0;
  function renderTicker() {
    var el = $('ticker');
    if (!el) return;
    var recent = snapshot.recentSubmissions || [];
    if (!recent.length) { el.innerHTML = '<div style="padding:0 16px;font-size:14px;color:var(--muted)">投稿流水采集中…</div>'; return; }
    var items = [];
    for (var i = 0; i < 3; i++) {
      var r = recent[(tickIdx + i) % recent.length];
      var cls = r.status === '待审核' ? 'p' : (r.status === '已通过' ? 'a' : 'r');
      items.push('<div class="tick-item"><span class="nm">' + esc(r.name) + '</span>' +
        '<span class="au">@' + esc(r.author) + '</span>' +
        '<span class="st ' + cls + '">' + esc(r.status) + '</span>' +
        '<span class="t">' + esc((r.submittedAt || '').slice(11)) + '</span></div>');
    }
    el.innerHTML = items.join('');
    tickIdx = (tickIdx + 1) % recent.length;
  }

  function renderAiPanel() {
    var el = $('aiPanel');
    if (!el) return;
    var metaEl = $('aiMeta');
    var works = snapshot.works || [];
    var st = Analysis.getStats();
    if (metaEl) metaEl.textContent = (window.__aiModel ? '模型 ' + window.__aiModel : '模型加载中') + ' · 每件约 30-40 秒';
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
      '<div class="table-wrap"><table class="works"><thead><tr>' +
      '<th class="c-no">#</th><th>作品</th><th>作者</th><th class="c-form">形态</th><th class="c-plat">平台</th><th class="c-ai">AI 评分</th><th class="c-pop">人气</th><th class="c-link"></th>' +
      '</tr></thead><tbody id="worksBody"></tbody></table>' +
      '<div class="empty" id="worksEmpty" hidden>没有符合条件的作品</div></div>' +
      '<div class="table-foot"><span id="worksShown">–</span><button class="btn" id="loadMoreBtn" hidden>加载更多</button></div>' +
      '</div>';
    buildPlatformOptions();
    bindWorksFilters();
    renderWorksBody();
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
        visibleCount = 60;
        renderWorksBody();
      }, 200);
    });
    $('fForm').addEventListener('change', function () { filters.form = this.value; visibleCount = 60; renderWorksBody(); });
    $('fPlatform').addEventListener('change', function () { filters.platform = this.value; visibleCount = 60; renderWorksBody(); });
    $('fSort').addEventListener('change', function () { filters.sort = this.value; renderWorksBody(); });
    $('loadMoreBtn').addEventListener('click', function () { visibleCount += 120; renderWorksBody(); });
  }

  function filteredWorks() {
    var list = (snapshot.works || []).slice();
    var kw = filters.keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter(function (w) {
        return (w.name + ' ' + w.author + ' ' + w.highlight + ' ' + w.tags + ' ' + w.manifesto).toLowerCase().indexOf(kw) >= 0;
      });
    }
    if (filters.form) list = list.filter(function (w) { return w.form === filters.form; });
    if (filters.platform) list = list.filter(function (w) { return w.platform === filters.platform; });
    if (filters.sort === 'cardDesc') list.sort(function (a, b) { return b.cardNo - a.cardNo; });
    else if (filters.sort === 'cardAsc') list.sort(function (a, b) { return a.cardNo - b.cardNo; });
    else if (filters.sort === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    else if (filters.sort === 'aiDesc') {
      list.sort(function (a, b) {
        var pa = Analysis.getCached(Analysis.workKey(a)), pb = Analysis.getCached(Analysis.workKey(b));
        return (pb ? pb.total : -1) - (pa ? pa.total : -1);
      });
    } else if (filters.sort === 'popDesc') {
      list.sort(function (a, b) { return voteCount(Analysis.workKey(b)) - voteCount(Analysis.workKey(a)); });
    }
    return list;
  }

  function aiCell(w) {
    var p = Analysis.getCached(Analysis.workKey(w));
    if (p) return '<span class="ai-score">' + p.total + '<small> /100</small></span>';
    return '<span class="ai-score pending">待分析</span>';
  }

  function workRow(w) {
    var key = Analysis.workKey(w);
    var shot = w.shots && w.shots[0] && w.shots[0].url;
    var formChip = w.form === '小程序应用' ? '<span class="chip mini">小程序</span>' : '<span class="chip web">网页</span>';
    var link = w.link && w.link.link
      ? '<a class="link-btn" href="' + esc(w.link.link) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">体验</a>'
      : '<span class="link-btn disabled">暂无</span>';
    return '<tr data-open="' + esc(w.id) + '">' +
      '<td class="c-no no">' + (w.cardNo || '–') + '</td>' +
      '<td>' + (shot
        ? '<img class="shot" loading="lazy" src="' + esc(shot) + '" alt="">'
        : '<div class="shot-ph">无图</div>') + '</td>' +
      '<td><div class="w-name">' + esc(w.name) + '</div>' +
      '<div class="w-hl">' + esc(w.highlight) + '</div></td>' +
      '<td>' + esc(w.author) + '</td>' +
      '<td class="c-form">' + formChip + '</td>' +
      '<td class="c-plat">' + (w.platform ? '<span class="chip">' + esc(w.platform) + '</span>' : '<span style="color:var(--muted)">–</span>') + '</td>' +
      '<td class="c-ai">' + aiCell(w) + '</td>' +
      '<td class="c-pop" data-pop="' + esc(key) + '">' + popCellHtml(key) + '</td>' +
      '<td class="c-link">' + link + '</td>' +
      '</tr>';
  }

  function renderWorksBody() {
    var list = filteredWorks();
    var shown = list.slice(0, visibleCount);
    $('worksBody').innerHTML = shown.map(workRow).join('');
    $('worksEmpty').hidden = list.length > 0;
    $('worksCountNote').textContent = '共 ' + fmtNum((snapshot.works || []).length) + ' 件 · 当前筛选 ' + fmtNum(list.length) + ' 件';
    $('worksShown').textContent = '显示 ' + shown.length + ' / ' + list.length + ' 件';
    $('loadMoreBtn').hidden = list.length <= visibleCount;
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

  function renderRatingsList() {
    var el = $('boardFull');
    if (!el) return;
    var list = analyzedWorks().slice(0, 120);
    if (!list.length) {
      el.innerHTML = '<tr><td style="padding:18px 12px;color:var(--muted);font-size:14px">' +
        (aiReady ? '还没有已完成分析的作品。打开任意作品详情即可触发分析。' : 'AI 模块加载中…') + '</td></tr>';
      $('ratingsDetail').innerHTML = '<div class="empty">选择左侧榜单中的作品查看完整评审依据</div>';
      return;
    }
    var selKey = ratingsSel && list.some(function (w) { return Analysis.workKey(w) === ratingsSel; }) ? ratingsSel : Analysis.workKey(list[0]);
    ratingsSel = selKey;
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

  function renderCharts() {
    var pb = snapshot.poolBreakdown;
    if (pb && pb.dailyTrend && pb.dailyTrend.length) {
      barChart($('dailyChart'), pb.dailyTrend.map(function (d) { return { label: d.date, value: d.count }; }));
    } else if ($('dailyChart')) {
      $('dailyChart').innerHTML = '<div class="chart-empty">深度扫描进行中…</div>';
    }
    if ($('trendChart')) lineChart($('trendChart'), snapshot.history || []);
  }

  function renderBreakdown() {
    var pb = snapshot.poolBreakdown;
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
        var wallN = (snapshot.works || []).length;
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
      var web = (snapshot.works || []).filter(function (w) { return w.form === '网页应用'; }).length;
      var mini = (snapshot.works || []).length - web;
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
      var tags = {};
      (snapshot.works || []).forEach(function (w) {
        if (!w.tags) return;
        String(w.tags).split(/[、,，/#\s]+/).forEach(function (t) {
          t = t.trim();
          if (t && t.length >= 2) tags[t] = (tags[t] || 0) + 1;
        });
      });
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

  function renderHistogram() {
    var el = $('histChart');
    if (!el) return;
    var scores = analyzedScores();
    if (scores.length) {
      var avg = (scores.reduce(function (a, b) { return a + b; }, 0) / scores.length).toFixed(1);
      $('histMeta').textContent = scores.length + ' 件已评审 · 均值 ' + avg + ' 分';
    } else {
      $('histMeta').textContent = '等待首批分析';
    }
    histogram(el, scores);
  }

  function renderPopularity() {
    var el = $('popList');
    if (!el) return;
    var works = snapshot.works || [];
    var scored = works.map(function (w) {
      return { w: w, key: Analysis.workKey(w), v: voteCount(Analysis.workKey(w)) };
    }).filter(function (x) { return x.v > 0; });
    scored.sort(function (a, b) { return b.v - a.v; });
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
  function renderFeedPage() {
    $('page').innerHTML =
      '<div class="panel">' +
      '<div class="panel-h"><h2>最新投稿流水</h2><div class="rule"></div><span class="panel-note meta">投稿池按提交时间倒序 · 每 60 秒同步 · 点击行查看详情</span></div>' +
      '<ul class="stream" id="recentStream"></ul></div>';
    renderStream();
  }

  function renderStream() {
    var el = $('recentStream');
    if (!el) return;
    var list = snapshot.recentSubmissions || [];
    var statusMap = { '待审核': 'st-pending', '已通过': 'st-approved', '已驳回': 'st-rejected' };
    if (!list.length) {
      el.innerHTML = '<li style="cursor:default;color:var(--muted)">投稿流水采集中…</li>';
      return;
    }
    el.innerHTML = list.map(function (r) {
      var t = (r.submittedAt || '').slice(5);
      return '<li data-open="' + esc(r.id || '') + '">' +
        '<span class="s-time">' + esc(t) + '</span>' +
        '<span class="s-name">' + esc(r.name) + (r.highlight ? '<span class="hl">' + esc(r.highlight) + '</span>' : '') + '</span>' +
        '<span class="s-author">@' + esc(r.author) + '</span>' +
        '<span class="s-st"><span class="chip ' + (statusMap[r.status] || '') + '">' + esc(r.status) + '</span></span>' +
        '</li>';
    }).join('');
  }

  // ============================================================ 页面：关于
  function renderAboutPage() {
    $('page').innerHTML =
      '<div class="panel"><div class="panel-h"><h2>关于本站</h2><div class="rule"></div><span class="meta">1024 造物挑战 · 开发网站赛道参赛作品</span></div>' +
      '<div class="panel-b prose">' +
      '<p class="lede">「1024 造物挑战 · 作品监控台」是一个<b>非官方</b>数据监控与智能分析应用：实时同步官方活动页公开的作品墙与投稿池数据，并用大模型按官方评审细则为每件作品生成模拟评分、技术栈推断与痛点分析，帮助参赛者了解竞争格局、帮助围观者快速发现好应用。</p>' +
      '<h3>数据来源与同步原理</h3>' +
      '<p>数据来源于官方活动页公开的数据表（作品墙、投稿收集池）。服务端每 60 秒快速轮询一次、每 10 分钟对投稿池做一次全量深度扫描，结果以快照形式存储；您浏览的页面读取的是最近一次快照，<b>不会因每位访客而重复抓取上游</b>，避免对官方服务造成压力。</p>' +
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
      '<p>本项目代码已在 GitHub 开源（MIT 许可）：<a href="https://github.com/xiaojiaenen/wb1024-monitor" target="_blank" rel="noopener">github.com/xiaojiaenen/wb1024-monitor</a>。欢迎提交 Issue 与 PR；<code>design-demos/</code> 目录保留了三个设计方向的完整初稿与设计决策记录。</p>' +
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

  function openModal(id) {
    var w = findWork(id);
    if (!w) return;
    var chips = '';
    chips += w.form === '小程序应用' ? '<span class="chip mini">小程序应用</span>' : '<span class="chip web">网页应用</span>';
    if (w.platform) chips += '<span class="chip">' + esc(w.platform) + '</span>';
    if (w.social && w.social.link) chips += '<span class="chip st-approved">已提交社媒分享</span>';
    if (w.tags) chips += '<span class="chip">#' + esc(w.tags) + '</span>';

    var shots = (w.shots || []).map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener"><img src="' + esc(s.url) + '" alt="' + esc(s.title) + '" loading="lazy"></a>';
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
      (shots ? '<div class="m-sec"><h3>作品截图（' + (w.shots || []).length + '）</h3><div class="m-shots">' + shots + '</div></div>' : '');
    $('modalFoot').innerHTML = drawerFootHtml(w);
    $('modalMask').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('modalMask').hidden = true;
    document.body.style.overflow = '';
  }

  function triggerAnalyze(btn) {
    var w = findWork(btn.getAttribute('data-id'));
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
        var w = findWork(id);
        if (w) shareCard(w).then(function (r) { if (r === 'shared') toast('已调用系统分享'); });
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
    var opener = t.closest('[data-open]');
    if (opener) {
      var oid = opener.getAttribute('data-open');
      if (oid) { openModal(oid); return; }
    }
  });

  $('modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('hashchange', navigate);

  // ------------------------------------------------------------ 启动
  renderCountdown();
  setInterval(renderCountdown, 1000);
  renderClock();
  setInterval(renderClock, 1000);
  loadSnapshot();
  setInterval(loadSnapshot, 30000);
  setInterval(updateAiBadge, 2000);
  navigate();
})();
