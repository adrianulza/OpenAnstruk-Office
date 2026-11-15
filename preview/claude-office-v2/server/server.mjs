#!/usr/bin/env node
// server.mjs: the office on your own PC. Serves the 3D office and adds the Producer desk:
// chat with Pak Prod, start a run, approve checkpoints, upload recordings, resume, cancel, see costs.
// Listens on 127.0.0.1 only. No dependencies.
//
//   node server/server.mjs --repo D:\_Projects\OpenAnstruk-Studio            (engine claude-cli if Claude Code is installed)
//   node server/server.mjs --engine dry                                      (free demo, no model calls)
//   options: --port 8765  --engine dry|claude-cli|api  --chat dry|claude|api  --subscription  --repo <path>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  OFFICE, RUNS, PIPELINE, TEMPLATES, parseArgs, buildConfig, resolveRunId, defaultLog,
} from '../orchestrator/lib/config.mjs';
import { loadState, saveState, listRuns, readLedger, createEmitter, runDir, END_STATUSES } from '../orchestrator/lib/events.mjs';
import { claudeInstalled, killTree } from '../orchestrator/lib/claude.mjs';
import { chatTurn, loadChat, listChats } from './chat.mjs';

let flags;
try { flags = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
if (flags.help) { console.log('node server/server.mjs [--port 8765] [--repo <path>] [--engine dry|claude-cli|api] [--chat dry|claude|api] [--subscription]'); process.exit(0); }

const PORT = Number(flags.port || process.env.PORT || 8765);
const REPO = path.resolve(flags.repo || process.env.OFFICE_REPO || process.cwd());
const HAS_CLAUDE = claudeInstalled();
const ENGINE = flags.engine || (HAS_CLAUDE && flags.repo ? 'claude-cli' : 'dry');
const CHAT = flags.chat || (ENGINE === 'claude-cli' ? 'claude' : ENGINE === 'api' ? 'api' : 'dry');
const SUBSCRIPTION = !!flags.subscription;
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon' };
const STATIC_DENY = /^(\.|node_modules|orchestrator|server|tools|test)(\/|$)/;
const TEXT_EXT = /\.(md|json|txt|log)$/i;

// ---------- run processes ----------
let active = null;   // { run, child }
function spawnRun(args, run) {
  fs.mkdirSync(runDir(run), { recursive: true });
  const out = fs.openSync(path.join(runDir(run), 'stdout.log'), 'a');
  const env = { ...process.env };
  const child = spawn(process.execPath, [path.join(OFFICE, 'orchestrator', 'run.mjs'), ...args], { cwd: OFFICE, env, stdio: ['ignore', out, out], windowsHide: true });
  active = { run, child };
  child.on('exit', () => {
    fs.closeSync(out);
    if (active?.child === child) active = null;
    const st = loadState(run);
    if (st && st.status === 'running') {         // killed hard (Windows taskkill) before it could write run_end
      st.status = 'cancelled'; st.reason = 'Proses berhenti'; st.endedAt = new Date().toISOString(); saveState(st);
      createEmitter(run, { quiet: true, offsetSec: st.elapsed || 0 })('producer', 'run_end', { status: 'cancelled', summary: 'Run dihentikan' });
    }
  });
  return child;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A run started by an earlier server (or from the command line) that is still going counts too.
function external() {
  return listRuns().find((st) => ['running', 'waiting'].includes(st.status) && st.pid && st.pid !== process.pid && alive(st.pid) && !(active && active.run === st.run));
}
function busy() {
  if (active?.child.external && !alive(active.child.pid)) active = null;
  if (active && active.child.exitCode === null) return true;
  const ext = external();
  if (ext) { active = { run: ext.run, child: { exitCode: null, pid: ext.pid, external: true } }; return true; }
  return false;
}

const RUN_FIELDS = ['kreator', 'template', 'topic', 'slot', 'notes', 'approve', 'engine', 'phase', 'skipVoice', 'autoApprove', 'cap', 'budgetUSD', 'platforms', 'until', 'pace', 'waitMin'];
function startRun(body) {
  if (busy()) throw httpError(409, `Run ${active.run} is still going. Wait for it, or cancel it first.`);
  const cfgIn = { engine: ENGINE, repo: REPO, subscription: SUBSCRIPTION };
  for (const k of RUN_FIELDS) if (body[k] !== undefined && body[k] !== '') cfgIn[k] = body[k];
  fs.mkdirSync(path.join(RUNS, '_queue'), { recursive: true });
  let cfg, run;
  try { cfg = buildConfig({}, cfgIn); run = resolveRunId(cfg); } catch (e) { throw httpError(400, e.message); }
  const file = path.join(RUNS, '_queue', `${run}.json`);
  fs.writeFileSync(file, JSON.stringify(cfgIn, null, 2));
  spawnRun(['--config', file, '--run', run], run);
  return { run, engine: cfg.engine, cap: cfg.cap };
}
function resumeRun(run, extra = []) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  if (busy()) {
    if (active.run === run) return { run, already: true };
    throw httpError(409, `Run ${active.run} is still going`);
  }
  if (st.status === 'ok') throw httpError(400, 'Run already finished');
  spawnRun(['--resume', run, ...extra], run);
  return { run, resumed: true };
}
function cancelRun(run) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  if (busy() && active.run === run) {
    if (active.child.external) { try { process.kill(active.child.pid, 'SIGTERM'); } catch { /* gone */ } active = null; }
    else killTree(active.child);
    return { run, cancelling: true };
  }
  if (END_STATUSES.includes(st.status)) return { run, status: st.status };
  st.status = 'cancelled'; st.reason = 'Dibatalkan dari office'; st.endedAt = new Date().toISOString(); st.waiting = null; saveState(st);
  createEmitter(run, { quiet: true, offsetSec: st.elapsed || 0 })('producer', 'run_end', { status: 'cancelled', summary: 'Dibatalkan dari office' });
  return { run, status: 'cancelled' };
}
function approve(run, { name, decision, note }) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  if (!/^[a-z]+$/.test(name || '') || !['approve', 'reject'].includes(decision)) throw httpError(400, 'name and decision (approve|reject) are required');
  const dir = path.join(runDir(run), 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ decision, note: String(note || '').slice(0, 500), at: new Date().toISOString() }));
  if (st.status === 'parked' && !busy()) resumeRun(run);
  return { run, name, decision };
}

