import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseJSONL, runIds, latestRun, eventsOf, liveDelta } from '../js/log.js';
import { checkEvents } from '../tools/check-events.mjs';
import { OFFICE } from './helpers.mjs';

const ev = (run, type, t, extra = {}) => ({ t, run, agent: 'producer', type, ...extra });

test('parseJSONL skips broken lines and non-events', () => {
  const txt = `${JSON.stringify(ev('a', 'run_start', 0))}\nnot json\n{"x":1}\n\n${JSON.stringify(ev('a', 'done', 1))}`;
  assert.equal(parseJSONL(txt).length, 2);
});

test('live view follows only the latest run, including resumed runs', () => {
  const all = [ev('a', 'run_start', 0), ev('a', 'done', 5), ev('b', 'run_start', 0), ev('b', 'parked', 3), ev('a', 'tool', 6)];
  assert.deepEqual(runIds(all), ['a', 'b']);
  assert.equal(latestRun(all), 'a', 'the run with the newest line wins');
  assert.deepEqual(eventsOf(all, 'b').map((e) => e.type), ['run_start', 'parked']);
  const retried = [ev('a', 'run_start', 0), ev('a', 'done', 1), ev('a', 'run_start', 0), ev('a', 'tool', 1)];
  assert.deepEqual(eventsOf(retried, 'a').map((e) => e.type), ['run_start', 'tool'], 'older attempt with the same id is dropped');
});

test('liveDelta resets when the log is truncated', () => {
  assert.deepEqual(liveDelta(3, [1, 2, 3, 4]), { reset: false, fresh: [4] });
  assert.deepEqual(liveDelta(5, [1, 2]), { reset: true, fresh: [] });
});

test('the sample log matches the event schema', () => {
  assert.deepEqual(checkEvents(fs.readFileSync(path.join(OFFICE, 'data', 'sample-run.jsonl'), 'utf8')), []);
  assert.ok(checkEvents('{"t":0,"run":"x","agent":"nobody","type":"dance"}').length >= 2);
});

test('pipeline config is consistent', () => {
  const p = JSON.parse(fs.readFileSync(path.join(OFFICE, 'data', 'pipeline.json'), 'utf8'));
  const staff = JSON.parse(fs.readFileSync(path.join(OFFICE, 'data', 'staff.json'), 'utf8'));
  const seats = new Set(staff.staff.map((s) => s.id));
  for (const [name, steps] of Object.entries(p.pipelines)) {
    const ids = steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate step ids`);
    for (const s of steps) {
      if (s.seat) assert.ok(seats.has(s.seat), `${name}/${s.id}: unknown seat ${s.seat}`);
      if (s.model) assert.ok(p.models[s.model], `${name}/${s.id}: unknown model ${s.model}`);
      if (s.revise) assert.ok(ids.indexOf(s.revise) < ids.indexOf(s.id), `${name}/${s.id}: revise target must come earlier`);
      if (s.handoff) assert.ok(seats.has(s.handoff), `${name}/${s.id}: bad handoff`);
      if (!s.kind) assert.ok(Array.isArray(s.size) && s.size.length === 4, `${name}/${s.id}: size`);
      if (!s.kind) assert.ok(fs.existsSync(path.join(OFFICE, 'agents', `office-${s.seat}.md`)), `agent file for ${s.seat}`);
    }
  }
  assert.ok(!JSON.stringify(p).includes('fable'), 'no Fable in production (house rule)');
});
