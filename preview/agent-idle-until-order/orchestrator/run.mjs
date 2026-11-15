#!/usr/bin/env node
// run.mjs: the Producer's pipeline for one video, with the $4 budget guard.
// Every step writes events to the office log, so the 3D office can replay or follow it live.
//
//   node orchestrator/run.mjs --template kolase-browser --topic "Gempa kecil tapi merusak" --slot 2026-11-20
//   options:
//     --engine dry | claude-cli | api   (default dry: no model calls, simulated usage, free)
//     --kreator openanstruk | aina       (default openanstruk)
//     --repo <path>                      repo the agents work in (claude-cli engine), e.g. D:\_Projects\OpenAnstruk-Studio
//     --log <file>                       default office/data/events.jsonl
//     --cap 4 --wrap 3.0 --stop 3.6      budget guard in USD
//     --skip-voice                       do not wait for the human voice-over
//     --pace 4                           dry engine: slow the simulation down for a live office demo
//     --run <id>                         run id, default from slot + topic
//
// Engines
//   dry        Simulates each step with the token sizes from cost-model.py. Use it to test the office.
//   claude-cli Runs each seat as `claude -p` (Claude Code headless) inside --repo, with the seat's
//              agent file as system prompt and the seat's model. Works on a subscription or an API key.
//              Usage and cost come from `--output-format json`.
//   api        Text-only steps through the Messages API (needs ANTHROPIC_API_KEY). Cannot edit files,
//              so it only covers research notes, script drafts, critique and captions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFICE = path.resolve(HERE, '..');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const ENGINE = opt('engine', 'dry');
const KREATOR = opt('kreator', 'openanstruk');
const TEMPLATE = opt('template', 'kolase-browser');
const TOPIC = opt('topic', 'Topik belum diisi');
const SLOT = opt('slot', new Date().toISOString().slice(0, 10));
const REPO = opt('repo', process.cwd());
const LOG = path.resolve(opt('log', path.join(OFFICE, 'data', 'events.jsonl')));
const CAP = +opt('cap', 4), WRAP = +opt('wrap', 3.0), STOP = +opt('stop', 3.6);
const SKIP_VOICE = !!opt('skip-voice', false);
const PACE = +opt('pace', 1);           // dry engine only: slow down for a live office demo (e.g. --pace 4)
const RUN = opt('run', `${SLOT}-${TOPIC.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)}`);

// ---------- prices (USD per million tokens, Nov 2026 list) ----------
// Assumption: model ids below; override with ORCH_MODEL_OPUS / _SONNET / _HAIKU if your account uses others.
const MODELS = {
  opus:   { id: process.env.ORCH_MODEL_OPUS   || 'claude-opus-5-5',   in: 4.00, out: 20.00, read: 0.20 },
  sonnet: { id: process.env.ORCH_MODEL_SONNET || 'claude-sonnet-5-5', in: 2.00, out: 10.00, read: 0.10 },
  haiku:  { id: process.env.ORCH_MODEL_HAIKU  || 'claude-haiku-5-5',  in: 0.10, out: 0.50,  read: 0.01 },
};
const priceOf = (m, u) => (u.in * MODELS[m].in + u.out * MODELS[m].out + u.cache_read * MODELS[m].read + u.cache_write * MODELS[m].in * 1.25) / 1e6;

// ---------- the pipeline (Phase 2, office-plan-v2.md) ----------
// size: simulated usage for the dry engine (turns x tokens), from cost-model.py
const STEPS = [
  { seat: 'producer',     model: 'haiku',  effort: 'low',    task: 'brief',    say: `Brief: ${TOPIC} (${SLOT}), template ${TEMPLATE}`, size: [6, 15000, 2000, 800] },
  { seat: 'researcher',   model: 'sonnet', effort: 'medium', task: 'research', say: 'Cek fakta: setiap angka bersumber dan bertanggal', size: [8, 30000, 3000, 1200], handoff: 'scriptwriter' },
  { seat: 'scriptwriter', model: 'opus',   effort: 'high',   task: 'script',   say: 'Naskah lisan + script.json, hook tanpa angka', size: [5, 35000, 2000, 3000], handoff: 'critic', check: 'cek-naskah' },
  { seat: 'critic',       model: 'opus',   effort: 'medium', task: 'critique', say: 'naskah-critic, satu putaran', size: [4, 35000, 3000, 1500], batch: true, gate: true },
  { seat: 'critic',       model: 'sonnet', effort: 'low',    task: 'attention', say: 'attention-check mode 1', size: [4, 30000, 2000, 1200], batch: true, handoff: 'animator' },
  { seat: 'animator',     model: 'sonnet', effort: 'high',   task: 'animate',  say: `Isi templat ${TEMPLATE}: adegan, isyarat kata`, size: [25, 60000, 3000, 2500], wrapAware: true },
  { seat: 'human',        task: 'voice' },
  { seat: 'ops',          task: 'render' },
  { seat: 'scriptwriter', model: 'sonnet', effort: 'medium', task: 'captions', say: 'Caption IG, judul TikTok dan YouTube', size: [3, 25000, 2000, 1500], batch: true },
];

