// main.js: renderer, camera, event player, hover bubbles and HUD.
// The office only reads event logs. It never calls a model: zero tokens.
// On your own PC (node server/server.mjs) it also loads the Producer desk (js/panel.js).
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld, ZONES } from './world.js';
import { Character, idleTick } from './staff.js';
import { parseJSONL, runIds, latestRun, eventsOf, liveDelta, STATUS_TEXT } from './log.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const getJSON = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };

// Local server? (GitHub Pages has no /api, so the office is replay-only there.)
const LOCALHOST = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const SERVER = LOCALHOST ? await getJSON('api/status').catch(() => null) : null;
const LIVE = params.has('live') || (!!SERVER && !params.has('log') && !params.has('replay'));
const LOG = params.get('log') || (LIVE ? 'data/events.jsonl' : 'data/sample-run.jsonl');

// ---------- renderer, scene, camera ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#ffe9d6');
scene.fog = new THREE.Fog('#ffe9d6', 40, 70);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
const orbit = { yaw: 0.0, pitch: 0.78, dist: 30, target: new THREE.Vector3(-1.2, 0, 0.6) };   // a little left so the kanban wall clears the run card
if (innerWidth < 800) { orbit.dist = 48; orbit.target.x = 0; }
function placeCamera() {
  const { yaw, pitch, dist, target } = orbit;
  camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(target);
}
scene.add(new THREE.HemisphereLight('#fff6ea', '#e8c9a8', 1.1));
const sun = new THREE.DirectionalLight('#fff1dc', 1.6);
sun.position.set(-8, 18, 10); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 1, far: 50 });
sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.03;
scene.add(sun);

const [staffData, pipeline, templates] = await Promise.all([getJSON('data/staff.json'), getJSON('data/pipeline.json'), getJSON('templates.json').catch(() => ({ templates: [] }))]);
const W = buildWorld(scene, { templateCount: templates.templates.length });

// Default model per seat (first step of the OpenAnstruk pipeline), for the hover bubble.
const seatModel = {};
for (const s of pipeline.pipelines.openanstruk) if (s.seat && s.model && !seatModel[s.seat]) seatModel[s.seat] = `${s.model} / ${s.effort}`;

// ---------- staff ----------
const agents = {}, roster = [];
const OUTSIDE = [14.2, 6.6];
staffData.staff.forEach((s) => { const a = new Character(s, scene); agents[s.id] = a; roster.push(a); });
staffData.visitors.forEach((v) => {
  const a = new Character({ ...v, hat: 'mic', hair: '#1d1d2b' }, scene);
  a.visitor = true; agents[v.id] = a;
});
const visitors = () => Object.values(agents).filter((a) => a.visitor);

// ---------- sim-time timers (follow replay speed and pause) ----------
let simT = 0, timers = [];
const later = (sec, fn) => timers.push({ at: simT + sec, fn });
function runTimers() {
  const due = timers.filter((x) => x.at <= simT);
  if (!due.length) return;
  timers = timers.filter((x) => x.at > simT);
  due.forEach((x) => x.fn());
}

// ---------- run state ----------
const DEFAULT_STAGES = ['Riset', 'Naskah', 'Kritik', 'Animasi', 'Rekam', 'Render', 'Tayang'];
const stageOf = { researcher: 'Riset', scriptwriter: 'Naskah', critic: 'Kritik', animator: 'Animasi', ulza: 'Rekam', aina: 'Rekam', ops: 'Render' };
const guard0 = pipeline.guard.phase2;
let run, feed, banner;

