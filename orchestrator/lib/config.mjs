// config.mjs: paths, run config (file + CLI flags), validation, run ids and post folders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNS = process.env.OFFICE_RUNS_DIR ? path.resolve(process.env.OFFICE_RUNS_DIR) : path.join(OFFICE, 'runs');
export const ENGINES = ['dry', 'claude-cli', 'api'];
export const KREATORS = ['openanstruk', 'aina'];
export const APPROVALS = ['brief', 'script', 'final'];

export const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const PIPELINE = readJSON(path.join(OFFICE, 'data', 'pipeline.json'));
export const TEMPLATES = readJSON(path.join(OFFICE, 'templates.json')).templates;
export const defaultLog = () => process.env.OFFICE_LOG ? path.resolve(process.env.OFFICE_LOG) : path.join(OFFICE, 'data', 'events.jsonl');

export class ConfigError extends Error {}

// ---------- CLI ----------
const BOOL = new Set(['skip-voice', 'subscription', 'auto-approve', 'allow-unready', 'help']);
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ConfigError(`Unexpected argument "${a}". Options start with --`);
    const k = a.slice(2);
    if (BOOL.has(k)) { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new ConfigError(`--${k} needs a value`);
    out[k] = v; i++;
  }
  return out;
}

const num = (v, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a positive number, got "${v}"`);
  return n;
};
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

// Merges defaults <- --config file <- flags, then validates. Returns a plain config object.
export function buildConfig(flags, fileObj = null) {
  let file = fileObj || {};
  if (!fileObj && flags.config) {
    const f = path.resolve(flags.config);
    if (!fs.existsSync(f)) throw new ConfigError(`--config file not found: ${f}`);
    try { file = readJSON(f); } catch (e) { throw new ConfigError(`--config is not valid JSON: ${e.message}`); }
  }
  const pick = (k, fk = k) => flags[k] ?? file[fk];
  const c = {
    engine: pick('engine') || 'dry',
    kreator: pick('kreator') || 'openanstruk',
    template: pick('template') || 'kolase-browser',
    topic: (pick('topic') || '').trim(),
    slot: pick('slot') || '',
    notes: (pick('notes') || '').trim(),
    phase: Number(pick('phase') || 2),
    repo: path.resolve(pick('repo') || process.cwd()),
    run: pick('run') || '',
    post: pick('post') || '',
    approve: list(flags.approve ?? file.approve ?? []),
    until: pick('until') || '',
    skipVoice: !!(flags['skip-voice'] || file.skipVoice),
    autoApprove: !!(flags['auto-approve'] || file.autoApprove),
    allowUnready: !!(flags['allow-unready'] || file.allowUnready),
    subscription: !!(flags.subscription || file.subscription),
    pace: num(pick('pace'), '--pace') ?? 1,
    rounds: num(pick('rounds'), '--rounds') ?? 1,
    retries: num(pick('retries'), '--retries') ?? 1,
    stepTimeoutMin: num(pick('step-timeout', 'stepTimeoutMin'), '--step-timeout') ?? 30,
    waitMin: num(pick('wait', 'waitMin'), '--wait') ?? 60,
    dryVerdicts: pick('dry-verdicts', 'dryVerdicts') || '',
    platforms: file.platforms || ['instagram', 'tiktok'],
  };
  const g = PIPELINE.guard[c.phase === 1 ? 'phase1' : 'phase2'];
  c.cap = num(flags.cap ?? file.budgetUSD ?? file.cap, '--cap') ?? g.cap;
  c.wrap = num(flags.wrap ?? file.wrap, '--wrap') ?? +(c.cap * g.wrap / g.cap).toFixed(2);
  c.stop = num(flags.stop ?? file.stop, '--stop') ?? +(c.cap * g.stop / g.cap).toFixed(2);
  validate(c);
  return c;
}

export function validate(c) {
  if (!ENGINES.includes(c.engine)) throw new ConfigError(`--engine must be one of ${ENGINES.join(', ')}, got "${c.engine}"`);
  if (!KREATORS.includes(c.kreator)) throw new ConfigError(`--kreator must be one of ${KREATORS.join(', ')}, got "${c.kreator}"`);
  if (![1, 2].includes(c.phase)) throw new ConfigError(`--phase must be 1 (adapt a template) or 2 (make a reel)`);
  const t = TEMPLATES.find((x) => x.id === c.template);
  if (!t) throw new ConfigError(`Unknown template "${c.template}". Pick an id from templates.json (Template Board)`);
  if (c.phase === 2) {
    if (!c.topic) throw new ConfigError('--topic is required');
    if (c.topic.length > 120) throw new ConfigError('--topic is too long (max 120 characters)');
    if (!c.slot) c.slot = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.slot) || Number.isNaN(Date.parse(c.slot))) throw new ConfigError(`--slot must be a date like 2026-11-20, got "${c.slot}"`);
    if (t.kreator && !t.kreator.includes(c.kreator)) throw new ConfigError(`Template "${t.id}" is for ${t.kreator.join('/')}, not ${c.kreator}`);
    if (t.status !== 'ready' && !c.allowUnready) throw new ConfigError(`Template "${t.id}" is not ready (${t.status}). Adapt it first with --phase 1 (needs your OK), or pick a ready template`);
  } else {
    if (!c.topic) c.topic = `Adaptasi ${t.name}`;
    if (!c.slot) c.slot = new Date().toISOString().slice(0, 10);
    if (t.status === 'ready') throw new ConfigError(`Template "${t.id}" is already ready; phase 1 is only for templates that need adapting`);
  }
  for (const a of c.approve) if (!APPROVALS.includes(a)) throw new ConfigError(`--approve accepts ${APPROVALS.join(', ')}, got "${a}"`);
  if (!(c.wrap <= c.stop && c.stop <= c.cap)) throw new ConfigError(`Budget guard must be wrap <= stop <= cap (got ${c.wrap} / ${c.stop} / ${c.cap})`);
  if (c.engine !== 'dry' && !fs.existsSync(c.repo)) throw new ConfigError(`--repo does not exist: ${c.repo}`);
  if (c.until && !pipelineFor(c).some((s) => s.id === c.until)) throw new ConfigError(`--until must be a step id: ${pipelineFor(c).map((s) => s.id).join(', ')}`);
  c.templateInfo = { id: t.id, name: t.name, status: t.status, needsImageGen: !!t.needsImageGen, estUSD: t.estUSD };
  return c;
}

export const pipelineFor = (c) => PIPELINE.pipelines[c.phase === 1 ? 'phase1' : c.kreator];

// ---------- run id, post folder ----------
const STOP_WORDS = new Set(['tapi', 'dan', 'yang', 'di', 'ke', 'dari', 'itu', 'ini', 'kok', 'sudah', 'bisa', 'untuk', 'dengan', 'atau', 'the', 'a', 'of', 'and']);
export function slugify(s, max = 32) {
  const words = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  let out = '';
  for (const w of (kept.length ? kept : words)) { if ((out + '-' + w).length > max + 1) break; out = out ? `${out}-${w}` : w; }
  return out || 'reel';
}
const numbered = (dir, prefix = '') => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => new RegExp(`^${prefix}(\\d{4})-`).exec(n)?.[1]).filter(Boolean).map(Number) : []);
export function resolveRunId(c) {
  if (c.run) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.run)) throw new ConfigError('--run may only use letters, digits, . _ -');
    return c.run;
  }
  if (c.phase === 1) return `kit-${slugify(c.template.replace(/^opuscar:/, ''), 24)}-${c.slot}`;
  // Dry runs are numbered on their own (dry-0001-...) so they never push the real post numbers forward.
  const dry = c.engine === 'dry';
  const nums = dry ? numbered(RUNS, 'dry-') : [...numbered(RUNS), ...numbered(path.join(c.repo, PIPELINE.posts[c.kreator]))];
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `${dry ? 'dry-' : ''}${String(n).padStart(4, '0')}-${slugify(c.topic)}`;
}
export function resolvePostDir(c, run) {
  if (c.post) return path.resolve(c.post);
  if (c.engine === 'dry') return path.join(RUNS, run, 'post');
  if (c.phase === 1) return path.join(c.repo, 'templates', c.template.replace(/^opuscar:/, ''));
  return path.join(c.repo, PIPELINE.posts[c.kreator], run);
}
