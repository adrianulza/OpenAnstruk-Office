// world.js: the room, the zones and the furniture. Pure geometry, no logic.
import * as THREE from '../vendor/three.module.min.js';

export const W = 26, D = 18;            // floor size (x, z), metres
const HX = W / 2, HZ = D / 2;
const WALL_H = 4.2;

// Where each seat works, and the free spots of the idle zones.
export const ZONES = {
  producer:  { label: 'Producer · Kanban',     desk: [-7.4, -5.2], face: Math.PI, color: '#ffd9c7' },
  research:  { label: 'Research Library',      desk: [-10.2, 0.6], face: -Math.PI / 2, color: '#d4e9fa' },
  writers:   { label: "Writers' Nook",          desk: [-3.6, -5.2], face: Math.PI, color: '#ecdcfa' },
  animation: { label: 'Animation Bay',          desk: [1.6, -5.2],  face: Math.PI, color: '#d6f2e2' },
  critic:    { label: 'Critic Booth',           desk: [6.6, -5.2],  face: Math.PI, color: '#fbefc8' },
  ops:       { label: 'Render & Publish Dock',  desk: [10.4, 0.6],  face: Math.PI / 2, color: '#e3e8ef' },
  booth:     { label: 'VO Booth',               spot: [10.6, -6.4] },
  door:      { spot: [12.6, 6.6] },
  kanban:    { spot: [-10.6, -7.2], face: Math.PI },
  screen:    { spot: [0, 0.6], ring: [[-1.6, 1.0], [-0.6, 1.3], [0.6, 1.3], [1.6, 1.0], [-1.1, 2.0], [1.1, 2.0], [0, 2.2], [2.4, 1.6]] },
  // pose: sit | stand | play ; face: yaw for a model that looks along +z
  lounge:    { label: 'Lounge', spots: [
    { p: [-11.6, 5.4], pose: 'sit', face: Math.PI / 2, what: 'Rebahan di sofa' },
    { p: [-11.6, 6.6], pose: 'sit', face: Math.PI / 2, what: 'Ngobrol santai' },
    { p: [-11.6, 7.8], pose: 'sit', face: Math.PI / 2, what: 'Baca buku SNI 1726' },
    { p: [-8.4, 7.4],  pose: 'sit', face: 0,     what: 'Tiduran di bean bag' },
    { p: [-6.8, 7.8],  pose: 'sit', face: 0,     what: 'Scroll reel orang' },
    { p: [-4.6, 7.4],  pose: 'stand', face: 0,         what: 'Bikin kopi' } ] },
  play:      { label: 'Play Zone', spots: [
    { p: [1.4, 7.3],  pose: 'play', face: 0,            what: 'Main arcade' },
    { p: [3.5, 7.0],  pose: 'play', face: Math.PI / 2,  what: 'Main pingpong' },
    { p: [6.9, 7.0],  pose: 'play', face: -Math.PI / 2, what: 'Main pingpong' },
    { p: [9.4, 6.5],  pose: 'stand', face: 0,           what: 'Nonton meja getar' } ] },
};

