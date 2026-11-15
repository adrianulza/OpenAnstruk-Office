import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, waitFor } from './helpers.mjs';
import { checkEvents } from '../tools/check-events.mjs';

const FAST = ['--pace', '0.01'];
const ends = (events) => events.filter((e) => e.type === 'run_end');

test('arguments are validated before anything runs', () => {
  const s = sandbox();
  try {
    const cases = [
      [[], /--topic is required/],
      [['--topic', 'x', '--engine', 'foo'], /--engine must be one of/],
      [['--topic', 'x', '--engine'], /--engine needs a value/],
      [['--topic', 'x', '--template', 'nope'], /Unknown template/],
      [['--topic', 'x', '--template', 'motion-map'], /not ready/],
      [['--topic', 'x', '--template', 'aina-reel-cepat'], /is for aina/],
      [['--topic', 'x', '--slot', '20-11-2026'], /--slot must be a date/],
      [['--topic', 'x', '--cap', 'abc'], /--cap must be a positive number/],
      [['--topic', 'x', '--wrap', '5'], /wrap <= stop <= cap/],
      [['--topic', 'x', '--approve', 'everything'], /--approve accepts/],
      [['--topic', 'x', '--until', 'nope'], /--until must be a step id/],
      [['--topic', 'x', '--engine', 'claude-cli', '--repo', '/does/not/exist'], /--repo does not exist/],
    ];
    for (const [args, re] of cases) {
      const r = s.run(args);
      assert.equal(r.code, 2, `${args.join(' ')} should exit 2:\n${r.out}`);
      assert.match(r.out, re);
    }
    assert.deepEqual(s.runs(), [], 'no run folders for rejected configs');
  } finally { s.cleanup(); }
});

test('dry run: full pipeline, every artifact, valid events, ledger', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Gempa kecil tapi merusak', '--slot', '2026-11-20', ...FAST]);
    assert.equal(r.code, 0, r.out);
    const run = 'dry-0001-gempa-kecil-merusak';
    const st = s.state(run);
    assert.equal(st.status, 'ok');
    for (const f of ['brief.md', 'fakta.md', 'naskah.md', 'script.json', 'critic.md', 'atensi.md', 'animasi.md', 'qa.md', 'caption-ig.md', 'publish.json']) {
      assert.ok(fs.existsSync(path.join(st.post, f)), `missing ${f}`);
    }
    const ev = s.events(run);
    assert.deepEqual(checkEvents(ev.map((e) => JSON.stringify(e)).join('\n')), []);
    assert.equal(ends(ev).length, 1);
    assert.equal(ends(ev)[0].status, 'ok');
    assert.ok(ev[0].stages.includes('QA'), 'run_start lists the stages');
    assert.ok(st.spent > 1 && st.spent < st.config.stop, `spent ${st.spent}`);
    const ledger = fs.readFileSync(path.join(s.dir, 'runs', 'ledger.jsonl'), 'utf8');
    assert.match(ledger, /"status":"ok"/);
    assert.ok(fs.existsSync(path.join(s.dir, 'runs', run, 'report.md')));
  } finally { s.cleanup(); }
});

test('gate fails closed: a second BLOCK stops the run before animation', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Blok', '--dry-verdicts', 'critique=BLOCK,BLOCK', ...FAST]);
    assert.equal(r.code, 3, r.out);
    const ev = s.events('dry-0001-blok');
    assert.equal(ends(ev)[0].status, 'blocked');
    assert.equal(ev.filter((e) => e.type === 'blocked').length, 2);
    assert.ok(!ev.some((e) => e.agent === 'animator' && e.type === 'task_start'), 'animator never starts');
    assert.ok(!ev.some((e) => e.agent === 'ops'), 'nothing is rendered');
  } finally { s.cleanup(); }
});

test('one revision round: BLOCK then PASS goes back to the writer and finishes', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Revisi', '--dry-verdicts', 'critique=BLOCK,PASS', ...FAST]);
    assert.equal(r.code, 0, r.out);
    const ev = s.events('dry-0001-revisi');
    assert.equal(ev.filter((e) => e.agent === 'scriptwriter' && e.type === 'task_start' && e.task === 'script').length, 2);
    assert.equal(ends(ev)[0].status, 'ok');
  } finally { s.cleanup(); }
});

