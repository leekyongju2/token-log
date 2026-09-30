#!/usr/bin/env node
// Aggregate the record files under the log folder into per-user and per-day tables.
// Usage: node report.js [--dir FOLDER] [--since YYYY-MM-DD] [--user NAME]
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const since = opt('--since');
const onlyUser = opt('--user');
// --dir comes from the skill as ${user_config.log_dir}; empty when not configured.
const dir = (opt('--dir') || '').trim() || process.env.TOKEN_LOG_DIR || path.join(os.homedir(), '.claude', 'token-log');

if (!fs.existsSync(dir)) { console.log(`로그 폴더 없음: ${dir}`); process.exit(0); }

// Records are deltas (usage since the previous record of that session), so they just add up.
// Layout: <dir>/<YYYY-MM>/<name>/*.txt, one JSON line each. Month folders before --since are skipped.
const rise = (a, b) => (a == null || b == null || a === '' || b === '' ? 0 : Number(b) >= Number(a) ? Number(b) - Number(a) : Number(b));
const all = [];
for (const month of fs.readdirSync(dir).filter((m) => /^\d{4}-\d{2}$/.test(m) && (!since || m >= since.slice(0, 7)))) {
  for (const f of fs.readdirSync(path.join(dir, month), { recursive: true })) {
    if (!String(f).endsWith('.txt')) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, month, String(f)), 'utf8')); } catch { continue; } // half-synced or foreign file
    for (const k of ['requests', 'input', 'output', 'cache_write', 'cache_read', 'total']) r[k] = Number(r[k]) || 0;
    // Rise in account-wide % during the record. A drop means the window reset in between: count the end value.
    r.d5h = rise(r.five_hour_start, r.five_hour_end);
    r.d7d = rise(r.seven_day_start, r.seven_day_end);
    r.usd = Number(r.usd) || 0;
    all.push(r);
  }
}

const rows = all.filter((r) =>
  (!since || r.ended_at >= since) && (!onlyUser || r.user === onlyUser));

function table(title, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const a = g.get(k) || { ids: new Set(), input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0, usd: 0, d5h: 0, d7d: 0 };
    a.ids.add(r.session_id); for (const f of ['input', 'output', 'cache_write', 'cache_read', 'total', 'usd', 'd5h', 'd7d']) a[f] += r[f];
    g.set(k, a);
  }
  const n = (x) => x.toLocaleString('en-US');
  console.log(`\n### ${title}\n`);
  console.log('| 구분 | 세션 | input | output | cache_write | cache_read | total | API환산$ | 5h한도+%p | 7d한도+%p |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [k, a] of [...g].sort((x, y) => y[1].total - x[1].total))
    console.log(`| ${k} | ${a.ids.size} | ${n(a.input)} | ${n(a.output)} | ${n(a.cache_write)} | ${n(a.cache_read)} | ${n(a.total)} | ${a.usd.toFixed(2)} | ${a.d5h.toFixed(0)} | ${a.d7d.toFixed(0)} |`);
}

console.log(`로그 폴더: ${dir} · 세션 ${new Set(rows.map((r) => r.session_id)).size}개${since ? ` · ${since} 이후` : ''}`);
// Latest account-wide reading across everyone's rows.
const lastRate = rows.filter((r) => r.five_hour_end !== '' && r.five_hour_end != null)
  .sort((a, b) => (a.ended_at < b.ended_at ? 1 : -1))[0];
if (lastRate) {
  const reset = lastRate.five_hour_resets_at ? new Date(lastRate.five_hour_resets_at).toLocaleString('ko-KR') : '-';
  console.log(`계정 한도 (${lastRate.ended_at.slice(0, 16).replace('T', ' ')} UTC 기준): 5h ${Math.round(lastRate.five_hour_end)}% · 7d ${Math.round(lastRate.seven_day_end)}% · 5h 초기화 ${reset}`);
  console.log('한도+%p 는 세션 동안 계정 전체 %가 오른 폭이다. 공유 계정이라 같은 시간에 쓴 남의 몫이 섞인 추정치.');
}
if (rows.length) {
  table('사용자별', (r) => r.user);
  table('일자별', (r) => r.ended_at.slice(0, 10));
}
