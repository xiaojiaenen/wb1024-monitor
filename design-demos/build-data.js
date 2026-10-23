/* 冻结演示数据构建脚本：snapshot-raw.json + analyses.json → data.js（真实数据快照，供三个方向初稿共用） */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot-raw.json'), 'utf8'));
const analyses = JSON.parse(fs.readFileSync(path.join(dir, 'analyses.json'), 'utf8'));

/* 最新作品（按 cardNo 降序）取 12 件，每件带首张截图 */
const latestWorks = (snap.works || [])
  .slice()
  .sort((a, b) => (b.cardNo || 0) - (a.cardNo || 0))
  .slice(0, 12)
  .map((w) => ({
    id: w.id,
    cardNo: w.cardNo,
    name: w.name,
    author: w.author,
    form: w.form,
    platform: w.platform || '',
    highlight: (w.highlight || '').slice(0, 80),
    shot: (w.shots && w.shots[0] && w.shots[0].url) || ''
  }));

/* 最近投稿流水取 8 条 */
const recent = (snap.recentSubmissions || []).slice(0, 8).map((r) => ({
  name: r.name, author: r.author, form: r.form, status: r.status,
  submittedAt: r.submittedAt, highlight: (r.highlight || '').slice(0, 60)
}));

/* 历史序列取最后 48 个点（约 48 分钟）用于 sparkline */
const history = (snap.history || []).slice(-48).map((h) => ({ t: h.t, wall: h.wall, pool: h.pool }));

const data = {
  generatedAt: snap.generatedAt,
  activity: snap.activity,
  stats: snap.stats,
  poolBreakdown: snap.poolBreakdown,
  latestWorks,
  recent,
  history,
  analyses
};

const out = '/* 冻结于 ' + new Date().toISOString() + ' — 来自 /api/snapshot 与云数据库 analyses 表的真实数据 */\n' +
  'window.DEMO_DATA = ' + JSON.stringify(data, null, 1) + ';\n';
fs.writeFileSync(path.join(dir, 'data.js'), out);
console.log('data.js written:', out.length, 'bytes;', 'works:', latestWorks.length, 'analyses:', analyses.length, 'history:', history.length);