test('a missing VERDICT counts as BLOCK', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Tanpa verdict', '--dry-verdicts', 'qa=NONE', ...FAST]);
    assert.equal(r.code, 3);
    assert.equal(ends(s.events('dry-0001-tanpa-verdict'))[0].status, 'blocked');
  } finally { s.cleanup(); }
});

test('accuracy gate: READY: no stops the run at the brief', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Belum siap', '--dry-verdicts', 'brief=BLOCK', ...FAST]);
    assert.equal(r.code, 3);
    const ev = s.events('dry-0001-belum-siap');
    assert.match(ends(ev)[0].summary, /akurasi/);
    assert.ok(!ev.some((e) => e.agent === 'researcher'));
  } finally { s.cleanup(); }
});

test('--until stops early with status partial', () => {
  const s = sandbox();
  try {
    const r = s.run(['--topic', 'Sampai naskah', '--until', 'attention', ...FAST]);
    assert.equal(r.code, 0);
    assert.equal(s.state('dry-0001-sampai-naskah').status, 'partial');
  } finally { s.cleanup(); }
});

test('approval: parks, a rejection sends the script back, approval finishes the run', async () => {
  const s = sandbox();
  try {
    let r = s.run(['--topic', 'Setuju', '--approve', 'script', '--wait', '0.01', ...FAST]);
    assert.equal(r.code, 0, r.out);
    const run = 'dry-0001-setuju';
    assert.equal(s.state(run).status, 'parked');
    assert.equal(s.state(run).waiting.name, 'script');
    const ap = path.join(s.dir, 'runs', run, 'approvals', 'script.json');
    fs.writeFileSync(ap, JSON.stringify({ decision: 'reject', note: 'hook kurang tajam' }));
    r = s.run(['--resume', run, '--wait', '0.01']);
    assert.equal(s.state(run).status, 'parked', r.out);
    let ev = s.events(run);
    assert.ok(ev.some((e) => e.type === 'decision' && e.decision === 'reject'));
    assert.ok(ev.some((e) => e.type === 'thinking' && /hook kurang tajam/.test(e.summary)), 'writer sees the note');
    fs.writeFileSync(ap, JSON.stringify({ decision: 'approve' }));
    r = s.run(['--resume', run]);
    assert.equal(r.code, 0, r.out);
    assert.equal(s.state(run).status, 'ok');
    ev = s.events(run);
    assert.equal(ends(ev).length, 1, 'one run_end across all resumes');
    assert.deepEqual(checkEvents(fs.readFileSync(path.join(s.dir, 'runs', run, 'events.jsonl'), 'utf8')), []);
  } finally { s.cleanup(); }
});

test('a live run picks up an approval file while it waits', async () => {
  const s = sandbox();
  try {
    const child = s.spawnRun(['--topic', 'Tunggu', '--approve', 'brief', ...FAST]);
    const run = 'dry-0001-tunggu';
    await waitFor(() => fs.existsSync(path.join(s.dir, 'runs', run, 'state.json')) && s.state(run).status === 'waiting');
    fs.writeFileSync(path.join(s.dir, 'runs', run, 'approvals', 'brief.json'), JSON.stringify({ decision: 'approve' }));
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    assert.equal(s.state(run).status, 'ok');
  } finally { s.cleanup(); }
});

test('phase 1 adapts a template with two required approvals; aina has its own pipeline', () => {
  const s = sandbox();
  try {
    let r = s.run(['--phase', '1', '--template', 'motion-map', '--auto-approve', ...FAST]);
    assert.equal(r.code, 0, r.out);
    const kit = s.runs().find((n) => n.startsWith('kit-motion-map'));
    const ev = s.events(kit);
    assert.deepEqual(ev.filter((e) => e.type === 'approval').map((e) => e.name), ['plan', 'kit']);
    assert.equal(ev[0].cap, 6);
    r = s.run(['--kreator', 'aina', '--template', 'aina-reel-cepat', '--topic', 'Titik panas Riau', ...FAST]);
    assert.equal(r.code, 0, r.out);
    const aina = s.events('dry-0001-titik-panas-riau');
    const order = aina.filter((e) => e.type === 'task_start').map((e) => e.agent);
    assert.ok(order.indexOf('aina') < order.indexOf('animator'), 'Aina records before the edit');
  } finally { s.cleanup(); }
});

