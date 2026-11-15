// staff.js: chibi characters, walking, and what they do when they are not working.
import * as THREE from '../vendor/three.module.min.js';
import { ZONES, textSprite } from './world.js';

const SPEED = 2.4;              // m/s
const deskOf = { producer: 'producer', researcher: 'research', scriptwriter: 'writers', animator: 'animation', critic: 'critic', ops: 'ops' };

const M = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...o });
function part(geo, mat, x, y, z, parent) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; }

// Status icons drawn once, reused as sprite textures.
const ICONS = { work: '⌨️', think: '💭', walk: '👣', carry: '📄', blocked: '❗', wait: '⏳', done: '🎉', idle: '☕', play: '🎮', sit: '😌', record: '🎙️', gather: '🎬', hello: '👋' };
const iconTex = {};
function icon(name) {
  if (!iconTex[name]) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = name === 'blocked' ? '#ffdede' : '#ffffff';
    g.beginPath(); g.arc(64, 58, 50, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(48, 100); g.lineTo(64, 126); g.lineTo(76, 100); g.fill();
    g.font = '60px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ICONS[name] || '•', 64, 60);
    iconTex[name] = new THREE.CanvasTexture(c); iconTex[name].colorSpace = THREE.SRGBColorSpace;
  }
  return iconTex[name];
}

// Waypoints: leave the station, cross the open floor, avoid the centre screen.
function entry([x, z]) {
  if (z < -3) return [x, -3.4];                 // desk row, booth, kanban
  if (x < -8.0 && z < 4) return [-8.0, z];      // research corner
  if (x > 8.2 && z < 4.5) return [8.2, z];      // ops dock
  if (z > 4.4) return [x, 4.4];                 // lounge and play
  return [x, z];
}
function crossesScreen(a, b) {
  const north = (p) => p[1] < -1.3, south = (p) => p[1] > -0.5;
  if (!((north(a) && south(b)) || (north(b) && south(a)))) return false;
  const t = (-0.9 - a[1]) / (b[1] - a[1]);
  const x = a[0] + t * (b[0] - a[0]);
  return Math.abs(x) < 2.4;
}
export function route(from, to) {
  const a = entry(from), b = entry(to), pts = [];
  if (a[0] !== from[0] || a[1] !== from[1]) pts.push(a);
  if (crossesScreen(a, b)) {
    const side = (a[0] + b[0]) / 2 >= 0 ? 2.8 : -2.8;
    const n = a[1] < b[1] ? [[side, -2.2], [side, 0.4]] : [[side, 0.4], [side, -2.2]];
    pts.push(...n);
  }
  if (b[0] !== to[0] || b[1] !== to[1]) pts.push(b);
  pts.push(to);
  return pts;
}

