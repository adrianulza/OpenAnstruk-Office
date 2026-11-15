import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, waitFor, OFFICE } from './helpers.mjs';

async function startServer(s, args = []) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(OFFICE, 'server', 'server.mjs'), '--port', String(port), '--engine', 'dry', ...args], { env: s.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://localhost:${port}`;
  await waitFor(async () => { try { return (await fetch(`${base}/api/status`)).ok; } catch { return false; } }, 10000);
  return { base, stop: () => child.kill() };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('server: chat → proposal → run with approval → upload-free finish, all over HTTP', async () => {
  const s = sandbox();
  const srv = await startServer(s);
  try {
    const st = await (await fetch(`${srv.base}/api/status`)).json();
    assert.equal(st.engine, 'dry');
    assert.ok(st.templates.every((t) => t.id), 'ready templates listed');

    let r = await (await post(`${srv.base}/api/chat`, { message: 'Reel gempa kecil tapi merusak' })).json();
    assert.ok(r.chat.id);
    assert.equal(r.proposal, null, 'first turn asks questions');
    r = await (await post(`${srv.base}/api/chat`, { id: r.chat.id, message: 'ok openanstruk 2026-11-20' })).json();
    assert.equal(r.proposal.slot, '2026-11-20');
    assert.equal(r.proposal.kreator, 'openanstruk');
    assert.equal(r.proposal.template, 'kolase-browser');

    const bad = await post(`${srv.base}/api/runs`, { ...r.proposal, topic: '' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /topic/);

    const started = await (await post(`${srv.base}/api/runs`, { ...r.proposal, approve: ['script'], pace: 0.01 })).json();
    assert.match(started.run, /^dry-0001-/);
    const busy = await post(`${srv.base}/api/runs`, { ...r.proposal, pace: 0.01 });
    assert.equal(busy.status, 409, 'one run at a time');

    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).waiting?.name === 'script');
    const view = await (await fetch(`${srv.base}/api/runs/${started.run}`)).json();
    assert.ok(view.files.includes('naskah.md'));
    const naskah = await (await fetch(`${srv.base}/api/runs/${started.run}/file?name=naskah.md`)).text();
    assert.match(naskah, /dry run/);
    await post(`${srv.base}/api/runs/${started.run}/approve`, { name: 'script', decision: 'approve' });
    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).status === 'ok', 30000);

    const ledger = await (await fetch(`${srv.base}/api/ledger`)).json();
    assert.equal(ledger.dryRuns, 1);
    assert.equal(ledger.all, 0, 'dry runs cost nothing');
  } finally { srv.stop(); s.cleanup(); }
});

test('server: refuses cross-origin writes, foreign hosts, path traversal and private files', async () => {
  const s = sandbox();
  const srv = await startServer(s);
  try {
    assert.equal((await post(`${srv.base}/api/runs`, {}, { origin: 'http://evil.example' })).status, 403);
    const port = new URL(srv.base).port;
    const foreign = await new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
        req.end();
      });
    });
    assert.equal(foreign, 403, 'DNS-rebinding hosts are refused');
    assert.equal((await fetch(`${srv.base}/server/server.mjs`)).status, 404);
    assert.equal((await fetch(`${srv.base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${srv.base}/runs/ledger.jsonl`)).status, 404);
    assert.equal((await fetch(`${srv.base}/index.html`)).status, 200);
    assert.equal((await fetch(`${srv.base}/api/runs/..%2F..%2Fetc/file?name=x.md`)).status, 400);
    const upBad = await fetch(`${srv.base}/api/runs/nope/upload?kind=voice&name=a.exe`, { method: 'POST', body: 'x' });
    assert.equal(upBad.status, 404);
  } finally { srv.stop(); s.cleanup(); }
});

test('server: approving a parked run resumes it', async () => {
  const s = sandbox();
  const srv = await startServer(s);
  try {
    const started = await (await post(`${srv.base}/api/runs`, { topic: 'Rekam', template: 'kolase-browser', approve: ['final'], pace: 0.01, waitMin: 0.02 })).json();
    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).status === 'parked', 30000);
    const st = await (await fetch(`${srv.base}/api/runs/${started.run}`)).json();
    assert.equal(st.waiting.kind, 'approval');
    const r = await post(`${srv.base}/api/runs/${started.run}/approve`, { name: 'final', decision: 'approve' });
    assert.equal(r.status, 200);
    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).status === 'ok', 30000);
  } finally { srv.stop(); s.cleanup(); }
});

test('server: uploading the voice-over resumes a run parked at the recording step', async () => {
  const s = sandbox();
  const fs = await import('node:fs');
  fs.mkdirSync(path.join(s.repo, 'lib', 'reel'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, 'lib', 'reel', 'build.mjs'), "import fs from 'node:fs'; import path from 'node:path'; const p = process.argv[2]; fs.mkdirSync(path.join(p, 'video'), { recursive: true }); fs.writeFileSync(path.join(p, 'video', 'reel.mp4'), 'mp4');");
  const srv = await startServer(s, ['--engine', 'claude-cli', '--repo', s.repo]);
  try {
    const started = await (await post(`${srv.base}/api/runs`, { topic: 'Rekam suara', template: 'kolase-browser', waitMin: 0.02 })).json();
    assert.equal(started.engine, 'claude-cli');
    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).status === 'parked', 30000);
    let st = await (await fetch(`${srv.base}/api/runs/${started.run}`)).json();
    assert.equal(st.waiting.kind, 'human');
    const bad = await fetch(`${srv.base}/api/runs/${started.run}/upload?kind=voice&name=evil.sh`, { method: 'POST', body: 'x' });
    assert.equal(bad.status, 400);
    const up = await fetch(`${srv.base}/api/runs/${started.run}/upload?kind=voice&name=../../take%201.wav`, { method: 'POST', body: 'RIFF fake wav' });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).saved, path.join('voice', 'take_1.wav'));
    await waitFor(async () => (await (await fetch(`${srv.base}/api/runs/${started.run}`)).json()).status === 'ok', 30000);
    st = await (await fetch(`${srv.base}/api/runs/${started.run}`)).json();
    assert.ok(fs.existsSync(path.join(s.repo, 'video', `${started.run}.mp4`)));
  } finally { srv.stop(); s.cleanup(); }
});