// ---------- event log ----------
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const T0 = Date.now();
let spent = 0, wrapped = false;
function emit(agent, type, extra = {}) {
  const ev = { t: +((Date.now() - T0) / 1000).toFixed(1), run: RUN, agent, type, ...extra };
  fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
  const usd = ev.usd ? `  +$${ev.usd.toFixed(3)} (total $${spent.toFixed(2)})` : '';
  console.log(`[${String(ev.t).padStart(6)}] ${agent.padEnd(12)} ${type.padEnd(13)} ${ev.summary || ''}${usd}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- engines ----------
function agentPrompt(seat) {
  const f = path.join(OFFICE, 'agents', `office-${seat}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\n/, '') : '';
}
function taskPrompt(step) {
  return [
    `Run ${RUN}. Kreator: ${KREATOR}. Template: ${TEMPLATE}. Topic: ${TOPIC}. Slot: ${SLOT}.`,
    `Your task: ${step.task}. ${step.say}.`,
    wrapped ? 'BUDGET WRAP-UP: finish what you are doing in as few turns as possible. No new scenes.' : '',
    'End with one line starting with SUMMARY: (at most 90 characters, Bahasa Indonesia).',
    step.gate ? 'Also print one line VERDICT: PASS or VERDICT: BLOCK <reason>.' : '',
  ].filter(Boolean).join('\n');
}

// Estimated cost of a step from its size, and how many turns still fit under the stop line.
function estimate(step, turns = step.size[0]) {
  const [, ctx, fresh, out] = step.size;
  const u = { in: 0, out: turns * out, cache_read: turns * (ctx - fresh), cache_write: turns * fresh };
  return priceOf(step.model, u) * (step.batch ? 0.5 : 1);
}
function turnsAllowed(step) {
  const left = STOP - spent, full = step.size[0];
  if (estimate(step) <= left) return full;
  const perTurn = estimate(step, 1);
  return Math.max(1, Math.floor(left / perTurn));
}

async function callDry(step) {
  const [, ctx, fresh, out] = step.size;
  const turns = step.turns;
  await sleep((600 + turns * 120) * PACE);
  // with caching the fresh part of each turn is billed as a cache write, the rest as cache reads
  const u = { in: 0, out: turns * out, cache_read: turns * (ctx - fresh), cache_write: turns * fresh };
  return { usage: u, usd: priceOf(step.model, u) * (step.batch ? 0.5 : 1), text: `SUMMARY: ${step.say}\nVERDICT: PASS` };
}

async function callClaudeCli(step) {
  const args = ['-p', taskPrompt(step), '--output-format', 'json', '--model', MODELS[step.model].id,
    '--append-system-prompt', agentPrompt(step.seat), '--max-turns', String(step.turns * 2), '--permission-mode', 'acceptEdits'];
  const r = spawnSync('claude', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`claude -p failed: ${r.stderr || r.error}`);
  const j = JSON.parse(r.stdout);
  const u = j.usage || {};
  const usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 };
  // on a subscription total_cost_usd is the API-equivalent figure; it is still what the guard counts
  return { usage, usd: j.total_cost_usd ?? priceOf(step.model, usage), text: j.result || '' };
}

async function callApi(step) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELS[step.model].id, max_tokens: Math.max(800, Math.min(6000, Math.round(step.turns * step.size[3]))),
      system: [{ type: 'text', text: agentPrompt(step.seat), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: taskPrompt(step) }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(j));
  const u = j.usage;
  const usage = { in: u.input_tokens, out: u.output_tokens, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 };
  return { usage, usd: priceOf(step.model, usage), text: j.content.map((c) => c.text || '').join('\n') };
}
const ENGINES = { dry: callDry, 'claude-cli': callClaudeCli, api: callApi };

// ---------- free deterministic checks (scripts before agents) ----------
function freeCheck(name) {
  if (ENGINE === 'dry') return { ok: true, note: `${name}: dilewati (dry)` };
  if (name === 'cek-naskah') {
    const tool = path.join(REPO, 'tools', 'naskah', 'cek-naskah.mjs');
    if (!fs.existsSync(tool)) return { ok: true, note: 'cek-naskah.mjs tidak ada di repo ini' };
    return { ok: true, note: 'cek-naskah.mjs dijalankan oleh agen penulis' };
  }
  return { ok: true, note: name };
}

