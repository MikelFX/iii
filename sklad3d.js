/* 3D přehled skladu pro kancelář: připravené objednávky čekající na vydání jako palety na místech P1–P12 a Z1–Z15.
 * Nezobrazuje zásoby skladu, jen hotové objednávky. Načítá se až při otevření obrazovky (import()). */
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// ---------- Půdorys podle nákresu (metry; x doprava, z dopředu ke kanceláři) ----------
const WALL_H = 3.0, WALL_T = 0.28;
const OUTLINE = [[-3.2, -16], [9.6, -16], [9.6, -3.4], [4.6, -3.4], [4.6, 11.6], [-5, 11.6], [-5, 0.4], [-9.6, 0.4], [-9.6, -4.8], [-3.2, -4.8]];
/** Vrata (béžově v nákresu): na stěně z OUTLINE[i] → OUTLINE[i+1], od–do podél stěny. */
const DOORS = [
  { id: 'A', wall: 8, from: -9.0, to: -5.6, title: 'VRATA A', sub: 'příjem / výdej' },
  { id: 'B', wall: 5, from: 3.8, to: 7.4, title: 'VRATA B', sub: 'příjem / výdej' },
];
const OFFICE = { x0: -6, x1: 8.6, z0: 11.6, z1: 16.4 };
const PAL_W = 1.2, PAL_D = 0.8; // europaleta 1200 × 800 mm

/** Místa pro palety: přední část P1–P12 (2 řady × 6), zadní část Z1–Z15 (3 řady × 5), podél levé stěny jako v nákresu. */
export const SLOTS = (() => {
  const s = [];
  [-3.55, -2.05].forEach((x, c) => [-1.6, 0.4, 2.4, 4.4, 6.4, 8.4].forEach((z, r) => s.push({ id: 'P' + (c * 6 + r + 1), zone: 'front', x, z })));
  [-2.35, -0.85, 0.65].forEach((x, c) => [-14.6, -12.6, -10.6, -8.6, -6.6].forEach((z, r) => s.push({ id: 'Z' + (c * 5 + r + 1), zone: 'back', x, z })));
  return s;
})();

// ---------- Pomocné textury z plátna ----------
function canvasTex(w, h, draw, { repeat = null, aniso = 8 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fitText(g, text, maxW, size, weight = 800, family = 'system-ui, "Segoe UI", Roboto, sans-serif') {
  let s = size; do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > maxW && s > 10); return s + 2;
}
function concreteTex() {
  return canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#c9c6bf'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26000; i++) { const v = 150 + Math.random() * 70 | 0; g.fillStyle = `rgba(${v},${v - 3},${v - 8},${Math.random() * 0.22})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    for (let i = 0; i < 40; i++) { const r = 40 + Math.random() * 160; const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); const d = Math.random() < 0.5; gr.addColorStop(0, d ? 'rgba(90,85,78,0.07)' : 'rgba(255,255,255,0.07)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.save(); g.translate(Math.random() * w, Math.random() * h); g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2); g.restore(); }
    g.strokeStyle = 'rgba(80,76,70,0.28)'; g.lineWidth = 2; // dilatační spáry
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.stroke(); g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke(); }
  }, { repeat: [1 / 16, 1 / 16] });
}
function asphaltTex() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#8f959b'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 18000; i++) { const v = 60 + Math.random() * 70 | 0; g.fillStyle = `rgba(${v},${v},${v + 4},0.35)`; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
  }, { repeat: [1 / 8, 1 / 8] });
}
function stripeTex() { // vrata: béžová lamela
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#d6bd86'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) { g.fillStyle = 'rgba(120,90,40,0.25)'; g.fillRect(0, y, w, 2); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, y + 3, w, 2); }
  });
}
function hazardTex() {
  return canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, h); g.fillStyle = '#222';
    for (let x = -h; x < w + h; x += 32) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 16 + h, 0); g.lineTo(x + h, 0); g.closePath(); g.fill(); }
  }, { repeat: [1, 1] });
}
function floorText(text, sub, color = 'rgba(40,40,40,0.55)') {
  return canvasTex(1024, 256, (g, w, h) => {
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color;
    fitText(g, text, w - 40, sub ? 120 : 150); g.fillText(text, w / 2, sub ? h * 0.38 : h / 2);
    if (sub) { g.font = `600 58px system-ui, "Segoe UI", Roboto, sans-serif`; g.fillText(sub, w / 2, h * 0.8); }
  });
}

