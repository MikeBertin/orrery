// textures.js — procedural planet/moon/ring/sun textures.
//
// No image assets: every surface is generated in-canvas from 3D value noise
// sampled on the sphere (so there are no polar pinches or seams), then mapped
// onto the body. "Roughly what they look like", fully offline.
import * as THREE from "three";

// ---- 3D value noise --------------------------------------------------------
function hash(i, j, k) {
  let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  const x00 = L(hash(i, j, k), hash(i + 1, j, k), ux);
  const x10 = L(hash(i, j + 1, k), hash(i + 1, j + 1, k), ux);
  const x01 = L(hash(i, j, k + 1), hash(i + 1, j, k + 1), ux);
  const x11 = L(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), ux);
  return L(L(x00, x10, uy), L(x01, x11, uy), uz);
}
function fbm(x, y, z, oct = 5) {
  let a = 0, amp = 0.5, f = 1, tot = 0;
  for (let o = 0; o < oct; o++) { a += amp * vnoise(x * f, y * f, z * f); tot += amp; f *= 2; amp *= 0.5; }
  return a / tot;
}

// ---- colour helpers --------------------------------------------------------
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function ramp(stops, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      return mix(a[1], b[1], (t - a[0]) / (b[0] - a[0] || 1));
    }
  return stops[stops.length - 1][1];
}

