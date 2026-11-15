# Workflow: from your instruction to a finished reel

## 0. Start the office on your PC

```
npm start -- --repo <path to OpenAnstruk-Studio or video-in-motion> --subscription
```

| Server option | Meaning |
|---|---|
| `--repo <path>` | Repo the agents work in. Posts go to `<repo>/marketing/posts/<run>/` (OpenAnstruk) or `<repo>/aina/projects/<run>/` (Aina) |
| `--engine dry\|claude-cli\|api` | Default pipeline engine. Default: `claude-cli` if Claude Code is installed and `--repo` is given, else `dry` |
| `--chat dry\|claude\|api` | Who answers in the chat. Default follows the engine |
| `--subscription` | Strip `ANTHROPIC_API_KEY` so Claude Code uses your plan |
| `--port 8765` | Port (the server only listens on 127.0.0.1) |

## 1. Instruction and discussion (Producer desk › Chat)

Pak Prod runs as Claude Code in your repo with **read-only** tools (Read, Grep, Glob) and at most $0.50 per message. He can read `JADWAL-REEL.md`, `aina/JADWAL.md`, `PROFIL.md` and earlier posts. He only proposes READY templates. When you agree he writes a proposal:

```json
{"proposal": {"kreator": "openanstruk", "topic": "...", "slot": "2026-11-20", "template": "kolase-browser", "notes": "angle, hook, sources"}}
```

The desk turns it into an editable card: kreator, slot, topic, template, notes, checkpoints (brief, script, final), engine and budget cap. Nothing runs until you press **Start run**.

Other ways in:
- **Template Board** › pick a ready template › **Send to Producer desk** (fills the card).
- **New run without chat** in the desk.
- **Command line:** `node orchestrator/run.mjs --config run.json` or flags (see `--help`).

## 2. The pipeline (OpenAnstruk)

| # | Step | Seat · model | Reads | Writes | Gate |
|---|---|---|---|---|---|
| 1 | brief | Producer · haiku low | schedule | `brief.md` | `READY: yes/no` (accuracy gate) |
| 2 | checkpoint **brief** | you | `brief.md` | | approve / reject + note |
| 3 | research | Researcher · sonnet medium | `brief.md` | `fakta.md` | |
| 4 | script | Scriptwriter · opus high | brief, fakta, earlier critique | `naskah.md`, `script.json` | `cek-naskah` / `preflight` script if present |
| 5 | critique | Critic · opus medium | fakta, naskah, script.json | `critic.md` | `VERDICT` (BLOCK → back to script) |
| 6 | attention | Critic · sonnet low | naskah, script.json | `atensi.md` | `VERDICT` (BLOCK → back to script) |
| 7 | checkpoint **script** | you | naskah, critic, atensi | | approve / reject + note |
| 8 | animate | Animator · sonnet high | brief, fakta, naskah, script.json | `animasi.md` + the reel files | |
| 9 | voice | Ulza (human) | `script.json` | `voice/*.wav` | waits; upload in the desk |
| 10 | render | Ops (script) | | mp4 | must produce an mp4 |
| 11 | qa | Critic · sonnet low | `periksa.txt`, script.json | `qa.md` | `periksa-reel` script + `VERDICT` (BLOCK → back to animate) |
| 12 | captions | Scriptwriter · sonnet medium | brief, naskah | `caption-ig.md` | optional (skipped after wrap-up) |
| 13 | checkpoint **final** | you | qa, caption, publish | | approve / reject + note |
| 14 | publish | Ops | | `publish.json`, `video/<run>.mp4` | |

**Aina** is the same up to the script checkpoint. Then Aina records on camera (`footage/`), the animator edits (transcribe with large-v3 `id`, DeepFilterNet, cuts, overlays), then render, QA, captions, final and publish.

**Phase 1** (a template that is not ready yet): scope (producer) → checkpoint **plan** (always) → build the kit (animator) → review (critic, slide-critic) → checkpoint **kit** (always) → the template is marked ready in `templates.json`. Default guard $6 / $4.50 / $5.40. Start it with `--phase 1 --template <id>`.

Every step is defined in `data/pipeline.json`, including the render commands per template and the check scripts. Edit it there.

### How each agent runs (`--engine claude-cli`)
`claude -p` in your repo with:
- the seat's agent file as `--append-system-prompt-file`;
- the task prompt on stdin (never on the command line, so quotes or `&` in a topic cannot break anything);
- `--model <alias>` and `--effort <level>`;
- `--tools` / `--allowedTools` from the agent file's `tools:` line, with `--permission-mode dontAsk`. The critic and producer cannot edit files; the researcher, writer, animator and ops may run scripts;
- `--max-budget-usd` = what is left under the cap, plus a live kill switch on the streamed usage;
- `--max-turns` from the step size; a per-step timeout (`--step-timeout`, default 30 min).

Tool calls stream into the office as live `tool` events.

## 3. Checkpoints and recordings

When the run reaches a checkpoint it emits an `approval` event. Pak Prod walks to the kanban and the banner says what is needed. The desk shows **Approve / Reject** with the files to read first. A rejection needs a note. The step goes back with your note (at most twice), then the run stops as `rejected`.

At the recording step Pak Prod waits at the door and Ulza (or Aina) walks into the booth. Upload the file in the desk, or save it in `<post>/voice/` (or `footage/`).

If nobody answers for `--wait` minutes (default 60), the run **parks**: its state is saved and the process exits. Approving or uploading in the desk resumes it. The server also resumes a parked run by itself when the recording appears in the folder. From the terminal, use `--resume <id>`.

## 4. Endings

| Status | Meaning |
|---|---|
| `ok` | Ready to publish: `publish.json`, `video/<run>.mp4`, caption |
| `partial` | Stopped on purpose (`--until`, or the api engine reached a step that needs file access) |
| `blocked` | A gate stayed BLOCK after the revision rounds, or the accuracy gate said not ready |
| `rejected` | You rejected a checkpoint more than twice |
| `over_budget` | The cap or stop line was reached before a required step |
| `error` | A step failed twice, login problem, render failed or produced no mp4 |
| `cancelled` | You cancelled it |

Every run writes `runs/<id>/report.md` (steps, cost per step and seat, files) and a line in `runs/ledger.jsonl`, shown in **Producer desk › Costs**. Any run that did not end `ok` can be resumed after you fix the cause.

## 5. What stays manual
- Posting to Instagram, TikTok and YouTube (the run prepares `publish.json` and the caption).
- Recording the voice-over or footage.
- Images for the three styles that need an image generator.
