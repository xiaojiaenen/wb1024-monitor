import io, re

p = 'dir-2.html'
s = io.open(p, encoding='utf-8').read()
orig = s

# ---- 颜色 ----
s = s.replace('--muted: #8d8378;', '--muted: #6E6257;')
s = s.replace('.lg-row .rk { font-family: "Playfair Display", serif; font-size: 19px; font-weight: 600; text-align: center; color: #B7AA9C; }',
              '.lg-row .rk { font-family: "Playfair Display", serif; font-size: 19px; font-weight: 600; text-align: center; color: #7A6B5C; }')

# ---- 柱状图标签飞出柱体（避免 ink-on-claret 假阳性 + 真实可读）----
s = s.replace(""".bars .b .lab { position: absolute; top: -19px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }""",
""".bars .lab { position: absolute; bottom: calc(100% - 0px); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; transform: translateX(-50%); }""")

old_bars_css = """  .bars { display: flex; align-items: flex-end; gap: 22px; height: 118px; padding: 0 6px; border-bottom: 1px solid var(--hair); position: relative; }
  .bars .b { flex: 1; background: var(--ink); position: relative; }"""
new_bars_css = """  .bars { display: flex; align-items: flex-end; gap: 22px; height: 118px; padding: 0 6px; border-bottom: 1px solid var(--hair); position: relative; }
  .bars .b { flex: 1; background: var(--ink); position: relative; }
  .bars .bl { position: absolute; bottom: 100%; left: 50%; }"""
if old_bars_css not in s: print('MISS bars css')
s = s.replace(old_bars_css, new_bars_css)

# JS：标签移出 .b，成为 .bl 绝对定位（按柱高定位）
old_js = """  $('daily-bars').innerHTML = trend.map(function (t, i) {
    var h = Math.max(2, Math.round(t.count / maxT * 100));
    var cls = i === trend.length - 1 ? 'now' : (t.count > 1000 ? 'hi' : '');
    return '<div class="b ' + cls + '" style="height:' + h + '%"><span class="lab">' + t.count.toLocaleString() + '</span></div>';
  }).join('');"""
new_js = """  var barW = 100 / trend.length;
  $('daily-bars').innerHTML = trend.map(function (t, i) {
    var h = Math.max(2, Math.round(t.count / maxT * 100));
    var cls = i === trend.length - 1 ? 'now' : (t.count > 1000 ? 'hi' : '');
    var left = (i * barW + barW / 2) + '%';
    return '<div class="b ' + cls + '" style="height:' + h + '%"></div>' +
      '<span class="lab" style="left:' + left + ';bottom:calc(' + h + '% + 5px)">' + t.count.toLocaleString() + '</span>';
  }).join('');"""
if old_js not in s: print('MISS bars js')
s = s.replace(old_js, new_js)

