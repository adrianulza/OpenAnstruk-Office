# Office event log (`events.jsonl`)

One JSON object per line, appended by the orchestrator (or by any agent hook). The office only **reads** this file; it never calls a model. Zero tokens.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `t` | number | yes | Seconds since the run started (replay clock) |
| `run` | string | yes | Run id, e.g. `0025-retak-rumah` |
| `agent` | string | yes | `producer`, `researcher`, `scriptwriter`, `animator`, `critic`, `ops`, or a visitor `ulza`, `aina` |
| `type` | string | yes | See types below |
| `summary` | string | no | What the agent is thinking or doing, at most 90 characters. Shown in the hover bubble |
| `to` | string | handoff | Receiving agent |
| `model` | string | no | `opus`, `sonnet`, `haiku` |
| `effort` | string | no | `low`, `medium`, `high`, `xhigh` |
| `usage` | object | cost | `{ "in": n, "out": n, "cache_read": n, "cache_write": n }` |
| `usd` | number | cost | Cost of this call in USD |
| `template` | string | run_start | Template id from `templates.json` |

## Types

| Type | Office behaviour |
|---|---|
| `run_start` | Producer walks to the kanban wall, run card appears, budget meter resets |
| `task_start` | Agent walks to its desk and starts working |
| `thinking` | Thought bubble with dots; summary on hover |
| `tool` | Typing animation, small screen flash |
| `handoff` | Agent carries a paper to `to`, then returns |
| `blocked` | Red "!" above the head |
| `waiting_human` | Agent waits at the door; visitor (`ulza`/`aina`) walks in on their next event |
| `cost` | Adds `usd` to the run total; updates meter and the agent's bubble |
| `budget` | Guard message (`wrap_up` or `stop`); meter flashes |
| `done` | Small celebration, then the agent goes idle |
| `idle` | Agent wanders to the lounge or play zone |
| `run_end` | Everyone gathers by the screen; finished reel card |

## Example

```json
{"t":0,"run":"0025-retak-rumah","agent":"producer","type":"run_start","template":"kolase-browser","summary":"Slot 3 Nov: Rumah baru kok sudah retak?"}
{"t":4,"run":"0025-retak-rumah","agent":"researcher","type":"task_start","model":"sonnet","effort":"medium","summary":"Cek fakta retak struktural vs retak rambut"}
{"t":30,"run":"0025-retak-rumah","agent":"researcher","type":"cost","usd":0.21,"usage":{"in":3000,"out":1200,"cache_read":27000,"cache_write":3000}}
{"t":31,"run":"0025-retak-rumah","agent":"researcher","type":"handoff","to":"scriptwriter","summary":"Fact sheet siap, 6 angka bersumber"}
```

## Live mode
Serve the `office/` folder and point the orchestrator's `--log` at `office/data/events.jsonl`. The office polls that file every 2 s and plays new lines in real time. This is the default (`index.html`); `index.html?replay` plays `data/sample-run.jsonl` instead. On open, only an unfinished run (a `run_start` with no `run_end` after it) is picked up; finished runs are skipped.
