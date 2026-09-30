// Regression check for issues found while building this plugin. Run: node test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const HOOK = path.join(__dirname, 'scripts', 'log-usage.js');
const SNAP = path.join(__dirname, 'scripts', 'snapshot.js');
const REPORT = path.join(__dirname, 'scripts', 'report.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-log-test-'));
const logDir = path.join(tmp, 'logs');
// Fake home so ~/.claude/token-log/{rate,bin,state} land in tmp, not the real profile.
const HOME = path.join(tmp, 'home');
const ENV = { ...process.env, TOKEN_LOG_DIR: logDir, HOME, USERPROFILE: HOME };
const homeLog = path.join(HOME, '.claude', 'token-log');

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

const runHook = (user, sessionId, { interim = false, file = transcript, env = {} } = {}) => new Promise((resolve, reject) => {
  const e = { ...ENV, ...env };
  if (user) e.CLAUDE_USER = user; else delete e.CLAUDE_USER;
  const p = spawn(process.execPath, [HOOK, ...(interim ? ['--interim'] : [])], { env: e });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => (code === 0 && !err ? resolve() : reject(new Error(err || `exit ${code}`))));
  p.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: file, cwd: 'C:\\프로젝트, "A"', reason: 'exit' }));
});
// All record files of one user (any month), oldest first.
const recsOf = (user, root = logDir) => {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const m of fs.readdirSync(root)) {
    const d = path.join(root, m, user);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) out.push({ file: path.join(d, f), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) });
  }
  return out;
};
const report = (...args) => execFileSync(process.execPath, [REPORT, ...args], { env: ENV, encoding: 'utf8' });