// Parked runs waiting for a recording continue by themselves when the file appears.
setInterval(() => {
  if (busy()) return;
  for (const st of listRuns()) {
    if (st.status !== 'parked' || st.waiting?.kind !== 'human' || !st.waiting.dir) continue;
    const step = Object.values(PIPELINE.pipelines).flat().find((s) => s.kind === 'human' && s.dir === st.waiting.name);
    const exts = step?.ext || ['wav', 'm4a', 'mp3', 'mp4', 'mov'];
    if (fs.existsSync(st.waiting.dir) && fs.readdirSync(st.waiting.dir).some((f) => exts.includes(f.split('.').pop().toLowerCase()))) {
      console.log(`Recording found for ${st.run}, resuming`);
      try { resumeRun(st.run); } catch (e) { console.warn(e.message); }
      return;
    }
  }
}, 10000).unref();

// ---------- uploads (voice / footage) ----------
function upload(req, run, kind, name) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  const step = Object.values(PIPELINE.pipelines).flat().find((s) => s.kind === 'human' && s.dir === kind);
  if (!step) throw httpError(400, 'kind must be voice or footage');
  const safe = path.basename(String(name || '')).replace(/[^\w.-]+/g, '_');
  const ext = safe.split('.').pop().toLowerCase();
  if (!safe || !step.ext.includes(ext)) throw httpError(400, `File type must be one of: ${step.ext.join(', ')}`);
  const dir = path.join(st.post, kind);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safe), tmp = dest + '.part';
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = fs.createWriteStream(tmp);
    req.on('data', (c) => { size += c.length; if (size > 4 * 1024 ** 3) { req.destroy(); ws.destroy(); fs.rmSync(tmp, { force: true }); reject(httpError(413, 'File too large')); } });
    req.pipe(ws);
    ws.on('finish', () => { fs.renameSync(tmp, dest); resolve({ run, saved: path.relative(st.post, dest), bytes: size }); if (st.status === 'parked' && !busy()) { try { resumeRun(run); } catch { /* next tick */ } } });
    ws.on('error', reject);
  });
}

// ---------- read-only views ----------
function runView(run) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  const files = [];
  if (fs.existsSync(st.post)) for (const f of fs.readdirSync(st.post)) if (TEXT_EXT.test(f)) files.push(f);
  if (fs.existsSync(path.join(runDir(run), 'report.md'))) files.push('report.md');
  const pending = st.waiting || null;
  return { ...st, files, active: busy() && active.run === run, pending };
}
function runFile(run, name) {
  const st = loadState(run);
  if (!st) throw httpError(404, 'No such run');
  if (!/^[\w.-]+$/.test(name || '') || !TEXT_EXT.test(name)) throw httpError(400, 'Bad file name');
  const f = name === 'report.md' ? path.join(runDir(run), 'report.md') : path.join(st.post, name);
  if (!fs.existsSync(f)) throw httpError(404, 'Not found');
  return fs.readFileSync(f, 'utf8').slice(0, 200000);
}
function ledger() {
  const all = readLedger();
  const now = Date.now(), day = 86400000;
  const sum = (since, pred = () => true) => +all.filter((e) => e.engine !== 'dry' && Date.parse(e.at) >= since && pred(e)).reduce((a, e) => a + (e.usd || 0), 0).toFixed(4);
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  return {
    today: sum(startToday.getTime()), week: sum(now - 7 * day), month: sum(now - 30 * day), all: sum(0),
    chats: sum(0, (e) => e.kind === 'chat'), runs: all.filter((e) => e.kind === 'run' && e.engine !== 'dry').length,
    dryRuns: all.filter((e) => e.kind === 'run' && e.engine === 'dry').length,
    recent: all.slice(-40).reverse(),
  };
}
function status() {
  return {
    local: true, engine: ENGINE, chat: CHAT, repo: REPO, repoExists: fs.existsSync(REPO), claude: HAS_CLAUDE,
    apiKeySet: !!process.env.ANTHROPIC_API_KEY, subscription: SUBSCRIPTION,
    billing: ENGINE === 'dry' ? 'none (dry)' : ENGINE === 'api' ? 'API key' : (process.env.ANTHROPIC_API_KEY && !SUBSCRIPTION ? 'API key (ANTHROPIC_API_KEY is set; start with --subscription to use your plan)' : 'Claude subscription login'),
    active: busy() ? active.run : null, guard: PIPELINE.guard,
    templates: TEMPLATES.filter((t) => t.status === 'ready').map((t) => ({ id: t.id, name: t.name, kreator: t.kreator, estUSD: t.estUSD })),
  };
}

