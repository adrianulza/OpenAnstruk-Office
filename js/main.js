// main.js: renderer, camera, event player, hover bubbles and HUD.
// The office only reads event logs. It never calls a model: zero tokens.
import * as THREE from '../vendor/three.module.min.js';
import { buildWorld, ZONES } from './world.js';
import { Character, idleTick } from './staff.js';

const params = new URLSearchParams(location.search);
// Default: watch the real event log and stay idle until an order (run_start) arrives.
// The sample run only plays when asked for with ?replay.
const LIVE = !params.has('replay');
const LOG = params.get('log') || (LIVE ? 'data/events.jsonl' : 'data/sample-run.jsonl');

// ---------- renderer, scene, camera ----------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#ffe9d6');
scene.fog = new THREE.Fog('#ffe9d6', 40, 70);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
const orbit = { yaw: 0.0, pitch: 0.78, dist: 30, target: new THREE.Vector3(0, 0, 0.6) };
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

const W = buildWorld(scene);

// ---------- staff ----------
const staffData = await (await fetch('data/staff.json')).json();
const CAP = staffData.capUSD, GUARD = staffData.guard;
const agents = {}, roster = [];
staffData.staff.forEach((s, i) => {
  const a = new Character(s, scene);
  const sp = [...ZONES.lounge.spots, ...ZONES.play.spots][i];
  a.place(sp.p, sp.face); a.pose = sp.pose; sp.taken = a; a.spot = sp; a.thought = sp.what;
  a.setIcon(sp.pose === 'play' ? 'play' : sp.pose === 'sit' ? 'sit' : 'idle');
  agents[s.id] = a; roster.push(a);
});
const OUTSIDE = [14.2, 6.6];
staffData.visitors.forEach((v) => {
  const a = new Character({ ...v, hat: 'mic', hair: '#1d1d2b' }, scene);
  a.visitor = true; a.place(OUTSIDE, -Math.PI / 2); a.root.visible = false; a.thought = v.role;
  agents[v.id] = a;
});

// ---------- run state ----------
const run = { id: '-', template: '-', usd: 0, status: 'idle · waiting for an order', stage: -1, budgetMsg: '' };
const STAGES = ['Riset', 'Naskah', 'Kritik', 'Animasi', 'Rekam', 'Render', 'Tayang'];
const stageOf = { researcher: 0, scriptwriter: 1, critic: 2, animator: 3, ulza: 4, aina: 4, ops: 5 };
const feed = [];

function say(agent, ev) {
  if (ev.summary) agent.thought = ev.summary;
  if (ev.model) { agent.model = ev.model + (ev.effort ? ' / ' + ev.effort : ''); }
}
function deskSpot(id) {
  const z = ZONES[{ producer: 'producer', researcher: 'research', scriptwriter: 'writers', animator: 'animation', critic: 'critic', ops: 'ops' }[id]];
  // a spot beside the desk, on the open-floor side
  const [x, y] = z.desk;
  if (y < -3) return [x + 1.4, y + 1.2];
  return [x + (x < 0 ? 1.6 : -1.6), y + 0.6];
}

function apply(ev) {
  const a = agents[ev.agent];
  if (!a) return;
  const line = `${fmtT(ev.t)}  ${a.info.name}: ${ev.type}${ev.summary ? ' · ' + ev.summary : ''}${ev.usd ? ` (+$${ev.usd.toFixed(2)})` : ''}`;
  feed.unshift(line); feed.length = Math.min(feed.length, 60);
  if (stageOf[ev.agent] !== undefined && ['task_start', 'tool', 'thinking'].includes(ev.type)) run.stage = Math.max(run.stage, stageOf[ev.agent]);
  say(a, ev);

  if (a.visitor && ev.type !== 'done') { a.setIcon(ev.type === 'blocked' ? 'blocked' : 'record'); return; }
  switch (ev.type) {
    case 'run_start':
      Object.assign(run, { id: ev.run, template: ev.template || '-', usd: 0, status: 'running', stage: -1, budgetMsg: '' });
      roster.forEach((r) => (r.usd = 0));
      a.busy = true; a.setIcon('walk');
      a.goTo(ZONES.kanban.spot, { pose: 'think', yaw: Math.PI, then: () => a.setIcon('think') });
      break;
    case 'task_start':
      a.busy = true; a.blocked = false; a.setIcon('walk');
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
        if (b) { b.paper.visible = true; setTimeout(() => (b.paper.visible = false), 1500); }
        setTimeout(() => { if (a.busy) a.goDesk(() => a.setIcon('work')); }, 900);
      } });
      break;
    }
    case 'blocked':
      a.blocked = true; a.setIcon('blocked');
      break;
    case 'waiting_human': {
      a.setIcon('wait'); a.busy = true;
      const v = agents[ev.to || 'ulza'];
      if (v) {
        v.root.visible = true; v.place(OUTSIDE, -Math.PI / 2); v.setIcon('hello');
        v.thought = ev.summary || 'Datang untuk rekaman';
        v.goTo(ZONES.booth.spot, { pose: 'record', yaw: Math.PI, then: () => { v.setIcon('record'); W.setOnAir(true); } });
      }
      break;
    }
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
        a.goTo(OUTSIDE, { then: () => { a.root.visible = false; } });
        break;
      }
      a.celebrate = 1.3; a.setIcon('done');
      setTimeout(() => { a.busy = false; a.idleTimer = 1.5 + Math.random() * 2; }, 1800);
      break;
    case 'idle':
      a.busy = false; a.blocked = false; a.idleTimer = 0.5;
      break;
    case 'run_end':
      run.status = 'done'; run.stage = STAGES.length - 1;
      roster.forEach((r, i) => {
        r.busy = true; r.blocked = false;
        r.goTo(ZONES.screen.ring[i], { pose: 'stand', yaw: Math.PI, then: () => { r.setIcon('gather'); r.celebrate = 1.5; } });
        r.thought = ev.summary || 'Nonton hasil akhir';
      });
      setTimeout(() => { roster.forEach((r) => { r.busy = false; r.idleTimer = 2 + Math.random() * 6; }); if (LIVE) run.status = 'idle · waiting for an order'; }, 12000);
      break;
  }
}