const mats = {};
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!mats[key]) mats[key] = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.0, ...opts });
  return mats[key];
}
function box(w, h, d, color, x, y, z, parent, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
function cyl(rt, rb, h, color, x, y, z, parent, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
export function textSprite(text, { size = 40, bg = 'rgba(255,255,255,0.92)', fg = '#2b2340', pad = 14, scale = 0.006 } = {}) {
  const ctx0 = document.createElement('canvas').getContext('2d');
  ctx0.font = `700 ${size}px system-ui, sans-serif`;
  const tw = Math.ceil(ctx0.measureText(text).width);
  const tex = canvasTex(tw + pad * 2, size + pad * 2, (g, w, h) => {
    g.fillStyle = bg; const r = h / 2;
    g.beginPath(); g.roundRect(0, 0, w, h, r); g.fill();
    g.font = `700 ${size}px system-ui, sans-serif`; g.fillStyle = fg; g.textBaseline = 'middle';
    g.fillText(text, pad, h / 2 + 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((tw + pad * 2) * scale, (size + pad * 2) * scale, 1);
  s.renderOrder = 10;
  return s;
}

export function buildWorld(scene) {
  const world = new THREE.Group(); scene.add(world);
  const clickables = [];
  const anim = [];           // per-frame callbacks for ambient motion

  // ---------- floor: warm wood planks ----------
  const floorTex = canvasTex(1024, 1024, (g, w, h) => {
    const cols = ['#e9c99d', '#e4c193', '#edd0a6', '#e1bc8c'];
    const ph = h / 16;
    for (let r = 0; r < 16; r++) {
      let x = (r % 2) * -w / 6;
      while (x < w) { const pw = w / 3; g.fillStyle = cols[(r * 7 + Math.floor(x)) % 4]; g.fillRect(x, r * ph, pw - 3, ph - 3); x += pw; }
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(3, 2);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; world.add(floor);

  // zone rugs (soft colour patches under each workstation)
  for (const [k, z] of Object.entries(ZONES)) {
    if (!z.desk) continue;
    const rug = new THREE.Mesh(new THREE.CircleGeometry(2.0, 40), mat(z.color));
    rug.rotation.x = -Math.PI / 2; rug.position.set(z.desk[0], 0.01, z.desk[1] + (k === 'research' || k === 'ops' ? 0 : 0.9));
    rug.receiveShadow = true; world.add(rug);
  }
  // lounge and play rugs
  const lr = new THREE.Mesh(new THREE.PlaneGeometry(9.0, 4.4), mat('#f6c9c9')); lr.rotation.x = -Math.PI / 2; lr.position.set(-8.2, 0.012, 6.6); lr.receiveShadow = true; world.add(lr);
  const pr = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 4.6), mat('#c9e6f6')); pr.rotation.x = -Math.PI / 2; pr.position.set(5.0, 0.012, 6.4); pr.receiveShadow = true; world.add(pr);

  // ---------- walls (back and left only, so the camera sees in) ----------
  box(W, WALL_H, 0.3, '#fff4e6', 0, WALL_H / 2, -HZ - 0.15, world);
  box(0.3, WALL_H, D, '#fdeedd', -HX - 0.15, WALL_H / 2, 0, world);
  box(W, 0.25, 0.32, '#f2c28f', 0, 0.12, -HZ - 0.1, world);   // skirting
  box(0.32, 0.25, D, '#f2c28f', -HX - 0.1, 0.12, 0, world);
  // low half-wall on the right with the door gap
  box(0.3, 1.1, D - 4, '#fdeedd', HX + 0.15, 0.55, -2, world);

  // windows on the left wall
  for (const z of [-3.5, 3.5]) {
    box(0.06, 1.6, 2.6, '#bfe3ff', -HX + 0.02, 2.4, z, world, { emissive: '#9fd3ff', emissiveIntensity: 0.35 });
    box(0.12, 0.1, 2.8, '#ffffff', -HX + 0.05, 1.55, z, world);
    box(0.12, 0.1, 2.8, '#ffffff', -HX + 0.05, 3.25, z, world);
  }

  // ---------- OpenAnstruk logo on the back wall ----------
  const logoTex = new THREE.TextureLoader().load('assets/logo.png');
  logoTex.colorSpace = THREE.SRGBColorSpace;
  const plaque = box(7.4, 2.1, 0.12, '#ffffff', 0, 2.7, -HZ + 0.06, world);
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(7.0, 1.75), new THREE.MeshBasicMaterial({ map: logoTex, transparent: true }));
  logo.position.set(0, 2.7, -HZ + 0.13); world.add(logo);
  const spot = new THREE.SpotLight('#fff1d6', 18, 9, 0.6, 0.6); spot.position.set(0, 4.1, -HZ + 2.5); spot.target = plaque; world.add(spot);

  // ---------- Producer: desk + kanban wall ----------
  desk(world, ZONES.producer, '#ffb38f');
  const kanbanTex = canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    const cols = ['IDE', 'RISET', 'NASKAH', 'ANIMASI', 'REVIEW', 'TAYANG'];
    cols.forEach((c, i) => {
      const x = i * w / 6;
      g.fillStyle = '#2b2340'; g.font = '700 30px system-ui'; g.fillText(c, x + 14, 42);
      g.strokeStyle = '#f0dcc4'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      const notes = ['#ffe08a', '#ffc2d1', '#bde7ff', '#c8f2c2'];
      for (let n = 0; n < 2 + (i % 3); n++) { g.fillStyle = notes[(i + n) % 4]; g.fillRect(x + 18 + (n % 2) * 70, 70 + n * 95, 120, 80); }
    });
  });
  const kb = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.8), new THREE.MeshStandardMaterial({ map: kanbanTex }));
  kb.position.set(-10.6, 2.2, -HZ + 0.07); world.add(kb);
  const kbLabel = textSprite('Kanban', { size: 34 }); kbLabel.position.set(-10.6, 3.3, -HZ + 0.3); world.add(kbLabel);

  // ---------- Research library: shelves on the left wall ----------
  for (const z of [-1.6, 0.6, 2.8]) bookshelf(world, -HX + 0.45, z);
  desk(world, ZONES.research, '#9fcdf0');

  // ---------- Writers, Animation, Critic desks ----------
  desk(world, ZONES.writers, '#d2b4f0', { lamp: true });
  desk(world, ZONES.animation, '#96d9b2', { monitors: 3 });
  desk(world, ZONES.critic, '#f2d27a', { stamp: true });

  // ---------- Template Board (clickable) ----------
  const tbTex = canvasTex(1024, 640, (g, w, h) => {
    g.fillStyle = '#2b2340'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ff8a5b'; g.font = '800 64px system-ui'; g.fillText('TEMPLATE BOARD', 40, 90);
    g.fillStyle = '#fff7ec'; g.font = '500 34px system-ui'; g.fillText('108 styles · click to choose', 40, 140);
    const c = ['#ffe08a', '#ffc2d1', '#bde7ff', '#c8f2c2', '#f6c9c9', '#d6c9f6'];
    for (let i = 0; i < 12; i++) { g.fillStyle = c[i % 6]; g.fillRect(40 + (i % 6) * 160, 190 + Math.floor(i / 6) * 210, 140, 180); }
  });
  const tb = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.6, 0.14), [mat('#2b2340'), mat('#2b2340'), mat('#2b2340'), mat('#2b2340'), new THREE.MeshStandardMaterial({ map: tbTex, emissive: '#ffffff', emissiveMap: tbTex, emissiveIntensity: 0.25 }), mat('#2b2340')]);
  tb.position.set(7.4, 2.4, -HZ + 0.1); tb.castShadow = true; world.add(tb);
  tb.userData = { click: 'templates', hover: 'Template Board: click to pick the template for the next run' };
  clickables.push(tb);

  // ---------- VO booth (Ulza records here) ----------
  box(2.4, 0.1, 2.4, '#3a3352', ZONES.booth.spot[0], 0.05, ZONES.booth.spot[1], world);
  box(0.08, 2.3, 2.4, '#5b5277', ZONES.booth.spot[0] + 1.2, 1.15, ZONES.booth.spot[1], world, { transparent: true, opacity: 0.55 });
  cyl(0.03, 0.03, 1.5, '#222', ZONES.booth.spot[0] - 0.3, 0.75, ZONES.booth.spot[1] + 0.3, world, 8);
  cyl(0.09, 0.09, 0.22, '#555', ZONES.booth.spot[0] - 0.3, 1.55, ZONES.booth.spot[1] + 0.3, world, 12);
  const onAir = textSprite('ON AIR', { size: 30, bg: '#d9534f', fg: '#fff' }); onAir.position.set(ZONES.booth.spot[0], 2.6, ZONES.booth.spot[1]); onAir.visible = false; world.add(onAir);

  // ---------- Ops dock: server racks + render screen ----------
  desk(world, ZONES.ops, '#b7c3d4', { monitors: 1 });
  const leds = [];
  for (const z of [3.0, 4.2]) {
    box(1.0, 2.2, 0.9, '#3a4256', HX - 0.8, 1.1, z, world);
    for (let i = 0; i < 6; i++) { const l = box(0.05, 0.06, 0.06, '#7dff9a', HX - 1.32, 0.4 + i * 0.3, z - 0.2, world, { emissive: '#7dff9a', emissiveIntensity: 1 }); leds.push(l); }
  }
  anim.push((t) => leds.forEach((l, i) => { l.material = mat(Math.sin(t * 3 + i * 1.7) > 0 ? '#7dff9a' : '#2d5a3a', { emissive: Math.sin(t * 3 + i * 1.7) > 0 ? '#7dff9a' : '#000000', emissiveIntensity: 1 }); }));

  // ---------- center status screen ----------
  const screenCanvas = document.createElement('canvas'); screenCanvas.width = 1024; screenCanvas.height = 512;
  const screenTex = new THREE.CanvasTexture(screenCanvas); screenTex.colorSpace = THREE.SRGBColorSpace;
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.8), new THREE.MeshBasicMaterial({ map: screenTex }));
  scr.position.set(0, 1.55, -0.9); world.add(scr);
  box(3.8, 2.0, 0.1, '#2b2340', 0, 1.55, -0.97, world);
  cyl(0.06, 0.06, 0.6, '#2b2340', 0, 0.3, -0.97, world, 8);
  box(1.2, 0.06, 0.6, '#2b2340', 0, 0.03, -0.97, world);

  // ---------- Lounge ----------
  const sf = sofa(world, -12.3, 6.6); sf.rotation.y = Math.PI / 2;
  // coffee machine on a counter
  box(1.6, 0.95, 0.7, '#f2c28f', -4.6, 0.48, 8.4, world);
  box(0.55, 0.65, 0.5, '#3a3352', -4.6, 1.28, 8.4, world);
  box(0.2, 0.1, 0.12, '#d9534f', -4.6, 1.45, 8.12, world, { emissive: '#d9534f', emissiveIntensity: 0.8 });
  plant(world, -12.2, 8.6); plant(world, -2.8, 8.4); plant(world, 12.2, -8.2); plant(world, -12.2, -8.2);
  // bean bags
  for (const [x, z, c] of [[-8.4, 7.4, '#ff9fb2'], [-6.8, 7.8, '#9fd3ff']]) {
    const bb = new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 14), mat(c)); bb.scale.set(1, 0.6, 1); bb.position.set(x, 0.35, z); bb.castShadow = true; world.add(bb);
  }

  // ---------- Play zone ----------
  // arcade cabinet
  const arc = new THREE.Group(); arc.position.set(1.4, 0, 8.3); arc.rotation.y = Math.PI; world.add(arc);
  box(1.0, 1.9, 0.9, '#6c4bd6', 0, 0.95, 0, arc);
  const arcScreen = box(0.75, 0.55, 0.05, '#111', 0, 1.45, 0.46, arc, { emissive: '#ff6bd6', emissiveIntensity: 0.6 });
  box(0.9, 0.12, 0.4, '#2b2340', 0, 1.05, 0.55, arc);
  anim.push((t) => { arcScreen.material = mat('#111', { emissive: ['#ff6bd6', '#6bd6ff', '#ffe36b'][Math.floor(t * 2) % 3], emissiveIntensity: 0.7 }); });
  // ping-pong table
  box(2.6, 0.08, 1.4, '#2f8f5b', 5.2, 0.76, 7.0, world);
  box(0.04, 0.16, 1.4, '#ffffff', 5.2, 0.88, 7.0, world);
  for (const [dx, dz] of [[-1.1, -0.55], [1.1, -0.55], [-1.1, 0.55], [1.1, 0.55]]) box(0.08, 0.74, 0.08, '#333', 5.2 + dx, 0.37, 7.0 + dz, world);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat('#ffffff')); world.add(ball);
  anim.push((t) => { const p = (Math.sin(t * 2.4) + 1) / 2; ball.position.set(5.2 - 1.1 + p * 2.2, 0.85 + Math.abs(Math.sin(t * 4.8)) * 0.35, 7.0 + Math.sin(t * 1.3) * 0.3); });
  // mini shake table (nod to SIM-GEUMPA) with a wobbling tower
  const shake = new THREE.Group(); shake.position.set(9.4, 0, 7.8); world.add(shake);
  box(1.4, 0.7, 1.0, '#8a7f99', 0, 0.35, 0, shake);
  const plate = box(1.1, 0.06, 0.8, '#e0b43b', 0, 0.73, 0, shake);
  const tower = new THREE.Group(); tower.position.y = 0.76; shake.add(tower);
  for (let i = 0; i < 4; i++) { box(0.5, 0.04, 0.5, '#fff', 0, 0.26 * (i + 1), 0, tower); for (const [a, b] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) box(0.03, 0.26, 0.03, '#1a2f5e', a, 0.26 * i + 0.13, b, tower); }
  const shakeLabel = textSprite('SIM-GEUMPA mini', { size: 26 }); shakeLabel.position.set(0, 2.1, 0); shake.add(shakeLabel);
  anim.push((t) => { const g = Math.sin(t * 9) * 0.05 * (0.5 + 0.5 * Math.sin(t * 0.7)); plate.position.x = g; tower.position.x = g; tower.rotation.z = -g * 1.6; });

  // ---------- zone labels ----------
  for (const z of Object.values(ZONES)) {
    if (!z.label) continue;
    const p = z.desk || z.spot || z.spots[0].p;
    const s = textSprite(z.label, { size: 30, bg: 'rgba(43,35,64,0.82)', fg: '#fff7ec' });
    s.position.set(p[0], 3.3, p[1]); world.add(s);
  }

  // door mat
  const dm = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), mat('#c98f5e')); dm.rotation.x = -Math.PI / 2; dm.position.set(12.4, 0.013, 6.6); world.add(dm);

  return {
    world, clickables, anim,
    screen: { canvas: screenCanvas, tex: screenTex },
    setOnAir(v) { onAir.visible = v; },
  };
}

