#!/usr/bin/env node
// SessionEnd hook: sum token usage from the session transcript and append one CSV row
// to <TOKEN_LOG_DIR>/<CLAUDE_USER>.csv. Never fails the session: all errors go to stderr.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HEADER = 'ended_at,user,host,session_id,project,reason,models,requests,input,output,cache_write,cache_read,total\n';

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

function csv(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw || '{}');
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
    const dir = process.env.TOKEN_LOG_DIR || path.join(os.homedir(), '.claude', 'token-log');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${user.replace(/[\\/:*?"<>|]/g, '_')}.csv`);

    const row = [
      new Date().toISOString(), user, os.hostname(), input.session_id, input.cwd, input.reason,
      [...models].join('+'), byId.size,
      tot.input, tot.output, tot.cache_write, tot.cache_read,
      tot.input + tot.output + tot.cache_write + tot.cache_read,
    ].map(csv).join(',') + '\n';

    // 'wx' = create only: a concurrent first write can't truncate another session's row. BOM for Excel.
    try { fs.writeFileSync(file, '﻿' + HEADER, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.appendFileSync(file, row);
  } catch (err) {
    process.stderr.write(`[token-log] ${err.message}\n`);
  }
});