// ---------- event player ----------
let events = [], cursor = 0, clock = 0, playing = true, speed = Number(params.get('speed') || 4);
const speedNow = () => (LIVE ? 1 : speed);
function parseJSONL(txt) { return txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
let firstLoad = true;
async function loadLog() {
  try {
    const r = await fetch(LOG + '?_=' + Date.now());
    const all = r.ok ? parseJSONL(await r.text()) : [];
    if (LIVE) {
      let fresh = all.slice(events.length);
      if (firstLoad) {
        // Only an unfinished order is picked up on open; finished runs stay in the past.
        let start = -1;
        all.forEach((e, i) => { if (e.type === 'run_start') start = i; });
        const open = start >= 0 && !all.slice(start).some((e) => e.type === 'run_end');
        fresh = open ? all.slice(start) : [];
        if (!open && start >= 0) {
          const end = [...all].reverse().find((e) => e.type === 'run_end');
          feed.unshift(`Last order ${all[start].run} finished${end?.summary ? ' · ' + end.summary : ''}`);
        }
      }
      events = all; fresh.forEach(apply);
    } else if (r.ok) {
      events = all.sort((x, y) => x.t - y.t);
    } else feed.unshift('Log not found: ' + LOG);
  } catch (e) { if (!LIVE) feed.unshift('Log not found: ' + LOG); }
  firstLoad = false;
}
await loadLog();
if (LIVE && !feed.length) feed.unshift('Staff are idle. Waiting for an order.');
if (LIVE) setInterval(loadLog, 2000);
function restart() {
  location.reload();
}

// ---------- HUD ----------
const $ = (id) => document.getElementById(id);
function fmtT(t) { t = Math.max(0, Math.floor(t)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
let flashUntil = 0;
function flashBudget() { flashUntil = performance.now() + 2500; }
function hud() {
  $('runId').textContent = run.id;
  $('runTpl').textContent = run.template;
  $('runStatus').textContent = run.status;
  const pct = Math.min(100, (run.usd / CAP) * 100);
  const bar = $('meterFill');
  bar.style.width = pct + '%';
  bar.style.background = run.usd >= GUARD.stopUSD ? '#d9534f' : run.usd >= GUARD.wrapUpUSD ? '#e9a23b' : '#3bb273';
  $('meter').classList.toggle('flash', performance.now() < flashUntil);
  $('usd').textContent = `$${run.usd.toFixed(2)} / $${CAP.toFixed(2)}`;
  $('budgetMsg').textContent = run.budgetMsg;
  $('clock').textContent = LIVE ? (run.status === 'running' ? 'WORKING' : 'IDLE') : `${fmtT(clock)} / ${fmtT(events.length ? events[events.length - 1].t : 0)}`;
  $('feed').innerHTML = feed.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  $('stages').innerHTML = STAGES.map((s, i) => `<span class="${i < run.stage ? 'past' : i === run.stage ? 'now' : ''}">${s}</span>`).join('');
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function drawScreen() {
  const { canvas: c, tex } = W.screen; const g = c.getContext('2d');
  g.fillStyle = '#1e1a2e'; g.fillRect(0, 0, c.width, c.height);
  if (run.id === '-') {
    g.fillStyle = '#ff8a5b'; g.font = '800 54px system-ui'; g.fillText('No order yet', 40, 80);
    g.fillStyle = '#fff7ec'; g.font = '500 34px system-ui'; g.fillText('The team is idle until a run is started.', 40, 140);
    g.fillStyle = '#a99fbf'; g.font = '500 26px system-ui'; g.fillText('Office animation: 0 tokens', 40, 450);
    tex.needsUpdate = true; return;
  }
  g.fillStyle = '#ff8a5b'; g.font = '800 54px system-ui'; g.fillText('RUN ' + run.id, 40, 80);
  g.fillStyle = '#fff7ec'; g.font = '500 34px system-ui'; g.fillText('Template: ' + run.template, 40, 130);
  STAGES.forEach((s, i) => {
    const x = 40 + i * 136, y = 200;
    g.fillStyle = i < run.stage ? '#3bb273' : i === run.stage ? '#ffcc33' : '#3a3352';
    g.beginPath(); g.roundRect(x, y, 122, 64, 18); g.fill();
    g.fillStyle = i <= run.stage ? '#1e1a2e' : '#a99fbf'; g.font = '700 26px system-ui'; g.fillText(s, x + 12, y + 42);
  });
  g.fillStyle = '#fff7ec'; g.font = '700 40px system-ui'; g.fillText(`$${run.usd.toFixed(2)} of $${CAP}`, 40, 340);
  g.fillStyle = '#3a3352'; g.fillRect(40, 370, 940, 26);
  g.fillStyle = run.usd >= GUARD.wrapUpUSD ? '#e9a23b' : '#3bb273'; g.fillRect(40, 370, 940 * Math.min(1, run.usd / CAP), 26);
  g.fillStyle = '#a99fbf'; g.font = '500 26px system-ui'; g.fillText('Office animation: 0 tokens', 40, 450);
  tex.needsUpdate = true;
}

// ---------- hover bubbles + clicks ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let hoverAgent = null, hoverObj = null;
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const targets = [...Object.values(agents).filter((a) => a.root.visible).map((a) => a.root), ...W.clickables];
  const hit = ray.intersectObjects(targets, true)[0];
  hoverAgent = hit ? hit.object.userData.agent || null : null;
  hoverObj = hit && !hoverAgent ? W.clickables.find((c) => c === hit.object) : null;
  const tip = $('tip');
  if (hoverAgent) {
    const a = hoverAgent;
    tip.innerHTML = `<b style="color:${a.info.color}">${a.info.name}</b> <span class="muted">${a.info.role}</span><div class="thought">“${escapeHtml(a.thought)}”</div>${a.visitor ? '' : `<div class="muted">${a.model || a.info.model?.phase2 || ''}${a.usd ? ` · spent $${a.usd.toFixed(2)}` : ''}</div>`}`;
  } else if (hoverObj) tip.innerHTML = hoverObj.userData.hover;
  tip.style.display = hoverAgent || hoverObj ? 'block' : 'none';
  tip.style.left = Math.min(e.clientX + 16, innerWidth - 300) + 'px'; tip.style.top = e.clientY + 16 + 'px';
  canvas.style.cursor = hoverObj || hoverAgent ? 'pointer' : drag ? 'grabbing' : 'grab';
});
canvas.addEventListener('click', () => { if (hoverObj?.userData.click === 'templates') openTemplates(); });
function openTemplates() { window.open('template-picker.html', '_blank'); }

// orbit: drag to rotate, wheel to zoom
let drag = null;
canvas.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY, yaw: orbit.yaw, pitch: orbit.pitch }));
addEventListener('pointerup', () => (drag = null));
addEventListener('pointermove', (e) => { if (!drag) return; orbit.yaw = drag.yaw - (e.clientX - drag.x) * 0.005; orbit.pitch = Math.max(0.35, Math.min(1.35, drag.pitch + (e.clientY - drag.y) * 0.004)); });
canvas.addEventListener('wheel', (e) => { orbit.dist = Math.max(12, Math.min(48, orbit.dist * (1 + Math.sign(e.deltaY) * 0.08))); e.preventDefault(); }, { passive: false });

