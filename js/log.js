// log.js: pure helpers for event logs (no DOM, no three.js), shared by the office and the tests.

export function parseJSONL(txt) {
  return String(txt).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && typeof e === 'object' && e.run && e.type);
}

// Run ids in the order they first appear.
export function runIds(events) {
  return [...new Set(events.map((e) => e.run))];
}

// The run to follow: the run of the most recent event (a resumed run keeps its old run_start).
export function latestRun(events) {
  return events.length ? events[events.length - 1].run : null;
}

// Events of one run, from its last run_start on (older attempts with the same id are dropped).
export function eventsOf(events, run) {
  const mine = events.filter((e) => e.run === run);
  let start = 0;
  mine.forEach((e, i) => { if (e.type === 'run_start') start = i; });
  return mine.slice(start);
}

// Live mode: given what we already applied (count of lines seen) and the new full file,
// returns { reset, fresh } so the caller can reload on truncation or a new run.
export function liveDelta(seenCount, all) {
  if (all.length < seenCount) return { reset: true, fresh: [] };
  return { reset: false, fresh: all.slice(seenCount) };
}

export const STATUS_TEXT = {
  ok: 'ready to publish', partial: 'stopped early', blocked: 'blocked', rejected: 'rejected',
  over_budget: 'over budget', error: 'error', cancelled: 'cancelled', parked: 'waiting for you', running: 'running',
};
