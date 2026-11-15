# Phase 1 build plan: the 3D virtual office

Budget for this build: $25 (one-off, 15 Nov 2026).

## Model rules (current, replaces anything older)
- **Video production (Phase 1 and Phase 2 of every reel): no Fable, ever.** Opus, Sonnet, Haiku only, $4 cap per video (office-plan-v2.md).
- **This office build only:** Fable was allowed by Ulza as a helper. It is not a seat, not in `staff.json`, and never used by the orchestrator.
- **What actually happens in this session:** there is no sub-agent tool here, so no other model (Fable or otherwise) is called. The assistant builds every package itself.

## Work packages

| Work package | Status |
|---|---|
| WP1 Event schema + staff data | done |
| WP2 3D room, zones, furniture, logo wall | done |
| WP3 Chibi staff, walking, behaviours | done |
| WP4 Event player (replay + live), hover bubbles, HUD | done |
| WP5 Orchestrator (`run.mjs`): pipeline, budget guard, event writer | done |
| WP6 Agent files (6 seats) | done |
| WP7 Test: headless screenshots, console errors, event coverage | done |

## Deliverables (`office/`)

- `index.html`, `js/*.js`, `vendor/three.module.min.js` (r160, from Studio explorations), `assets/logo.png`
- `data/staff.json`, `data/sample-run.jsonl`, `docs/EVENTS.md`
- `orchestrator/run.mjs` (dry mode works offline; claude-cli uses Claude Code, with a subscription or a key; api mode needs `ANTHROPIC_API_KEY`)
- `agents/*.md` (copy into `.claude/agents/`)
- `template-picker.html` + `templates.json` (done), opened from the Template Board on the wall

## Rules carried over
- Animation reads logs only: zero tokens.
- $4 per-video guard in the orchestrator ($3.00 wrap-up, $3.60 stop).
- No em dash in user-facing text; Bahasa Indonesia for content, English UI for now.
- Frozen agent names `prose-critic`, `slide-critic` are used as-is.

## Phase 2 (15 Nov 2026): from demo to working office
See `docs/EVALUATION.md` (findings and fixes) and `docs/WORKFLOW.md` (how to use it). In short: Producer desk (chat, runs, approvals, uploads, costs), fail-closed gates, an enforced budget, a file contract between steps, resume, notifications, an Aina pipeline, a phase 1 pipeline, the local server, tests and CI.