(async () => {
  // Default SessionEnd timeout is 1.5s and node startup alone can take ~1s on Windows.
  const hook = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionEnd[0].hooks[0];
  assert.ok(hook.timeout >= 10, 'hooks.json must set a SessionEnd timeout');

  // 10 sessions ending at once: 10 separate files, each one JSON line.
  await Promise.all(Array.from({ length: 10 }, (_, i) => runHook('홍길동', `s${i}`)));
  const recs = recsOf('홍길동');
  assert.strictEqual(recs.length, 10, 'one file per record');
  assert.ok(/\d{4}-\d{2}[\\/]홍길동[\\/]\d{8}T\d{9}Z_.+_s0_exit\.txt$/.test(recs.find((r) => r.session_id === 's0').file), `file layout: ${recs[0].file}`);

  // Totals: m1 once + m2 + subagent s1; cwd with comma/quote survives as-is.
  const r0 = recs[0];
  assert.strictEqual(r0.project, 'C:\\프로젝트, "A"', 'cwd kept');
  assert.strictEqual(r0.models, 'claude-opus-5+claude-haiku-4-5', 'models include subagent');
  assert.deepStrictEqual([r0.requests, r0.input, r0.output, r0.cache_write, r0.cache_read, r0.total], [3, 16, 107, 1008, 10009, 11140], 'totals');
  assert.strictEqual(r0.five_hour_start, null, 'no statusline snapshot = empty rate fields');
  assert.ok(fs.existsSync(path.join(homeLog, 'bin', 'snapshot.js')), 'snapshot.js copied to fixed path');

  // Missing name falls back to UNSET-<os user>.
  await runHook(undefined, 'x1');
  assert.ok(fs.readdirSync(path.join(logDir, fs.readdirSync(logDir)[0])).some((f) => f.startsWith('UNSET-')), 'UNSET fallback folder');

  // Config dialog values (CLAUDE_PLUGIN_OPTION_*) win over the old env vars.
  const optDir = path.join(tmp, 'opt-dir');
  await runHook('env이름', 'cfg', { env: { CLAUDE_PLUGIN_OPTION_USER_NAME: '설정이름', CLAUDE_PLUGIN_OPTION_LOG_DIR: optDir } });
  assert.strictEqual(recsOf('설정이름', optDir).length, 1, 'plugin options used for name and folder');
  assert.ok(report('--dir', optDir).includes('| 설정이름 | 1 |'), 'report --dir');

  // Rerun with no new usage writes nothing (records are deltas).
  await runHook('김철수', 'resumed');
  await runHook('김철수', 'resumed');
  assert.strictEqual(recsOf('김철수').length, 1, 'no-change rerun adds no record');
  const out = report('--user', '김철수');
  assert.ok(out.includes('| 김철수 | 1 |') && out.includes('| 11,140 |'), `counted twice:\n${out}`);

  // Session left open for weeks: the async Stop hook logs as it goes, throttled; SessionEnd adds only what's new.
  const live = path.join(tmp, 'live.jsonl');
  fs.writeFileSync(live, msg('a1', 'claude-opus-5', u(1, 10, 100, 1000)) + '\n');
  await runHook('최', 'live', { interim: true, file: live });
  fs.appendFileSync(live, msg('a2', 'claude-opus-5', u(2, 20, 200, 2000)) + '\n');
  await runHook('최', 'live', { interim: true, file: live }); // within 10 min: skipped
  assert.strictEqual(recsOf('최').length, 1, 'interim throttled');
  assert.strictEqual(recsOf('최')[0].reason, 'interim');
  assert.strictEqual(recsOf('최')[0].total, 1111);
  await runHook('최', 'live', { file: live });
  assert.strictEqual(recsOf('최')[1].total, 2222, 'end record is the delta');

  // SessionEnd got killed: the next session start logs what the old session used after its last record.
  fs.appendFileSync(live, msg('a3', 'claude-opus-5', u(3, 30, 300, 3000)) + '\n');
  const catchup = () => execFileSync(process.execPath, [HOOK, '--catchup'], { env: { ...ENV, CLAUDE_USER: '최' }, input: JSON.stringify({ session_id: 'new-session' }) });
  catchup();
  const cu = recsOf('최');
  assert.strictEqual(cu.length, 3, 'catch-up adds one record');
  assert.ok(cu[2].reason === 'catchup' && cu[2].total === 3333, `catch-up record: ${JSON.stringify(cu[2])}`);
  catchup();
  assert.strictEqual(recsOf('최').length, 3, 'second catch-up adds nothing');

  // Stop and SessionEnd racing on the last turn: usage counted exactly once.
  const race = path.join(tmp, 'race.jsonl');
  fs.writeFileSync(race, msg('b1', 'claude-opus-5', u(1, 1, 1, 1)) + '\n');
  await Promise.all([runHook('경주', 'race', { interim: true, file: race }), runHook('경주', 'race', { file: race })]);
  assert.strictEqual(recsOf('경주').reduce((s, r) => s + r.total, 0), 4, 'race double-counted');

  // Statusline snapshots: first reading = start, last = end; the next record starts where this one ended.
  const snap = (p5, p7, usd) => execFileSync(process.execPath, [SNAP], { env: ENV, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'r1', rate_limits: { five_hour: { used_percentage: p5, resets_at: 1790000000 }, seven_day: { used_percentage: p7 } }, cost: { total_cost_usd: usd } }) });
  assert.strictEqual(snap(40, 10, 1.5), '5h 40% · 7d 10%', 'statusline text');
  snap(55, 12, 2.5);
  await runHook('박', 'r1');
  const r1 = recsOf('박')[0];
  assert.deepStrictEqual([r1.five_hour_start, r1.five_hour_end, r1.seven_day_start, r1.seven_day_end, r1.five_hour_resets_at, r1.usd],
    [40, 55, 10, 12, '2026-09-21T14:13:20.000Z', 2.5], 'rate fields');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(homeLog, 'rate', 'r1.json'), 'utf8')).first.five_hour, 55, 'next record starts where this one ended');
  const rep = report('--user', '박');
  assert.ok(rep.includes('계정 한도') && rep.includes('5h 55% · 7d 12%'), `account line missing:\n${rep}`);
  assert.ok(rep.includes('| 2.50 | 15 | 2 |'), `usd / limit rise wrong:\n${rep}`);

  // Nothing in the log folder is ever rewritten: every file keeps its first content.
  const snapshotOf = () => new Map(fs.readdirSync(logDir, { recursive: true }).map(String).filter((f) => f.endsWith('.txt'))
    .map((f) => [f, fs.readFileSync(path.join(logDir, f), 'utf8')]));
  const before = snapshotOf();
  fs.appendFileSync(transcript, '\n' + msg('m9', 'claude-opus-5', u(1, 1, 1, 1)));
  await runHook('홍길동', 's0');
  const after = snapshotOf();
  for (const [f, c] of before) assert.strictEqual(after.get(f), c, `file rewritten: ${f}`);
  assert.strictEqual(after.size, before.size + 1, 'new usage = new file');

  // A half-synced file in the folder doesn't break the report.
  fs.writeFileSync(path.join(path.dirname(recs[0].file), 'broken.txt'), '{"user": "홍');
  assert.ok(report('--user', '홍길동').includes('| 홍길동 | 10 |'), 'report skips unreadable files');

  // --since skips older month folders.
  assert.ok(report('--since', '2999-01-01').includes('세션 0개'), '--since');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