test('run ids continue the repo numbering; dry runs are numbered apart', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Gempa kecil tapi merusak', '--until', 'brief']);
    assert.equal(r.code, 0, r.out);
    assert.ok(s.runs().includes('0026-gempa-kecil-merusak'), s.runs().join(','));
    assert.ok(fs.existsSync(path.join(s.repo, 'marketing', 'posts', '0026-gempa-kecil-merusak', 'brief.md')));
  } finally { s.cleanup(); }
});

test('claude-cli: safe args, per-step dollar cap, seat tools, no shell', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Gempa "kecil" & merusak | rm -rf', '--until', 'research']);
    assert.equal(r.code, 0, r.out);
    const calls = s.calls();
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.ok(!c.some((a) => a.includes('Gempa')), 'the topic never goes on the command line');
      assert.ok(c.includes('--append-system-prompt-file'));
      assert.ok(c.includes('--max-budget-usd'));
      assert.equal(c[c.indexOf('--permission-mode') + 1], 'dontAsk');
    }
    assert.equal(calls[0][calls[0].indexOf('--tools') + 1], 'Read,Grep,Glob', 'producer is read-only');
    assert.match(calls[1][calls[1].indexOf('--tools') + 1], /Bash/, 'researcher may run scripts');
    assert.equal(calls[0][calls[0].indexOf('--model') + 1], 'haiku');
  } finally { s.cleanup(); }
});

test('budget: a step that overspends ends the run as over_budget, nothing after it runs', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Mahal', '--skip-voice'], { FAKE_CLAUDE: JSON.stringify({ animate: { cost: 3.6 } }) });
    assert.equal(r.code, 3, r.out);
    const st = s.state('0026-mahal');
    assert.equal(st.status, 'over_budget');
    const ev = s.events('0026-mahal');
    assert.ok(!ev.some((e) => e.agent === 'ops'), 'no render after the cap');
    const animCall = s.calls().find((c) => c.includes('sonnet') && c.includes('high'));
    assert.ok(Number(animCall[animCall.indexOf('--max-budget-usd') + 1]) <= 4 - 0.4, 'step budget is what is left under the cap');
  } finally { s.cleanup(); }
});

test('budget: the live kill switch stops a step that streams past its budget', () => {
  const s = sandbox();
  try {
    // 2M output tokens of haiku = $1 > the $0.5 cap given to the brief step
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Bocor', '--cap', '0.5', '--wrap', '0.3', '--stop', '0.4'], { FAKE_CLAUDE: JSON.stringify({ brief: { usage: 2000000 } }) });
    assert.equal(r.code, 3, r.out);
    assert.equal(s.state('0026-bocor').status, 'over_budget');
    assert.match(s.state('0026-bocor').reason, /budget/);
  } finally { s.cleanup(); }
});

test('auth errors stop at once (Claude Code exits 0 with is_error)', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Auth'], { FAKE_CLAUDE: JSON.stringify({ default: { error: 'Not logged in · Please run /login' } }) });
    assert.equal(r.code, 1);
    assert.equal(s.calls().length, 1, 'no retry on auth errors');
    assert.match(s.state('0026-auth').reason, /Login/);
  } finally { s.cleanup(); }
});

test('a missing output file is retried once, then the run errors', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Lupa'], { FAKE_CLAUDE: JSON.stringify({ research: { write: false } }) });
    assert.equal(r.code, 1);
    assert.match(s.state('0026-lupa').reason, /fakta\.md/);
    assert.equal(s.calls().length, 3);
  } finally { s.cleanup(); }
});

test('render without an mp4 is an error, not a success', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Tanpa video', '--skip-voice']);
    assert.equal(r.code, 1, r.out);
    const ev = s.events('0026-tanpa-video');
    assert.equal(ends(ev)[0].status, 'error');
    assert.match(ends(ev)[0].summary, /mp4/);
    assert.ok(!ev.some((e) => e.agent === 'ops' && e.type === 'done'));
  } finally { s.cleanup(); }
});

