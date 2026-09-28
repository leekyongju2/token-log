#!/usr/bin/env node
// Appends token usage to <TOKEN_LOG_DIR>/<CLAUDE_USER>.csv. Never fails the session: errors go to stderr.
//
//   SessionEnd:           node log-usage.js            always writes
//   Stop (async):         node log-usage.js --interim  at most every INTERVAL, so sessions left open
//                                                      for weeks still show up
//
// Each row is the usage since the previous row of the same session (a delta), so rows can be summed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HEADER = 'ended_at,user,host,session_id,project,reason,models,requests,input,output,cache_write,cache_read,total,'
  + 'five_hour_start,five_hour_end,seven_day_start,seven_day_end,five_hour_resets_at,usd\n';
const HOME_DIR = path.join(os.homedir(), '.claude', 'token-log');
const STATE_DIR = path.join(HOME_DIR, 'state');
const RATE_DIR = path.join(HOME_DIR, 'rate');
const INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_MS = 45 * 24 * 60 * 60 * 1000;
const FIELDS = ['requests', 'input', 'output', 'cache_write', 'cache_read', 'usd'];

// Streams line by line: transcripts can exceed V8's 512MB string limit.
async function sumTranscript(file, byId) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m || !m.usage || !m.id) continue;
    byId.set(m.id, { model: m.model, u: m.usage }); // streamed blocks repeat the same id; keep last
  }
}

// The statusline can't use ${CLAUDE_PLUGIN_ROOT} and the plugin path changes per version,
// so keep a copy of snapshot.js at a fixed path for statusline scripts to require.
function installSnapshot() {
  const code = fs.readFileSync(path.join(__dirname, 'snapshot.js'), 'utf8');
  const dst = path.join(HOME_DIR, 'bin', 'snapshot.js');
  let cur = null;
  try { cur = fs.readFileSync(dst, 'utf8'); } catch {}
  if (cur === code) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, code);
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };

// Old per-session state and rate files (sessions nobody will resume) pile up otherwise.
function prune() {
  const cutoff = Date.now() - PRUNE_MS;
  for (const dir of [STATE_DIR, RATE_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      try { if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { force: true }); } catch {}
    }
  }
}

// Files made before the rate columns existed: swap in the new header so old rows read as blanks.
function upgradeHeader(file) {
  const text = fs.readFileSync(file, 'utf8');
  const nl = text.indexOf('\n');
  if (text.slice(0, nl + 1).replace(/^﻿/, '') === HEADER) return;
  fs.writeFileSync(file, '﻿' + HEADER + text.slice(nl + 1));
}

function csv(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One writer per session: the async Stop run and SessionEnd can overlap on the last turn.
// Interim gives up if busy; SessionEnd waits a little. A lock older than a minute is stale.
async function withLock(file, wait, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.closeSync(fs.openSync(file, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > 60000) { fs.rmSync(file, { force: true }); continue; } } catch {}
      if (!wait || i >= 50) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { await fn(); } finally { fs.rmSync(file, { force: true }); }
}

async function main(input, interim) {
  const sid = input.session_id;
  if (!sid || /[\\/]/.test(sid)) return;
  await withLock(path.join(STATE_DIR, `${sid}.lock`), !interim, () => logSession(input, interim, sid));
}

async function logSession(input, interim, sid) {
  const stateFile = path.join(STATE_DIR, `${sid}.json`);
  const state = readJson(stateFile) || { at: 0, tot: {} };
  if (interim && Date.now() - state.at < INTERVAL_MS) return;

  const byId = new Map();
  const t = input.transcript_path;
  if (t) {
    await sumTranscript(t, byId);
    // subagent transcripts live in <session>/subagents/*.jsonl next to the main file
    const subDir = path.join(t.replace(/\.jsonl$/, ''), 'subagents');
    if (fs.existsSync(subDir)) {
      for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) await sumTranscript(path.join(subDir, f), byId);
    }
  }

  const rateFile = path.join(RATE_DIR, `${sid}.json`);
  const rate = readJson(rateFile) || {};
  const first = rate.first || {};
  const last = rate.last || {};

  const tot = { requests: byId.size, input: 0, output: 0, cache_write: 0, cache_read: 0, usd: last.usd || 0 };
  const models = new Set();
  for (const { model, u } of byId.values()) {
    if (model && model !== '<synthetic>') models.add(model);
    tot.input += u.input_tokens || 0;
    tot.output += u.output_tokens || 0;
    tot.cache_write += u.cache_creation_input_tokens || 0;
    tot.cache_read += u.cache_read_input_tokens || 0;
  }
  const d = {};
  for (const k of FIELDS) d[k] = Math.max(0, tot[k] - (state.tot[k] || 0));
  if (d.requests === 0 && d.input + d.output + d.cache_write + d.cache_read === 0) return; // nothing new

  const user = process.env.CLAUDE_USER || `UNSET-${os.userInfo().username}`;
  const dir = process.env.TOKEN_LOG_DIR || HOME_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${user.replace(/[\\/:*?"<>|]/g, '_')}.csv`);
  const row = [
    new Date().toISOString(), user, os.hostname(), sid, input.cwd, interim ? 'interim' : input.reason,
    [...models].join('+'), d.requests,
    d.input, d.output, d.cache_write, d.cache_read,
    d.input + d.output + d.cache_write + d.cache_read,
    first.five_hour, last.five_hour, first.seven_day, last.seven_day, last.five_hour_resets_at,
    last.usd == null ? '' : Math.round(d.usd * 1e4) / 1e4,
  ].map(csv).join(',') + '\n';

  // 'wx' = create only: a concurrent first write can't truncate another session's row. BOM for Excel.
  try { fs.writeFileSync(file, '﻿' + HEADER, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  upgradeHeader(file);
  fs.appendFileSync(file, row);

  // Remember what was logged. State is kept after SessionEnd so a resumed session only logs what's new.
  writeJson(stateFile, { at: Date.now(), tot });
  if (rate.last) writeJson(rateFile, { first: rate.last, last: rate.last }); // next row starts where this one ended
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw || '{}');
    const interim = process.argv.includes('--interim');
    try { installSnapshot(); } catch (e) { process.stderr.write(`[token-log] snapshot: ${e.message}\n`); }
    await main(input, interim);
    if (!interim) prune();
  } catch (err) {
    process.stderr.write(`[token-log] ${err.message}\n`);
  }
});