// ---------- http ----------
function httpError(code, message) { const e = new Error(message); e.code = code; return e; }
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { req.destroy(); reject(httpError(413, 'Body too large')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
  });
}
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api\//, '').split('/').map(decodeURIComponent);
  const m = req.method;
  if (m !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !ORIGINS.has(origin)) throw httpError(403, 'Cross-origin request refused');
  }
  if (m === 'GET' && p[0] === 'status') return send(res, 200, status());
  if (m === 'GET' && p[0] === 'ledger') return send(res, 200, ledger());
  if (p[0] === 'chat') {
    if (m === 'GET' && !p[1]) return send(res, 200, listChats());
    if (m === 'GET') { const c = loadChat(p[1]); if (!c) throw httpError(404, 'No such chat'); return send(res, 200, c); }
    if (m === 'POST') {
      const b = await readJSON(req);
      try { return send(res, 200, await chatTurn({ id: b.id, message: b.message, engine: CHAT, repo: REPO, subscription: SUBSCRIPTION })); }
      catch (e) { throw httpError(502, e.message); }
    }
  }
  if (p[0] === 'runs') {
    if (m === 'GET' && !p[1]) return send(res, 200, listRuns().map((s) => ({ run: s.run, status: s.status, spent: s.spent, cap: s.config.cap, topic: s.config.topic, template: s.config.template, kreator: s.config.kreator, engine: s.config.engine, waiting: s.waiting, updatedAt: s.updatedAt, reason: s.reason, active: busy() && active.run === s.run })));
    if (m === 'POST' && !p[1]) return send(res, 200, startRun(await readJSON(req)));
    const run = p[1];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run)) throw httpError(400, 'Bad run id');
    if (m === 'GET' && !p[2]) return send(res, 200, runView(run));
    if (m === 'GET' && p[2] === 'file') return send(res, 200, runFile(run, url.searchParams.get('name')), 'text/plain; charset=utf-8');
    if (m === 'POST' && p[2] === 'approve') return send(res, 200, approve(run, await readJSON(req)));
    if (m === 'POST' && p[2] === 'resume') { const b = await readJSON(req); return send(res, 200, resumeRun(run, b.engine ? ['--engine', b.engine] : [])); }
    if (m === 'POST' && p[2] === 'cancel') return send(res, 200, cancelRun(run));
    if (m === 'POST' && p[2] === 'upload') return send(res, 200, await upload(req, run, url.searchParams.get('kind'), url.searchParams.get('name')));
  }
  throw httpError(404, 'Unknown endpoint');
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const okRun = /^runs\/[A-Za-z0-9._-]+\/events\.jsonl$/.test(rel);
  if (!okRun && (STATIC_DENY.test(rel) || rel.startsWith('runs'))) return send(res, 404, 'Not found', 'text/plain');
  const file = path.resolve(OFFICE, rel);
  if (!file.startsWith(OFFICE + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  if (rel === 'data/events.jsonl' && !fs.existsSync(file)) return send(res, 200, '', MIME['.jsonl']);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase();
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(host)) return send(res, 403, 'Forbidden host', 'text/plain');
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    if (!e.code) console.error(e);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenAnstruk Virtual Office: http://localhost:${PORT}/?live=1`);
  console.log(`  pipeline engine: ${ENGINE}   chat: ${CHAT}   repo: ${REPO}${fs.existsSync(REPO) ? '' : ' (missing!)'}`);
  console.log(`  billing: ${status().billing}`);
  if (!HAS_CLAUDE && ENGINE === 'claude-cli') console.log('  WARNING: Claude Code (claude) was not found on PATH.');
  if (ENGINE === 'dry') console.log('  dry mode: everything is simulated and free. Use --repo <path> (and Claude Code) for real runs.');
  console.log(`  live log: ${defaultLog()}`);
});
