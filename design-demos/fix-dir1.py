import re, io

p = 'dir-1.html'
s = io.open(p, encoding='utf-8').read()
orig = s

# ---- 颜色 ----
s = s.replace('--muted: #8A8578;', '--muted: #6B655A;')
s = s.replace('--panel: #FFFFFF; --ok: #1F7A4D; --warn: #B26A00;',
              '--panel: #FFFFFF; --ok: #1F7A4D; --warn: #8F5400; --signal-text: #C43A14;')
s = s.replace('color: #C4BFB2; text-align: center;', 'color: #6E685C; text-align: center;')
s = s.replace('table.board tr.sel .rk, table.board .rk.top { color: var(--signal); }',
              'table.board .rk.top { color: var(--signal-text); }')
s = s.replace('table.board tr.sel .rk { color: var(--signal); }',
              'table.board tr.sel .rk { color: var(--bg); }')
s = s.replace('.d-head .no { font-family: Oswald; font-size: 12px; color: var(--signal);',
              '.d-head .no { font-family: Oswald; font-size: 12px; color: var(--signal-text);')

# ---- 字号 ----
repl = [
  ('.rail .it { width: 48px; height: 46px;', '.rail .it { width: 48px; height: 52px;'),
  ('gap: 3px; font-size: 9px; color: var(--muted);', 'gap: 3px; font-size: 12px; color: var(--muted);'),
  ('.band .live { display: flex; align-items: center; padding: 0 18px; font-size: 11px;',
   '.band .live { display: flex; align-items: center; padding: 0 18px; font-size: 12px;'),
  ('.notice { height: 26px; display: flex; align-items: center; gap: 8px; padding: 0 16px; font-size: 11px;',
   '.notice { height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 16px; font-size: 14px;'),
  ('.kpi .k { font-size: 10px;', '.kpi .k { font-size: 12px;'),
  ('.kpi .s { font-size: 10px;', '.kpi .s { font-size: 12px;'),
  ('.panel-h .meta { font-size: 10px;', '.panel-h .meta { font-size: 12px;'),
  ('.nm .no { font-weight: 400; font-size: 10.5px;', '.nm .no { font-weight: 400; font-size: 12px;'),
  ('.sub { font-size: 10.5px;', '.sub { font-size: 12px;'),
  ('.sc small { font-size: 10px;', '.sc small { font-size: 12px;'),
  ('font-family: Oswald; font-size: 11px; padding: 2px 7px; letter-spacing: .04em; }',
   'font-family: Oswald; font-size: 12px; padding: 2px 7px; letter-spacing: .04em; }'),
  ('background: var(--signal); color: #fff; font-size: 9px; padding: 2px 6px; letter-spacing: .1em; }',
   'background: var(--signal); color: #fff; font-size: 12px; padding: 2px 7px; }'),
  ('.wcard .info .nm { font-size: 11.5px;', '.wcard .info .nm { font-size: 12px;'),
  ('.wcard .info .au { font-size: 9.5px;', '.wcard .info .au { font-size: 12px;'),
  ('.tick-item .au { font-size: 10px;', '.tick-item .au { font-size: 12px;'),
  ('.tick-item .st { font-size: 10px;', '.tick-item .st { font-size: 12px;'),
  ('.tick-item .t { font-size: 10px;', '.tick-item .t { font-size: 12px;'),
  ('.d-head .au { font-size: 11px;', '.d-head .au { font-size: 12px; }'),
  ('.d-total .tag { font-size: 10px;', '.d-total .tag { font-size: 12px;'),
  ('.bar-row .lb { font-size: 11px;', '.bar-row .lb { font-size: 12px;'),
  ('.bar-row .val small { font-size: 10px;', '.bar-row .val small { font-size: 12px;'),
  ('.d-sec p { font-size: 12.5px; line-height: 1.65; }', '.d-sec p { font-size: 14px; line-height: 1.65; }'),
  ('.d-sec li { font-size: 12px;', '.d-sec li { font-size: 14px;'),
  ('.chips span { font-size: 10.5px;', '.chips span { font-size: 12px;'),
]
for a, b in repl:
    if a not in s:
        print('MISS:', a[:70])
    s = s.replace(a, b)

# ---- 删 rail 装饰字 ----
s = s.replace('\n    <div class="foot">1024 · MONITOR</div>', '')
s = re.sub(r'\s*\.rail \.foot \{[^}]*\}\n', '\n', s)

# ---- 点分隔改斜杠 / 中文标点 ----
s = s.replace("'网页 ' + D.stats.webApps + ' · 小程序 ' + D.stats.miniApps",
              "'网页 ' + D.stats.webApps + ' / 小程序 ' + D.stats.miniApps")
s = s.replace("'已通过 ' + D.stats.poolApproved + ' · 已驳回 ' + D.stats.poolRejected",
              "'已通过 ' + D.stats.poolApproved + ' / 已驳回 ' + D.stats.poolRejected")
s = s.replace('社区非官方监控台 · 数据取自官方公开页面，若官方调整页面结构可能导致数据中断，届时以官方页面为准',
              '社区非官方监控台，数据取自官方公开页面；若官方调整页面结构可能导致数据中断，届时以官方页面为准')

# ---- JS：时钟行；详情 meta 拆行 ----
s = s.replace("$('clock').textContent = 'LIVE · ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' · 60s 同步';",
              "$('clock').textContent = 'LIVE ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' 同步间隔 60s';")

old_au = """'<div class="au">作者 <b>' + (works.filter(function (w) { return String(w.cardNo) === String(a.id); })[0] || {}).author + '</b> · AI 评审 <b>glm-5.3-flash</b> · 对齐官方评审细则</div></div>' +"""
new_au = """'<div class="au">作者 <b>' + (works.filter(function (w) { return String(w.cardNo) === String(a.id); })[0] || {}).author + '</b>，' + (works.filter(function (w) { return String(w.cardNo) === String(a.id); })[0] || {}).form + '</div>' +
      '<div class="au meta">AI 评审 glm-5.3-flash，对齐官方评审细则</div></div>' +"""
if old_au not in s:
    print('MISS: au line')
s = s.replace(old_au, new_au)

io.open(p, 'w', encoding='utf-8').write(s)
print('dir-1 done, changed:', s != orig)
