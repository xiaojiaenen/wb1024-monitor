import io

p = 'dir-3.html'
s = io.open(p, encoding='utf-8').read()
orig = s

# ---- 颜色 ----
s = s.replace('--muted: #777;', '--muted: #6E6E6E;')
s = s.replace('table.rt .rk { font-family: Newsreader, serif; font-size: 15px; font-weight: 600; color: #B5B5B5; width: 30px; }',
              'table.rt .rk { font-family: Newsreader, serif; font-size: 15px; font-weight: 600; color: #737373; width: 30px; }')
s = s.replace('table.dt .na { color: #BBB; font-size: 10px; }', 'table.dt .na { color: #737373; font-size: 12px; }')
s = s.replace('.notice { display: flex; gap: 8px; padding: 7px 26px; font-size: 10.5px; color: #8a8a8a;',
              '.notice { display: flex; gap: 8px; padding: 7px 26px; font-size: 14px; color: #6E6E6E;')

# ---- 柱状标签飞出柱体 ----
s = s.replace(""".direct .b b { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); font-size: 10.5px; font-weight: 600; white-space: nowrap; }""",
""".direct .bl { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; }""")

old_css = """  .direct { display: flex; align-items: flex-end; gap: 14px; height: 108px; padding: 14px 4px 0; border-bottom: 1px solid var(--ink); }"""
new_css = """  .direct { display: flex; align-items: flex-end; gap: 14px; height: 108px; padding: 16px 4px 0; border-bottom: 1px solid var(--ink); position: relative; }"""
if old_css not in s: print('MISS direct css')
s = s.replace(old_css, new_css)

old_js = """  $('direct').innerHTML = trend.map(function (t, i) {
    var last = i === trend.length - 1;
    return '<div class="b' + (last ? ' on' : '') + '" style="height:' + Math.max(3, Math.round(t.count / maxT * 100)) + '%"><b>' + t.count.toLocaleString() + '</b></div>';
  }).join('');"""
new_js = """  var bw = 100 / trend.length;
  $('direct').innerHTML = trend.map(function (t, i) {
    var last = i === trend.length - 1;
    var h = Math.max(3, Math.round(t.count / maxT * 100));
    return '<div class="b' + (last ? ' on' : '') + '" style="height:' + h + '%"></div>' +
      '<span class="bl" style="left:calc(' + (i * bw + bw / 2) + '% );bottom:calc(' + h + '% + 6px)">' + t.count.toLocaleString() + '</span>';
  }).join('');"""
if old_js not in s: print('MISS direct js')
s = s.replace(old_js, new_js)

old_hist = """  $('score-hist').innerHTML = bins.map(function (b) {
    return '<div class="b' + (b.lb === '70+' ? ' on' : '') + '" style="height:' + Math.max(3, Math.round(b.v / maxB * 100)) + '%"><b>' + b.v + '</b></div>';
  }).join('');"""
new_hist = """  var hw = 100 / bins.length;
  $('score-hist').innerHTML = bins.map(function (b, i) {
    var h = Math.max(3, Math.round(b.v / maxB * 100));
    return '<div class="b' + (b.lb === '70+' ? ' on' : '') + '" style="height:' + h + '%"></div>' +
      '<span class="bl" style="left:calc(' + (i * hw + hw / 2) + '% );bottom:calc(' + h + '% + 6px)">' + b.v + '</span>';
  }).join('');"""
if old_hist not in s: print('MISS hist js')
s = s.replace(old_hist, new_hist)

