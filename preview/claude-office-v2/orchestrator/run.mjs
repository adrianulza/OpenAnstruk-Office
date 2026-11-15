#!/usr/bin/env node
// run.mjs: the Producer's pipeline for one reel (or one template adaptation), with the budget guard.
// Every step writes events to data/events.jsonl and runs/<id>/events.jsonl, so the office can follow it.
//
//   node orchestrator/run.mjs --topic "Gempa kecil tapi merusak" --slot 2026-11-20 --template kolase-browser
//   node orchestrator/run.mjs --config run.json            (the Template Board's "Copy run config")
//   node orchestrator/run.mjs --resume 0026-gempa-kecil-merusak
//
// Run with --help for every option. Steps, models and prices: data/pipeline.json.
import fs from 'node:fs';
import path from 'node:path';
import {
  OFFICE, PIPELINE, TEMPLATES, ConfigError, parseArgs, buildConfig, resolveRunId, resolvePostDir, pipelineFor, validate,
} from './lib/config.mjs';
import { createEmitter, loadState, saveState, appendLedger, notify, runDir, END_STATUSES } from './lib/events.mjs';
import {
  ENGINE_FNS, estimate, turnsAllowed, parseGate, summaryOf, missingOutputs, captureOutputs, fill,
  runCommand, findCommand, expand,
} from './lib/engines.mjs';
import { killTree, claudeInstalled } from './lib/claude.mjs';

const HELP = `Usage: node orchestrator/run.mjs [options]

What to make
  --topic <text>          Reel topic (required for phase 2)
  --slot <YYYY-MM-DD>     Publish slot (default today)
  --template <id>         Template id from templates.json (default kolase-browser)
  --kreator <name>        openanstruk | aina (default openanstruk)
  --notes <text>          Extra instructions for the team
  --config <file>         JSON run config (Template Board / office "Start run"); flags override it
  --phase <1|2>           2 = make a reel (default), 1 = adapt a template that is not ready yet

How to run it
  --engine <name>         dry (free, simulated) | claude-cli (Claude Code: subscription or API key) | api (API key, text-only)
  --repo <path>           Repo the agents work in (claude-cli/api), e.g. D:\\_Projects\\OpenAnstruk-Studio
  --subscription          Remove ANTHROPIC_API_KEY from the agents' environment so Claude Code uses your subscription login
  --run <id>              Run id (default: next number + slug, e.g. 0026-gempa-kecil-merusak)
  --post <dir>            Post folder (default <repo>/marketing/posts/<run> or aina/projects/<run>)
  --until <step>          Stop after this step (e.g. attention: brief, research and script only)
  --resume <run id>       Continue a parked, blocked or failed run from where it stopped

Human checkpoints
  --approve <list>        Pause for your OK at: brief,script,final (comma list)
  --auto-approve          Approve every checkpoint automatically (demos)
  --wait <minutes>        How long to wait for a recording or an approval before parking the run (default 60)
  --skip-voice            Do not wait for the voice-over / footage

Budget and safety
  --cap 4 --wrap 3 --stop 3.6   Guard in USD (phase 1 default 6 / 4.5 / 5.4)
  --rounds <n>            Revision rounds after a BLOCK before the run stops (default 1)
  --retries <n>           Retries for a failed step (default 1)
  --step-timeout <min>    Kill a step after this many minutes (default 30)
  --pace <n>              dry engine: slow the simulation down for a live demo
  --dry-verdicts <spec>   dry engine: simulate verdicts, e.g. critique=BLOCK,PASS;qa=PASS`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT = { ok: 0, partial: 0, blocked: 3, rejected: 3, over_budget: 3, error: 1, cancelled: 130 };

