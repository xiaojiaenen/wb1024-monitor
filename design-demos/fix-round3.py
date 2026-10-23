import io

# ---------- dir-3：small 标签显式 12px ----------
p = 'dir-3.html'
s = io.open(p, encoding='utf-8').read()
pairs3 = [
  ('.feed .row .nm small { color: var(--muted); margin-left: 7px; }',
   '.feed .row .nm small { color: var(--muted); margin-left: 7px; font-size: 12px; }'),
  ('table.rt .nm small { display: block; font-weight: 400; color: var(--muted); margin-top: 1px; }',
   'table.rt .nm small { display: block; font-weight: 400; color: var(--muted); margin-top: 1px; font-size: 12px; }'),
]
for a, b in pairs3:
    if a not in s: print('MISS3:', a[:50])
    s = s.replace(a, b)
io.open(p, 'w', encoding='utf-8').write(s)
print('dir-3 ok')

# ---------- dir-1：骨架差异化——面板回到纸底（Aicher 无白卡片） ----------
p = 'dir-1.html'
s = io.open(p, encoding='utf-8').read()
pairs1 = [
  # 面板不再用白底，纸底 + 发丝线（结构上区别于 FT 的白卡片浮起）
  ('.panel { border: 1px solid var(--hair); background: var(--panel); display: flex; flex-direction: column; min-height: 0; }',
   '.panel { border: 1px solid var(--hair); background: transparent; display: flex; flex-direction: column; min-height: 0; }'),
  ('table.board tr:hover td { background: #F6F3EA; }', 'table.board tr:hover td { background: #F0EDE4; }'),
  ('.wcard { border: 1px solid var(--hair); background: #fff; cursor: pointer; position: relative; }',
   '.wcard { border: 1px solid var(--hair); background: transparent; cursor: pointer; position: relative; }'),
  ('.ticker { display: flex; align-items: stretch; border: 1px solid var(--hair); background: var(--panel); flex-shrink: 0; height: 62px; overflow: hidden; }',
   '.ticker { display: flex; align-items: stretch; border: 1px solid var(--hair); background: transparent; flex-shrink: 0; height: 62px; overflow: hidden; }'),
  # --panel 变量改为纸色系（保留定义但不再当白卡片用）
  ('--panel: #FFFFFF;', '--panel: #FBFAF7;'),
]
for a, b in pairs1:
    if a not in s: print('MISS1:', a[:60])
    s = s.replace(a, b)
io.open(p, 'w', encoding='utf-8').write(s)
print('dir-1 ok')