// ---------- Hlavní třída ----------
export function createWarehouse3D({ onPick, onHover } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'w3d-canvas';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  wrap.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const BG = new THREE.Color('#d9e1ea');
  scene.background = BG; scene.fog = new THREE.Fog(BG, 45, 110);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = 1.38; controls.minDistance = 6; controls.maxDistance = 90;
  controls.screenSpacePanning = false;
  const VIEWS = {
    all: { pos: [17, 22, 21], target: [0.2, 0, -1.5] },
    top: { pos: [0.6, 58, 2.5], target: [0.6, 0, 0] },
    front: { pos: [8, 10, 15], target: [-2.6, 0, 3.6] },
    back: { pos: [9, 11, -1], target: [-0.9, 0, -10.6] },
  };
  camera.position.set(...VIEWS.all.pos); controls.target.set(...VIEWS.all.target); controls.update();

  // Světla
  scene.add(new THREE.HemisphereLight('#f4f8ff', '#8a7a62', 1.25));
  const sun = new THREE.DirectionalLight('#fff3e2', 2.1);
  sun.position.set(18, 34, 16); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.5); fill.position.set(-20, 18, -10); scene.add(fill);

  // Okolí (asfalt)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ map: asphaltTex(), roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);
  ground.material.map.repeat.set(30, 30);

  // Podlaha haly
  const shape = new THREE.Shape(); OUTLINE.forEach(([x, z], i) => i ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
  const floorTex = concreteTex();
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.82, metalness: 0.0 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  // ShapeGeometry dává UV v metrech → textura 1/16 = jedna dlaždice 16 m
  floorTex.repeat.set(1 / 16, 1 / 16);

  // Stěny s otvory pro vrata
  const wallMat = new THREE.MeshStandardMaterial({ color: '#efebe4', roughness: 0.9 });
  const capMat = new THREE.MeshStandardMaterial({ color: '#8d99a6', roughness: 0.6, metalness: 0.2 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: '#bfe3ff', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#56616d', roughness: 0.5, metalness: 0.5 });
  function wallPiece(a, b, h = WALL_H, mat = wallMat, y0 = 0) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz); if (len < 0.01) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(len + WALL_T, h, WALL_T), mat);
    m.position.set((a[0] + b[0]) / 2, y0 + h / 2, (a[1] + b[1]) / 2); m.rotation.y = -Math.atan2(dz, dx);
    m.castShadow = mat !== glassMat; m.receiveShadow = true; scene.add(m);
    if (mat === wallMat) { const cap = new THREE.Mesh(new THREE.BoxGeometry(len + WALL_T + 0.02, 0.08, WALL_T + 0.04), capMat); cap.position.set(m.position.x, y0 + h + 0.04, m.position.z); cap.rotation.y = m.rotation.y; scene.add(cap); }
    return m;
  }
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  OUTLINE.forEach((a, i) => {
    const b = OUTLINE[(i + 1) % OUTLINE.length];
    if (i === 4) { // stěna do kanceláře: prosklená (kancelář vidí do skladu)
      wallPiece(a, b, 1.0); wallPiece(a, b, WALL_H - 1.0, glassMat, 1.0);
      const top = wallPiece(a, b, 0.12, frameMat, WALL_H - 0.12);
      for (let t = 0; t <= 1.0001; t += 1 / 8) { const p = lerp2(a, b, t); const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, WALL_H - 1, 0.1), frameMat); post.position.set(p[0], 1 + (WALL_H - 1) / 2, p[1]); scene.add(post); }
      return top;
    }
    const doors = DOORS.filter(d => d.wall === i);
    const axis = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 0 : 1; // podél x nebo z
    const pos = (p) => p[axis];
    let cuts = doors.map(d => [Math.min(d.from, d.to), Math.max(d.from, d.to)]).sort((p, q) => p[0] - q[0]);
    const lo = Math.min(pos(a), pos(b)), hi = Math.max(pos(a), pos(b));
    let cur = lo; const pt = (v) => axis === 0 ? [v, a[1]] : [a[0], v];
    for (const [f, t] of cuts) { wallPiece(pt(cur), pt(f)); wallPiece(pt(f), pt(t), WALL_H - 2.6 - 0.15, wallMat, 2.6 + 0.15); cur = t; }
    wallPiece(pt(cur), pt(hi));
  });

  // Vrata (béžová) + značení před nimi
  const gateTex = stripeTex();
  for (const d of DOORS) {
    const a = OUTLINE[d.wall], b = OUTLINE[(d.wall + 1) % OUTLINE.length];
    const horiz = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
    const mid = (d.from + d.to) / 2, w = Math.abs(d.to - d.from);
    const cx = horiz ? mid : a[0], cz = horiz ? a[1] : mid;
    // roleta vytažená nahoru (otevřená), béžový rám
    const gt = gateTex.clone(); gt.needsUpdate = true;
    const roll = new THREE.Mesh(new THREE.BoxGeometry(horiz ? w : 0.18, 0.55, horiz ? 0.18 : w), new THREE.MeshStandardMaterial({ map: gt, roughness: 0.7 }));
    roll.position.set(cx, 2.6 + 0.15 - 0.28, cz); roll.castShadow = true; scene.add(roll);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.75, 0.34), new THREE.MeshStandardMaterial({ color: '#c9a868', roughness: 0.55 }));
      post.position.set(horiz ? mid + s * w / 2 : a[0], 1.375, horiz ? a[1] : mid + s * w / 2); if (!horiz) post.rotation.y = Math.PI / 2; post.castShadow = true; scene.add(post);
    }
    // béžová zóna na podlaze uvnitř i venku + šrafování na prahu
    const zoneMat = new THREE.MeshStandardMaterial({ color: '#d8c08c', roughness: 0.8, transparent: true, opacity: 0.9 });
    const inward = d.id === 'A' ? [0, 1] : [1, 0]; // směr do haly
    for (const k of [-1, 1]) {
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(horiz ? w : 2.6, horiz ? 2.6 : w), zoneMat);
      zone.rotation.x = -Math.PI / 2; zone.position.set(cx + inward[0] * k * 1.45, 0.012, cz + inward[1] * k * 1.45); zone.receiveShadow = true; scene.add(zone);
    }
    const hz = hazardTex(); hz.repeat.set(w / 1.2, 1);
    const sill = new THREE.Mesh(new THREE.PlaneGeometry(horiz ? w : 0.3, horiz ? 0.3 : w), new THREE.MeshStandardMaterial({ map: hz, roughness: 0.6 }));
    if (!horiz) { hz.rotation = Math.PI / 2; }
    sill.rotation.x = -Math.PI / 2; sill.position.set(cx, 0.016, cz); scene.add(sill);
    // nápis venku na asfaltu
    const txt = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.05), new THREE.MeshBasicMaterial({ map: floorText(d.title, d.sub, 'rgba(255,255,255,0.92)'), transparent: true, depthWrite: false }));
    txt.rotation.x = -Math.PI / 2; if (!horiz) txt.rotation.z = Math.PI / 2;
    txt.position.set(cx - inward[0] * 4.1, 0.02, cz - inward[1] * 4.1); scene.add(txt);
    // šipky obousměrné (příjem / výdej)
    const arrowTex = canvasTex(256, 256, (g) => { g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.moveTo(128, 18); g.lineTo(210, 110); g.lineTo(158, 110); g.lineTo(158, 238); g.lineTo(98, 238); g.lineTo(98, 110); g.lineTo(46, 110); g.closePath(); g.fill(); });
    for (const k of [-1, 1]) {
      const ar = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, depthWrite: false }));
      ar.rotation.x = -Math.PI / 2;
      const dirAng = Math.atan2(inward[0], -inward[1]) * -1; // šipka ukazuje dovnitř
      ar.rotation.z = dirAng + (k > 0 ? 0 : Math.PI);
      const off = horiz ? [k * w / 4, 0] : [0, k * w / 4];
      ar.position.set(cx - inward[0] * 1.8 + off[0], 0.022, cz - inward[1] * 1.8 + off[1]); scene.add(ar);
    }
  }

  // Kancelář (zelená zóna)
  {
    const { x0, x1, z0, z1 } = OFFICE; const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const of = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: '#8fae4a', roughness: 0.9 }));
    of.rotation.x = -Math.PI / 2; of.position.set(cx, 0.005, cz); of.receiveShadow = true; scene.add(of);
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.8, d - 0.8), new THREE.MeshStandardMaterial({ color: '#a6c45e', roughness: 1 }));
    carpet.rotation.x = -Math.PI / 2; carpet.position.set(cx, 0.01, cz); carpet.receiveShadow = true; scene.add(carpet);
    const offWall = (a, b) => { wallPiece(a, b, 0.9, new THREE.MeshStandardMaterial({ color: '#e4ecd8', roughness: 0.8 })); wallPiece(a, b, 1.6, glassMat, 0.9); wallPiece(a, b, 0.1, frameMat, 2.5); };
    offWall([x0, z0], [x0, z1]); offWall([x0, z1], [x1, z1]); offWall([x1, z1], [x1, z0]);
    offWall([x0, z0], [-5, z0]); offWall([4.6, z0], [x1, z0]);
    const deskMat = new THREE.MeshStandardMaterial({ color: '#f3f1ec', roughness: 0.5 });
    const legMat = new THREE.MeshStandardMaterial({ color: '#3b434c', roughness: 0.4, metalness: 0.6 });
    const scrMat = new THREE.MeshStandardMaterial({ color: '#1d2329', roughness: 0.3, metalness: 0.3, emissive: '#2a6fd6', emissiveIntensity: 0.25 });
    const chairMat = new THREE.MeshStandardMaterial({ color: '#2f3a46', roughness: 0.7 });
    [[-3.6, 13.3], [-0.6, 13.3], [2.4, 13.3], [5.6, 13.3]].forEach(([x, z]) => {
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.85), deskMat); top.position.set(x, 0.75, z); top.castShadow = top.receiveShadow = true; scene.add(top);
      for (const sx of [-0.82, 0.82]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.75), legMat); l.position.set(x + sx, 0.375, z); scene.add(l); }
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.38, 0.03), scrMat); scr.position.set(x, 1.05, z - 0.28); scr.rotation.y = Math.PI; scr.castShadow = true; scene.add(scr);
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.25, 0.05), legMat); st.position.set(x, 0.88, z - 0.3); scene.add(st);
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), chairMat); ch.position.set(x, 0.48, z + 0.75); ch.castShadow = true; scene.add(ch);
      const bk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), chairMat); bk.position.set(x, 0.78, z + 1.0); bk.castShadow = true; scene.add(bk);
    });
    // květiny v rozích
    [[x0 + 0.6, z1 - 0.6], [x1 - 0.6, z1 - 0.6]].forEach(([x, z]) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.4, 20), new THREE.MeshStandardMaterial({ color: '#c8c2b6' })); pot.position.set(x, 0.2, z); pot.castShadow = true; scene.add(pot);
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), new THREE.MeshStandardMaterial({ color: '#3f7d3a', roughness: 0.8, flatShading: true })); leaf.position.set(x, 0.75, z); leaf.castShadow = true; scene.add(leaf);
    });
    const t = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshBasicMaterial({ map: floorText('KANCELÁŘ', null, 'rgba(40,70,20,0.55)'), transparent: true, depthWrite: false }));
    t.rotation.x = -Math.PI / 2; t.position.set(cx + 1, 0.02, z1 - 1.05); scene.add(t);
  }

  // Popisky zón na podlaze
  const zoneLabel = (text, sub, x, z, rotZ = 0, w = 7) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: floorText(text, sub), transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.rotation.z = rotZ; m.position.set(x, 0.02, z); scene.add(m); };
  zoneLabel('PŘEDNÍ ČÁST', '12 míst · P1–P12', 2.2, 4.2, Math.PI / 2, 7.5);
  zoneLabel('ZADNÍ ČÁST', '15 míst · Z1–Z15', 5.6, -10.4, Math.PI / 2, 8);

  // Místa pro palety: žluté rámečky + číslo na podlaze
  const lineMat = new THREE.MeshStandardMaterial({ color: '#f2c230', roughness: 0.6, emissive: '#5a4300', emissiveIntensity: 0.15 });
  const slotObjs = {};
  for (const s of SLOTS) {
    const g = new THREE.Group(); g.position.set(s.x, 0, s.z); scene.add(g);
    const W = PAL_W + 0.22, D = PAL_D + 0.22, t = 0.06;
    [[0, -D / 2, W, t], [0, D / 2, W, t], [-W / 2, 0, t, D], [W / 2, 0, t, D]].forEach(([x, z, w, d]) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.014, z); m.receiveShadow = true; g.add(m); });
    const glowMat = new THREE.MeshBasicMaterial({ color: '#f2c230', transparent: true, opacity: 0.0, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W, D), glowMat); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.013; g.add(glow);
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshBasicMaterial({ map: canvasTex(256, 128, (c, w, h) => { c.fillStyle = 'rgba(30,30,30,0.72)'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '800 92px system-ui, "Segoe UI", Roboto, sans-serif'; c.fillText(s.id, w / 2, h / 2 + 4); }), transparent: true, depthWrite: false }));
    num.rotation.x = -Math.PI / 2; num.position.set(0, 0.018, 0); g.add(num);
    slotObjs[s.id] = { group: g, glow, num, slot: s, pallet: null };
  }

  // ---------- Paleta s objednávkou ----------
  const woodMat = new THREE.MeshStandardMaterial({ color: '#c79a62', roughness: 0.85 });
  const woodDark = new THREE.MeshStandardMaterial({ color: '#a77c49', roughness: 0.9 });
  const boxMats = ['#c49a63', '#b98d57', '#cfa772', '#bf935c'].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.92 }));
  const tapeMat = new THREE.MeshStandardMaterial({ color: '#8a6a3c', roughness: 0.6 });
  const wrapMat = new THREE.MeshPhysicalMaterial({ color: '#e9f2ff', roughness: 0.18, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.2 });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  function buildPalletBase() {
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const blockGeo = new THREE.BoxGeometry(0.14, 0.078, 0.1);
    for (const x of [-0.53, 0, 0.53]) for (const z of [-0.33, 0, 0.33]) add(blockGeo, woodDark, x, 0.022 + 0.039, z);
    const bottomGeo = new THREE.BoxGeometry(PAL_W, 0.022, 0.1); for (const z of [-0.35, 0, 0.35]) add(bottomGeo, woodMat, 0, 0.011, z);
    const stringer = new THREE.BoxGeometry(PAL_W, 0.022, 0.1); for (const z of [-0.35, 0, 0.35]) add(stringer, woodMat, 0, 0.1 + 0.011, z);
    const deckGeo = new THREE.BoxGeometry(0.145, 0.022, PAL_D); for (let i = 0; i < 5; i++) add(deckGeo, woodMat, -0.5275 + i * 0.26375, 0.122 + 0.011, 0);
    return g;
  }
  function labelCanvas(p) {
    return canvasTex(768, 512, (g, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = '#111'; g.textBaseline = 'top';
      fitText(g, p.no, w - 220, 84); g.fillText(p.no, 26, 22);
      g.font = '700 46px system-ui, "Segoe UI", Roboto, sans-serif'; g.textAlign = 'right'; g.fillText(`${p.slot}`, w - 26, 34); g.textAlign = 'left';
      const cust = p.customer || 'bez odběratele'; fitText(g, cust, w - 52, 44, 600); g.fillText(cust, 26, 118);
      try {
        const bc = document.createElement('canvas');
        window.JsBarcode(bc, p.no, { format: 'CODE128', displayValue: false, height: 150, width: 4, margin: 0, background: '#ffffff', lineColor: '#000000' });
        const bw = Math.min(w - 52, bc.width); g.imageSmoothingEnabled = false; g.drawImage(bc, (w - bw) / 2, 186, bw, 200);
      } catch (_) {}
      g.font = '600 36px ui-monospace, Menlo, Consolas, monospace'; g.textAlign = 'center'; g.fillText(p.no, w / 2, 400);
      g.font = '500 30px system-ui, "Segoe UI", Roboto, sans-serif'; g.fillStyle = '#444'; g.fillText(`${p.flag || ''} ${p.wh || ''} · ${p.count || 0} položek${p.when ? ' · ' + p.when : ''}`.trim(), w / 2, 450);
    }, { aniso: 16 });
  }
  function tagSprite(p, hl = false) {
    const tex = canvasTex(640, 200, (g, w, h) => {
      const col = p.wh === 'SK' ? '#0b4ea2' : '#1f6feb';
      g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 18; g.shadowOffsetY = 6;
      rrect(g, 14, 10, w - 28, 140, 34); g.fillStyle = hl ? '#ffb300' : col; g.fill(); g.shadowColor = 'transparent';
      g.beginPath(); g.moveTo(w / 2 - 22, 148); g.lineTo(w / 2 + 22, 148); g.lineTo(w / 2, 186); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left';
      g.font = '800 34px system-ui, "Segoe UI", Roboto, sans-serif'; const sw = g.measureText(p.slot).width;
      rrect(g, 34, 34, sw + 28, 56, 14); g.fillStyle = 'rgba(255,255,255,0.22)'; g.fill(); g.fillStyle = '#fff'; g.fillText(p.slot, 48, 63);
      fitText(g, p.no, w - sw - 120, 56); g.fillText(p.no, 34 + sw + 50, 62);
      g.font = '600 30px system-ui, "Segoe UI", Roboto, sans-serif'; let c = p.customer || 'bez odběratele'; while (g.measureText(c).width > w - 80 && c.length > 3) c = c.slice(0, -2); if (c !== (p.customer || 'bez odběratele')) c += '…';
      g.globalAlpha = 0.92; g.fillText(c, 36, 118); g.globalAlpha = 1;
    });
    return new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  }
  const pickables = [];
  function makePallet(p) {
    const g = new THREE.Group(); g.userData.orderId = p.id;
    g.add(buildPalletBase());
    // náklad: kartony, výška podle počtu položek (1–4 vrstvy)
    const layers = Math.max(1, Math.min(4, Math.ceil((p.count || 1) / 2)));
    const bw = PAL_W / 3, bd = PAL_D / 2, bh = 0.28; let seed = [...p.id].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const load = new THREE.Group(); g.add(load);
    for (let l = 0; l < layers; l++) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      if (l === layers - 1 && layers > 1 && rnd() < 0.18) continue; // horní vrstva občas neúplná
      const b = new THREE.Mesh(boxGeo, boxMats[(rnd() * boxMats.length) | 0]);
      b.scale.set(bw - 0.02, bh - 0.01, bd - 0.02); b.position.set(-PAL_W / 2 + bw * (i + 0.5), 0.144 + bh * (l + 0.5), -PAL_D / 2 + bd * (j + 0.5));
      b.castShadow = b.receiveShadow = true; load.add(b);
      const tape = new THREE.Mesh(boxGeo, tapeMat); tape.scale.set(0.06, 0.004, bd - 0.018); tape.position.set(b.position.x, b.position.y + bh / 2 - 0.004, b.position.z); load.add(tape);
    }
    const H = 0.144 + bh * layers;
    const wrapM = new THREE.Mesh(boxGeo, wrapMat); wrapM.scale.set(PAL_W + 0.02, H - 0.13, PAL_D + 0.02); wrapM.position.y = 0.144 + (H - 0.144) / 2 + 0.005; wrapM.renderOrder = 2; g.add(wrapM);
    // štítek s kódem objednávky na čelní (+z) a boční (+x) straně
    const lblMat = new THREE.MeshStandardMaterial({ map: labelCanvas(p), roughness: 0.55 });
    const lh = Math.min(0.42, H - 0.2), lw = lh * 1.5;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(lw, lh), lblMat); front.userData.ownMat = true; front.position.set(0, 0.144 + (H - 0.144) / 2, PAL_D / 2 + 0.016); g.add(front);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(lw * 0.85, lh * 0.85), lblMat); side.position.set(PAL_W / 2 + 0.016, 0.144 + (H - 0.144) / 2, 0); side.rotation.y = Math.PI / 2; g.add(side);
    // klikací obal
    const hit = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ visible: false })); hit.scale.set(PAL_W + 0.1, H + 0.1, PAL_D + 0.1); hit.position.y = H / 2; hit.userData.orderId = p.id; g.add(hit); pickables.push(hit);
    const tag = new THREE.Sprite(tagSprite(p)); tag.renderOrder = 10; tag.center.set(0.5, 0.0); tag.userData.ownMat = true; tag.position.y = H + 0.12; g.add(tag);
    const tagHl = tagSprite(p, true);
    g.userData = { orderId: p.id, H, tag, tagN: tag.material, tagHl, hit, data: p, born: performance.now(), anim: 'in' };
    return g;
  }

  // ---------- Synchronizace s objednávkami ----------
  const pallets = new Map(); // orderId → group
  function key(p) { return [p.slot, p.no, p.customer, p.count, p.wh].join('|'); }
  function setPallets(list) {
    const seen = new Set();
    for (const p of list) {
      const so = slotObjs[p.slot]; if (!so) continue;
      seen.add(p.id);
      const ex = pallets.get(p.id);
      if (ex && ex.userData.key === key(p)) continue;
      if (ex) removePallet(p.id, true);
      const g = makePallet(p); g.userData.key = key(p);
      g.position.copy(so.group.position); if (p.instant) { g.userData.anim = null; } else g.position.y = 4;
      scene.add(g); pallets.set(p.id, g); so.pallet = g;
    }
    for (const id of [...pallets.keys()]) if (!seen.has(id)) removePallet(id);
    for (const s of Object.values(slotObjs)) if (s.pallet && !pallets.has(s.pallet.userData.orderId)) s.pallet = null;
  }
  function removePallet(id, now = false) {
    const g = pallets.get(id); if (!g) return; pallets.delete(id);
    const i = pickables.indexOf(g.userData.hit); if (i >= 0) pickables.splice(i, 1);
    for (const s of Object.values(slotObjs)) if (s.pallet === g) s.pallet = null;
    if (now) { disposeGroup(g); return; }
    g.userData.anim = 'out'; g.userData.born = performance.now();
  }
  function disposeGroup(g) {
    scene.remove(g);
    g.traverse(o => {
      if (o.userData.ownMat && o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      if (o.userData.tagHl) { o.userData.tagHl.map.dispose(); o.userData.tagHl.dispose(); o.userData.tagN.map.dispose(); o.userData.tagN.dispose(); }
      if (o.geometry && o.geometry !== boxGeo) o.geometry.dispose();
    });
  }


  // ---------- Výběr myší ----------
  const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2(); let hovered = null, selected = null, downAt = null;
  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.orderId : null;
  }
  function setHover(id, ev) {
    if (id === hovered) { if (onHover) onHover(id, ev); return; }
    hovered = id; renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    if (onHover) onHover(id, ev);
  }
  renderer.domElement.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') setHover(pickAt(ev), ev); });
  renderer.domElement.addEventListener('pointerleave', () => setHover(null));
  renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
    const id = pickAt(ev); select(id); if (onPick) onPick(id);
  });
  function select(id) {
    selected = id;
    for (const s of Object.values(slotObjs)) s.glow.material.opacity = s.pallet && s.pallet.userData.orderId === id ? 0.55 : 0;
  }

  // ---------- Kamera: plynulý přelet ----------
  let fly = null;
  /** Na úzké (mobilní) obrazovce kameru oddálit, aby se sklad vešel. */
  function viewPos(v) {
    const t = new THREE.Vector3(...v.target), p = new THREE.Vector3(...v.pos);
    const f = camera.aspect < 1.25 ? Math.min(2.4, 1.3 / camera.aspect) : 1;
    return { p: t.clone().add(p.sub(t).multiplyScalar(f)), t };
  }
  function view(name, instant = false) {
    const v = VIEWS[name]; if (!v) return; const { p, t } = viewPos(v);
    if (instant) { camera.position.copy(p); controls.target.copy(t); controls.update(); fly = null; return; }
    fly = { t0: performance.now(), dur: 900, p0: camera.position.clone(), t0v: controls.target.clone(), p1: p, t1: t };
  }
  function focusOrder(id) {
    const g = pallets.get(id); if (!g) return;
    select(id);
    const t = g.position.clone(); t.y = 0.6;
    fly = { t0: performance.now(), dur: 900, p0: camera.position.clone(), t0v: controls.target.clone(), p1: t.clone().add(new THREE.Vector3(6.5, 7, 8)), t1: t };
  }

  // ---------- Smyčka ----------
  let running = false, raf = 0;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const bounce = (t) => { const n1 = 7.5625, d1 = 2.75; if (t < 1 / d1) return n1 * t * t; if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75; if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375; return n1 * (t -= 2.625 / d1) * t + 0.984375; };
  function frame(now) {
    if (!running) return;
    if (!wrap.isConnected) { running = false; return; }
    raf = requestAnimationFrame(frame);
    if (fly) { const k = Math.min(1, (now - fly.t0) / fly.dur), e = ease(k); camera.position.lerpVectors(fly.p0, fly.p1, e); controls.target.lerpVectors(fly.t0v, fly.t1, e); if (k >= 1) fly = null; }
    controls.update();
    for (const [, g] of pallets) {
      const u = g.userData; if (u.anim !== 'in') continue;
      const k = Math.min(1, (now - u.born) / 900); g.position.y = 4 * (1 - bounce(k)); if (k >= 1) { u.anim = null; g.position.y = 0; }
    }
    for (const g of [...scene.children]) {
      const u = g.userData; if (u && u.anim === 'out') {
        const k = Math.min(1, (now - u.born) / 650); g.position.y = ease(k) * 3; g.scale.setScalar(1 - 0.6 * k);
        if (k >= 1) disposeGroup(g);
      }
    }
    // jemné pulzování štítku vybrané palety
    // štítky nad paletami: na dálku čitelné, zblízka nepřerostou
    for (const [id, g] of pallets) {
      const u = g.userData, s = u.tag, sel = id === selected;
      const want = sel ? u.tagHl : u.tagN; if (s.material !== want) s.material = want;
      const d = camera.position.distanceTo(g.position);
      const ws = Math.min(3.2, Math.max(1.05, d * 0.085)) * (sel || id === hovered ? 1.15 : 1) * (sel ? 1 + Math.sin(now / 260) * 0.03 : 1);
      s.scale.set(ws, ws * 0.3125, 1);
    }
    renderer.render(scene, camera);
  }
  let placed = false;
  function start() { if (running) return; running = true; resize(); if (!placed && wrap.clientWidth) { placed = true; view('all', true); } raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function resize() {
    const w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
  }
  const ro = new ResizeObserver(() => resize()); ro.observe(wrap);

  function snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); }

  return { el: wrap, setPallets, start, stop, resize, view, focusOrder, select, snapshot };
}
