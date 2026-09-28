#!/usr/bin/env node
// SessionEnd hook: sum token usage from the session transcript and append one CSV row
// to <TOKEN_LOG_DIR>/<CLAUDE_USER>.csv. Never fails the session: all errors go to stderr.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HEADER = 'ended_at,user,host,session_id,project,reason,models,requests,input,output,cache_write,cache_read,total,'
  + 'five_hour_start,five_hour_end,seven_day_start,seven_day_end,five_hour_resets_at,usd\n';
const HOME_DIR = path.join(os.homedir(), '.claude', 'token-log');

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

// Rate-limit % the statusline saved for this session (account-wide, not per person).
// Kept on clear/resume because the same session id keeps going.
function takeRate(sid, reason) {
  const file = path.join(HOME_DIR, 'rate', `${sid}.json`);
  let r = {};
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return r; }
  if (reason !== 'clear' && reason !== 'resume') fs.rmSync(file, { force: true });
  return r;
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

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw || '{}');
    try { installSnapshot(); } catch (e) { process.stderr.write(`[token-log] snapshot: ${e.message}\n`); }
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
    if (byId.size === 0) return; // nothing to log (e.g. session exited immediately)

    const tot = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    const models = new Set();
    for (const { model, u } of byId.values()) {
      if (model && model !== '<synthetic>') models.add(model);
      tot.input += u.input_tokens || 0;
      tot.output += u.output_tokens || 0;
      tot.cache_write += u.cache_creation_input_tokens || 0;
      tot.cache_read += u.cache_read_input_tokens || 0;
    }
    const user = process.env.CLAUDE_USER || `UNSET-${os.userInfo().username}`;
    const dir = process.env.TOKEN_LOG_DIR || HOME_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${user.replace(/[\\/:*?"<>|]/g, '_')}.csv`);

    const rate = takeRate(input.session_id, input.reason);
    const first = rate.first || {};
    const last = rate.last || {};
    const row = [
      new Date().toISOString(), user, os.hostname(), input.session_id, input.cwd, input.reason,
      [...models].join('+'), byId.size,
      tot.input, tot.output, tot.cache_write, tot.cache_read,
      tot.input + tot.output + tot.cache_write + tot.cache_read,
      first.five_hour, last.five_hour, first.seven_day, last.seven_day, last.five_hour_resets_at, last.usd,
    ].map(csv).join(',') + '\n';

    // 'wx' = create only: a concurrent first write can't truncate another session's row. BOM for Excel.
    try { fs.writeFileSync(file, '﻿' + HEADER, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    upgradeHeader(file);
    fs.appendFileSync(file, row);
  } catch (err) {
    process.stderr.write(`[token-log] ${err.message}\n`);
  }
});
