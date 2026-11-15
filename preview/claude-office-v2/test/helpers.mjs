import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OFFICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE = JSON.stringify([process.execPath, path.join(OFFICE, 'test', 'fake-claude.mjs')]);

// A fresh sandbox: its own runs/ folder, office log and a fake repo with one earlier post (0025).
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'marketing', 'posts', '0025-retak-rumah'), { recursive: true });
  const env = { ...process.env, OFFICE_RUNS_DIR: path.join(dir, 'runs'), OFFICE_LOG: path.join(dir, 'events.jsonl'), OFFICE_CLAUDE_CMD: FAKE, FAKE_CLAUDE_LOG: path.join(dir, 'claude-calls.log') };
  delete env.ANTHROPIC_API_KEY; delete env.OFFICE_NOTIFY_WEBHOOK; delete env.OFFICE_NTFY_TOPIC;
  return {
    dir, repo, env,
    run(args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [path.join(OFFICE, 'orchestrator', 'run.mjs'), ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    },
    spawnRun(args, extraEnv = {}) {
      return spawn(process.execPath, [path.join(OFFICE, 'orchestrator', 'run.mjs'), ...args], { env: { ...env, ...extraEnv }, stdio: 'ignore' });
    },
    state(run) { return JSON.parse(fs.readFileSync(path.join(dir, 'runs', run, 'state.json'), 'utf8')); },
    events(run) { return fs.readFileSync(path.join(dir, 'runs', run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
    runs() { return fs.existsSync(path.join(dir, 'runs')) ? fs.readdirSync(path.join(dir, 'runs')).filter((n) => !n.startsWith('_') && !n.endsWith('.jsonl')) : []; },
    calls() { return fs.existsSync(env.FAKE_CLAUDE_LOG) ? fs.readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

export const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
};
