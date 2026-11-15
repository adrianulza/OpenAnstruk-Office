# Office event log (`events.jsonl`)

One JSON object per line, appended by the orchestrator. Each event goes to `data/events.jsonl` (the live office) and to `runs/<id>/events.jsonl` (replay and history). The office only **reads** these files; it never calls a model. Zero tokens. Validate a log with `node tools/check-events.mjs <file>`.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `t` | number | yes | Seconds since the run started (continues across resumes) |
| `run` | string | yes | Run id, e.g. `0026-gempa-kecil-merusak` (`dry-0001-…` for dry runs) |
| `agent` | string | yes | `producer`, `researcher`, `scriptwriter`, `animator`, `critic`, `ops`, or a visitor `ulza`, `aina` |
| `type` | string | yes | See types below |
| `summary` | string | no | What the agent is thinking or doing, at most 90 characters. Shown in the hover bubble |
| `to` | string | handoff, waiting_human | Receiving agent or visitor |
| `model` | string | no | `opus`, `sonnet`, `haiku` (`none` for scripts) |
| `effort` | string | no | `low`, `medium`, `high`, `xhigh` |
| `stage` | string | task_start | Stage name shown in the stage pills (from `run_start.stages`) |
| `task` | string | task_start | Step id from `data/pipeline.json` |
| `usage` | object | cost | `{ "in": n, "out": n, "cache_read": n, "cache_write": n }` |
| `usd` | number | cost | Cost of this step in USD |
| `template`, `kreator`, `phase`, `engine` | | run_start | Run settings |
| `cap`, `wrap`, `stop` | number | run_start | Budget guard of this run |
| `stages` | string[] | run_start | Stage pills for this pipeline |
| `level` | string | budget | `wrap_up` or `stop` |
| `name` | string | approval, decision | Checkpoint: `brief`, `script`, `final`, `plan`, `kit` |
| `decision` | string | decision | `approve` or `reject` |
| `status` | string | run_end | `ok`, `partial`, `blocked`, `rejected`, `over_budget`, `error`, `cancelled` |
| `total` | number | run_end | Total spend in USD |

## Types

| Type | Office behaviour |
|---|---|
| `run_start` | Producer walks to the kanban wall, run card appears, budget meter and stages reset |
| `task_start` | Agent walks to its desk and starts working; stage pill moves |
| `thinking` | Thought bubble; summary on hover |
| `tool` | Typing animation (live tool calls from Claude Code too) |
| `handoff` | Agent carries a paper to `to`, then returns |
| `blocked` | Red "!" above the head and a red banner |
| `waiting_human` | Producer waits at the door; the visitor walks into the VO booth (ON AIR) |
| `approval` | Producer waits at the kanban; banner "Waiting for your OK"; the desk shows Approve / Reject |
| `decision` | Your answer to a checkpoint |
| `parked` | The run saved its state and stopped waiting; it continues when you answer |
| `cost` | Adds `usd` to the run total; updates the meter and the agent's bubble |
| `budget` | Guard message; meter flashes |
| `done` | Small celebration, then the agent goes idle |
| `idle` | Agent wanders to the lounge or play zone |
| `run_end` | Everyone gathers by the screen; banner shows the status |

## Example

```json
{"t":0,"run":"0026-gempa-kecil-merusak","agent":"producer","type":"run_start","template":"kolase-browser","kreator":"openanstruk","phase":2,"engine":"claude-cli","cap":4,"wrap":3,"stop":3.6,"stages":["Brief","Riset","Naskah","Kritik","Animasi","Rekam","Render","QA","Caption","Siap tayang"],"summary":"2026-11-20: Gempa kecil tapi merusak"}
{"t":4,"run":"0026-gempa-kecil-merusak","agent":"researcher","type":"task_start","model":"sonnet","effort":"medium","stage":"Riset","task":"research","summary":"Cek fakta: setiap angka bersumber dan bertanggal"}
{"t":30,"run":"0026-gempa-kecil-merusak","agent":"researcher","type":"cost","usd":0.18,"usage":{"in":0,"out":9600,"cache_read":216000,"cache_write":24000},"model":"sonnet"}
{"t":31,"run":"0026-gempa-kecil-merusak","agent":"researcher","type":"handoff","to":"scriptwriter","summary":"Fact sheet siap, 6 angka bersumber"}
{"t":120,"run":"0026-gempa-kecil-merusak","agent":"producer","type":"approval","name":"script","to":"ulza","summary":"Setujui naskah sebelum animasi dan rekaman"}
{"t":300,"run":"0026-gempa-kecil-merusak","agent":"producer","type":"run_end","status":"ok","total":1.92,"summary":"Siap tayang 2026-11-20. Total $1.92 dari $4"}
```

## Live mode
`node server/server.mjs` serves the office and the log; open `http://localhost:8765/` (live by default there). The office polls `data/events.jsonl` every 2 s, follows only the run of the newest line, and starts fresh when a new run begins or the file is cleared. `index.html?log=runs/<id>/events.jsonl` replays one run, with a seek bar.