function resetOffice() {
  run = { id: '-', template: '-', usd: 0, status: 'idle', stage: -1, stages: DEFAULT_STAGES, budgetMsg: '', cap: guard0.cap, wrap: guard0.wrap, stop: guard0.stop, events: [] };
  feed = []; banner = null; timers = [];
  [...ZONES.lounge.spots, ...ZONES.play.spots].forEach((sp) => (sp.taken = null));
  roster.forEach((a, i) => {
    const sp = [...ZONES.lounge.spots, ...ZONES.play.spots][i];
    a.path = []; a.onArrive = null; a.busy = false; a.blocked = false; a.celebrate = 0; a.usd = 0; a.model = ''; a.paper.visible = false; a.hurry = false;
    a.place(sp.p, sp.face); a.pose = sp.pose; sp.taken = a; a.spot = sp; a.thought = sp.what; a.idleTimer = 2 + Math.random() * 4;
    a.setIcon(sp.pose === 'play' ? 'play' : sp.pose === 'sit' ? 'sit' : 'idle');
  });
  visitors().forEach((a) => { a.path = []; a.onArrive = null; a.place(OUTSIDE, -Math.PI / 2); a.root.visible = false; a.thought = a.info.role; });
  W.setOnAir(false);
}
resetOffice();

function say(agent, ev) {
  if (ev.summary) agent.thought = ev.summary;
  if (ev.model) agent.model = ev.model + (ev.effort ? ' / ' + ev.effort : '');
}
function deskSpot(id) {
  const zone = { producer: 'producer', researcher: 'research', scriptwriter: 'writers', animator: 'animation', critic: 'critic', ops: 'ops' }[id];
  if (!zone) return ZONES.door.spot;
  const [x, y] = ZONES[zone].desk;
  if (y < -3) return [x + 1.4, y + 1.2];
  return [x + (x < 0 ? 1.6 : -1.6), y + 0.6];
}
function setStage(name) {
  const i = run.stages.indexOf(name);
  if (i >= 0) run.stage = Math.max(run.stage, i);
}
function showBanner(kind, text) { banner = { kind, text }; }

