#!/usr/bin/env node
// Statusline side: save the account's rate-limit % for this session so SessionEnd can log it.
// SessionEnd input has no rate_limits; only the statusline input does.
//
// Existing statusline: add one line after parsing input
//   try { require(require('os').homedir() + '/.claude/token-log/bin/snapshot.js')(input); } catch {}
// No statusline: "statusLine": { "type": "command", "command": "node ~/.claude/token-log/bin/snapshot.js" }
const fs = require('fs');
const path = require('path');
const os = require('os');

const RATE_DIR = path.join(os.homedir(), '.claude', 'token-log', 'rate');

function snapshot(input) {
  const sid = input && input.session_id;
  const rl = (input && input.rate_limits) || {};
  if (!sid || /[\\/]/.test(sid)) return;
  // resets_at arrives as unix seconds
  const iso = (t) => (typeof t === 'number' ? new Date(t * 1000).toISOString() : t || null);
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? w.used_percentage : null);
  const now = {
    five_hour: pct(rl.five_hour), seven_day: pct(rl.seven_day),
    five_hour_resets_at: iso(rl.five_hour && rl.five_hour.resets_at),
    usd: input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null,
  };
  const file = path.join(RATE_DIR, `${sid}.json`);
  let first = null;
  try { first = JSON.parse(fs.readFileSync(file, 'utf8')).first; } catch {}
  // Keep the first reading that has a %, so a start value arriving late still counts.
  if (!first || first.five_hour == null) first = now;
  fs.mkdirSync(RATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ first, last: now }));
}

module.exports = snapshot;

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw); snapshot(input); } catch {}
    const rl = input.rate_limits || {};
    const p = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '-');
    process.stdout.write(`5h ${p(rl.five_hour)} · 7d ${p(rl.seven_day)}`);
  });
}
