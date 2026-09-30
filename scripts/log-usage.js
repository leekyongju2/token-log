#!/usr/bin/env node
// Writes token usage records under <log folder> (see writeRecord). Never fails the session: errors go to stderr.
//
//   SessionEnd:           node log-usage.js            best effort (see catchUp)
//   SessionStart (async): node log-usage.js --catchup  logs what earlier sessions used after their last row
//   Stop (async):         node log-usage.js --interim  at most every INTERVAL, so sessions left open
//                                                      for weeks still show up
//
// Each record is the usage since the previous record of the same session (a delta), so records can be summed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME_DIR = path.join(os.homedir(), '.claude', 'token-log');
const STATE_DIR = path.join(HOME_DIR, 'state');
const RATE_DIR = path.join(HOME_DIR, 'rate');
// Settings come from the plugin's config dialog (/plugin configure token-log), which Claude Code
// passes to hooks as CLAUDE_PLUGIN_OPTION_*. The older CLAUDE_USER / TOKEN_LOG_DIR env vars still work.
const opt = (k) => (process.env[`CLAUDE_PLUGIN_OPTION_${k}`] || '').trim();
const INTERVAL_MS = (Number(opt('INTERVAL_MIN')) || 10) * 60 * 1000;
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

// One new file per record, never edited afterwards: OneDrive/SharePoint sync only conflicts when
// two places change the same file, so create-only writes can't conflict.
//   <log folder>/<YYYY-MM>/<name>/<time>_<host>_<session>_<reason>.txt   (one JSON line)
function writeRecord(rec, now) {
  const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]/g, '_');
  const root = opt('LOG_DIR') || process.env.TOKEN_LOG_DIR || HOME_DIR;
  const dir = path.join(root, now.toISOString().slice(0, 7), safe(rec.user));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '');
  const base = `${stamp}_${safe(rec.host)}_${rec.session_id.slice(0, 8)}_${safe(rec.reason || 'end')}`;
  for (let i = 0; ; i++) {
    try { return fs.writeFileSync(path.join(dir, `${base}${i ? '_' + i : ''}.txt`), JSON.stringify(rec) + '\n', { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST' || i > 20) throw e; }
  }
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

async function main(input, mode) {
  const sid = input.session_id;
  if (!sid || /[\/]/.test(sid)) return;
  await withLock(path.join(STATE_DIR, `${sid}.lock`), mode === 'end', () => logSession(input, mode, sid));
}

// SessionEnd hooks from plugins get killed after ~1.5s whatever their timeout says, and node alone
// takes ~1s to start on Windows, so the exit row is best effort. The next session start picks up
// whatever earlier sessions used after their last row.
async function catchUp(currentSid) {
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json')); } catch { return; }
  for (const n of names) {
    const sid = n.slice(0, -5);
    if (sid === currentSid) continue;
    const st = readJson(path.join(STATE_DIR, n));
    if (!st || !st.transcript) continue;
    let mtime = 0;
    try { mtime = fs.statSync(st.transcript).mtimeMs; } catch { continue; }
    if (mtime <= st.at) continue; // nothing written since the last row
    await main({ session_id: sid, transcript_path: st.transcript, cwd: st.cwd }, 'catchup');
  }
}

async function logSession(input, mode, sid) {
  const stateFile = path.join(STATE_DIR, `${sid}.json`);
  const state = readJson(stateFile) || { at: 0, tot: {} };
  if (mode === 'interim' && Date.now() - state.at < INTERVAL_MS) return;

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

  const user = opt('USER_NAME') || process.env.CLAUDE_USER || `UNSET-${os.userInfo().username}`;
  const now = new Date();
  const rec = {
    ended_at: now.toISOString(), user, host: os.hostname(), session_id: sid, project: input.cwd,
    reason: mode === 'end' ? input.reason : mode, models: [...models].join('+'), requests: d.requests,
    input: d.input, output: d.output, cache_write: d.cache_write, cache_read: d.cache_read,
    total: d.input + d.output + d.cache_write + d.cache_read,
    five_hour_start: first.five_hour ?? null, five_hour_end: last.five_hour ?? null,
    seven_day_start: first.seven_day ?? null, seven_day_end: last.seven_day ?? null,
    five_hour_resets_at: last.five_hour_resets_at ?? null,
    usd: last.usd == null ? null : Math.round(d.usd * 1e4) / 1e4,
  };
  writeRecord(rec, now);

  // Remember what was logged (and where the transcript is, for catch-up). Kept after SessionEnd
  // so a resumed session only logs what's new.
  writeJson(stateFile, { at: Date.now(), tot, transcript: input.transcript_path, cwd: input.cwd });
  if (rate.last) writeJson(rateFile, { first: rate.last, last: rate.last }); // next row starts where this one ended
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw || '{}');
    const mode = process.argv.includes('--interim') ? 'interim' : process.argv.includes('--catchup') ? 'catchup' : 'end';
    try { installSnapshot(); } catch (e) { process.stderr.write(`[token-log] snapshot: ${e.message}\n`); }
    if (mode === 'catchup') { await catchUp(input.session_id); prune(); }
    else await main(input, mode);
  } catch (err) {
    process.stderr.write(`[token-log] ${err.message}\n`);
  }
});