function apply(ev) {
  const a = agents[ev.agent];
  if (!a) return;
  run.events.push(ev);
  const line = `${fmtT(ev.t)}  ${a.info.name}: ${ev.type}${ev.summary ? ' · ' + ev.summary : ''}${ev.usd ? ` (+$${ev.usd.toFixed(2)})` : ''}`;
  feed.unshift(line); if (feed.length > 400) feed.length = 400;
  if (ev.type === 'task_start' && ev.stage) setStage(ev.stage);
  else if (!ev.stage && stageOf[ev.agent] && ['task_start', 'tool', 'thinking'].includes(ev.type) && run.stages === DEFAULT_STAGES) setStage(stageOf[ev.agent]);
  say(a, ev);
  window.dispatchEvent(new CustomEvent('office:event', { detail: ev }));

  if (a.visitor && ev.type !== 'done') { a.setIcon(ev.type === 'blocked' ? 'blocked' : 'record'); return; }
  switch (ev.type) {
    case 'run_start':
      Object.assign(run, {
        id: ev.run, template: ev.template || '-', usd: 0, status: 'running', stage: -1, budgetMsg: '',
        stages: Array.isArray(ev.stages) && ev.stages.length ? ev.stages : DEFAULT_STAGES,
        cap: ev.cap ?? guard0.cap, wrap: ev.wrap ?? guard0.wrap, stop: ev.stop ?? guard0.stop,
      });
      banner = null;
      roster.forEach((r) => (r.usd = 0));
      a.busy = true; a.setIcon('walk');
      a.goTo(ZONES.kanban.spot, { pose: 'think', yaw: Math.PI, then: () => a.setIcon('think') });
      break;
    case 'task_start':
      a.busy = true; a.blocked = false; a.setIcon('walk');
      if (banner?.kind === 'blocked') banner = null;
      if (run.status === 'parked') run.status = 'running';
      a.goDesk(() => a.setIcon('work'));
      break;
    case 'thinking':
      a.busy = true; if (!a.path.length && a.pose === 'work') a.pose = 'think';
      a.setIcon('think');
      break;
    case 'tool':
      a.busy = true; if (!a.path.length && (a.pose === 'think' || a.pose === 'work')) a.pose = 'work';
      if (!a.path.length) a.setIcon('work');
      break;
    case 'handoff': {
      const b = agents[ev.to];
      a.busy = true; a.paper.visible = true; a.setIcon('carry'); a.hurry = true;
      a.goTo(deskSpot(ev.to), { pose: 'stand', then: () => {
        a.paper.visible = false; a.setIcon('hello'); a.hurry = false;
        if (b && !b.visitor) { b.paper.visible = true; later(1.5, () => (b.paper.visible = false)); }
        later(0.9, () => { if (a.busy) a.goDesk(() => a.setIcon('work')); });
      } });
      break;
    }
    case 'blocked':
      a.blocked = true; a.setIcon('blocked');
      showBanner('blocked', `${a.info.name}: ${ev.summary || 'blocked'}`);
      break;
    case 'waiting_human': {
      a.setIcon('wait'); a.busy = true;
      a.goTo(ZONES.door.spot, { pose: 'wait', yaw: -Math.PI / 2, then: () => a.setIcon('wait') });
      showBanner('wait', ev.summary || 'Waiting for a recording');
      const v = agents[ev.to || 'ulza'];
      if (v) {
        v.root.visible = true; v.place(OUTSIDE, -Math.PI / 2); v.setIcon('hello');
        v.thought = ev.summary || 'Datang untuk rekaman';
        v.goTo(ZONES.booth.spot, { pose: 'record', yaw: Math.PI, then: () => { v.setIcon('record'); W.setOnAir(true); } });
      }
      break;
    }
    case 'approval':
      a.busy = true; a.setIcon('wait');
      a.goTo(ZONES.kanban.spot, { pose: 'think', yaw: Math.PI, then: () => a.setIcon('wait') });
      showBanner('approval', `Waiting for your OK: ${ev.name || ''} · ${ev.summary || ''}`);
      run.pendingApproval = ev.name;
      break;
    case 'decision':
      a.setIcon('hello'); run.pendingApproval = null;
      if (banner?.kind === 'approval') banner = null;
      later(1.2, () => { a.busy = false; a.idleTimer = 2; });
      break;
    case 'parked':
      run.status = 'parked'; a.setIcon('wait');
      showBanner('wait', ev.summary || 'Parked: waiting for you');
      break;
    case 'cost':
      run.usd += ev.usd || 0; a.usd += ev.usd || 0;
      break;
    case 'budget':
      run.budgetMsg = ev.summary || ev.level || 'budget';
      flashBudget();
      break;
    case 'done':
      a.blocked = false; a.paper.visible = false;
      if (a.visitor) {
        W.setOnAir(false); a.setIcon('hello');
        if (banner?.kind === 'wait') banner = null;
        a.goTo(OUTSIDE, { then: () => { a.root.visible = false; } });
        break;
      }
      a.celebrate = 1.3; a.setIcon('done');
      later(1.8, () => { a.busy = false; a.idleTimer = 1.5 + Math.random() * 2; });
      break;
    case 'idle':
      a.busy = false; a.blocked = false; a.idleTimer = 0.5;
      break;
    case 'run_end': {
      const status = ev.status || 'ok';
      run.status = status; run.pendingApproval = null;
      if (typeof ev.total === 'number') run.usd = ev.total;
      if (status === 'ok') { run.stage = run.stages.length - 1; showBanner('ok', ev.summary || 'Ready to publish'); }
      else showBanner(status === 'partial' ? 'wait' : 'blocked', `${STATUS_TEXT[status] || status}: ${ev.summary || ''}`);
      roster.forEach((r, i) => {
        r.busy = true; r.blocked = false;
        r.goTo(ZONES.screen.ring[i], { pose: 'stand', yaw: Math.PI, then: () => { r.setIcon(status === 'ok' ? 'gather' : 'idle'); if (status === 'ok') r.celebrate = 1.5; } });
        r.thought = ev.summary || 'Nonton hasil akhir';
      });
      later(12, () => roster.forEach((r) => { r.busy = false; r.idleTimer = 2 + Math.random() * 6; }));
      break;
    }
  }
}

// ---------- event player ----------
let allEvents = [], events = [], cursor = 0, clock = 0, playing = true, seen = 0;
const duration = () => (events.length ? events[events.length - 1].t : 0);
const SPEEDS = [1, 4, 16];
let speed = SPEEDS.includes(Number(params.get('speed'))) ? Number(params.get('speed')) : 4;
let selectedRun = params.get('run');