// ---------- furniture helpers ----------
function desk(parent, zone, color, opt = {}) {
  const g = new THREE.Group();
  g.position.set(zone.desk[0], 0, zone.desk[1]); g.rotation.y = zone.face + Math.PI; parent.add(g);
  // table sits in front of the seat (towards -z in local space)
  box(2.2, 0.08, 1.0, color, 0, 0.76, -0.75, g);
  for (const [x, z] of [[-1.0, -1.15], [1.0, -1.15], [-1.0, -0.35], [1.0, -0.35]]) box(0.07, 0.76, 0.07, '#8a6a4a', x, 0.38, z, g);
  const n = opt.monitors || 1;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.7;
    box(0.62, 0.42, 0.04, '#2b2340', x, 1.13, -1.05, g);
    const s = box(0.56, 0.36, 0.01, '#9fe3ff', x, 1.13, -1.025, g, { emissive: '#9fe3ff', emissiveIntensity: 0.5 });
    s.userData.screen = true;
    box(0.05, 0.18, 0.05, '#2b2340', x, 0.89, -1.05, g);
  }
  box(0.7, 0.03, 0.22, '#fffaf0', 0, 0.81, -0.55, g);       // keyboard
  if (opt.lamp) { cyl(0.02, 0.02, 0.5, '#2b2340', 0.85, 1.05, -0.95, g, 6); const sh = cyl(0.05, 0.16, 0.16, '#ffe08a', 0.85, 1.32, -0.95, g); sh.material = mat('#ffe08a', { emissive: '#ffe08a', emissiveIntensity: 0.6 }); }
  if (opt.stamp) { cyl(0.08, 0.08, 0.14, '#d9534f', -0.8, 0.88, -0.6, g); box(0.4, 0.02, 0.3, '#ffffff', -0.45, 0.81, -0.6, g); }
  // chair
  box(0.6, 0.08, 0.6, '#5b5277', 0, 0.5, 0.05, g);
  box(0.6, 0.6, 0.08, '#5b5277', 0, 0.82, 0.33, g);
  cyl(0.04, 0.04, 0.46, '#333', 0, 0.23, 0.05, g, 6);
  return g;
}
function bookshelf(parent, x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  box(0.6, 2.6, 1.9, '#c98f5e', 0, 1.3, 0, g);
  const cols = ['#d9534f', '#4fa3e0', '#3bb273', '#e0b43b', '#b07be0', '#ff8a5b'];
  for (let s = 0; s < 4; s++) {
    box(0.62, 0.05, 1.9, '#a8754a', 0.02, 0.3 + s * 0.6, 0, g);
    let zz = -0.8;
    while (zz < 0.8) { const w = 0.08 + Math.random() * 0.08, h = 0.35 + Math.random() * 0.15; box(0.4, h, w, cols[Math.floor(Math.random() * 6)], 0.12, 0.33 + s * 0.6 + h / 2, zz + w / 2, g); zz += w + 0.015; }
  }
}
function sofa(parent, x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  box(3.4, 0.45, 1.0, '#ff9f8f', 0, 0.3, 0, g);
  box(3.4, 0.8, 0.3, '#ff8a7a', 0, 0.75, -0.45, g);
  box(0.3, 0.65, 1.0, '#ff8a7a', -1.7, 0.55, 0, g);
  box(0.3, 0.65, 1.0, '#ff8a7a', 1.7, 0.55, 0, g);
  return g;
}
function plant(parent, x, z) {
  cyl(0.28, 0.22, 0.5, '#f2c28f', x, 0.25, z, parent);
  for (let i = 0; i < 5; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), mat(i % 2 ? '#3bb273' : '#5fcf8f')); l.position.set(x + Math.cos(i * 1.3) * 0.18, 0.75 + i * 0.12, z + Math.sin(i * 1.3) * 0.18); l.castShadow = true; parent.add(l); }
}