# ---- 字号 ----
repl = [
  ('.mast .kick { font-size: 9px;', '.mast .kick { font-size: 12px;'),
  ('.mast .edition { position: absolute; right: 20px; top: 16px; font-size: 9px;', '.mast .edition { position: absolute; right: 20px; top: 16px; font-size: 12px;'),
  ('.mast .date { position: absolute; left: 20px; top: 16px; font-size: 10px;', '.mast .date { position: absolute; left: 20px; top: 16px; font-size: 12px;'),
  ('.navbar a { font-size: 11px;', '.navbar a { font-size: 12px;'),
  ('.notice { display: flex; align-items: center; gap: 8px; padding: 6px 22px; font-size: 10.5px;',
   '.notice { display: flex; align-items: center; gap: 8px; padding: 7px 22px; font-size: 14px;'),
  ('.kpi .k { font-size: 9px;', '.kpi .k { font-size: 12px;'),
  ('.kpi .s { font-size: 10px;', '.kpi .s { font-size: 12px;'),
  ('.card-h .kick { font-size: 8.5px;', '.card-h .kick { font-size: 12px;'),
  ('.xax span { flex: 1; text-align: center; font-size: 9.5px;', '.xax span { flex: 1; text-align: center; font-size: 12px;'),
  ('.feed .row { display: grid; grid-template-columns: 1fr 56px 52px; gap: 8px; align-items: center; padding: 6.5px 13px; border-bottom: 1px dotted #E4DCD2; font-size: 11.5px; }',
   '.feed .row { display: grid; grid-template-columns: 1fr 62px 56px; gap: 8px; align-items: center; padding: 7px 13px; border-bottom: 1px dotted #E4DCD2; font-size: 12px; }'),
  ('.feed .row .nm small { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: 10px; }',
   '.feed .row .nm small { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: 12px; }'),
  ('.feed .row .st { font-size: 9.5px;', '.feed .row .st { font-size: 12px;'),
  ('.feed .row .t { font-size: 10px;', '.feed .row .t { font-size: 12px;'),
  ('.funnel .fr { display: flex; align-items: center; gap: 10px; font-size: 11.5px; }',
   '.funnel .fr { display: flex; align-items: center; gap: 10px; font-size: 12px; }'),
  ('.funnel .fr .lb { width: 52px; color: var(--muted); font-size: 10.5px; }', '.funnel .fr .lb { width: 56px; color: var(--muted); font-size: 12px; }'),
  ('.wcard .shot .no { position: absolute; left: 0; bottom: 0; background: var(--ink); color: var(--paper); font-size: 10px;',
   '.wcard .shot .no { position: absolute; left: 0; bottom: 0; background: var(--ink); color: var(--paper); font-size: 12px;'),
  ('.wcard .info .au { font-size: 9.5px;', '.wcard .info .au { font-size: 12px;'),
  ('.lg-head, .lg-row { display: grid; grid-template-columns: 40px 1.6fr 1fr 66px; gap: 10px; align-items: center; padding: 8px 14px; }',
   '.lg-head, .lg-row { display: grid; grid-template-columns: 44px 1.6fr 1.1fr 70px; gap: 10px; align-items: center; padding: 9px 14px; }'),
  ('.lg-head { border-bottom: 2px solid var(--ink); font-size: 9px;', '.lg-head { border-bottom: 2px solid var(--ink); font-size: 12px;'),
  ('.lg-row .nm small { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: 10px; }',
   '.lg-row .nm small { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: 12px; }'),
  ('.lg-row .nm .sm { display: block; font-size: 9.5px;', '.lg-row .nm .sm { display: block; font-size: 12px;'),
  ('.lg-row .sub { font-size: 10px;', '.lg-row .sub { font-size: 12px;'),
  ('.lg-row .sc small { font-size: 9px;', '.lg-row .sc small { font-size: 12px;'),
  ('.lg-reason { display: none; padding: 0 14px 12px 64px; font-size: 11px; line-height: 1.65;',
   '.lg-reason { display: none; padding: 0 14px 13px 68px; font-size: 14px; line-height: 1.65;'),
  ('.lg-reason .bars2 span { font-size: 10px;', '.lg-reason .bars2 span { font-size: 12px;'),
  ('.foot-tick { height: 26px; background: var(--ink); color: var(--paper); display: flex; align-items: center; padding: 0 22px; font-size: 10px;',
   '.foot-tick { height: 28px; background: var(--ink); color: var(--paper); display: flex; align-items: center; padding: 0 22px; font-size: 12px;'),
]
for a, b in repl:
    if a not in s:
        print('MISS:', a[:70])
    s = s.replace(a, b)

# ---- kicker 去内嵌点号（FT 锁定字保留）----
s = s.replace('COMMUNITY MONITOR · UNOFFICIAL', 'COMMUNITY MONITOR（非官方）')
s = s.replace('SUBMISSION FLOW · 投稿池', 'SUBMISSION FLOW')
s = s.replace('LEAGUE TABLE · 对齐官方细则', 'LEAGUE TABLE')
s = s.replace('ALL SUBMISSIONS · 最新在前', 'ALL SUBMISSIONS')
s = s.replace('<span class="kick">SUBMISSION FLOW</span>', '<span class="kick">SUBMISSION FLOW 投稿池</span>')
s = s.replace('<span class="kick">LEAGUE TABLE</span>', '<span class="kick">LEAGUE TABLE 对齐官方细则</span>')

# ---- 数据分隔点 → 斜杠 ----
s = s.replace("'网页 ' + st.webApps + ' · 小程序 ' + st.miniApps", "'网页 ' + st.webApps + ' / 小程序 ' + st.miniApps")
s = s.replace("'已通过 ' + st.poolApproved + ' · 已驳回 ' + st.poolRejected", "'已通过 ' + st.poolApproved + ' / 已驳回 ' + st.poolRejected")
s = s.replace("$('foot-item').textContent = '#' + (649 - Math.floor(Math.random() * 3)) + ' ' + feedData[0].name + ' · ' + feedData[0].status;",
              "$('foot-item').textContent = '#' + (649 - Math.floor(Math.random() * 3)) + ' ' + feedData[0].name + '（' + feedData[0].status + '）';")

# ---- 侧栏内联字号 ----
s = s.replace("font-size:10px;padding:2px 8px\">#' + a.id", "font-size:12px;padding:2px 8px\">#' + a.id")
s = s.replace("<div style=\"font-size:10px;color:var(--muted);margin-top:3px\">", "<div style=\"font-size:12px;color:var(--muted);margin-top:3px\">")
s = s.replace("<span style=\"font-size:11px;color:var(--muted)\">/ 100 · 创意35 + 完成度40 + 体验25</span>",
              "<span style=\"font-size:12px;color:var(--muted)\">/ 100（创意35 + 完成度40 + 体验25）</span>")
s = s.replace("<div style=\"padding:11px 13px;font-size:12px;line-height:1.7\">' + a.summary + '</div>",
              "<div style=\"padding:11px 13px;font-size:14px;line-height:1.7\">' + a.summary + '</div>")

io.open(p, 'w', encoding='utf-8').write(s)
print('dir-2 done, changed:', s != orig)