test('render script, QA and publish package on the claude-cli engine', () => {
  const s = sandbox();
  try {
    // a fake kolase build script that writes the video where the post expects it
    fs.mkdirSync(path.join(s.repo, 'lib', 'reel'), { recursive: true });
    fs.writeFileSync(path.join(s.repo, 'lib', 'reel', 'build.mjs'), "import fs from 'node:fs'; import path from 'node:path'; const p = process.argv[2]; fs.mkdirSync(path.join(p, 'video'), { recursive: true }); fs.writeFileSync(path.join(p, 'video', 'reel.mp4'), 'mp4');");
    fs.mkdirSync(path.join(s.repo, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(s.repo, 'tools', 'periksa-reel.mjs'), "console.log('1080x1920 OK, -16 LUFS');");
    const r = s.run(['--engine', 'claude-cli', '--repo', s.repo, '--topic', 'Lengkap', '--skip-voice']);
    assert.equal(r.code, 0, r.out);
    const st = s.state('0026-lengkap');
    assert.equal(st.status, 'ok');
    assert.ok(fs.existsSync(path.join(s.repo, 'video', '0026-lengkap.mp4')), 'copied to video/<run>.mp4');
    assert.match(fs.readFileSync(path.join(st.post, 'periksa.txt'), 'utf8'), /1080x1920/);
    const pkg = JSON.parse(fs.readFileSync(path.join(st.post, 'publish.json'), 'utf8'));
    assert.equal(pkg.status, 'ready_to_publish');
  } finally { s.cleanup(); }
});

test('api engine without a key fails at once instead of pretending', () => {
  const s = sandbox();
  try {
    const r = s.run(['--engine', 'api', '--repo', s.repo, '--topic', 'Api']);
    assert.equal(r.code, 1);
    assert.match(s.state('0026-api').reason, /ANTHROPIC_API_KEY/);
  } finally { s.cleanup(); }
});

test('api engine: inputs inlined, outputs captured, stops (partial) before animation', async () => {
  const s = sandbox();
  const http = await import('node:http');
  const prompts = [];
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); const msg = body.messages[0].content; prompts.push(msg);
      const task = /Your task: ([\w-]+)\./.exec(msg)[1];
      let text = `Isi ${task}.`;
      if (task === 'script') text += '\n```json\n{"scenes":[1,2]}\n```';
      if (/READY:/.test(msg)) text += '\nREADY: yes';
      if (/VERDICT:/.test(msg)) text += '\nVERDICT: PASS';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: text + '\nSUMMARY: ok' }], usage: { input_tokens: 1000, output_tokens: 500 } }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  try {
    const child = s.spawnRun(['--engine', 'api', '--repo', s.repo, '--topic', 'Lewat API'], { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    const st = s.state('0026-lewat-api');
    assert.equal(st.status, 'partial');
    assert.match(st.reason, /claude-cli/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(st.post, 'script.json'), 'utf8')), { scenes: [1, 2] });
    assert.match(fs.readFileSync(path.join(st.post, 'fakta.md'), 'utf8'), /Isi research/);
    const scriptPrompt = prompts.find((p) => p.includes('Your task: script.'));
    assert.match(scriptPrompt, /===== fakta\.md =====/, 'earlier output is inlined');
    assert.ok(st.spent > 0);
  } finally { mock.close(); s.cleanup(); }
});

test('notifications reach the webhook when a run needs you and when it ends badly', async () => {
  const s = sandbox();
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${hook.address().port}/hook`;
    const child = s.spawnRun(['--topic', 'Kabari', '--approve', 'brief', '--wait', '0.01', '--pace', '0.01'], { OFFICE_NOTIFY_WEBHOOK: url });
    await new Promise((r) => child.on('exit', r));
    assert.ok(got.some((g) => g.kind === 'approval' && /brief/.test(g.text)), JSON.stringify(got));
    const child2 = s.spawnRun(['--topic', 'Gagal', '--dry-verdicts', 'critique=BLOCK', '--rounds', '0', '--pace', '0.01'], { OFFICE_NOTIFY_WEBHOOK: url });
    await new Promise((r) => child2.on('exit', r));
    assert.ok(got.some((g) => g.kind === 'blocked' && g.run === 'dry-0002-gagal'), JSON.stringify(got));
    assert.match(fs.readFileSync(path.join(s.dir, 'runs', 'dry-0002-gagal', 'notifications.log'), 'utf8'), /blocked/);
  } finally { hook.close(); s.cleanup(); }
});