async function fetchLog() {
  const r = await fetch(LOG + (LOG.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return parseJSONL(await r.text());
}

// settle: finish every walk and timer at once (seeking).
function settle() {
  for (let k = 0; k < 30; k++) {
    let moved = false;
    for (const a of Object.values(agents)) if (a.snap()) moved = true;
    if (timers.length) { const t = timers; timers = []; t.forEach((x) => x.fn()); moved = true; }
    if (!moved) break;
  }
}
function seek(to) {
  to = Math.max(0, Math.min(to, duration()));
  if (to < clock) { resetOffice(); cursor = 0; }
  while (cursor < events.length && events[cursor].t <= to) { apply(events[cursor++]); settle(); }
  clock = to;
}

async function loadReplay() {
  try {
    allEvents = await fetchLog();
  } catch { feed.unshift('Log not found: ' + LOG); return; }
  const ids = runIds(allEvents);
  if (!selectedRun || !ids.includes(selectedRun)) selectedRun = latestRun(allEvents);
  events = eventsOf(allEvents, selectedRun).sort((x, y) => x.t - y.t);
  const sel = $('runPick');
  if (ids.length > 1) {
    sel.innerHTML = ids.map((id) => `<option ${id === selectedRun ? 'selected' : ''}>${escapeHtml(id)}</option>`).join('');
    sel.style.display = '';
    sel.onchange = () => { params.set('run', sel.value); location.search = params.toString(); };
  }
  const start = Number(params.get('t'));
  if (start > 0) seek(start);
}

async function pollLive() {
  let all;
  try { all = await fetchLog(); } catch { return; }
  const { reset, fresh } = liveDelta(seen, all);
  if (reset) { seen = 0; resetOffice(); return pollLive(); }
  if (seen === 0) {
    // first load: show only the run that is going on now (older runs stay in the log file)
    const id = latestRun(all);
    seen = all.length;
    if (!id) return;
    const mine = eventsOf(all, id);
    mine.forEach((e) => { apply(e); settle(); });
    return;
  }
  seen = all.length;
  for (const e of fresh) {
    if (e.type === 'run_start' && run.id !== '-' && e.run !== run.id) resetOffice();
    apply(e);
  }
}

if (LIVE) { await pollLive(); setInterval(pollLive, 2000); }
else await loadReplay();

// ---------- HUD ----------
function fmtT(t) { t = Math.max(0, Math.floor(t)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
let flashUntil = 0, feedOpen = false;
function flashBudget() { flashUntil = performance.now() + 2500; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function hud() {
  $('runId').textContent = run.id;
  $('runTpl').textContent = run.template;
  $('runStatus').textContent = STATUS_TEXT[run.status] || run.status;
  const pct = Math.min(100, (run.usd / run.cap) * 100);
  const bar = $('meterFill');
  bar.style.width = pct + '%';
  bar.style.background = run.usd >= run.stop ? '#d9534f' : run.usd >= run.wrap ? '#e9a23b' : '#3bb273';
  $('tickWrap').style.left = `${(run.wrap / run.cap) * 100}%`;
  $('tickStop').style.left = `${(run.stop / run.cap) * 100}%`;
  $('guardTxt').textContent = `guard ${run.wrap.toFixed(2)} · ${run.stop.toFixed(2)}`;
  $('meter').classList.toggle('flash', performance.now() < flashUntil);
  $('usd').textContent = `$${run.usd.toFixed(2)} / $${run.cap.toFixed(2)}`;
  $('budgetMsg').textContent = run.budgetMsg;
  if (LIVE) $('clock').textContent = 'LIVE';
  else {
    $('clock').textContent = `${fmtT(clock)} / ${fmtT(duration())}`;
    const sk = $('seek');
    if (document.activeElement !== sk) { sk.max = String(Math.ceil(duration())); sk.value = String(Math.min(clock, duration())); }
  }
  $('feed').innerHTML = (feedOpen ? feed : feed.slice(0, 8)).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  $('stages').innerHTML = run.stages.map((s, i) => `<span class="${i < run.stage ? 'past' : i === run.stage ? 'now' : ''}">${escapeHtml(s)}</span>`).join('');
  const b = $('banner');
  b.style.display = banner ? 'block' : 'none';
  if (banner) { b.className = `panel ${banner.kind}`; b.textContent = banner.text; }
  if (pinned) renderAgentPanel(pinned);
}

function drawScreen() {
  const { canvas: c, tex } = W.screen; const g = c.getContext('2d');
  g.fillStyle = '#1e1a2e'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ff8a5b'; g.font = '800 54px system-ui'; g.fillText('RUN ' + run.id, 40, 80);
  g.fillStyle = '#fff7ec'; g.font = '500 34px system-ui'; g.fillText('Template: ' + run.template, 40, 130);
  const n = run.stages.length, w = Math.min(122, Math.floor(940 / n) - 10);
  run.stages.forEach((s, i) => {
    const x = 40 + i * (w + 10), y = 200;
    g.fillStyle = i < run.stage ? '#3bb273' : i === run.stage ? '#ffcc33' : '#3a3352';
    g.beginPath(); g.roundRect(x, y, w, 64, 18); g.fill();
    g.fillStyle = i <= run.stage ? '#1e1a2e' : '#a99fbf'; g.font = `700 ${n > 8 ? 18 : 24}px system-ui`; g.fillText(s, x + 8, y + 42, w - 12);
  });
  g.fillStyle = '#fff7ec'; g.font = '700 40px system-ui'; g.fillText(`$${run.usd.toFixed(2)} of $${run.cap}`, 40, 340);
  g.fillStyle = '#3a3352'; g.fillRect(40, 370, 940, 26);
  g.fillStyle = run.usd >= run.wrap ? '#e9a23b' : '#3bb273'; g.fillRect(40, 370, 940 * Math.min(1, run.usd / run.cap), 26);
  g.fillStyle = '#a99fbf'; g.font = '500 26px system-ui'; g.fillText(`${STATUS_TEXT[run.status] || run.status} · office animation: 0 tokens`, 40, 450);
  tex.needsUpdate = true;
}

// ---------- agent panel (click a person) ----------
let pinned = null;
function renderAgentPanel(a) {
  const evs = run.events.filter((e) => e.agent === a.id).slice(-30).reverse();
  $('agentPanel').innerHTML = `<button class="x" id="agentClose" title="Close">✕</button>
    <h2 style="color:${a.info.color}">${escapeHtml(a.info.name)}</h2><div class="muted">${escapeHtml(a.info.role)}</div>
    <div class="thought">“${escapeHtml(a.thought)}”</div>
    ${a.visitor ? '' : `<div class="muted">${escapeHtml(a.model || seatModel[a.id] || '')}${a.usd ? ` · spent $${a.usd.toFixed(2)}` : ''}</div>`}
    ${a.info.skills ? `<div class="muted">Skills: ${a.info.skills.map(escapeHtml).join(', ')}</div>` : ''}
    <h3>This run</h3><ul>${evs.map((e) => `<li><b>${fmtT(e.t)}</b> ${escapeHtml(e.type)}${e.summary ? ' · ' + escapeHtml(e.summary) : ''}${e.usd ? ` (+$${e.usd.toFixed(3)})` : ''}</li>`).join('') || '<li class="muted">Nothing yet</li>'}</ul>`;
  $('agentPanel').style.display = 'block';
  $('agentClose').onclick = () => { pinned = null; $('agentPanel').style.display = 'none'; };
}

// ---------- hover bubbles + clicks ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let hoverAgent = null, hoverObj = null;
canvas.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const targets = [...Object.values(agents).filter((a) => a.root.visible).map((a) => a.root), ...W.clickables];
  const hit = ray.intersectObjects(targets, true)[0];
  hoverAgent = hit ? hit.object.userData.agent || null : null;
  hoverObj = hit && !hoverAgent ? W.clickables.find((c) => c === hit.object) : null;
  const tip = $('tip');
  if (hoverAgent) {
    const a = hoverAgent;
    tip.innerHTML = `<b style="color:${a.info.color}">${escapeHtml(a.info.name)}</b> <span class="muted">${escapeHtml(a.info.role)}</span><div class="thought">“${escapeHtml(a.thought)}”</div>${a.visitor ? '' : `<div class="muted">${escapeHtml(a.model || seatModel[a.id] || '')}${a.usd ? ` · spent $${a.usd.toFixed(2)}` : ''}</div>`}<div class="muted">Click for history</div>`;
  } else if (hoverObj) tip.textContent = hoverObj.userData.hover;
  tip.style.display = (hoverAgent || hoverObj) && !drag?.moved ? 'block' : 'none';
  tip.style.left = Math.min(e.clientX + 16, innerWidth - 300) + 'px'; tip.style.top = e.clientY + 16 + 'px';
  canvas.style.cursor = hoverObj || hoverAgent ? 'pointer' : drag ? 'grabbing' : 'grab';
});
canvas.addEventListener('click', () => {
  if (drag?.moved) return;
  if (hoverAgent) { pinned = hoverAgent; renderAgentPanel(pinned); }
  else if (hoverObj?.userData.click === 'templates') openTemplates();
});
function openTemplates() { window.open('template-picker.html', '_blank'); }

// orbit: drag to rotate, wheel or pinch to zoom
let drag = null; const pointers = new Map(); let pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { const [p, q] = [...pointers.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), dist: orbit.dist }; drag = null; }
  else drag = { x: e.clientX, y: e.clientY, yaw: orbit.yaw, pitch: orbit.pitch, moved: false };
});
addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; setTimeout(() => (drag = null), 0); });
addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; drag = null; });
addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    orbit.dist = Math.max(12, Math.min(48, pinch.dist * pinch.d / Math.max(1, Math.hypot(p.x - q.x, p.y - q.y))));
    return;
  }
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
  orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.005;
  orbit.pitch = Math.max(0.35, Math.min(1.35, drag.pitch + (e.clientY - drag.y) * 0.004));
});
canvas.addEventListener('wheel', (e) => { orbit.dist = Math.max(12, Math.min(48, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08))); e.preventDefault(); }, { passive: false });

