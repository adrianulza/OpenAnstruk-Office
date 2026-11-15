#!/usr/bin/env node
// Runs a Claude Managed Agents session (billed to the Claude Console API balance)
// that mounts the Office, Studio and video-in-motion repos and can push branches.
//
// Secrets are read from files OUTSIDE the repo (never commit them):
//   %USERPROFILE%\.anstruk-agent\anthropic-key.txt   Console API key
//   %USERPROFILE%\.anstruk-agent\github-token.txt    fine-grained GitHub token
//
// Usage:
//   node tools/console-agent/agent.mjs setup [--model claude-opus-5-5]   create environment + agent (once)
//   node tools/console-agent/agent.mjs run "task text" [--budget 200]
//       --budget is in US cents (200 = $2.00). Default 200.
//   node tools/console-agent/agent.mjs check                 verify keys work (no cost)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".anstruk-agent");
const IDS = path.join(DIR, "ids.json");
const API = "https://api.anthropic.com/v1";
const OWNER = "adrianulza";
const REPOS = [
  { name: "OpenAnstruk-Office", role: "MAIN repo: the one you modify" },
  { name: "OpenAnstruk-Studio", role: "reference only: read, do not push" },
  { name: "video-in-motion", role: "reference only: read, do not push" },
];

const readSecret = (f) => {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return fs.readFileSync(p, "utf8").trim();
};
const KEY = () => readSecret("anthropic-key.txt");
const GH = () => readSecret("github-token.txt");

const headers = () => ({
  "x-api-key": KEY(),
  "anthropic-version": "2026-10-21",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
});

async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: headers(), body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${t}`);
  return t ? JSON.parse(t) : {};
}

const SYSTEM = `You work on three GitHub repositories mounted under /workspace:
${REPOS.map((r) => `- /workspace/${r.name} (${r.role})`).join("\n")}

Rules:
- Only modify and push /workspace/OpenAnstruk-Office. Read the other two for reference; never push to them.
- Never commit to or push main. Create a branch named agent/<short-task-name>, commit with a clear message, and git push -u origin <branch>.
- Office is a static site (index.html, js/, vendor/). Keep it runnable by opening index.html through a static server.
- Finish by reporting: branch name, files changed, and a short summary of what you did.`;

async function setup(model) {
  fs.mkdirSync(DIR, { recursive: true });
  const env = await api("POST", "/environments", {
    name: "anstruk-office-env",
    config: { type: "cloud", networking: { type: "limited", allow_package_managers: true } },
  });
  const agent = await api("POST", "/agents", {
    name: "Anstruk Office Agent",
    model,
    system: SYSTEM,
    tools: [{
      type: "agent_toolset_20260401",
      configs: [{ name: "web_search", enabled: false }, { name: "web_fetch", enabled: false }],
    }],
  });
  fs.writeFileSync(IDS, JSON.stringify({ environment_id: env.id, agent_id: agent.id, model }, null, 2));
  console.log(`environment: ${env.id}\nagent:       ${agent.id} (${model})\nsaved to ${IDS}`);
}

async function run(task, budgetCents) {
  if (!fs.existsSync(IDS)) throw new Error("Run 'setup' first.");
  const ids = JSON.parse(fs.readFileSync(IDS, "utf8"));
  const token = GH();
  const session = await api("POST", "/sessions", {
    agent: ids.agent_id,
    environment_id: ids.environment_id,
    budget: { type: "limit", max_list_cost: { amount: String(budgetCents), currency: "USD" } },
    resources: REPOS.map((r) => ({
      type: "github_repository",
      url: `https://github.com/${OWNER}/${r.name}`,
      mount_path: `/workspace/${r.name}`,
      authorization_token: token,
    })),
  });
  console.log(`session ${session.id} (budget $${(budgetCents / 100).toFixed(2)})\n`);

  // Open the stream BEFORE sending the message (docs: only later events are delivered).
  const ctrl = new AbortController();
  const res = await fetch(`${API}/sessions/${session.id}/events/stream?beta=true`, {
    headers: { ...headers(), accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.ok) throw new Error(`stream HTTP ${res.status}: ${await res.text()}`);

  await api("POST", `/sessions/${session.id}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: task }] }],
  });

  const dec = new TextDecoder();
  let buf = "";
  outer: for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "agent.message") {
        for (const b of ev.content || []) if (b.type === "text") process.stdout.write(b.text + "\n");
      } else if (ev.type === "session.usage") {
        console.log(`\n[usage] list cost: ${JSON.stringify(ev.list_cost ?? ev.usage?.list_cost ?? ev)}`);
      } else if (ev.type === "session.error") {
        console.log(`\n[error] ${ev.error?.message ?? JSON.stringify(ev)}`);
        break outer;
      } else if (ev.type === "session.status_idle") {
        console.log(`\n[idle] stop_reason: ${JSON.stringify(ev.stop_reason ?? null)}`);
        break outer;
      } else if (/tool_use/.test(ev.type)) {
        const name = ev.name ?? ev.tool_name ?? "";
        const cmd = ev.input?.command ?? ev.input?.path ?? ev.input?.file_path ?? "";
        console.log(`  · ${name} ${String(cmd).slice(0, 140)}`);
      }
    }
  }
  ctrl.abort();
  console.log(`\nsession id: ${session.id}`);
}

async function check() {
  const r = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": KEY(), "anthropic-version": "2023-06-01" },
  });
  console.log("Anthropic key:", r.status === 200 ? "OK" : `HTTP ${r.status}`);
  for (const repo of REPOS) {
    const g = await fetch(`https://api.github.com/repos/${OWNER}/${repo.name}`, {
      headers: { authorization: `Bearer ${GH()}`, "user-agent": "anstruk-agent" },
    });
    const j = g.ok ? await g.json() : {};
    console.log(`GitHub ${repo.name}:`, g.ok ? `OK (push: ${j.permissions?.push})` : `HTTP ${g.status}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest.splice(i, 2)[1] : d; };
try {
  if (cmd === "setup") await setup(flag("--model", "claude-opus-5-5"));
  else if (cmd === "check") await check();
  else if (cmd === "run") {
    const budget = parseInt(flag("--budget", "200"), 10);

    if (!rest[0]) throw new Error('Usage: run "task text"');
    await run(rest[0], budget);
  } else console.log("Commands: setup | check | run \"task\" [--budget cents]");
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