// paint an equirectangular texture; fn(u,v,dx,dy,dz) -> [r,g,b] (0..255)
function paint(w, h, fn) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d"), img = ctx.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const v = y / h, lat = (v - 0.5) * Math.PI, cl = Math.cos(lat), sy = Math.sin(lat);
    for (let x = 0; x < w; x++) {
      const u = x / w, lon = u * 2 * Math.PI;
      const col = fn(u, v, cl * Math.cos(lon), sy, cl * Math.sin(lon));
      const p = (y * w + x) * 4;
      d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- terrestrial -----------------------------------------------------------
export function earthTexture() {
  const sea = [[0, [6, 26, 60]], [1, [26, 78, 130]]];
  const land = [[0, [40, 82, 46]], [0.45, [70, 104, 52]], [0.75, [130, 116, 74]], [1, [180, 170, 150]]];
  return paint(512, 256, (u, v, x, y, z) => {
    const lat = Math.abs(v - 0.5) * 2;
    const e = fbm(x * 2.1 + 3, y * 2.1 + 3, z * 2.1 + 3, 6);
    if (lat > 0.84 + 0.05 * fbm(x * 5, y * 5, z * 5, 3)) return [238, 242, 246];   // ice caps
    if (e < 0.55) return ramp(sea, e / 0.55);
    return ramp(land, (e - 0.55) / 0.45);
  });
}
export function marsTexture() {
  const pal = [[0, [96, 40, 24]], [0.4, [150, 66, 38]], [0.7, [188, 108, 68]], [1, [212, 150, 110]]];
  return paint(512, 256, (u, v, x, y, z) => {
    const lat = Math.abs(v - 0.5) * 2;
    const e = fbm(x * 2.6, y * 2.6, z * 2.6, 6);
    let col = ramp(pal, e * 0.7 + 0.18);
    if (fbm(x * 1.3 + 9, y * 1.3 + 9, z * 1.3 + 9, 4) < 0.45) col = mix(col, [86, 42, 30], 0.45); // dark albedo
    if (lat > 0.9) col = mix(col, [236, 228, 232], (lat - 0.9) / 0.1);                            // polar caps
    return col;
  });
}
// generic rocky / cloudy body: mottled tint (Mercury, Venus, moons)
export function mottledTexture(rgb, { contrast = 0.35, freq = 3.2, crater = 0 } = {}) {
  return paint(256, 128, (u, v, x, y, z) => {
    const n = fbm(x * freq, y * freq, z * freq, 5);
    let f = 1 + (n - 0.5) * contrast * 2;
    if (crater) { const c = fbm(x * 9 + 2, y * 9 + 2, z * 9 + 2, 3); if (c < crater) f *= 0.7; }
    return [rgb[0] * f, rgb[1] * f, rgb[2] * f];
  });
}

// ---- gas / ice giants: latitude bands with turbulent flow ------------------
function banded(colors, { bands = 14, spot = null, warp = 4 } = {}) {
  return paint(512, 256, (u, v, x, y, z) => {
    const lat = v - 0.5;
    const flow = fbm(x * 5, y * 2.4, z * 5, 4) - 0.5;              // wavy, mostly horizontal
    const s = Math.sin(lat * bands * Math.PI + flow * warp) * 0.5 + 0.5;
    const idx = s * (colors.length - 1), i0 = Math.floor(idx);
    let col = mix(colors[i0], colors[Math.min(i0 + 1, colors.length - 1)], idx - i0);
    const pl = Math.abs(lat) * 2;
    if (pl > 0.72) col = mix(col, mix(col, [70, 70, 70], 0.5), (pl - 0.72) / 0.28);   // pole darkening
    if (spot) {                                                    // an oval storm
      const dl = (u - spot.u) * (u - spot.u) / spot.ru, dv = (v - spot.v) * (v - spot.v) / spot.rv;
      const dd = dl + dv;
      if (dd < 1) col = mix(col, spot.c, (1 - dd) * 0.9);
    }
    return col;
  });
}
export const jupiterTexture = () => banded(
  [[90, 62, 44], [178, 140, 96], [232, 210, 168], [150, 108, 74], [214, 182, 138], [120, 84, 60]],
  { bands: 20, warp: 5, spot: { u: 0.55, v: 0.63, ru: 0.02, rv: 0.004, c: [178, 74, 52] } });
export const saturnTexture = () => banded(
  [[150, 118, 74], [204, 178, 128], [232, 214, 170], [186, 158, 112], [220, 198, 150]],
  { bands: 16, warp: 3.5 });
export const uranusTexture = () => banded(
  [[150, 208, 210], [176, 224, 224], [196, 234, 232]], { bands: 8, warp: 2 });
export const neptuneTexture = () => banded(
  [[34, 66, 138], [52, 100, 176], [96, 146, 208], [40, 78, 150]],
  { bands: 10, warp: 3, spot: { u: 0.4, v: 0.4, ru: 0.014, rv: 0.005, c: [18, 34, 78] } });

export const mercuryTexture = () => mottledTexture([120, 112, 104], { contrast: 0.4, crater: 0.4 });
export const venusTexture   = () => mottledTexture([214, 188, 130], { contrast: 0.18, freq: 2.2 });

// ---- Saturn's rings: a 1-D radial band pattern with the Cassini gap --------
export function ringTexture() {
  const w = 512, c = document.createElement("canvas"); c.width = w; c.height = 1;
  const ctx = c.getContext("2d"), img = ctx.createImageData(w, 1), d = img.data;
  for (let x = 0; x < w; x++) {
    const t = x / w;                                    // 0 inner … 1 outer
    let alpha = 210 * (0.55 + 0.45 * Math.sin(t * 90));
    if (Math.abs(t - 0.55) < 0.03) alpha = 12;          // Cassini division
    if (t < 0.04 || t > 0.97) alpha *= 0.25;            // soft edges
    const col = mix([200, 184, 148], [150, 138, 116], t);
    const p = x * 4; d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- generic rock sprite (asteroids / NEOs / comets) -----------------------
// A small grayscale sprite: lumpy silhouette (alpha) + Lambert shading on a
// fake sphere normal + speckle, so the point clouds read as little shaded
// rocks instead of square blocks. Grayscale so each layer's colour tints it.
export function rockSprite() {
  const S = 64, c = document.createElement("canvas"); c.width = c.height = S;
  const ctx = c.getContext("2d"), img = ctx.createImageData(S, S), d = img.data;
  const cx = (S - 1) / 2, cy = (S - 1) / 2, R = S / 2 - 1;
  const lx = -0.55, ly = -0.55, lz = 0.63;         // light from upper-left, toward viewer
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - cx) / R, dy = (y - cy) / R, dist = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
    const lump = 0.80 + 0.17 * fbm(Math.cos(ang) * 1.7 + 5, Math.sin(ang) * 1.7 + 5, 0, 4);
    const p = (y * S + x) * 4;
    if (dist > lump) { d[p + 3] = 0; continue; }    // outside the rock
    const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, dist * dist)));
    const diff = Math.max(0, dx * lx + dy * ly + nz * lz);
    let v = (0.30 + 0.70 * diff) * (0.78 + 0.34 * fbm(dx * 4 + 11, dy * 4 + 11, 0.5, 3));
    v = Math.max(0, Math.min(1, v));
    const g = Math.round(v * 255);
    d[p] = g; d[p + 1] = g; d[p + 2] = g; d[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- generic satellite icon (spacecraft markers) ---------------------------
// A little satellite silhouette — central bus + two solar-panel wings + dish —
// drawn grayscale on transparent so each mission's colour tints it.
export function satelliteSprite() {
  const S = 64, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d"), m = S / 2;
  x.clearRect(0, 0, S, S);
  // struts
  x.strokeStyle = "rgba(190,190,190,0.9)"; x.lineWidth = 2;
  x.beginPath(); x.moveTo(14, m); x.lineTo(50, m); x.stroke();
  // two solar-panel wings
  const wing = (x0) => {
    x.fillStyle = "rgba(150,150,150,0.95)"; x.fillRect(x0, m - 9, 16, 18);
    x.strokeStyle = "rgba(55,55,55,0.9)"; x.lineWidth = 1;
    for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(x0 + i * 4, m - 9); x.lineTo(x0 + i * 4, m + 9); x.stroke(); }
    x.beginPath(); x.moveTo(x0, m); x.lineTo(x0 + 16, m); x.stroke();
    x.strokeStyle = "rgba(225,225,225,0.9)"; x.lineWidth = 1.2; x.strokeRect(x0, m - 9, 16, 18);
  };
  wing(2); wing(46);
  // central bus
  x.fillStyle = "rgba(242,242,242,1)"; x.fillRect(m - 7, m - 11, 14, 22);
  x.strokeStyle = "rgba(85,85,85,0.9)"; x.lineWidth = 1.5; x.strokeRect(m - 7, m - 11, 14, 22);
  // dish antenna
  x.strokeStyle = "rgba(150,150,150,0.9)"; x.beginPath(); x.moveTo(m, m - 11); x.lineTo(m, m - 17); x.stroke();
  x.fillStyle = "rgba(255,255,255,0.95)"; x.beginPath(); x.arc(m, m - 18, 5, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- Sun: granulated emissive surface --------------------------------------
export function sunTexture() {
  return paint(256, 128, (u, v, x, y, z) => {
    const t = fbm(x * 6, y * 6, z * 6, 5) * 0.7 + fbm(x * 18, y * 18, z * 18, 3) * 0.3;
    return ramp([[0, [200, 92, 24]], [0.5, [246, 162, 44]], [0.85, [255, 220, 120]], [1, [255, 250, 224]]], t);
  });
}
