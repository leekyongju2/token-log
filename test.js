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
// Fake home so ~/.claude/token-log/{rate,bin} land in tmp, not the real profile.
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

const runHook = (user, sessionId, { interim = false, file = transcript } = {}) => new Promise((resolve, reject) => {
  const env = { ...ENV };
  if (user) env.CLAUDE_USER = user; else delete env.CLAUDE_USER;
  const p = spawn(process.execPath, [HOOK, ...(interim ? ['--interim'] : [])], { env });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => (code === 0 && !err ? resolve() : reject(new Error(err || `exit ${code}`))));
  p.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: file, cwd: 'C:\\프로젝트, "A"', reason: 'exit' }));
});
const rowsOf = (user) => fs.readFileSync(path.join(logDir, `${user}.csv`), 'utf8').trim().split('\n').slice(1);
const report = (user) => execFileSync(process.execPath, [REPORT, '--user', user], { env: ENV, encoding: 'utf8' });

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
  assert.ok(row.includes(',3,16,107,1008,10009,11140,'), `totals wrong: ${row}`);
  assert.ok(row.endsWith(',,,,,,'), 'no statusline snapshot = empty rate columns');
  assert.ok(fs.existsSync(path.join(homeLog, 'bin', 'snapshot.js')), 'snapshot.js copied to fixed path');

  // Missing CLAUDE_USER falls back to UNSET-<os user>.
  await runHook(undefined, 'x1');
  assert.ok(fs.readdirSync(logDir).some((f) => f.startsWith('UNSET-')), 'UNSET fallback file');

  // Config dialog values (CLAUDE_PLUGIN_OPTION_*) win over the old env vars.
  const optDir = path.join(tmp, 'opt-dir');
  execFileSync(process.execPath, [HOOK], { env: { ...ENV, CLAUDE_USER: 'env이름', CLAUDE_PLUGIN_OPTION_USER_NAME: '설정이름', CLAUDE_PLUGIN_OPTION_LOG_DIR: optDir },
    input: JSON.stringify({ session_id: 'cfg', transcript_path: transcript, cwd: 'c', reason: 'exit' }) });
  assert.ok(fs.existsSync(path.join(optDir, '설정이름.csv')), 'plugin options used for name and folder');
  assert.ok(report('설정이름').includes('세션 0개'), 'report ignores other folders by default');
  assert.ok(execFileSync(process.execPath, [REPORT, '--dir', optDir], { env: ENV, encoding: 'utf8' }).includes('| 설정이름 | 1 |'), 'report --dir');

  // Resumed session with no new usage writes no second row (rows are deltas).
  await runHook('김철수', 'resumed');
  await runHook('김철수', 'resumed');
  assert.strictEqual(rowsOf('김철수').length, 1, 'no-change rerun adds no row');
  const out = report('김철수');
  assert.ok(out.includes('| 김철수 | 1 |') && out.includes('| 11,140 |'), `resumed session counted twice:\n${out}`);

  // Session left open for weeks: the async Stop hook logs as it goes, throttled; SessionEnd adds only what's new.
  const live = path.join(tmp, 'live.jsonl');
  fs.writeFileSync(live, msg('a1', 'claude-opus-5', u(1, 10, 100, 1000)) + '\n');
  await runHook('최', 'live', { interim: true, file: live });
  fs.appendFileSync(live, msg('a2', 'claude-opus-5', u(2, 20, 200, 2000)) + '\n');
  await runHook('최', 'live', { interim: true, file: live }); // within 10 min: skipped
  assert.strictEqual(rowsOf('최').length, 1, 'interim throttled');
  assert.ok(rowsOf('최')[0].includes(',interim,claude-opus-5,1,1,10,100,1000,1111,'), `interim row: ${rowsOf('최')[0]}`);
  await runHook('최', 'live', { file: live });
  assert.ok(rowsOf('최')[1].includes(',exit,claude-opus-5,1,2,20,200,2000,2222,'), `end row is delta: ${rowsOf('최')[1]}`);

  // SessionEnd got killed: the next session start logs what the old session used after its last row.
  fs.appendFileSync(live, msg('a3', 'claude-opus-5', u(3, 30, 300, 3000)) + '\n');
  const before = rowsOf('최').length;
  execFileSync(process.execPath, [HOOK, '--catchup'], { env: { ...ENV, CLAUDE_USER: '최' }, input: JSON.stringify({ session_id: 'new-session' }) });
  const cu = rowsOf('최');
  assert.strictEqual(cu.length, before + 1, 'catch-up adds one row');
  assert.ok(cu.at(-1).includes(',catchup,claude-opus-5,1,3,30,300,3000,3333,'), `catch-up row: ${cu.at(-1)}`);
  execFileSync(process.execPath, [HOOK, '--catchup'], { env: { ...ENV, CLAUDE_USER: '최' }, input: JSON.stringify({ session_id: 'new-session' }) });
  assert.strictEqual(rowsOf('최').length, before + 1, 'second catch-up adds nothing');

  // Stop and SessionEnd racing on the last turn: usage counted exactly once.
  const race = path.join(tmp, 'race.jsonl');
  fs.writeFileSync(race, msg('b1', 'claude-opus-5', u(1, 1, 1, 1)) + '\n');
  await Promise.all([runHook('경주', 'race', { interim: true, file: race }), runHook('경주', 'race', { file: race })]);
  // total column counted from the end: cwd holds a quoted comma
  const raced = rowsOf('경주').reduce((s, r) => s + Number(r.split(',').at(-7)), 0);
  assert.strictEqual(raced, 4, `race double-counted: ${rowsOf('경주').join(' | ')}`);

  // Statusline snapshots: first reading kept as start, last as end; SessionEnd logs both then deletes.
  const snap = (p5, p7, usd) => execFileSync(process.execPath, [SNAP], { env: ENV, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'r1', rate_limits: { five_hour: { used_percentage: p5, resets_at: 1790000000 }, seven_day: { used_percentage: p7 } }, cost: { total_cost_usd: usd } }) });
  assert.strictEqual(snap(40, 10, 1.5), '5h 40% · 7d 10%', 'statusline text');
  snap(55, 12, 2.5);
  await runHook('박', 'r1');
  const r1 = fs.readFileSync(path.join(logDir, '박.csv'), 'utf8').trim().split('\n')[1];
  assert.ok(r1.endsWith(',40,55,10,12,2026-09-21T14:13:20.000Z,2.5'), `rate columns wrong: ${r1}`);
  const rateAfter = JSON.parse(fs.readFileSync(path.join(homeLog, 'rate', 'r1.json'), 'utf8'));
  assert.strictEqual(rateAfter.first.five_hour, 55, 'next row starts where this one ended');
  const rep = report('박');
  assert.ok(rep.includes('계정 한도') && rep.includes('5h 55% · 7d 12%'), `account line missing:\n${rep}`);
  assert.ok(rep.includes('| 2.50 | 15 | 2 |'), `usd / limit rise wrong:\n${rep}`);

  // CSV written by the old version gets the new header; old row stays.
  const old = path.join(logDir, '옛.csv');
  fs.writeFileSync(old, '\ufeffended_at,user,host,session_id,project,reason,models,requests,input,output,cache_write,cache_read,total\nold-row\n');
  await runHook('옛', 'o1');
  const oldLines = fs.readFileSync(old, 'utf8').split('\n');
  assert.ok(oldLines[0].endsWith(',usd') && oldLines[1] === 'old-row' && oldLines[2].includes(',o1,'), 'header upgrade');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