// ---------- run ----------
async function step(s) {
  if (spent >= STOP) { emit(s.seat, 'budget', { summary: `Stop: $${spent.toFixed(2)} >= $${STOP}. Langkah ${s.task} pakai skrip saja`, level: 'stop' }); return { skipped: true }; }
  if (!wrapped && spent >= WRAP) { wrapped = true; emit('producer', 'budget', { summary: `Wrap-up: $${spent.toFixed(2)} dari $${CAP}. Selesaikan, jangan tambah adegan`, level: 'wrap_up' }); }
  s.turns = turnsAllowed(s);
  if (s.turns < s.size[0]) {
    if (!wrapped) wrapped = true;
    emit('producer', 'budget', { summary: `${s.task}: dibatasi ${s.turns}/${s.size[0]} giliran agar di bawah $${STOP}`, level: 'wrap_up' });
  }
  emit(s.seat, 'task_start', { summary: s.say, model: s.model, effort: s.effort });
  emit(s.seat, 'thinking', { summary: s.task === 'animate' && wrapped ? 'Mode hemat: selesaikan adegan yang ada' : s.say });
  const out = await ENGINES[ENGINE](s);
  spent += out.usd;
  emit(s.seat, 'cost', { usd: +out.usd.toFixed(4), usage: out.usage, model: s.model });
  const summary = (out.text.match(/SUMMARY:\s*(.+)/) || [])[1]?.slice(0, 90) || `${s.task} selesai`;
  if (s.check) { const c = freeCheck(s.check); emit(s.seat, 'tool', { summary: c.note }); }
  const verdict = (out.text.match(/VERDICT:\s*(PASS|BLOCK.*)/) || [])[1] || 'PASS';
  return { summary, verdict };
}

async function main() {
  emit('producer', 'run_start', { template: TEMPLATE, summary: `${SLOT}: ${TOPIC}`, model: 'haiku', effort: 'low' });
  let rounds = 0;
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    if (s.seat === 'human') {
      if (SKIP_VOICE) { emit('producer', 'tool', { summary: 'Rekaman suara dilewati (--skip-voice)' }); continue; }
      const who = KREATOR === 'aina' ? 'aina' : 'ulza';
      emit('producer', 'waiting_human', { to: who, summary: `${who === 'aina' ? 'Aina' : 'Ulza'}, rekam sesuai script.json lalu simpan di voice/` });
      emit(who, 'task_start', { summary: 'Rekam di booth' });
      if (ENGINE === 'dry') await sleep(3000 * PACE);
      else await waitForVoice();
      emit(who, 'done', { summary: 'Rekaman masuk' });
      emit('producer', 'handoff', { to: 'ops', summary: 'Rekaman masuk, lanjut render' });
      continue;
    }
    if (s.seat === 'ops') { await renderStep(); continue; }
    const r = await step(s);
    if (r.skipped) continue;
    if (s.gate && r.verdict.startsWith('BLOCK') && rounds < 1) {
      rounds++;
      emit('critic', 'blocked', { summary: r.verdict.slice(0, 90) });
      emit('critic', 'handoff', { to: 'scriptwriter', summary: 'Kembalikan ke penulis' });
      i = STEPS.findIndex((x) => x.task === 'script') - 1;   // one revision round, then on
      continue;
    }
    emit(s.seat, 'done', { summary: r.summary });
    if (s.handoff) emit(s.seat, 'handoff', { to: s.handoff, summary: r.summary });
  }
  emit('producer', 'run_end', { summary: `Run ${RUN} selesai. Total $${spent.toFixed(2)} dari $${CAP}` });
  console.log(`\nTotal: $${spent.toFixed(3)}  (cap $${CAP})  log: ${LOG}`);
}

async function waitForVoice() {
  const dir = path.join(REPO, 'marketing', 'posts', RUN, 'voice');
  emit('producer', 'thinking', { summary: `Menunggu berkas suara di ${path.relative(REPO, dir)}` });
  while (!(fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(wav|m4a|mp3)$/i.test(f)))) await sleep(15000);
}

async function renderStep() {
  emit('ops', 'task_start', { summary: 'Whisper, campur, render (skrip, tanpa agen)', model: 'none', effort: 'none' });
  const post = path.join(REPO, 'marketing', 'posts', RUN);
  if (ENGINE !== 'dry' && fs.existsSync(path.join(post, 'final.sh'))) {
    const r = spawnSync('bash', [path.join(post, 'final.sh')], { cwd: post, encoding: 'utf8' });
    emit('ops', r.status === 0 ? 'tool' : 'blocked', { summary: r.status === 0 ? 'final.sh selesai' : 'final.sh gagal, cek log' });
  } else {
    if (ENGINE === 'dry') await sleep(1500 * PACE);
    emit('ops', 'tool', { summary: ENGINE === 'dry' ? 'Render disimulasikan (dry)' : 'final.sh belum ada di folder post' });
  }
  emit('ops', 'done', { summary: `video/${RUN}.mp4` });
}

main().catch((e) => { emit('producer', 'blocked', { summary: String(e.message).slice(0, 90) }); console.error(e); process.exit(1); });
