#!/usr/bin/env node
// check-events.mjs: validate an events.jsonl file against docs/EVENTS.md.
//   node tools/check-events.mjs data/sample-run.jsonl [more files]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OFFICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staff = JSON.parse(fs.readFileSync(path.join(OFFICE, 'data', 'staff.json'), 'utf8'));
const AGENTS = new Set([...staff.staff, ...staff.visitors].map((a) => a.id));
const TYPES = new Set(['run_start', 'task_start', 'thinking', 'tool', 'handoff', 'blocked', 'waiting_human', 'approval', 'decision', 'parked', 'cost', 'budget', 'done', 'idle', 'run_end']);
const STATUSES = new Set(['ok', 'blocked', 'over_budget', 'error', 'cancelled', 'rejected', 'partial']);

export function checkEvents(text) {
  const errors = [];
  const lastT = {};
  String(text).split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const n = i + 1;
    let e;
    try { e = JSON.parse(line); } catch { errors.push(`line ${n}: not JSON`); return; }
    if (typeof e.t !== 'number' || e.t < 0) errors.push(`line ${n}: t must be a number >= 0`);
    if (typeof e.run !== 'string' || !e.run) errors.push(`line ${n}: run is required`);
    if (!AGENTS.has(e.agent)) errors.push(`line ${n}: unknown agent "${e.agent}"`);
    if (!TYPES.has(e.type)) errors.push(`line ${n}: unknown type "${e.type}"`);
    if (e.summary !== undefined && (typeof e.summary !== 'string' || e.summary.length > 90)) errors.push(`line ${n}: summary must be a string of at most 90 characters`);
    if (['handoff', 'waiting_human'].includes(e.type) && !AGENTS.has(e.to)) errors.push(`line ${n}: ${e.type} needs a valid "to"`);
    if (e.type === 'cost' && (typeof e.usd !== 'number' || e.usd < 0)) errors.push(`line ${n}: cost needs usd >= 0`);
    if (['approval', 'decision'].includes(e.type) && !e.name) errors.push(`line ${n}: ${e.type} needs "name"`);
    if (e.type === 'decision' && !['approve', 'reject'].includes(e.decision)) errors.push(`line ${n}: decision must be approve or reject`);
    if (e.type === 'run_end' && e.status !== undefined && !STATUSES.has(e.status)) errors.push(`line ${n}: unknown run_end status "${e.status}"`);
    if (e.run && typeof e.t === 'number') {
      if (e.type === 'run_start') lastT[e.run] = 0;
      if (lastT[e.run] !== undefined && e.t + 0.05 < lastT[e.run]) errors.push(`line ${n}: t goes backwards in run ${e.run}`);
      lastT[e.run] = Math.max(lastT[e.run] ?? 0, e.t);
    }
  });
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) { console.log('Usage: node tools/check-events.mjs <events.jsonl> [...]'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const errs = checkEvents(fs.readFileSync(f, 'utf8'));
    console.log(errs.length ? `✗ ${f}\n  ${errs.slice(0, 30).join('\n  ')}` : `✓ ${f}`);
    bad += errs.length;
  }
  process.exit(bad ? 1 : 0);
}
