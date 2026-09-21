// Regression check for issues found while building this plugin. Run: node test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const HOOK = path.join(__dirname, 'scripts', 'log-usage.js');
const REPORT = path.join(__dirname, 'scripts', 'report.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-log-test-'));
const logDir = path.join(tmp, 'logs');

// Fixture transcript: streamed blocks repeat one message id, plus a broken line and a subagent file.
const u = (i, o, cw, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });
const msg = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
const transcript = path.join(tmp, 'sess.jsonl');
fs.writeFileSync(transcript, [
  msg('m1', 'claude-opus-5', u(10, 100, 1000, 10000)),
  msg('m1', 'claude-opus-5', u(10, 100, 1000, 10000)), // same id: count once
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi "usage"' } }),
  '{"usage": broken json',
  msg('m2', 'claude-opus-5', u(1, 2, 3, 4)),
].join('\n'));
fs.mkdirSync(path.join(tmp, 'sess', 'subagents'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'sess', 'subagents', 'agent-a.jsonl'), msg('s1', 'claude-haiku-4-5', u(5, 5, 5, 5)));

const runHook = (user, sessionId) => new Promise((resolve, reject) => {
  const env = { ...process.env, TOKEN_LOG_DIR: logDir };
  if (user) env.CLAUDE_USER = user; else delete env.CLAUDE_USER;
  const p = spawn(process.execPath, [HOOK], { env });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => (code === 0 && !err ? resolve() : reject(new Error(err || `exit ${code}`))));
  p.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: 'C:\\프로젝트, "A"', reason: 'exit' }));
});

(async () => {
  // Default SessionEnd timeout is 1.5s and node startup alone can take ~1s on Windows.
  const hook = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionEnd[0].hooks[0];
  assert.ok(hook.timeout >= 10, 'hooks.json must set a SessionEnd timeout');

  // Concurrent first writes to one file: header written once, no row lost.
  await Promise.all(Array.from({ length: 10 }, (_, i) => runHook('홍길동', `s${i}`)));
  const lines = fs.readFileSync(path.join(logDir, '홍길동.csv'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.filter((l) => l.includes('ended_at')).length, 1, 'one header');
  assert.strictEqual(lines.length, 11, '10 rows + header');

  // Totals: m1 once + m2 + subagent s1; comma/quote in cwd stays one CSV field.
  const row = lines[1];
  assert.ok(row.includes('"C:\\프로젝트, ""A"""'), 'cwd escaped');
  assert.ok(row.includes('claude-opus-5+claude-haiku-4-5'), 'models include subagent');
  assert.ok(row.endsWith(',3,16,107,1008,10009,11140'), `totals wrong: ${row}`);

  // Missing CLAUDE_USER falls back to UNSET-<os user>.
  await runHook(undefined, 'x1');
  assert.ok(fs.readdirSync(logDir).some((f) => f.startsWith('UNSET-')), 'UNSET fallback file');

  // Resumed session logged twice counts once in the report.
  await runHook('김철수', 'resumed');
  await runHook('김철수', 'resumed');
  const out = execFileSync(process.execPath, [REPORT, '--user', '김철수'], { env: { ...process.env, TOKEN_LOG_DIR: logDir }, encoding: 'utf8' });
  assert.ok(out.includes('| 김철수 | 1 |'), `resumed session counted twice:\n${out}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
