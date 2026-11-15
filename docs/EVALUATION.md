# Evaluation and fixes (15 Nov 2026)

What the review of `main` @ `0e59155` found, and what changed in v2. Every fix is covered by `npm test` (30 tests, with a fake Claude Code), except the visual layout fixes, which were checked in a headless browser.

## Workflow before and after

| Before | After |
|---|---|
| Instruction only through CLI flags; the Template Board's run config was read by nothing | Producer desk chat → editable proposal → Start. Template Board "Send to Producer desk". `run.mjs --config run.json` |
| No discussion step | Pak Prod discusses read-only (schedule, past posts), proposes READY templates only |
| Steps got only topic/slot; outputs were thrown away | Per-step file contract (`brief.md` → `fakta.md` → `naskah.md` + `script.json` → `critic.md` …), checked after every step |
| Critic BLOCK twice → continued; no verdict → PASS | Fail closed: one revision round (`--rounds`), then `blocked`; no verdict = BLOCK; accuracy gate `READY` |
| $4 cap never enforced, a step could overspend (demo: $5.00 of $4) | `--max-budget-usd` = what is left under the cap, a live kill switch, and hard stops |
| Failed or missing render still reported `done video/X.mp4` | No mp4 = `error`. QA after render (`periksa-reel` + critic). Publish package only after QA |
| `run_end` always "selesai" | `run_end.status`: ok, partial, blocked, rejected, over_budget, error, cancelled |
| Agents could not run scripts (`acceptEdits`); critic could edit | Per-seat `--tools`/`--allowedTools` from the agent files, `--permission-mode dontAsk` |
| Windows: prompt through `cmd.exe` (newlines cut, `& " |` broke or injected) | No shell: prompt on stdin, system prompt from a file, `claude.exe` resolved directly |
| Waited forever for the voice-over, no notice; crash = start over | Notifications (log, webhook, ntfy), upload in the desk, park and resume, state saved after every step |
| No human approval | Checkpoints brief / script / final (and plan / kit for phase 1) with approve or reject plus a note |
| No publish step | `publish.json` + `video/<run>.mp4` + caption. Posting stays manual (no platform API) |

## Findings and status

### Critical
1. No data between steps: **fixed** (artifact contract; api engine inlines inputs and captures outputs).
2. Gate fails open: **fixed**.
3. Budget overshoot: **fixed**.
4. False success: **fixed**.
5. Headless agents could not run commands: **fixed**.
6. Windows argument breakage / injection: **fixed** (logic covered by tests on Linux; the Windows binary lookup is untested on a real Windows machine).
7. Render path did not match the default template: **fixed** (`data/pipeline.json › render`, ops agent fallback).

### High
8. Run id convention: **fixed** (`0026-gempa-kecil-merusak`, continues the repo numbering; dry runs are `dry-0001-…`).
9. Aina flow: **fixed** (own pipeline: record on camera → edit → render).
10. No timeouts, retries or resume: **fixed** (`--step-timeout`, `--retries`, `--resume`, parking).
11. Fake batch discount: **removed**.
12. Errors left the office "running": **fixed** (`run_end` on every exit path, including uncaught errors and cancellation).
13. Live mode replayed old runs and broke on truncation: **fixed** (follows the newest run, resets on truncation or a new run).
14. `events.jsonl` not ignored: **fixed** (`runs/` and `data/events.jsonl` in `.gitignore`).
15. Three sources of truth for models: **fixed** (`data/pipeline.json`).
16. Prices: **verified**. They match the price table built into Claude Code 2.1 for `claude-*-5-5`. The earlier suspicion about the Haiku price was wrong.

### Medium and low
17. Template not validated: **fixed** (exists, kreator, ready, or phase 1).
18. Arguments not validated: **fixed**.
19. Producer handoff missing: **fixed**.
20. No live progress inside a step: **fixed** (stream-json tool calls become `tool` events).
21. Wall-clock timers in the viewer: **fixed** (sim-time timers; pause freezes everything; walking follows replay speed).
22. `waiting_human` not as documented: **fixed** (producer waits at the door).
23. Restart reloaded the page; no seek: **fixed** (seek bar, `?t=`, run picker).
24. "108 styles" hard-coded: **fixed**.
25. Template picker XSS: **fixed** (all fields escaped, only http(s) links).
26. Outdated `cd office` docs: **fixed** (README, WORKFLOW, EVENTS).
- Kanban hidden behind the run card: **fixed** (camera framing). Narrow-screen layout: **fixed**.
- Speed button highlight, pinch zoom: **fixed**.
- Pages workflow branch names not escaped: **fixed**. Tests and CI: **added** (`npm test`, `.github/workflows/test.yml`).

## Still open (by design or needs you)
- Posting to Instagram, TikTok and YouTube is manual. The run prepares `publish.json` and the caption.
- The check scripts for OpenAnstruk (`tools/preflight.mjs`) and the `periksa-reel` path are guesses. If they live elsewhere in your repo, set the paths in `data/pipeline.json › checks`. Until then the steps say "script not found, skipped" instead of pretending.
- One run at a time (on purpose: budget and attention). There is no queue.
- First real run: run it with `--approve brief,script,final` so you can see each hand-off before trusting it unattended.