// controls
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '⏸' : '▶'; };
document.querySelectorAll('[data-speed]').forEach((b) => (b.onclick = () => { speed = +b.dataset.speed; document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelector(`[data-speed="${speed}"]`)?.classList.add('on');
$('restart').onclick = restart;
$('tplBtn').onclick = openTemplates;
$('mode').textContent = LIVE ? `Watching ${LOG}` : `DEMO REPLAY · ${LOG.split('/').pop()}`;
$('replayLink').href = LIVE ? '?replay' : './';
$('replayLink').textContent = LIVE ? '▶ Replay sample run (demo)' : '■ Back to the office';
if (LIVE) { document.querySelectorAll('.replay-only').forEach((el) => (el.style.display = 'none')); $('controlsTitle').textContent = 'Office status'; }

// ---------- loop ----------
function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(canvas); resize();
const clk = new THREE.Clock(); let t = 0, hudT = 0;
function frame() {
  const dt = Math.min(0.05, clk.getDelta()); t += dt;
  if (!LIVE && playing) {
    clock += dt * speed;
    while (cursor < events.length && events[cursor].t <= clock) apply(events[cursor++]);
  }
  const simDt = dt * (LIVE ? 1 : Math.min(speed, 4));     // characters move faster when replay is sped up, capped for readability
  roster.forEach((a) => a.update(simDt, t));
  Object.values(agents).filter((a) => a.visitor).forEach((a) => a.update(simDt, t));
  idleTick(roster, simDt);
  W.anim.forEach((f) => f(t));
  placeCamera();
  renderer.render(scene, camera);
  if ((hudT += dt) > 0.2) { hudT = 0; hud(); drawScreen(); }
  requestAnimationFrame(frame);
}
hud(); drawScreen(); frame();
window.__office = { camera, agents, run, orbit, events: () => events, apply, setClock: (c) => { clock = c; } };