async function main() {
  let flags;
  try { flags = parseArgs(process.argv.slice(2)); } catch (e) { return usageError(e); }
  if (flags.help) { console.log(HELP); return 0; }

  let state, cfg;
  if (flags.resume) {
    state = loadState(flags.resume);
    if (!state) return usageError(new ConfigError(`No run "${flags.resume}" in runs/`));
    if (state.status === 'ok') return usageError(new ConfigError(`Run "${state.run}" already finished (ok)`));
    if (state.status === 'running' && state.pid && state.pid !== process.pid && alive(state.pid)) return usageError(new ConfigError(`Run "${state.run}" is already running (pid ${state.pid})`));
    cfg = state.config;
    state.rounds = {};
    if (flags.engine) cfg.engine = flags.engine;
    if (flags.cap) { cfg.cap = Number(flags.cap); cfg.stop = Math.min(cfg.cap, Number(flags.stop || cfg.stop)); }
    if (flags.wait) cfg.waitMin = Number(flags.wait);
    if (flags['auto-approve']) cfg.autoApprove = true;
    if (flags.subscription) cfg.subscription = true;
    try { validate(cfg); } catch (e) { return usageError(e); }
  } else {
    try { cfg = buildConfig(flags); } catch (e) { return usageError(e); }
    let run;
    try { run = resolveRunId(cfg); } catch (e) { return usageError(e); }
    if (loadState(run)) return usageError(new ConfigError(`Run "${run}" already exists. Use --resume ${run}, or pick another --run`));
    state = {
      run, config: cfg, post: resolvePostDir(cfg, run), status: 'running', stepIndex: 0, spent: 0, wrapped: false,
      rounds: {}, seats: {}, history: [], revision: null, startedAt: new Date().toISOString(), elapsed: 0,
    };
  }
  if (cfg.engine === 'claude-cli' && !claudeInstalled()) {
    return usageError(new ConfigError('Claude Code (`claude`) was not found. Install it and log in once (`claude`), or use --engine dry'));
  }
  if (cfg.engine === 'claude-cli' && process.env.ANTHROPIC_API_KEY && !cfg.subscription) {
    console.warn('Note: ANTHROPIC_API_KEY is set, so Claude Code bills the API. Add --subscription to use your Claude subscription instead.');
  }
  const runner = new Runner(state);
  let code;
  try { code = await runner.go(!!flags.resume); }
  catch (e) { console.error(e); code = runner.finish('error', `Kesalahan tak terduga: ${e.message}`); }
  await Promise.allSettled(runner.pending);   // let webhook / ntfy notifications finish
  return code;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function usageError(e) {
  console.error(`Error: ${e.message}\nRun with --help for options.`);
  return e instanceof ConfigError ? 2 : 1;
}

class Runner {
  constructor(state) {
    this.s = state; this.cfg = state.config; this.run = state.run; this.post = state.post;
    this.steps = pipelineFor(this.cfg);
    this.child = null; this.done = false; this.pending = [];
    this.emit = createEmitter(this.run, { offsetSec: state.elapsed || 0 });
    this.verdictPlan = parseDryVerdicts(this.cfg.dryVerdicts);
    fs.mkdirSync(this.post, { recursive: true });
  }

  save() { this.s.elapsed = this.emit.elapsed(); saveState(this.s); }

  async go(resumed) {
    this.s.pid = process.pid;
    const stop = () => { if (!this.done) { killTree(this.child); this.finish('cancelled', 'Dibatalkan'); } };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (!resumed) {
      const t = this.cfg.templateInfo;
      this.emit('producer', 'run_start', {
        template: this.cfg.template, kreator: this.cfg.kreator, phase: this.cfg.phase, engine: this.cfg.engine,
        cap: this.cfg.cap, wrap: this.cfg.wrap, stop: this.cfg.stop, stages: [...new Set(this.steps.map((s) => s.stage).filter(Boolean))],
        summary: `${this.cfg.slot}: ${this.cfg.topic}`, model: 'haiku', effort: 'low',
      });
      if (t.needsImageGen) this.emit('producer', 'tool', { summary: `Templat ${t.name} butuh generator gambar dari kamu` });
    } else {
      const at = this.steps[this.s.stepIndex]?.id || 'akhir';
      this.emit('producer', 'tool', { summary: `Lanjut run dari langkah ${at}` });
    }
    this.s.status = 'running'; this.s.waiting = null; this.s.reason = null; this.save();

    for (let i = this.s.stepIndex; i < this.steps.length; i++) {
      if (this.done) return EXIT[this.s.status];
      this.s.stepIndex = i; this.save();
      const step = this.steps[i];
      const r = await this.dispatch(step);
      if (this.done) return EXIT[this.s.status];
      if (r?.park) { this.park(r.park); return 0; }
      if (r?.goto) { i = this.steps.findIndex((s) => s.id === r.goto) - 1; continue; }
      this.s.stepIndex = i + 1; this.save();
      if (this.cfg.until && step.id === this.cfg.until) return this.finish('partial', `Berhenti setelah ${step.id} (--until)`);
    }
    return this.finish('ok');
  }

  dispatch(step) {
    switch (step.kind) {
      case 'approval': return this.approval(step);
      case 'human': return this.human(step);
      case 'render': return this.render(step);
      case 'publish': return this.publish(step);
      case 'register': return this.register(step);
      default: return this.agent(step);
    }
  }

  // ---------- agent steps ----------
  async agent(step, { synthetic = false } = {}) {
    const c = this.cfg, s = this.s;
    if (c.engine === 'api' && step.needsFiles) {
      return this.finish('partial', `Engine api tidak bisa mengedit berkas. Lanjutkan: --resume ${this.run} dengan claude-cli`, { resumeEngine: true });
    }
    if (s.spent >= c.cap) return this.finish('over_budget', `Batas $${c.cap} tercapai sebelum ${step.id}`);
    if (s.spent >= c.stop) {
      if (step.optional) { this.emit(step.seat, 'budget', { level: 'stop', summary: `Stop $${s.spent.toFixed(2)}: ${step.id} dilewati, tulis manual` }); this.skipped(step); return null; }
      return this.finish('over_budget', `Garis stop $${c.stop} tercapai sebelum ${step.id}`);
    }
    if (!s.wrapped && s.spent >= c.wrap) { s.wrapped = true; this.emit('producer', 'budget', { level: 'wrap_up', summary: `Wrap-up: $${s.spent.toFixed(2)} dari $${c.cap}. Selesaikan, jangan tambah adegan` }); }
    if (s.wrapped && step.optional) { this.emit(step.seat, 'budget', { level: 'wrap_up', summary: `Wrap-up: ${step.id} opsional dilewati, tulis manual` }); this.skipped(step); return null; }

    const turns = turnsAllowed(step, c.stop - s.spent);
    if (turns < step.size[0]) {
      s.wrapped = true;
      this.emit('producer', 'budget', { level: 'wrap_up', summary: `${step.id}: dibatasi ${turns}/${step.size[0]} giliran agar di bawah $${c.stop}` });
    }
    const revision = s.revision?.target === step.id ? s.revision : null;
    if (step.precheck && !synthetic) {
      const r = await this.freeCheck(step.precheck, step, 'periksa.txt');
      if (this.done) return null;
      if (r && !r.pass) return this.gateFail(step, step, r.reason, `${step.id}:pre`);
    }
    this.emit(step.seat, 'task_start', { summary: fill(step.say, c), model: step.model, effort: step.effort, stage: step.stage, task: step.id });
    this.emit(step.seat, 'thinking', { summary: revision ? `Revisi: ${revision.reason}` : (step.wrapAware && s.wrapped ? 'Mode hemat: selesaikan yang ada' : fill(step.say, c)) });

    let out, attempt = 0, note = revision;
    for (;;) {
      const startedAt = Date.now();
      const ctx = {
        cfg: c, run: this.run, post: this.post, wrapped: s.wrapped, revision: note, turns,
        budget: Math.max(0.01, c.cap - s.spent), emit: this.emit, setChild: (ch) => (this.child = ch),
        dryVerdict: (id) => this.verdictPlan(id),
      };
      out = await ENGINE_FNS[c.engine](step, ctx);
      this.addCost(step, out);
      if (this.done) return null;
      if (out.ok) {
        captureOutputs(this.post, step, out.text, { inline: c.engine === 'api' });
        const missing = missingOutputs(this.post, step, startedAt);
        if (!missing.length) break;
        out = { ok: false, error: `${step.seat} tidak menulis ${missing.join(', ')}` };
      }
      if (s.spent >= c.cap || out.budget || /budget/.test(out.error || '')) return this.finish('over_budget', `${step.id}: ${out.error || 'anggaran habis'}`);
      if (out.auth) return this.finish('error', `Login/kunci API bermasalah: ${out.error}`);
      if (attempt >= c.retries) return this.finish('error', `${step.id} gagal: ${out.error}`);
      attempt++;
      this.emit(step.seat, 'blocked', { summary: `${out.error}. Coba lagi (${attempt}/${c.retries})` });
      note = { round: attempt, reason: out.error };
    }
    if (revision) s.revision = null;
    s.history.push({ step: step.id, seat: step.seat, usd: +out.usd.toFixed(4), at: new Date().toISOString(), summary: summaryOf(out.text, `${step.id} selesai`) });
    if (s.spent > c.cap) return this.finish('over_budget', `Total $${s.spent.toFixed(2)} melewati batas $${c.cap}`);
    if (synthetic) return out;

    if (step.checks) {
      const r = await this.freeCheck(step.checks, step, 'cek.txt');
      if (r && !r.pass) return this.gateFail(step, { ...step, revise: step.id }, r.reason, `${step.id}:cek`);
    }
    if (step.gate) {
      const text = step.capture ? fs.readFileSync(path.join(this.post, step.capture), 'utf8') : out.text;
      const g = parseGate(step.gate, text);
      if (!g.pass) {
        if (step.gate === 'READY') return this.finish('blocked', `Gerbang akurasi: ${g.reason}`);
        return this.gateFail(step, step, g.reason, step.id);
      }
    }
    this.emit(step.seat, 'done', { summary: summaryOf(out.text, `${step.id} selesai`) });
    if (step.handoff) this.emit(step.seat, 'handoff', { to: step.handoff, summary: summaryOf(out.text, `${step.id} siap`) });
    return null;
  }

  gateFail(step, gateStep, reason, key) {
    const s = this.s;
    s.rounds[key] = (s.rounds[key] || 0) + 1;
    this.emit(step.seat, 'blocked', { summary: `BLOCK: ${reason}` });
    if (gateStep.revise && s.rounds[key] <= this.cfg.rounds) {
      const target = this.steps.find((x) => x.id === gateStep.revise);
      s.revision = { target: target.id, round: s.rounds[key], reason };
      this.emit(step.seat, 'handoff', { to: target.seat, summary: `Kembalikan ke ${target.id}: ${reason}` });
      return { goto: target.id };
    }
    return this.finish('blocked', `${step.id} BLOCK setelah ${s.rounds[key] - 1} revisi: ${reason}`);
  }

  addCost(step, out) {
    const usd = out.usd || 0;
    this.s.spent += usd;
    this.s.seats[step.seat] = +((this.s.seats[step.seat] || 0) + usd).toFixed(4);
    if (usd > 0 || out.ok) this.emit(step.seat, 'cost', { usd: +usd.toFixed(4), usage: out.usage || {}, model: step.model });
    this.save();
  }

  skipped(step) { this.s.history.push({ step: step.id, seat: step.seat, usd: 0, skipped: true, at: new Date().toISOString() }); }

  // ---------- free scripts ----------
  async freeCheck(name, step, outFile) {
    if (this.cfg.engine === 'dry') { this.emit(step.seat, 'tool', { summary: `${name}: dilewati (dry)` }); return null; }
    const cmd = findCommand(PIPELINE.checks[name], this.vars(), this.cfg.kreator);
    if (!cmd) { this.emit(step.seat, 'tool', { summary: `${name}: skrip tidak ditemukan, dilewati (atur di pipeline.json)` }); return null; }
    this.emit(step.seat, 'tool', { summary: `${name}: ${cmd.cmd.slice(0, 3).join(' ')}` });
    const r = await runCommand(cmd.cmd, { cwd: cmd.cwd, onSpawn: (c) => (this.child = c) });
    fs.writeFileSync(path.join(this.post, outFile), r.out);
    if (r.code !== 0) return { pass: false, reason: `${name} gagal (kode ${r.code}): ${r.out.trim().split('\n').slice(-1)[0] || ''}`.slice(0, 160) };
    this.emit(step.seat, 'tool', { summary: `${name}: lolos` });
    return { pass: true };
  }
  vars() {
    return { repo: this.cfg.repo, post: this.post, postRel: path.relative(this.cfg.repo, this.post).split(path.sep).join('/'), run: this.run, video: this.s.video || '' };
  }

  // ---------- humans ----------
  async waitFor(check, label) {
    const until = Date.now() + this.cfg.waitMin * 60000;
    for (;;) {
      const r = check();
      if (r) return r;
      if (this.done) return null;
      if (Date.now() >= until) return null;
      await sleep(this.cfg.engine === 'dry' ? 500 : 3000);
    }
  }

  async human(step) {
    const who = step.who, dir = path.join(this.post, step.dir);
    const name = who === 'aina' ? 'Aina' : 'Ulza';
    if (this.cfg.skipVoice) { this.emit('producer', 'tool', { summary: `Rekaman ${name} dilewati (--skip-voice)` }); return null; }
    const found = () => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => step.ext.includes(f.split('.').pop().toLowerCase()));
    if (!found()) {
      this.emit('producer', 'waiting_human', { to: who, summary: fill(step.say, this.cfg) });
      this.emit(who, 'task_start', { summary: step.dir === 'voice' ? 'Rekam suara di booth' : 'Rekam di depan kamera', stage: step.stage });
      this.notify('recording', `${name}: naskah siap. Simpan rekaman di ${dir}`);
      if (this.cfg.engine === 'dry') {
        await sleep(3000 * this.cfg.pace);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `dry.${step.ext[0]}`), 'DRY RUN placeholder');
      }
      this.setWaiting({ kind: 'human', name: step.dir, who, dir });
      const f = await this.waitFor(found, 'recording');
      this.setWaiting(null);
      if (this.done) return null;
      if (!f) return { park: { kind: 'human', name: step.dir, who, dir } };
    }
    this.emit(who, 'done', { summary: `Rekaman masuk: ${found()}` });
    this.emit('producer', 'handoff', { to: step.handoff || 'ops', summary: 'Rekaman masuk, lanjut' });
    return null;
  }

  async approval(step) {
    if (!step.required && !this.cfg.approve.includes(step.name)) return null;
    const dir = path.join(runDir(this.run), 'approvals'), file = path.join(dir, `${step.name}.json`);
    fs.mkdirSync(dir, { recursive: true });
    const read = () => { try { return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    if (!read()) {
      this.emit('producer', 'approval', { name: step.name, to: 'ulza', summary: fill(step.say, this.cfg) });
      this.notify('approval', `Perlu persetujuan: ${step.name}. Buka office atau tulis ${file}`);
      if (this.cfg.autoApprove) fs.writeFileSync(file, JSON.stringify({ decision: 'approve', note: 'auto', at: new Date().toISOString() }));
    }
    if (!read()) this.setWaiting({ kind: 'approval', name: step.name });
    const d = await this.waitFor(read, 'approval');
    this.setWaiting(null);
    if (this.done) return null;
    if (!d) return { park: { kind: 'approval', name: step.name } };
    this.emit('producer', 'decision', { name: step.name, decision: d.decision, summary: `${step.name}: ${d.decision === 'approve' ? 'disetujui' : 'ditolak'}${d.note ? ' · ' + d.note : ''}` });
    if (d.decision === 'approve') return null;
    // rejected: keep the record, clear the request, send the work back once or twice
    fs.renameSync(file, path.join(dir, `${step.name}.rejected-${Date.now()}.json`));
    const back = { brief: 'brief', script: 'script', final: this.steps.find((x) => x.id === 'animate' || x.id === 'edit')?.id, plan: 'scope', kit: 'build' }[step.name];
    const key = `approval:${step.name}`;
    this.s.rounds[key] = (this.s.rounds[key] || 0) + 1;
    if (back && this.s.rounds[key] <= 2) {
      const target = this.steps.find((x) => x.id === back);
      this.s.revision = { target: back, round: this.s.rounds[key], reason: `Ditolak Ulza: ${d.note || 'tanpa catatan'}` };
      this.emit('producer', 'handoff', { to: target.seat, summary: `Revisi ${back}: ${d.note || 'ditolak'}` });
      return { goto: back };
    }
    return this.finish('rejected', `${step.name} ditolak: ${d.note || ''}`);
  }

  notify(kind, text) { this.pending.push(notify(this.run, kind, text)); }

  setWaiting(w) {
    if (this.done) return;
    this.s.waiting = w ? { ...w, since: new Date().toISOString() } : null;
    this.s.status = w ? 'waiting' : 'running';
    this.save();
  }

  park(waiting) {
    this.s.status = 'parked'; this.s.waiting = { ...waiting, since: new Date().toISOString() };
    this.emit('producer', 'parked', { summary: waiting.kind === 'approval' ? `Menunggu persetujuan ${waiting.name}; lanjut lewat office` : `Menunggu rekaman ${waiting.who}; lanjut otomatis saat berkas masuk` });
    this.save();
    console.log(`\nParked: waiting for ${waiting.kind} (${waiting.name}). Continue with: node orchestrator/run.mjs --resume ${this.run}`);
  }

  // ---------- render, publish, register ----------
  async render(step) {
    const started = Date.now();
    let mentioned = [];
    this.emit('ops', 'task_start', { summary: 'Render (skrip, tanpa agen)', model: 'none', effort: 'none', stage: step.stage, task: 'render' });
    if (this.cfg.engine === 'dry') {
      await sleep(1500 * this.cfg.pace);
      fs.mkdirSync(path.join(this.post, 'video'), { recursive: true });
      fs.writeFileSync(path.join(this.post, 'video', `${this.run}.mp4`), 'DRY RUN placeholder, not a real video');
      this.emit('ops', 'tool', { summary: 'Render disimulasikan (dry)' });
    } else {
      const R = PIPELINE.render;
      const cmd = findCommand([R[this.cfg.template], R.default].filter(Boolean), this.vars(), this.cfg.kreator);
      if (cmd) {
        this.emit('ops', 'tool', { summary: cmd.cmd.join(' ') });
        const r = await runCommand(cmd.cmd, { cwd: cmd.cwd, timeoutMs: 60 * 60000, onSpawn: (c) => (this.child = c) });
        fs.writeFileSync(path.join(this.post, 'render.log'), r.out);
        if (this.done) return null;
        if (r.code !== 0) return this.finish('error', `Render gagal (kode ${r.code}), lihat render.log`);
      } else if (this.cfg.engine === 'claude-cli') {
        this.emit('ops', 'tool', { summary: 'Tidak ada skrip render; Opi Ops menjalankan office-ops' });
        const opsStep = { id: 'render', seat: 'ops', model: 'haiku', effort: 'low', stage: step.stage, size: [8, 20000, 2000, 600],
          say: 'Render video sesuai office-ops.md, lalu laporkan path mp4', reads: ['animasi.md', 'script.json'] };
        const out = await this.agent(opsStep, { synthetic: true });
        if (this.done || !out) return null;
        mentioned = [...out.text.matchAll(/([^\s`'"()]+\.mp4)\b/gi)].map((m) => path.resolve(this.cfg.repo, m[1]));
      } else {
        return this.finish('error', 'Tidak ada skrip render untuk templat ini (atur render di data/pipeline.json)');
      }
    }
    const video = findVideo([path.join(this.cfg.repo, 'video', `${this.run}.mp4`), ...mentioned], this.post, started);
    if (!video) return this.finish('error', 'Render tidak menghasilkan berkas mp4');
    this.s.video = video;
    this.emit('ops', 'done', { summary: `Video: ${path.basename(video)}` });
    this.emit('ops', 'handoff', { to: 'critic', summary: 'Video siap diperiksa' });
    this.save();
    return null;
  }

  async publish(step) {
    this.emit('ops', 'task_start', { summary: 'Siapkan paket tayang', model: 'none', effort: 'none', stage: step.stage, task: 'publish' });
    let video = this.s.video;
    if (this.cfg.engine !== 'dry' && video) {
      const dest = path.join(this.cfg.repo, 'video', `${this.run}.mp4`);
      if (path.resolve(dest) !== path.resolve(video)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(video, dest); video = dest; }
    }
    const caption = fs.existsSync(path.join(this.post, 'caption-ig.md'));
    const pkg = {
      run: this.run, kreator: this.cfg.kreator, slot: this.cfg.slot, platforms: this.cfg.platforms, template: this.cfg.template,
      video, caption: caption ? path.join(this.post, 'caption-ig.md') : null, status: 'ready_to_publish', dry: this.cfg.engine === 'dry',
      note: 'Upload manually (or with your scheduler) at the slot time. Nothing is posted automatically.',
    };
    fs.writeFileSync(path.join(this.post, 'publish.json'), JSON.stringify(pkg, null, 2));
    if (!caption) this.emit('ops', 'tool', { summary: 'Caption belum ada: tulis manual sebelum tayang' });
    this.emit('ops', 'done', { summary: `Siap tayang ${this.cfg.slot}: publish.json` });
    this.notify('ready', `Siap tayang ${this.cfg.slot}: ${video || 'video'}`);
    return null;
  }

  async register(step) {
    this.emit('ops', 'task_start', { summary: 'Daftarkan templat sebagai siap', model: 'none', effort: 'none', stage: step.stage, task: 'register' });
    if (this.cfg.engine === 'dry') { this.emit('ops', 'done', { summary: 'dry: templates.json tidak diubah' }); return null; }
    const f = path.join(OFFICE, 'templates.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const t = j.templates.find((x) => x.id === this.cfg.template);
    t.status = 'ready'; t.adaptedRun = this.run; t.kit = path.relative(this.cfg.repo, this.post).split(path.sep).join('/');
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    TEMPLATES.splice(0, TEMPLATES.length, ...j.templates);
    this.emit('ops', 'done', { summary: `${t.name} siap dipakai` });
    return null;
  }

  // ---------- end ----------
  finish(status, reason = '', extra = {}) {
    if (this.done) return EXIT[this.s.status];
    this.done = true;
    const s = this.s;
    if (!END_STATUSES.includes(status)) status = 'error';
    s.status = status; s.reason = reason || null; s.endedAt = new Date().toISOString(); s.waiting = null; Object.assign(s, extra);
    const total = `$${s.spent.toFixed(2)} dari $${this.cfg.cap}`;
    const text = {
      ok: this.cfg.phase === 1 ? `Templat siap. Total ${total}` : `Siap tayang ${this.cfg.slot}. Total ${total}`,
      partial: `${reason}. Total ${total}`, blocked: `Berhenti: ${reason}`, rejected: `Ditolak: ${reason}`,
      over_budget: `Anggaran: ${reason}`, error: `Gagal: ${reason}`, cancelled: `Dibatalkan. Total ${total}`,
    }[status];
    this.emit('producer', 'run_end', { status, summary: text, total: +s.spent.toFixed(4) });
    writeReport(s, this.steps);
    appendLedger({ kind: 'run', run: this.run, kreator: this.cfg.kreator, template: this.cfg.template, engine: this.cfg.engine, phase: this.cfg.phase, status, usd: +s.spent.toFixed(4), seats: s.seats });
    if (status !== 'ok') this.notify(status, text);
    this.save();
    console.log(`\n${status.toUpperCase()}: ${text}\nReport: ${path.join(runDir(this.run), 'report.md')}`);
    return EXIT[status];
  }
}

function findVideo(candidates, post, since) {
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).mtimeMs >= since - 1000) return c;
  const walk = (d, depth) => {
    if (depth > 3 || !fs.existsSync(d)) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !['footage', 'voice', 'node_modules'].includes(e.name)) { const r = walk(p, depth + 1); if (r) return r; }
      else if (e.isFile() && /\.mp4$/i.test(e.name) && fs.statSync(p).mtimeMs >= since - 1000 && fs.statSync(p).size > 0) return p;
    }
    return null;
  };
  return walk(post, 0);
}

function parseDryVerdicts(spec) {
  const plan = {};
  for (const part of String(spec || '').split(';').filter(Boolean)) {
    const [id, seq] = part.split('=');
    plan[id.trim()] = (seq || '').split(',').map((x) => x.trim().toUpperCase());
  }
  const used = {};
  return (id) => { const seq = plan[id]; if (!seq) return 'PASS'; const i = used[id] = (used[id] ?? -1) + 1; return seq[Math.min(i, seq.length - 1)]; };
}

function writeReport(s, steps) {
  const c = s.config;
  const rows = s.history.map((h) => `| ${h.step} | ${h.seat} | ${h.skipped ? 'skipped' : '$' + h.usd.toFixed(3)} | ${(h.summary || '').replace(/\|/g, '/')} |`).join('\n');
  const files = fs.existsSync(s.post) ? fs.readdirSync(s.post).filter((f) => !f.startsWith('.')).join(', ') : '-';
  const md = `# Run ${s.run}

- Status: **${s.status}**${s.reason ? ` (${s.reason})` : ''}
- Topic: ${c.topic} · Slot: ${c.slot} · Kreator: ${c.kreator} · Template: ${c.template} · Phase ${c.phase}
- Engine: ${c.engine}${c.engine === 'dry' ? ' (simulated, no model calls)' : ''}
- Spend: $${s.spent.toFixed(3)} of $${c.cap} (wrap ${c.wrap}, stop ${c.stop})
- Post folder: ${s.post}
- Video: ${s.video || '-'}
- Started ${s.startedAt} · ended ${s.endedAt || '-'}

## Steps
| Step | Seat | Cost | Summary |
|---|---|---|---|
${rows || '| - | - | - | - |'}

## Spend per seat
${Object.entries(s.seats).map(([k, v]) => `- ${k}: $${v.toFixed(3)}`).join('\n') || '- none'}

## Files in the post folder
${files}

Pipeline: ${steps.map((x) => x.id).join(' → ')}
`;
  fs.writeFileSync(path.join(runDir(s.run), 'report.md'), md);
}

main().then((code) => process.exit(code ?? 0)).catch((e) => { console.error(e); process.exit(1); });