// controls
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '⏸' : '▶'; };
document.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => { speed = +b.dataset.speed; document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelector(`[data-speed="${speed}"]`)?.classList.add('on');
$('restart').onclick = () => seek(0);
$('seek').oninput = (e) => seek(Number(e.target.value));
$('tplBtn').onclick = openTemplates;
$('feedToggle').onclick = () => { feedOpen = !feedOpen; $('feedBox').classList.toggle('open', feedOpen); $('feedToggle').textContent = feedOpen ? 'less' : 'all'; };
$('mode').textContent = LIVE ? `LIVE · ${LOG}` : `REPLAY · ${LOG.split('/').pop()}`;
if (LIVE) document.querySelectorAll('.replay-only').forEach((el) => (el.style.display = 'none'));
if (!SERVER) $('staticNote').style.display = 'block';

// ---------- loop ----------
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
const clk = new THREE.Clock(); let t = 0, hudT = 0;
function frame() {
  const dt = Math.min(0.05, clk.getDelta()); t += dt;
  const rate = LIVE ? 1 : playing ? speed : 0;
  if (!LIVE && playing) {
    clock = Math.min(clock + dt * speed, Math.max(duration(), clock));
    while (cursor < events.length && events[cursor].t <= clock) apply(events[cursor++]);
  }
  const simDt = dt * rate;           // walking, timers and idle life follow replay speed and pause
  simT += simDt; runTimers();
  roster.forEach((a) => a.update(simDt, t));
  visitors().forEach((a) => a.update(simDt, t));
  if (rate > 0) idleTick(roster, simDt);
  W.anim.forEach((f) => f(t));
  placeCamera();
  renderer.render(scene, camera);
  if ((hudT += dt) > 0.2) { hudT = 0; hud(); drawScreen(); }
  requestAnimationFrame(frame);
}
hud(); drawScreen(); frame();
window.__office = { camera, agents, get run() { return run; }, orbit, events: () => events, apply, seek, LIVE, SERVER };

if (SERVER) import('./panel.js').then((m) => m.initPanel({ server: SERVER, office: window.__office })).catch((e) => console.error('panel', e));
