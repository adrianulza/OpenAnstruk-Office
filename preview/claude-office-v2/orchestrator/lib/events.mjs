// events.mjs: event writer (office log + per-run log), run state, ledger and notifications.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, defaultLog } from './config.mjs';

export const runDir = (run) => path.join(RUNS, run);
export const statePath = (run) => path.join(runDir(run), 'state.json');
export const END_STATUSES = ['ok', 'blocked', 'over_budget', 'error', 'cancelled', 'rejected', 'partial'];

// Every event goes to the shared office log (live view) and to runs/<id>/events.jsonl (replay, history).
export function createEmitter(run, { offsetSec = 0, quiet = false, log = defaultLog() } = {}) {
  const t0 = Date.now() - offsetSec * 1000;
  const files = [log, path.join(runDir(run), 'events.jsonl')];
  files.forEach((f) => fs.mkdirSync(path.dirname(f), { recursive: true }));
  const emit = (agent, type, extra = {}) => {
    const ev = { t: +((Date.now() - t0) / 1000).toFixed(1), run, agent, type, ...extra };
    if (typeof ev.summary === 'string') ev.summary = ev.summary.replace(/\s+/g, ' ').trim().slice(0, 90);
    const line = JSON.stringify(ev) + '\n';
    for (const f of files) fs.appendFileSync(f, line);
    if (!quiet) {
      const usd = ev.usd !== undefined ? `  +$${ev.usd.toFixed(3)}` : '';
      console.log(`[${String(ev.t).padStart(7)}] ${agent.padEnd(12)} ${type.padEnd(13)} ${ev.summary || ev.status || ''}${usd}`);
    }
    return ev;
  };
  emit.elapsed = () => (Date.now() - t0) / 1000;
  return emit;
}

export function loadState(run) {
  const f = statePath(run);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(runDir(state.run), { recursive: true });
  const f = statePath(state.run), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}
export function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter((n) => !n.startsWith('_') && fs.existsSync(statePath(n))).map((n) => {
    try { return loadState(n); } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function appendLedger(entry) {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.appendFileSync(path.join(RUNS, 'ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
export function readLedger() {
  const f = path.join(RUNS, 'ledger.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Notifications: always written to runs/<id>/notifications.log; optionally pushed to a webhook
// (OFFICE_NOTIFY_WEBHOOK: Discord/Slack/any JSON endpoint) or ntfy.sh (OFFICE_NTFY_TOPIC).
export async function notify(run, kind, text) {
  const line = `${new Date().toISOString()}  [${kind}] ${text}\n`;
  fs.mkdirSync(runDir(run), { recursive: true });
  fs.appendFileSync(path.join(runDir(run), 'notifications.log'), line);
  const jobs = [];
  if (process.env.OFFICE_NOTIFY_WEBHOOK) {
    jobs.push(fetch(process.env.OFFICE_NOTIFY_WEBHOOK, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[${run}] ${text}`, content: `[${run}] ${text}`, run, kind }),
    }));
  }
  if (process.env.OFFICE_NTFY_TOPIC) {
    jobs.push(fetch(`https://ntfy.sh/${encodeURIComponent(process.env.OFFICE_NTFY_TOPIC)}`, { method: 'POST', headers: { Title: `OpenAnstruk Office: ${kind}` }, body: `[${run}] ${text}` }));
  }
  const res = await Promise.allSettled(jobs.map((j) => Promise.race([j, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))])));
  res.filter((r) => r.status === 'rejected').forEach((r) => console.warn(`notify failed: ${r.reason?.message || r.reason}`));
}