# ---- 字号 ----
repl = [
  ('header nav { display: flex; gap: 18px; font-size: 11.5px;', 'header nav { display: flex; gap: 18px; font-size: 12px;'),
  ('header .status { margin-left: auto; font-size: 10.5px;', 'header .status { margin-left: auto; font-size: 12px;'),
  ('.metric .k { font-size: 10px;', '.metric .k { font-size: 12px;'),
  ('.metric .d { font-size: 9.5px;', '.metric .d { font-size: 12px;'),
  ('.panel-h span { font-size: 9px;', '.panel-h span { font-size: 12px;'),
  ('.direct-x span { flex: 1; text-align: center; font-size: 9px;', '.direct-x span { flex: 1; text-align: center; font-size: 12px;'),
  ('.hbar { display: grid; grid-template-columns: 62px 1fr 64px; align-items: center; gap: 10px; font-size: 11px; }',
   '.hbar { display: grid; grid-template-columns: 68px 1fr 68px; align-items: center; gap: 10px; font-size: 12px; }'),
  ('table.dt th { font-size: 9px;', 'table.dt th { font-size: 12px;'),
  ('table.dt { width: 100%; border-collapse: collapse; font-size: 11.5px; }', 'table.dt { width: 100%; border-collapse: collapse; font-size: 12px; }'),
  ('table.dt .no { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 10px;', 'table.dt .no { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px;'),
  ('table.dt .mini b { font-size: 10.5px;', 'table.dt .mini b { font-size: 12px;'),
  ('table.rt { width: 100%; border-collapse: collapse; font-size: 11.5px; }', 'table.rt { width: 100%; border-collapse: collapse; font-size: 12px; }'),
  ('table.rt th { font-size: 9px;', 'table.rt th { font-size: 12px;'),
  ('table.rt .nm small { display: block; font-weight: 400; color: var(--muted); font-size: 9.5px;', 'table.rt .nm small { display: block; font-weight: 400; color: var(--muted); font-size: 12px;'),
  ('table.rt .sub { font-size: 9.5px;', 'table.rt .sub { font-size: 12px;'),
  ('.legend { display: flex; gap: 14px; font-size: 9.5px;', '.legend { display: flex; gap: 14px; font-size: 12px;'),
  ('.detail-box .meta { font-size: 10px;', '.detail-box .meta { font-size: 12px;'),
  ('.detail-box .kv { display: flex; justify-content: space-between; font-size: 11px;', '.detail-box .kv { display: flex; justify-content: space-between; font-size: 12px;'),
  ('.detail-box li { font-size: 11px;', '.detail-box li { font-size: 12px;'),
  ('.detail-box .sum { font-family: Newsreader, "Noto Serif SC", serif; font-size: 13px;', '.detail-box .sum { font-family: Newsreader, "Noto Serif SC", serif; font-size: 14px;'),
  ('.footnote { font-size: 9.5px;', '.footnote { font-size: 12px;'),
  ('<h3 style="font-size:13px">评审亮点</h3>', '<h3 style="font-size:14px">评审亮点</h3>'),
  ('<h3 style="font-size:13px;margin-top:11px">推断技术栈</h3>', '<h3 style="font-size:14px;margin-top:11px">推断技术栈</h3>'),
]
for a, b in repl:
    if a not in s:
        print('MISS:', a[:70])
    s = s.replace(a, b)

# ---- 标题去单词斜体 ----
s = s.replace('<h1>1024 造物挑战 <i>监控台</i></h1>', '<h1>1024 造物挑战监控台</h1>')

# ---- 点分隔 → 斜杠 ----
s = s.replace("'快照 <b id=\"snap-time\"></b> · 60s 轮询 · 同步正常'", "'快照 <b id=\"snap-time\"></b> / 60s 轮询 / 同步正常'")
s = s.replace("d: '占总量 ' + (st.newToday / st.poolTotal * 100).toFixed(1) + '% · 进行中'", "d: '占总量 ' + (st.newToday / st.poolTotal * 100).toFixed(1) + '% / 进行中'")
s = s.replace("d: '均值 ' + (analyses.reduce(function (s, a) { return s + a.total; }, 0) / analyses.length).toFixed(1) + ' 分 · glm-5.3-flash'",
              "d: '均值 ' + (analyses.reduce(function (s, a) { return s + a.total; }, 0) / analyses.length).toFixed(1) + ' 分 / glm-5.3-flash'")
s = s.replace("'<div class=\"meta\">#' + a.id + ' · ' + (w.author || '') + ' · ' + (w.form || '') + '</div>'",
              "'<div class=\"meta\">#' + a.id + ' / ' + (w.author || '') + ' / ' + (w.form || '') + '</div>'")
s = s.replace('数据：官方投稿池与作品墙公开表 · 2026-10-23 12:40 快照 · 上架率 = 已上架 / 投稿总量 = 23.1%',
              '数据：官方投稿池与作品墙公开表，2026-10-23 12:40 快照；上架率 = 已上架 / 投稿总量 = 23.1%')
s = s.replace('AI 评审：glm-5.3-flash，对齐官方评审细则（创意 35 + 完成度 40 + 体验 25，百分制）；评分基于公开信息推断，未实际运行作品，仅供社区参考。',
              'AI 评审：glm-5.3-flash，对齐官方评审细则（创意 35 + 完成度 40 + 体验 25，百分制）；评分基于公开信息推断，未实际运行作品，仅供社区参考。')

io.open(p, 'w', encoding='utf-8').write(s)
print('dir-3 done, changed:', s != orig)
