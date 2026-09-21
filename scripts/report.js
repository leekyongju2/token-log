#!/usr/bin/env node
// Aggregate all <TOKEN_LOG_DIR>/*.csv into per-user and per-day tables.
// Usage: node report.js [--since YYYY-MM-DD] [--user NAME]
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const since = opt('--since');
const onlyUser = opt('--user');
const dir = process.env.TOKEN_LOG_DIR || path.join(os.homedir(), '.claude', 'token-log');

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

if (!fs.existsSync(dir)) { console.log(`로그 폴더 없음: ${dir}`); process.exit(0); }

// A resumed session logs again with cumulative totals, so keep the largest row per session_id.
const sessions = new Map();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.csv'))) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '').split('\n').filter(Boolean);
  const head = parseLine(lines[0]);
  for (const l of lines.slice(1)) {
    const cols = parseLine(l);
    const r = Object.fromEntries(head.map((h, i) => [h, cols[i]]));
    for (const k of ['requests', 'input', 'output', 'cache_write', 'cache_read', 'total']) r[k] = Number(r[k]) || 0;
    const prev = sessions.get(r.session_id);
    if (!prev || r.total > prev.total) sessions.set(r.session_id, r);
  }
}

const rows = [...sessions.values()].filter((r) =>
  (!since || r.ended_at >= since) && (!onlyUser || r.user === onlyUser));

function table(title, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const a = g.get(k) || { sessions: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0 };
    a.sessions++; for (const f of ['input', 'output', 'cache_write', 'cache_read', 'total']) a[f] += r[f];
    g.set(k, a);
  }
  const n = (x) => x.toLocaleString('en-US');
  console.log(`\n### ${title}\n`);
  console.log('| 구분 | 세션 | input | output | cache_write | cache_read | total |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, a] of [...g].sort((x, y) => y[1].total - x[1].total))
    console.log(`| ${k} | ${a.sessions} | ${n(a.input)} | ${n(a.output)} | ${n(a.cache_write)} | ${n(a.cache_read)} | ${n(a.total)} |`);
}

console.log(`로그 폴더: ${dir} · 세션 ${rows.length}개${since ? ` · ${since} 이후` : ''}`);
if (rows.length) {
  table('사용자별', (r) => r.user);
  table('일자별', (r) => r.ended_at.slice(0, 10));
}