export class Character {
  constructor(info, scene) {
    this.info = info; this.id = info.id;
    this.root = new THREE.Group(); scene.add(this.root);
    this.body = new THREE.Group(); this.root.add(this.body);
    const col = new THREE.Color(info.color);
    const skin = M('#ffd9b8'), cloth = M(col), dark = M(col.clone().multiplyScalar(0.7));
    // legs
    this.legL = part(new THREE.CapsuleGeometry(0.09, 0.22, 4, 8), dark, -0.12, 0.2, 0, this.body);
    this.legR = part(new THREE.CapsuleGeometry(0.09, 0.22, 4, 8), dark, 0.12, 0.2, 0, this.body);
    // torso
    this.torso = part(new THREE.CapsuleGeometry(0.26, 0.3, 6, 14), cloth, 0, 0.62, 0, this.body);
    // arms (pivot at shoulder)
    this.armL = new THREE.Group(); this.armL.position.set(-0.32, 0.8, 0); this.body.add(this.armL);
    this.armR = new THREE.Group(); this.armR.position.set(0.32, 0.8, 0); this.body.add(this.armR);
    part(new THREE.CapsuleGeometry(0.07, 0.26, 4, 8), cloth, 0, -0.18, 0, this.armL);
    part(new THREE.CapsuleGeometry(0.07, 0.26, 4, 8), cloth, 0, -0.18, 0, this.armR);
    part(new THREE.SphereGeometry(0.08, 10, 8), skin, 0, -0.38, 0, this.armL);
    part(new THREE.SphereGeometry(0.08, 10, 8), skin, 0, -0.38, 0, this.armR);
    // big head
    this.head = new THREE.Group(); this.head.position.y = 1.28; this.body.add(this.head);
    part(new THREE.SphereGeometry(0.42, 24, 18), skin, 0, 0, 0, this.head);
    const hair = part(new THREE.SphereGeometry(0.44, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.5), M(info.hair || '#3b2a20'), 0, 0.04, -0.02, this.head);
    hair.rotation.x = -0.25;
    const eye = M('#1d1d2b');
    this.eyes = [part(new THREE.SphereGeometry(0.055, 10, 8), eye, -0.14, -0.02, 0.38, this.head), part(new THREE.SphereGeometry(0.055, 10, 8), eye, 0.14, -0.02, 0.38, this.head)];
    const blush = M('#ff9fb2', { transparent: true, opacity: 0.7 });
    part(new THREE.SphereGeometry(0.06, 10, 8), blush, -0.25, -0.12, 0.33, this.head).scale.set(1, 0.5, 0.4);
    part(new THREE.SphereGeometry(0.06, 10, 8), blush, 0.25, -0.12, 0.33, this.head).scale.set(1, 0.5, 0.4);
    this.accessory(info.hat, col);
    // paper prop for handoffs
    this.paper = part(new THREE.BoxGeometry(0.3, 0.02, 0.38), M('#ffffff'), 0, -0.4, 0.12, this.armR);
    this.paper.visible = false;
    // name tag + status icon
    this.tag = textSprite(info.name, { size: 34, bg: info.color, fg: '#ffffff', scale: 0.0055 });
    this.tag.position.y = 2.05; this.root.add(this.tag);
    this.iconSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: icon('idle'), depthTest: false, transparent: true }));
    this.iconSprite.scale.set(0.5, 0.5, 1); this.iconSprite.position.set(0.45, 2.45, 0); this.iconSprite.renderOrder = 11; this.root.add(this.iconSprite);
    this.root.traverse((o) => { o.userData.agent = this; });

    this.path = []; this.pose = 'stand'; this.activity = 'idle'; this.spot = null;
    this.thought = 'Belum ada tugas'; this.model = ''; this.usd = 0; this.bob = Math.random() * 10;
    this.idleTimer = 2 + Math.random() * 4; this.onArrive = null; this.busy = false;
    this.celebrate = 0; this.yawTarget = 0;
  }

  accessory(kind, col) {
    const h = this.head;
    if (kind === 'cap') { part(new THREE.CylinderGeometry(0.4, 0.42, 0.16, 20), M('#2b2340'), 0, 0.3, 0, h); part(new THREE.BoxGeometry(0.4, 0.04, 0.3), M('#2b2340'), 0, 0.24, 0.42, h); }
    if (kind === 'glasses') { const g = M('#2b2340'); for (const x of [-0.14, 0.14]) { const r = part(new THREE.TorusGeometry(0.09, 0.015, 6, 16), g, x, -0.02, 0.42, h); } part(new THREE.BoxGeometry(0.1, 0.015, 0.015), g, 0, -0.02, 0.43, h); }
    if (kind === 'beret') { const b = part(new THREE.SphereGeometry(0.36, 16, 10), M('#d9534f'), 0.05, 0.36, -0.02, h); b.scale.set(1.1, 0.35, 1.1); }
    if (kind === 'headphones') { const g = M('#2b2340'); const band = part(new THREE.TorusGeometry(0.44, 0.04, 8, 24, Math.PI), g, 0, 0.02, 0, h); band.rotation.z = 0; part(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14), M('#ff8a5b'), -0.43, 0, 0, h).rotation.z = Math.PI / 2; part(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14), M('#ff8a5b'), 0.43, 0, 0, h).rotation.z = Math.PI / 2; }
    if (kind === 'monocle') { part(new THREE.TorusGeometry(0.1, 0.018, 6, 16), M('#e0b43b', { metalness: 0.6 }), 0.14, -0.02, 0.42, h); const t = part(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 16), M('#2b2340'), 0, 0.42, 0, h); part(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 18), M('#2b2340'), 0, 0.28, 0, h); }
    if (kind === 'helmet') { const s = part(new THREE.SphereGeometry(0.45, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), M('#ffcc33'), 0, 0.06, 0, h); part(new THREE.BoxGeometry(0.9, 0.03, 0.2), M('#ffcc33'), 0, 0.12, 0.38, h); }
    if (kind === 'mic') { /* visitors: plain */ }
  }

  get pos() { return [this.root.position.x, this.root.position.z]; }
  place(p, yaw = 0) { this.root.position.set(p[0], 0, p[1]); this.root.rotation.y = yaw; this.yawTarget = yaw; }
  setIcon(name) { this.iconSprite.material.map = icon(name); this.iconSprite.material.needsUpdate = true; this.iconName = name; }

  goTo(p, { pose = 'stand', yaw = null, then = null } = {}) {
    this.path = route(this.pos, p);
    this.pose = 'walk'; this.arrivePose = pose; this.arriveYaw = yaw; this.onArrive = then;
    if (this.spot) { this.spot.taken = null; this.spot = null; }
  }
  goDesk(then) {
    const z = ZONES[deskOf[this.id]];
    const yaw = z.face + Math.PI;                       // desk() rotation
    const look = [-Math.sin(yaw), -Math.cos(yaw)];      // local -z in world
    this.goTo(z.desk, { pose: 'work', yaw: Math.atan2(look[0], look[1]), then });
  }

  update(dt, t) {
    this.bob += dt;
    // movement along the path
    if (this.path.length) {
      const [tx, tz] = this.path[0];
      const dx = tx - this.root.position.x, dz = tz - this.root.position.z;
      const d = Math.hypot(dx, dz);
      const step = SPEED * dt * (this.hurry ? 1.6 : 1);
      if (d <= step) {
        this.root.position.x = tx; this.root.position.z = tz; this.path.shift();
        if (!this.path.length) {
          this.pose = this.arrivePose;
          if (this.arriveYaw !== null) this.yawTarget = this.arriveYaw;
          const cb = this.onArrive; this.onArrive = null; if (cb) cb();
        }
      } else {
        this.root.position.x += dx / d * step; this.root.position.z += dz / d * step;
        this.yawTarget = Math.atan2(dx, dz);
      }
    }
    // smooth turning
    let dy = this.yawTarget - this.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.root.rotation.y += dy * Math.min(1, dt * 10);

    // body language per pose
    const b = this.bob, walk = this.pose === 'walk';
    const swing = walk ? Math.sin(b * 11) * 0.6 : 0;
    this.legL.rotation.x = swing; this.legR.rotation.x = -swing;
    this.body.position.y = walk ? Math.abs(Math.sin(b * 11)) * 0.06 : 0;
    this.armL.rotation.set(-swing, 0, 0.1); this.armR.rotation.set(swing, 0, -0.1);
    this.head.rotation.set(0, 0, 0);
    if (this.pose === 'work') {          // typing
      this.armL.rotation.set(-1.2 + Math.sin(b * 18) * 0.12, 0, 0.25);
      this.armR.rotation.set(-1.2 + Math.cos(b * 17) * 0.12, 0, -0.25);
      this.body.position.y = -0.18;      // seated
      this.head.rotation.x = 0.12 + Math.sin(b * 2) * 0.03;
    }
    if (this.pose === 'think') { this.armR.rotation.set(-2.3, 0, -0.5); this.head.rotation.z = Math.sin(b * 1.5) * 0.12; this.body.position.y = -0.18; }
    if (this.pose === 'sit') { this.body.position.y = -0.2; this.legL.rotation.x = this.legR.rotation.x = -1.3; this.head.rotation.z = Math.sin(b * 0.8) * 0.06; }
    if (this.pose === 'play') { this.armL.rotation.set(-1.0 + Math.sin(b * 9) * 0.3, 0, 0.2); this.armR.rotation.set(-1.0 + Math.cos(b * 8) * 0.4, 0, -0.2); this.body.position.y = Math.abs(Math.sin(b * 6)) * 0.04; }
    if (this.pose === 'stand' || this.pose === 'wait') { this.body.scale.y = 1 + Math.sin(b * 2.2) * 0.015; }
    if (this.pose === 'record') { this.armR.rotation.set(-1.6, 0, -0.2); this.head.rotation.x = Math.sin(b * 6) * 0.05; }
    if (this.blocked) { this.head.rotation.z = Math.sin(b * 8) * 0.08; }
    if (this.celebrate > 0) {
      this.celebrate -= dt;
      this.body.position.y = Math.abs(Math.sin(this.celebrate * 9)) * 0.35;
      this.armL.rotation.set(0, 0, 2.6); this.armR.rotation.set(0, 0, -2.6);
    }
    // blink
    const blink = (Math.sin(b * 0.9 + this.info.color.length) > 0.985) ? 0.1 : 1;
    this.eyes.forEach((e) => (e.scale.y = blink));
    // icon float
    this.iconSprite.position.y = 2.45 + Math.sin(b * 3) * 0.05;
    this.iconSprite.material.opacity = this.iconName === 'blocked' ? 0.6 + 0.4 * Math.abs(Math.sin(b * 6)) : 1;
  }
}

// Idle life: wander between lounge and play spots when nobody needs you.
export function idleTick(agents, dt) {
  const spots = [...ZONES.lounge.spots.map((s) => ({ ...s, zone: 'lounge' })), ...ZONES.play.spots.map((s) => ({ ...s, zone: 'play' }))];
  for (const a of agents) {
    if (a.busy || a.visitor || a.path.length) continue;
    a.idleTimer -= dt;
    if (a.idleTimer > 0) continue;
    a.idleTimer = 9 + Math.random() * 10;
    const all = [...ZONES.lounge.spots, ...ZONES.play.spots];
    const free = all.filter((s) => !s.taken || s.taken === a);
    if (!free.length) continue;
    const s = free[Math.floor(Math.random() * free.length)];
    if (a.spot) a.spot.taken = null;
    a.goTo(s.p, { pose: s.pose, yaw: s.face, then: () => { a.setIcon(s.pose === 'play' ? 'play' : s.pose === 'sit' ? 'sit' : 'idle'); a.thought = s.what; } });
    s.taken = a; a.spot = s; a.setIcon('walk'); a.thought = 'Istirahat dulu';
  }
}
