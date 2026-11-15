// engines.mjs: prompts, artifacts and the three engines (dry, claude-cli, api), plus script checks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OFFICE, PIPELINE } from './config.mjs';
import { runClaude, childEnv, supports, killTree } from './claude.mjs';
import { runDir } from './events.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const priceOf = (model, u) => {
  const m = PIPELINE.models[model];
  return (u.in * m.in + u.out * m.out + u.cache_read * m.read + u.cache_write * m.write) / 1e6;
};

// ---------- agent files ----------
export function agentFile(seat) {
  const f = path.join(OFFICE, 'agents', `office-${seat}.md`);
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const tools = fm ? (/^tools:\s*(.+)$/m.exec(fm[1])?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { body: raw.replace(/^---[\s\S]*?---\n?/, ''), tools };
}

// ---------- artifacts ----------
export const optionalName = (n) => n.endsWith('?');
export const bare = (n) => n.replace(/\?$/, '');
export function readArtifact(post, name, max = 12000) {
  const f = path.join(post, bare(name));
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  return t.length > max ? t.slice(0, max) + '\n[... dipotong ...]' : t;
}
export function missingOutputs(post, step, since) {
  return (step.writes || []).filter((n) => {
    const f = path.join(post, n);
    if (!fs.existsSync(f)) return true;
    const st = fs.statSync(f);
    return st.size === 0 || st.mtimeMs < since - 2000;
  });
}

// ---------- verdicts ----------
// Fail closed: no verdict line means BLOCK.
export function parseGate(kind, text) {
  if (kind === 'READY') {
    const m = [...text.matchAll(/READY:\s*(yes|ya|no|tidak)\b(.*)/gi)].pop();
    if (!m) return { pass: false, reason: 'Produser tidak memberi READY: yes/no' };
    return /^(yes|ya)$/i.test(m[1]) ? { pass: true } : { pass: false, reason: (m[2] || '').trim() || 'Sumber belum siap' };
  }
  const m = [...text.matchAll(/VERDICT:\s*(PASS|BLOCK)\b(.*)/gi)].pop();
  if (!m) return { pass: false, reason: 'Tidak ada VERDICT (dianggap BLOCK)' };
  return m[1].toUpperCase() === 'PASS' ? { pass: true } : { pass: false, reason: (m[2] || '').replace(/^[\s:-]+/, '').trim() || 'BLOCK' };
}
export const summaryOf = (text, fallback) => (/SUMMARY:\s*(.+)/.exec(text)?.[1] || fallback).trim().slice(0, 90);

// ---------- prompts ----------
export function taskPrompt(step, ctx, { inline = false } = {}) {
  const { cfg, run, post, wrapped, revision } = ctx;
  const say = fill(step.say, cfg);
  const lines = [
    `Run ${run}. Kreator: ${cfg.kreator}. Template: ${cfg.template}. Topic: ${cfg.topic}. Slot: ${cfg.slot}.`,
    cfg.notes ? `Catatan dari Ulza: ${cfg.notes}` : '',
    `Your task: ${step.id}. ${say}.`,
    `Post folder (all files for this run): ${post}`,
  ];
  const reads = (step.reads || []).filter((n) => !optionalName(n) || fs.existsSync(path.join(post, bare(n))));
  if (reads.length) {
    if (inline) {
      for (const n of reads) { const t = readArtifact(post, n); if (t !== null) lines.push(`\n===== ${bare(n)} =====\n${t}`); }
    } else lines.push(`Read these files first: ${reads.map((n) => path.join(post, bare(n))).join(', ')}`);
  }
  if (step.writes?.length) {
    lines.push(inline
      ? `Write your answer as the content of ${step.writes[0]}${step.writes.find((w) => w.endsWith('.json')) ? ` and put ${step.writes.find((w) => w.endsWith('.json'))} in one fenced \`\`\`json block` : ''}.`
      : `Write these files (required, the run stops if one is missing): ${step.writes.map((n) => path.join(post, n)).join(', ')}`);
  }
  if (step.id === 'animate' || step.id === 'edit' || step.id === 'build') lines.push('In animasi.md list what you built: scenes, files, how to render, and anything left to do.');
  if (revision) lines.push(`\nREVISION ${revision.round}: the previous version was blocked. Reason: ${revision.reason}. Fix exactly this, do not rewrite what already passed.`);
  if (wrapped) lines.push('BUDGET WRAP-UP: finish what you are doing in as few turns as possible. No new scenes, no optional work.');
  if (step.gate === 'READY') lines.push('Accuracy gate: end with one line `READY: yes`, or `READY: no <reason>` if the sources for this slot are not open (then propose the next ready theme in the brief).');
  if (step.gate === 'VERDICT') lines.push('End with one line `VERDICT: PASS` or `VERDICT: BLOCK <one reason>`. No verdict counts as BLOCK.');
  lines.push('Last line: `SUMMARY: <at most 90 characters, Bahasa Indonesia>`.');
  return lines.filter(Boolean).join('\n');
}
export const fill = (s, cfg) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? '');

// Write captured text (and any ```json block for .json outputs) into the post folder.
export function captureOutputs(post, step, text, { inline }) {
  fs.mkdirSync(post, { recursive: true });
  if (step.capture) fs.writeFileSync(path.join(post, step.capture), text.trim() + '\n');
  if (inline && step.writes?.length) {
    for (const w of step.writes) {
      if (w.endsWith('.json')) {
        const m = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop();
        if (m) { try { JSON.parse(m[1]); fs.writeFileSync(path.join(post, w), m[1].trim() + '\n'); } catch { /* invalid JSON: contract check reports it */ } }
      } else fs.writeFileSync(path.join(post, w), text.replace(/```json[\s\S]*?```/g, '').trim() + '\n');
    }
  }
}

// ---------- step size and turns ----------
export function estimate(step, turns = step.size[0]) {
  const [, ctx, fresh, out] = step.size;
  return priceOf(step.model, { in: 0, out: turns * out, cache_read: turns * (ctx - fresh), cache_write: turns * fresh });
}
export function turnsAllowed(step, left) {
  if (estimate(step) <= left) return step.size[0];
  return Math.max(1, Math.floor(left / estimate(step, 1)));
}

// ---------- engines ----------
// dry: no model calls. Simulated usage from the step size, placeholder artifacts so the contract checks run.
export async function dryEngine(step, ctx) {
  const turns = ctx.turns;
  await sleep((600 + turns * 120) * ctx.cfg.pace);
  const [, c, fresh, out] = step.size;
  const usage = { in: 0, out: turns * out, cache_read: turns * (c - fresh), cache_write: turns * fresh };
  const verdict = ctx.dryVerdict(step.id);
  const gateLine = step.gate === 'READY' ? (verdict === 'BLOCK' ? 'READY: no sumber belum terbuka (dry)' : 'READY: yes')
    : step.gate === 'VERDICT' ? (verdict === 'BLOCK' ? 'VERDICT: BLOCK contoh temuan (dry)' : verdict === 'NONE' ? '' : 'VERDICT: PASS') : '';
  const text = `# ${step.id} (dry run)\n\n${fill(step.say, ctx.cfg)}.\n\nTidak ada model yang dipanggil; ini berkas contoh.\n${gateLine}\nSUMMARY: ${fill(step.say, ctx.cfg)}`;
  fs.mkdirSync(ctx.post, { recursive: true });
  for (const w of step.writes || []) {
    fs.writeFileSync(path.join(ctx.post, w), w.endsWith('.json') ? JSON.stringify({ dry: true, run: ctx.run, scenes: [] }, null, 2) : text);
  }
  return { ok: true, text, usd: priceOf(step.model, usage), usage };
}

export async function claudeCliEngine(step, ctx) {
  const agent = agentFile(step.seat);
  const promptDir = path.join(runDir(ctx.run), 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const sys = path.join(promptDir, `office-${step.seat}.md`);
  fs.writeFileSync(sys, agent.body);
  const tools = agent.tools.length ? agent.tools : ['Read', 'Grep', 'Glob'];
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--model', PIPELINE.models[step.model].cli,
    '--append-system-prompt-file', sys,
    '--tools', tools.join(','), '--allowedTools', tools.join(','),
    '--permission-mode', 'dontAsk',
    '--max-turns', String(Math.max(2, ctx.turns * 2))];
  if (step.effort && supports('--effort')) args.push('--effort', step.effort);
  if (supports('--max-budget-usd')) args.push('--max-budget-usd', ctx.budget.toFixed(2));
  const r = await runClaude({
    args, input: taskPrompt(step, ctx), cwd: ctx.cfg.repo, env: childEnv(ctx.cfg),
    timeoutMs: ctx.cfg.stepTimeoutMin * 60000, budgetUSD: ctx.budget, price: PIPELINE.models[step.model],
    onTool: (s) => ctx.emit(step.seat, 'tool', { summary: s }),
    onText: (s) => ctx.emit(step.seat, 'thinking', { summary: s }),
    onSpawn: (c) => ctx.setChild(c),
  });
  ctx.setChild(null);
  return r;
}

export async function apiEngine(step, ctx) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY is not set', auth: true, usd: 0, usage: {}, text: '' };
  const m = PIPELINE.models[step.model];
  const maxOut = Math.max(600, Math.min(8000, Math.floor((ctx.budget * 1e6) / m.out * 0.8), Math.round(ctx.turns * step.size[3])));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ctx.cfg.stepTimeoutMin * 60000);
  try {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: m.api, max_tokens: maxOut,
        system: [{ type: 'text', text: agentFile(step.seat).body + '\n\nYou cannot read or write files here: everything you need is in the message, and your reply is saved as the output file.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: taskPrompt(step, ctx, { inline: true }) }],
      }),
    });
    const j = await res.json();
    if (!res.ok) return { ok: false, error: j.error?.message || JSON.stringify(j).slice(0, 200), auth: res.status === 401, usd: 0, usage: {}, text: '' };
    const usage = { in: j.usage.input_tokens || 0, out: j.usage.output_tokens || 0, cache_read: j.usage.cache_read_input_tokens || 0, cache_write: j.usage.cache_creation_input_tokens || 0 };
    return { ok: true, usage, usd: priceOf(step.model, usage), text: j.content.map((c) => c.text || '').join('\n') };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'step timed out' : e.message, usd: 0, usage: {}, text: '' };
  } finally { clearTimeout(timer); }
}
export const ENGINE_FNS = { dry: dryEngine, 'claude-cli': claudeCliEngine, api: apiEngine };

// ---------- deterministic scripts (free) ----------
export const expand = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
export function runCommand(cmd, { cwd, timeoutMs = 20 * 60000, onSpawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd[0], cmd.slice(1), { cwd, windowsHide: true, detached: process.platform !== 'win32' }); }
    catch (e) { resolve({ code: -1, out: e.message }); return; }
    onSpawn?.(child);
    const timer = setTimeout(() => { out += '\n[timeout]'; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); onSpawn?.(null); resolve({ code: code ?? -1, out }); });
  });
}
// First configured command whose "needs" file exists, or null.
export function findCommand(list, vars, kreator) {
  for (const c of list || []) {
    if (c.kreator && c.kreator !== kreator) continue;
    if (c.needs && !fs.existsSync(expand(c.needs, vars))) continue;
    return { cmd: c.cmd.map((a) => expand(a, vars)), cwd: expand(c.cwd || '{repo}', vars) };
  }
  return null;
}
