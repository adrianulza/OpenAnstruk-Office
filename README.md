# OpenAnstruk Virtual Office

A cute 3D office where six AI staff make reels for @openanstruk and Aina. You talk to the Producer, agree on the reel, press Start, and watch the team work. They stop and ask you at the checkpoints you choose. Watching costs **0 tokens**: the office only reads an event log.

![overview](docs/screens/overview.png)

- **Online (GitHub Pages):** https://adrianulza.github.io/OpenAnstruk-Office/ replays a sample run. It cannot start runs (no server there).
- **On your PC:** the full office with the **Producer desk** (chat, runs, approvals, uploads, costs).

## Quick start on your PC

Needs Node 22+. No `npm install` is needed: there are no dependencies.

```
git clone https://github.com/adrianulza/OpenAnstruk-Office.git
cd OpenAnstruk-Office
npm run demo          # free demo: everything simulated, no Claude needed
```

Open http://localhost:8765/ and click **💬 Producer desk**.

For real runs, install Claude Code and log in once (`claude`, then `/login`), then:

```
npm start -- --repo D:\_Projects\OpenAnstruk-Studio --subscription
```

- `--repo`: the repo the agents work in (OpenAnstruk-Studio or video-in-motion).
- `--subscription`: removes `ANTHROPIC_API_KEY` from the agents' environment, so Claude Code uses your Claude plan instead of billing an API key. Leave it out to bill the key.

## The workflow

```
1. Producer desk › Chat     Tell Pak Prod what you want. He asks what he needs, reads the schedule
                            (JADWAL-REEL.md / aina/JADWAL.md) and proposes a run.
2. Proposal card            Check topic, slot, template, notes, checkpoints and budget. Press Start.
3. The office               Brief → research → script → critic gate → attention check → animation →
                            recording → render → QA → captions → publish package. All live in 3D.
4. Checkpoints (you)        The run stops and asks you at brief / script / final (your choice).
                            Approve, or reject with a note: the work goes back with your note.
5. Recording (Ulza / Aina)  Upload the voice-over (or footage) in the desk, or drop it in the post
                            folder. The run continues by itself.
6. Done                     publish.json + video/<run>.mp4 + caption. Status "ready to publish".
                            Posting itself stays manual (nothing is uploaded to IG/TikTok for you).
```

Full details: [docs/WORKFLOW.md](docs/WORKFLOW.md).

### Safety rails
- **Gates fail closed.** A critic BLOCK sends the work back once (`--rounds`), then the run stops. A missing verdict counts as BLOCK. The producer's accuracy gate (`READY: no`) stops the run at the brief.
- **Budget guard:** $4 cap, wrap-up at $3.00, stop at $3.60. Each step gets at most what is left under the cap (`--max-budget-usd`), and a live kill switch stops a step that streams past it. Optional work (captions) is skipped after wrap-up.
- **Honest endings:** every run ends with a status: `ok`, `partial`, `blocked`, `rejected`, `over_budget`, `error` or `cancelled`. A render that produced no mp4 is an error, not a success.
- **Resumable:** state is saved after every step (`runs/<id>/state.json`). A run that waits too long for you parks itself and continues later. Use the desk, or `--resume <id>`.

## Subscription or API key?

| What | Claude subscription | API key |
|---|---|---|
| Watching the office | free | free |
| Chat with Pak Prod (`--chat claude`) | ✅ | ✅ |
| Pipeline `--engine claude-cli` (real agents that read, write and run scripts) | ✅ | ✅ |
| Pipeline `--engine api` (text only: brief, research, script, critique; stops before animation) | ❌ | ✅ |
| `tools/console-agent` (Managed Agents, for editing this repo) | ❌ | ✅ |

With a subscription, the dollar amounts are API-equivalent estimates (what Claude Code reports). Your real limit is your plan's usage allowance. Run it on your own PC for your own use.

## Command line (no browser)

```
node orchestrator/run.mjs --topic "Gempa kecil tapi merusak" --slot 2026-11-20 --engine claude-cli --repo <repo> --approve script,final
node orchestrator/run.mjs --config run.json        # the Template Board's "Copy run config"
node orchestrator/run.mjs --resume 0026-gempa-kecil-merusak
node orchestrator/run.mjs --help                   # every option
```

`--engine dry` (the default) simulates everything for free. Dry runs are numbered `dry-0001-…` so they never take a real post number.

In a Claude Code terminal you can also discuss first: copy `claude/commands/reel.md` to your repo's `.claude/commands/`, then type `/reel`.

## Notifications (optional)
When a run needs you (approval, recording) or ends badly, a line goes to `runs/<id>/notifications.log`. Set one of these to be pinged too:
- `OFFICE_NOTIFY_WEBHOOK=https://…`: JSON POST (`text` and `content` fields work for Slack and Discord webhooks).
- `OFFICE_NTFY_TOPIC=my-secret-topic`: push to your phone through ntfy.sh.

## Agent files
`agents/office-*.md` are the system prompts of the six seats. The orchestrator passes them to Claude Code itself (`--append-system-prompt-file`) with each seat's tools. You do not need to copy them. You may copy them to `.claude/agents/` if you also want them as interactive sub-agents. Models, prices, steps and guards live in one place: `data/pipeline.json`.

## Files
| Path | What |
|---|---|
| `index.html`, `js/main.js`, `js/world.js`, `js/staff.js`, `js/log.js` | The 3D office (three.js r160 in `vendor/`) |
| `js/panel.js` | The Producer desk (only on your PC) |
| `server/server.mjs`, `server/chat.mjs` | Local server: office, chat, runs, approvals, uploads, costs (127.0.0.1 only) |
| `orchestrator/run.mjs`, `orchestrator/lib/*` | The pipeline, budget guard, gates, resume, event writer |
| `data/pipeline.json` | Steps, models, prices, guards, render and check scripts |
| `data/staff.json` | Seats and visitors |
| `data/sample-run.jsonl` | Sample event log (the online replay) |
| `docs/EVENTS.md`, `docs/WORKFLOW.md` | Event format, full workflow |
| `template-picker.html`, `templates.json` | Template Board (9 house templates + 99 lemo-opuscar styles) |
| `tools/check-events.mjs` | Validates an event log |
| `test/` | `npm test`: orchestrator, server and log tests (with a fake Claude Code) |
| `runs/` (not in git) | Per run: state, events, report, prompts, approvals, notifications. Plus the cost ledger and chats |
