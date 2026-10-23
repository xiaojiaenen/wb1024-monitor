import io

def fix(path, pairs, must=True):
    s = io.open(path, encoding='utf-8').read()
    for a, b in pairs:
        if a not in s:
            print('MISS[' + path + ']:', a[:60])
        s = s.replace(a, b)
    io.open(path, 'w', encoding='utf-8').write(s)
    print(path, 'ok')

# ---------- dir-1：信号色统一 #C43A14；数据分隔去点号 ----------
fix('dir-1.html', [
  ('--signal: #E8481F;', '--signal: #C43A14;'),
  ('--signal-text: #C43A14;', '--signal-text: #C43A14;'),
  ('按官方细则评分 · 创意35/完成度40/体验25 · 点击行查看评审依据',
   '按官方细则评分：创意35 / 完成度40 / 体验25，点击行查看评审依据'),
  ("'已评审 ' + analyses.length + ' 件 · 均值 '", "'已评审 ' + analyses.length + ' 件，均值 '"),
  ("'<div class=\"info\"><div class=\"nm\">' + w.name + '</div><div class=\"au\">' + w.author + ' · ' + w.form + '</div></div></div>';",
   "'<div class=\"info\"><div class=\"nm\">' + w.name + '</div><div class=\"au\">' + w.author + ' / ' + w.form + '</div></div></div>';"),
  ("'已上架 ' + D.stats.wallTotal + ' 件 · 展示最新 ' + works.length + ' 件'",
   "'已上架 ' + D.stats.wallTotal + ' 件，展示最新 ' + works.length + ' 件'"),
  ("'#' + a.id + ' · ' + (works.filter(function (w) { return String(w.cardNo) === String(a.id); })[0] || {}).form + '</div>' +",
   "'#' + a.id + ' / ' + (works.filter(function (w) { return String(w.cardNo) === String(a.id); })[0] || {}).form + '</div>' +"),
  ("<span class=\"tag\">创意35 · 完成度40 · 体验25</span>", "<span class=\"tag\">创意35 / 完成度40 / 体验25</span>"),
])

# ---------- dir-2：标题冒号锁定；数据分隔去点号 ----------
fix('dir-2.html', [
  ('<h1>1024 造物挑战 · 赛事数据监控</h1>', '<h1>1024 造物挑战：赛事数据监控</h1>'),
  ('<div class="edition">社区版 · 非官方</div>', '<div class="edition">社区版（非官方）</div>'),
  ('<h2>墙内增长 · 48 分钟</h2>', '<h2>墙内增长（48 分钟）</h2>'),
  ('<span class="item">同步正常 · 60s 轮询</span>', '<span class="item">同步正常 / 60s 轮询</span>'),
  ("+ '日 · ' + ['周日'", "+ '日 ' + ['周日'"),
  ("(t.date === trend[trend.length - 1].date ? ' · 今日' : '')", "(t.date === trend[trend.length - 1].date ? '（今日）' : '')"),
  ("'<div class=\"info\"><div class=\"nm\">' + w.name + '</div><div class=\"au\">' + w.author + ' · <b>' + w.form + '</b></div></div></div>';",
   "'<div class=\"info\"><div class=\"nm\">' + w.name + '</div><div class=\"au\">' + w.author + '，<b>' + w.form + '</b></div></div></div>';"),
  ("'已上架 ' + st.wallTotal + ' 件 · 展示最新 ' + works.length + ' 件'",
   "'已上架 ' + st.wallTotal + ' 件，展示最新 ' + works.length + ' 件'"),
  ("' + (w.author || '') + ' · ' + (w.form || '') + '", "' + (w.author || '') + ' / ' + (w.form || '') + '"),
])

# ---------- dir-3：脚注色加深；数据分隔去点号 ----------
fix('dir-3.html', [
  ('.footnote { font-size: 12px; color: #999;', '.footnote { font-size: 12px; color: #6E6E6E;'),
  ('快照 <b id="snap-time"></b> · 60s 轮询 · 同步正常', '快照 <b id="snap-time"></b> / 60s 轮询 / 同步正常'),
  ('<span>直接标注 · 数据源：官方投稿池</span>', '<span>直接标注，数据源：官方投稿池</span>'),
  ('<span>作品墙实时 · AI 已评分的作品显示评分条</span>', '<span>作品墙实时，AI 已评分的作品显示评分条</span>'),
  ('<span>已上架 654 件 · 展示最新 12 件</span>', '<span>已上架 654 件，展示最新 12 件</span>'),
  ("{ k: '已上架作品 · 48 分钟趋势'", "{ k: '已上架作品（48 分钟趋势）'"),
  ("{ k: '投稿总量 · 48 分钟趋势'", "{ k: '投稿总量（48 分钟趋势）'"),
  ("$('rate-meta').textContent = analyses.length + ' 件 · 均值 '", "$('rate-meta').textContent = analyses.length + ' 件，均值 '"),
  ("'<td class=\"nm\">' + a.name + '<small>#' + a.id + ' · ' + a.summary + '</small></td>'",
   "'<td class=\"nm\">' + a.name + '<small>#' + a.id + ' ' + a.summary + '</small></td>'"),
  ("a.tech.join(' · ')", "a.tech.join('、')"),
])
