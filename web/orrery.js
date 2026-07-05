// orrery.js — the 3D solar-system renderer and time engine (M1).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { PLANETS, planetPosition, orbitSamples, centuriesSinceJ2000, julianDate,
         DWARFS, smallBodyPosition, smallBodyOrbit,
         INTERSTELLAR, interstellarPosition, interstellarPath } from "./ephem.js?v=m10";
import * as TEX from "./textures.js?v=m9";

// per-planet surface texture + axial tilt (deg) + sidereal rotation (days;
// negative = retrograde). Drives the 3D look and the daily spin.
const LOOKS = {
  mercury: { tex: TEX.mercuryTexture, tilt: 0.03, rot: 58.6 },
  venus:   { tex: TEX.venusTexture,   tilt: 177.4, rot: -243 },
  earth:   { tex: TEX.earthTexture,   tilt: 23.44, rot: 0.997 },
  mars:    { tex: TEX.marsTexture,    tilt: 25.19, rot: 1.026 },
  jupiter: { tex: TEX.jupiterTexture, tilt: 3.13, rot: 0.414 },
  saturn:  { tex: TEX.saturnTexture,  tilt: 26.73, rot: 0.444 },
  uranus:  { tex: TEX.uranusTexture,  tilt: 97.77, rot: -0.718 },
  neptune: { tex: TEX.neptuneTexture, tilt: 28.32, rot: 0.671 },
};
const YAXIS = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
const SPIN = new THREE.Quaternion();

// ---- display scaling -------------------------------------------------------
// Real distances span 0.39 AU (Mercury) to 30 AU (Neptune); planet radii span
// 2400 km to 70000 km. Nothing is to scale or the inner system is one pixel.
// We map AU -> scene units, with a log toggle that compresses radial distance
// so the inner planets stay visible next to the gas giants.
const AU = 40;                       // scene units per AU (linear mode)
let logScale = false;

function mapRadius(rAU) {
  if (!logScale) return rAU * AU;
  return Math.log10(rAU + 1) * AU * 4.2;   // compress; keeps ordering + spread
}
const smallLayers = [];      // asteroid / NEO / comet point clouds
const smallByName = {};
let smallDirty = true;       // force a small-body recompute next frame
// turn a heliocentric AU vector into a scene-space Vector3 (Y-up, ecliptic->XZ)
function toScene(p) {
  const rAU = Math.hypot(p.x, p.y, p.z) || 1e-9;
  const s = mapRadius(rAU) / rAU;
  return new THREE.Vector3(p.x * s, p.z * s, -p.y * s);
}

// planet visual sizes — sqrt of true radius, clamped, so Jupiter reads bigger
// than Mercury without dwarfing the scene.
function bodySize(planet) {
  return THREE.MathUtils.clamp(Math.sqrt(planet.radius) * 0.7, 0.7, 4.2) * sizeBoost;
}
let sizeBoost = 1;

// ---- scene -----------------------------------------------------------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100000);
camera.position.set(0, 380, 620);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Stay well inside the sky sphere (SKY_R=32000) — zooming past the Milky Way
// band breaks the illusion. Linear mode still fits Voyager 1 (~170 AU ≈ 6800
// units) with margin; log mode compresses everything (Oort shell ≈ 790) so it
// gets a much tighter leash. Kept in sync by the log toggle.
const MAX_DIST = { linear: 14000, log: 2600 };
controls.maxDistance = MAX_DIST.linear;

scene.add(new THREE.AmbientLight(0xffffff, 0.26));   // gentle fill so night sides stay legible
const sunLight = new THREE.PointLight(0xfff2d6, 3, 0, 0.0);
scene.add(sunLight);

// starfield
(function stars() {
  const g = new THREE.BufferGeometry();
  const n = 4000, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 18000 + Math.random() * 20000;
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    arr[i*3] = r*Math.sin(ph)*Math.cos(th);
    arr[i*3+1] = r*Math.cos(ph);
    arr[i*3+2] = r*Math.sin(ph)*Math.sin(th);
  }
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x99aacc, size: 18, sizeAttenuation: true, transparent: true, opacity: 0.7 })));
})();

// Sun
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(7, 48, 48),
  new THREE.MeshBasicMaterial({ map: TEX.sunTexture() })
);
scene.add(sun);
sun.add(new THREE.PointLight(0xffd76b, 1.2, 0, 0));
const corona = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTexture(), color: 0xffdf9a, transparent: true, opacity: 0.55,
  depthWrite: false, blending: THREE.AdditiveBlending }));
corona.scale.setScalar(34); sun.add(corona);

// ---- galactic frame --------------------------------------------------------
// "North" for the solar system is the ECLIPTIC north pole — the axis normal to
// Earth's orbital plane — which in this scene is +Y. The Milky Way, however,
// is tilted ~60° to the ecliptic, with its centre toward Sagittarius. To place
// it correctly we build the galaxy in galactic coordinates and rotate it
// through the real galactic → equatorial → ecliptic → scene chain.
const OBLIQUITY = 23.4393 * Math.PI / 180;          // ecliptic ↔ equatorial tilt
// galactic → equatorial rotation (columns = galactic basis in equatorial frame,
// J2000): col0 = galactic centre (l=0), col2 = north galactic pole.
const GAL2EQ = [
  [-0.054876,  0.494109, -0.867666],
  [-0.873437, -0.444830, -0.198076],
  [-0.483835,  0.746982,  0.455984],
];
function galacticToScene() {
  const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
  const cols = [];
  for (let i = 0; i < 3; i++) {
    const eqx = GAL2EQ[0][i], eqy = GAL2EQ[1][i], eqz = GAL2EQ[2][i];
    const ecx = eqx, ecy = eqy * ce + eqz * se, ecz = -eqy * se + eqz * ce; // eq→ecl
    cols.push(new THREE.Vector3(ecx, ecz, -ecy));                            // ecl→scene
  }
  const m = new THREE.Matrix4();
  m.set(cols[0].x, cols[1].x, cols[2].x, 0,
        cols[0].y, cols[1].y, cols[2].y, 0,
        cols[0].z, cols[1].z, cols[2].z, 0,
        0, 0, 0, 1);
  // col1 = galactic l=90° direction — the way the Sun travels around the Galaxy
  // (galactic rotation, ~230 km/s toward Cygnus).
  return {
    matrix: m,
    gcDir: cols[0].clone().normalize(),
    gnDir: cols[2].clone().normalize(),
    orbitDir: cols[1].clone().normalize(),
  };
}
const GAL = galacticToScene();
const SKY_R = 32000;

function randn() { // standard normal via Box–Muller
  let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,235,190,1)");
  g.addColorStop(0.3, "rgba(255,220,150,0.45)");
  g.addColorStop(1, "rgba(255,220,150,0)");
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Milky Way: stars concentrated near the galactic plane (b≈0), brighter toward
// the galactic centre (l≈0), built in the galactic frame then rotated to scene.
const galaxy = new THREE.Group();
galaxy.quaternion.setFromRotationMatrix(GAL.matrix);
scene.add(galaxy);
(function milkyWay() {
  const P = [], C = [];
  const place = (l, b, br) => {
    const cb = Math.cos(b);
    P.push(cb * Math.cos(l) * SKY_R, cb * Math.sin(l) * SKY_R, Math.sin(b) * SKY_R);
    br = Math.min(1, br);
    C.push(0.78 * br + 0.03, 0.72 * br + 0.025, 0.6 * br + 0.06);
  };

  // Disk band — longitude sampled (by rejection) so star DENSITY, not just
  // brightness, falls off from the galactic centre (l≈0) toward the
  // anticentre, and the band fattens & brightens toward the centre.
  let n = 0;
  while (n < 12000) {
    const l = Math.random() * Math.PI * 2;
    const centre = (1 + Math.cos(l)) / 2;                 // 1 at centre, 0 opposite
    if (Math.random() > 0.08 + 0.92 * centre * centre) continue;
    const sig = 0.045 + 0.11 * Math.pow(centre, 1.5);     // thin arms, fat toward centre
    const b = randn() * sig;
    const br = (0.28 + 0.72 * centre) * Math.exp(-(b * b) / (2 * sig * sig)) * (0.55 + Math.random() * 0.7);
    place(l, b, br); n++;
  }

  // Central bulge — a dense, fat concentration of stars at the centre.
  for (let i = 0; i < 7000; i++) {
    const l = randn() * 0.28, b = randn() * 0.17;
    const d = Math.exp(-(l * l) / (2 * 0.28 * 0.28) - (b * b) / (2 * 0.17 * 0.17));
    place(l, b, 0.32 + 0.4 * d * (0.7 + Math.random() * 0.6));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(C), 3));
  galaxy.add(new THREE.Points(g, new THREE.PointsMaterial({
    size: 1.8, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending,
  })));

  // Soft glow toward the galactic centre — kept subtle so it never washes out
  // the orbits/planets when it sits directly behind the inner system.
  const glow = glowTexture();
  for (const [s, o] of [[15000, 0.14], [7000, 0.16]]) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: 0xd8c094, transparent: true, opacity: o,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    spr.position.set(SKY_R, 0, 0);   // galactic centre direction (galaxy-local)
    spr.scale.setScalar(s);
    galaxy.add(spr);
  }
})();

// ---- direction arrows (from the Sun) + Galactic-Centre marker -------------
// Ecliptic N, Galactic N and the Sun's galactic-orbit heading are short arrows
// out of the Sun — local direction indicators. The Galactic Centre is a real
// place, pinned to the background sphere at "infinity" so it doesn't parallax.
function makeArrow(color) {
  const g = new THREE.Group(); scene.add(g);
  const line = new THREE.Line(new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 }));
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 14), new THREE.MeshBasicMaterial({ color }));
  g.add(line, cone);
  return { g, line, cone };
}
function setArrow(a, dir, L) {
  const tip = dir.clone().multiplyScalar(L);
  a.line.geometry.setFromPoints([new THREE.Vector3(), tip]);
  a.cone.position.copy(tip);
  a.cone.scale.setScalar(Math.max(1.5, L * 0.03));
  a.cone.quaternion.setFromUnitVectors(YAXIS, dir);
}
const eclArrow = makeArrow(0x7cc4ff);    // Ecliptic N  (solar-system north)
const gnArrow = makeArrow(0xffc266);     // Galactic N
const apexArrow = makeArrow(0x74e0a8);   // Sun's motion (toward l≈90°)

function makeMarker(text, cls) {
  const el = document.createElement("div");
  el.className = "label axis" + (cls ? " " + cls : "");
  el.textContent = text;
  document.getElementById("labels").appendChild(el);
  return el;
}
const markerEls = {
  north: makeMarker("Ecliptic N"),
  gc: makeMarker("Galactic Center", "gc"),
  gn: makeMarker("Galactic N", "gc"),
  sun: makeMarker("Sun's motion → ~230 km/s", "sun"),
};
const markerWorld = { north: new THREE.Vector3(), gc: new THREE.Vector3(), gn: new THREE.Vector3(), sun: new THREE.Vector3() };
const markerGroup = { north: eclArrow.g, gc: galaxy, gn: gnArrow.g, sun: apexArrow.g };

function updateNorthAxis(L) {
  const Ld = L * 0.5;   // shorter than the planetary system
  setArrow(eclArrow, YAXIS, Ld);
  setArrow(gnArrow, GAL.gnDir, Ld);
  setArrow(apexArrow, GAL.orbitDir, Ld);
  markerWorld.north.set(0, Ld * 1.07, 0);
  markerWorld.gn.copy(GAL.gnDir).multiplyScalar(Ld * 1.07);
  markerWorld.sun.copy(GAL.orbitDir).multiplyScalar(Ld * 1.07);
  // Galactic Centre = an actual place → pin to the background sphere.
  markerWorld.gc.copy(GAL.gcDir).multiplyScalar(SKY_R);
}

// ---- bodies (planets + dwarf planets) -------------------------------------
const DEG = Math.PI / 180;
const bodies = [];   // unified: { key, spec, kind, mesh, orbit, label, name, posAt, orbitPts, infoHTML, hidden }
const labelLayer = document.getElementById("labels");

// click-card facts. Masses in Earth masses; radii are equatorial; day lengths
// sidereal. Moon counts are the known tallies (they creep up — treat as ~).
const FACTS = {
  mercury: { mass: "0.055 M⊕", radius: "2,440 km", volume: "0.056 × Earth", day: "58.6 d", year: "88 d", moons: "0" },
  venus:   { mass: "0.815 M⊕", radius: "6,052 km", volume: "0.86 × Earth", day: "243 d (retrograde)", year: "225 d", moons: "0" },
  earth:   { mass: "5.97×10²⁴ kg", radius: "6,371 km", volume: "1.08×10¹² km³", day: "23.9 h", year: "365.25 d", moons: "1" },
  mars:    { mass: "0.107 M⊕", radius: "3,390 km", volume: "0.151 × Earth", day: "24.6 h", year: "687 d", moons: "2" },
  jupiter: { mass: "318 M⊕", radius: "69,911 km", volume: "1,321 × Earth", day: "9.9 h", year: "11.9 yr", moons: "97" },
  saturn:  { mass: "95 M⊕", radius: "58,232 km", volume: "764 × Earth", day: "10.7 h", year: "29.4 yr", moons: "274" },
  uranus:  { mass: "14.5 M⊕", radius: "25,362 km", volume: "63 × Earth", day: "17.2 h (retrograde)", year: "84 yr", moons: "29" },
  neptune: { mass: "17.1 M⊕", radius: "24,622 km", volume: "58 × Earth", day: "16.1 h", year: "165 yr", moons: "16" },
  ceres:    { mass: "9.4×10²⁰ kg", discovered: "1801 (G. Piazzi)", radius: "470 km", note: "largest object in the asteroid belt" },
  pluto:    { mass: "1.3×10²² kg", discovered: "1930 (C. Tombaugh)", radius: "1,188 km", note: "5 moons; visited by New Horizons 2015" },
  haumea:   { mass: "4.0×10²¹ kg", discovered: "2004", radius: "~816 km", note: "egg-shaped — spins in under 4 hours" },
  makemake: { mass: "~3.1×10²¹ kg", discovered: "2005", radius: "~715 km", note: "bright Kuiper-belt world" },
  eris:     { mass: "1.7×10²² kg", discovered: "2005 (M. Brown)", radius: "1,163 km", note: "more massive than Pluto — sparked its demotion" },
};
function factRows(key) {
  const f = FACTS[key];
  if (!f) return "";
  const order = { mass: "Mass", radius: "Radius", volume: "Volume", day: "Day length",
                  year: "Year", moons: "Moons", discovered: "Discovered", note: "Known for" };
  return Object.entries(order)
    .filter(([k]) => f[k])
    .map(([k, lbl]) => `<div><span>${lbl}</span><b>${f[k]}</b></div>`)
    .join("");
}

function makeBody(key, spec, kind, posAt, orbitPts) {
  const look = LOOKS[key];
  const mat = look
    ? new THREE.MeshStandardMaterial({ map: look.tex(), roughness: 1, metalness: 0 })
    : new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, look ? 48 : 24, look ? 32 : 24), mat);
  mesh.scale.setScalar(bodySize(spec) * (kind === "dwarf" ? 0.8 : 1));
  // axial tilt (fixed) — the daily spin is layered on each frame in updatePositions
  const tiltQ = new THREE.Quaternion().setFromAxisAngle(XAXIS, (look ? look.tilt : 0) * Math.PI / 180);
  mesh.quaternion.copy(tiltQ);
  scene.add(mesh);

  if (spec.ring) {
    const geo = new THREE.RingGeometry(1.35, 2.6, 96);
    const pos = geo.attributes.position, uv = geo.attributes.uv;   // remap UVs to radial
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - 1.35) / (2.6 - 1.35), 0.5);
    }
    uv.needsUpdate = true;
    const ring = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ map: TEX.ringTexture(), side: THREE.DoubleSide, transparent: true, depthWrite: false }));
    ring.rotation.x = Math.PI / 2;                                  // lie in the planet's equatorial plane
    mesh.add(ring);
  }

  const orbitMat = new LineMaterial({
    color: spec.color, linewidth: kind === "dwarf" ? 1.2 : 1.8,
    transparent: true, opacity: kind === "dwarf" ? 0.4 : 0.7, dashed: false,
  });
  orbitMat.resolution.set(innerWidth, innerHeight);
  const orbit = new Line2(new LineGeometry(), orbitMat);
  scene.add(orbit);

  const label = document.createElement("div");
  label.className = "label" + (kind === "dwarf" ? " dwarf" : "");
  label.textContent = spec.name;
  labelLayer.appendChild(label);

  const b = {
    key, spec, kind, mesh, orbit, label, name: spec.name, posAt, orbitPts, hidden: false,
    tiltQ, rotDays: look ? look.rot : 0,
    infoHTML: (date) => {
      const p = posAt(date), r = Math.hypot(p.x, p.y, p.z);
      return (kind === "dwarf" ? `<div><span>Type</span><b>Dwarf planet</b></div>` : "") +
        `<div><span>Distance from Sun</span><b>${r.toFixed(3)} AU</b></div>` +
        `<div><span>Light time from Sun</span><b>${(r * 499.0 / 60).toFixed(1)} min</b></div>` +
        factRows(key);
    },
  };
  label.addEventListener("click", () => focusTarget(b));
  bodies.push(b);
  return b;
}

for (const [key, planet] of Object.entries(PLANETS))
  makeBody(key, planet, "planet", (d) => planetPosition(planet, d), (T, n) => orbitSamples(planet, T, n));
for (const [key, el] of Object.entries(DWARFS))
  makeBody(key, el, "dwarf", (d) => smallBodyPosition(el, d), (_T, n) => smallBodyOrbit(el, n));

const bodyByKey = Object.fromEntries(bodies.map((b) => [b.key, b]));

function rebuildOrbits(T) {
  for (const b of bodies) {
    const flat = [];
    for (const p of b.orbitPts(T, 320)) { const v = toScene(p); flat.push(v.x, v.y, v.z); }
    b.orbit.geometry.setPositions(flat);
  }
  updateNorthAxis(mapRadius(31) * 1.1);   // axis spans just beyond Neptune
}

// ---- moons -----------------------------------------------------------------
// Schematic, not to scale: a moon's true orbit is sub-pixel beside its planet
// at solar-system scale. Real PERIODS, inclinations, retrograde sense and
// ordering are preserved; orbital RADII are exaggerated & compressed so the
// moons read when you zoom to a planet. (NASA's Eyes does the same.)
// [name, parentKey, aKm, periodDays, radiusKm, inclDeg, color, retrograde?]
const MOONS = [
  ["Moon", "earth", 384400, 27.322, 1737, 5.14, 0xcfcfcf],
  ["Phobos", "mars", 9376, 0.319, 11, 1.08, 0x9b8d7e],
  ["Deimos", "mars", 23463, 1.263, 6, 1.79, 0x9b8d7e],
  ["Io", "jupiter", 421700, 1.769, 1821, 0.04, 0xe8d24a],
  ["Europa", "jupiter", 671100, 3.551, 1560, 0.47, 0xd9c4a3],
  ["Ganymede", "jupiter", 1070400, 7.155, 2634, 0.20, 0xb6a88f],
  ["Callisto", "jupiter", 1882700, 16.69, 2410, 0.19, 0x8a7f6b],
  ["Enceladus", "saturn", 237948, 1.370, 252, 0.02, 0xeaf2f5],
  ["Rhea", "saturn", 527108, 4.518, 764, 0.35, 0xcfcabd],
  ["Titan", "saturn", 1221870, 15.95, 2575, 0.33, 0xd9a441],
  ["Iapetus", "saturn", 3560820, 79.32, 735, 15.47, 0x9a8a72],
  ["Miranda", "uranus", 129390, 1.413, 236, 4.34, 0xbfccd6],
  ["Titania", "uranus", 435910, 8.706, 789, 0.34, 0xaeb9c2],
  ["Oberon", "uranus", 583520, 13.46, 761, 0.07, 0x9aa7b2],
  ["Triton", "neptune", 354759, 5.877, 1353, 23, 0x9fd0d8, true],
  ["Charon", "pluto", 19591, 6.387, 606, 0.08, 0xb9b0a4],
];

// known masses (kg) for the schematic moons — feeds the info cards
const MOON_MASS = {
  Moon: "7.3×10²² kg", Phobos: "1.1×10¹⁶ kg", Deimos: "1.5×10¹⁵ kg",
  Io: "8.9×10²² kg", Europa: "4.8×10²² kg", Ganymede: "1.5×10²³ kg", Callisto: "1.1×10²³ kg",
  Enceladus: "1.1×10²⁰ kg", Rhea: "2.3×10²¹ kg", Titan: "1.35×10²³ kg", Iapetus: "1.8×10²¹ kg",
  Miranda: "6.6×10¹⁹ kg", Titania: "3.4×10²¹ kg", Oberon: "2.9×10²¹ kg",
  Triton: "2.1×10²² kg", Charon: "1.6×10²¹ kg",
};

const moonLayer = new THREE.Group(); scene.add(moonLayer);
const moons = [];
const moonGroups = {};
for (const row of MOONS) (moonGroups[row[1]] ??= []).push(row);

for (const [pkey, rows] of Object.entries(moonGroups)) {
  const parent = bodyByKey[pkey];
  if (!parent) continue;
  const pr = bodySize(parent.spec);
  const sq = rows.map((r) => Math.sqrt(r[2]));
  const smin = Math.min(...sq), smax = Math.max(...sq);
  rows.forEach((r, idx) => {
    const [name, , aKm, period, radiusKm, incl, color, retro] = r;
    const t = smax > smin ? (Math.sqrt(aKm) - smin) / (smax - smin) : 0.5;
    const dispR = pr * 1.7 + 3 + t * 11;                       // ordered, compressed
    const size = THREE.MathUtils.clamp(Math.sqrt(radiusKm / 1737) * 0.5, 0.12, 0.7);

    const cc = new THREE.Color(color);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshStandardMaterial({
        map: TEX.mottledTexture([cc.r * 255, cc.g * 255, cc.b * 255], { contrast: 0.4, crater: 0.35 }),
        roughness: 1,
      })
    );
    mesh.scale.setScalar(size);
    moonLayer.add(mesh);

    // pre-tilted display orbit ring (shape constant; only translated to parent)
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2, z0 = Math.sin(a) * dispR;
      pts.push(new THREE.Vector3(Math.cos(a) * dispR, z0 * Math.sin(incl * DEG), z0 * Math.cos(incl * DEG)));
    }
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5a6470, transparent: true, opacity: 0.4 })
    );
    moonLayer.add(ring);

    const label = document.createElement("div");
    label.className = "label moon";
    label.textContent = name;
    labelLayer.appendChild(label);

    const m = {
      name, parent, mesh, ring, label, dispR, period, incl, retro,
      phase0: idx * 1.9 + (aKm % 7),
      infoHTML: () => `<div><span>Type</span><b>Moon</b></div>` +
        `<div><span>Orbits</span><b>${parent.name}</b></div>` +
        `<div><span>Orbital period</span><b>${period < 1 ? (period * 24).toFixed(1) + " h" : period.toFixed(2) + " d"}</b></div>` +
        `<div><span>Radius</span><b>${radiusKm.toLocaleString()} km</b></div>` +
        (MOON_MASS[name] ? `<div><span>Mass</span><b>${MOON_MASS[name]}</b></div>` : "") +
        `<div style="opacity:.55"><span>distance</span><b>not to scale</b></div>`,
    };
    label.addEventListener("click", () => focusTarget(m));
    moons.push(m);
  });
}

function updateMoons() {
  const jd = julianDate(simDate);
  for (const m of moons) {
    const ang = m.phase0 + (m.retro ? -1 : 1) * 2 * Math.PI * (jd / m.period);
    const z0 = Math.sin(ang) * m.dispR;
    const pp = m.parent.mesh.position;
    m.mesh.position.set(
      pp.x + Math.cos(ang) * m.dispR,
      pp.y + z0 * Math.sin(m.incl * DEG),
      pp.z + z0 * Math.cos(m.incl * DEG)
    );
    m.ring.position.copy(pp);
  }
}

// ---- time engine -----------------------------------------------------------
const DAY = 86400000;
let simDate = new Date();
let speedDays = 0;          // simulated days advanced per real second
let playing = true;
let focused = null;
let flyDist = null;         // active "fly to" target distance, null = not flying
let homeFly = false;        // easing back to the Sun-centred overview
const HOME = new THREE.Vector3(0, 380, 620);   // default camera vantage
const ORIGIN = new THREE.Vector3();            // the Sun

// sub-day steps exist for the close approaches: at ±1 d/s a flyby sweeps past
// in seconds; at 1 h/s (and 5 min/s for the truly close ones) it's watchable.
const HOUR = 1 / 24, MIN5 = 5 / 1440;
const SPEEDS = [ -3650, -365, -30, -7, -1, -HOUR, -MIN5, 0, MIN5, HOUR, 1, 7, 30, 365, 3650 ];
let speedIdx = SPEEDS.indexOf(1);

function setSpeedIdx(i) {
  speedIdx = THREE.MathUtils.clamp(i, 0, SPEEDS.length - 1);
  speedDays = SPEEDS[speedIdx];
  ui.speed.textContent = fmtSpeed(speedDays);
}
function fmtSpeed(d) {
  if (d === 0) return "paused";
  const a = Math.abs(d), sign = d < 0 ? "−" : "+";
  if (a >= 365) return `${sign}${(a/365).toFixed(a%365?1:0)} yr/s`;
  if (a >= 1) return `${sign}${a} d/s`;
  if (a >= HOUR) return `${sign}${Math.round(a * 24)} h/s`;
  return `${sign}${Math.round(a * 1440)} min/s`;
}

function updatePositions() {
  const jd = julianDate(simDate);
  const T = centuriesSinceJ2000(jd);
  for (const b of bodies) {
    b.mesh.position.copy(toScene(b.posAt(simDate)));
    if (b.rotDays) {   // layer the daily spin on top of the fixed axial tilt
      SPIN.setFromAxisAngle(YAXIS, (jd / b.rotDays) * 2 * Math.PI);
      b.mesh.quaternion.copy(b.tiltQ).multiply(SPIN);
    }
  }
  updateMoons();
  return T;
}

// ---- focus / picking -------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const targets = [...bodies, ...moons];   // anything clickable/focusable

function focusTarget(t) {
  // A spacecraft outside its data window has no position — its marker sits
  // hidden at the origin, so flying to it would dive INTO THE SUN. The user
  // asked to see the craft: snap the clock to the nearest covered moment
  // (same spirit as approach rows jumping to their date), then fly.
  if (t.t && t.p) {
    const jd = julianDate(simDate);
    const t0 = t.t[0], t1 = t.t[t.t.length - 1];
    if (jd <= t0 || jd >= t1) {
      simDate = new Date(((jd <= t0 ? t0 + 0.5 : t1 - 0.5) - 2440587.5) * 86400000);
      smallDirty = true;
      updatePositions();
      updateSpacecraft(julianDate(simDate));
      updateApproaches(julianDate(simDate));
      updateInterstellar();
      updateFamousComets();
    }
  }
  focused = t;
  // Sprite markers (spacecraft/approaches/interstellar) keep a constant *screen*
  // size, so their world scale varies with camera distance — a fixed close
  // framing is correct for them. Meshes (planets/moons) frame by their size.
  flyDist = t.mesh.isSprite ? 5 : Math.max(3, t.mesh.scale.x * 4.5);
  ui.info.hidden = false;
  ui.infoName.textContent = t.name;
  updateInfo();
  for (const x of targets) x.label.classList.toggle("active", x === t);
}
function clearFocus() {
  focused = null;
  flyDist = null;
  ui.info.hidden = true;
  for (const x of targets) x.label.classList.remove("active");
}
function recenter() {          // ease back to the Sun-centred overview
  clearFocus();
  homeFly = true;
}
controls.addEventListener("start", () => {   // manual drag cancels any programmatic fly
  flyDist = null; homeFly = false; controls.enableDamping = true;
});
canvas.addEventListener("pointerdown", (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const pickable = targets.filter((t) => t.mesh.visible && !t.hidden).map((t) => t.mesh);
  const hit = raycaster.intersectObjects([sun, ...pickable])[0];
  if (!hit) return;
  if (hit.object === sun) recenter();                                  // click the Sun to recenter
  else focusTarget(targets.find((t) => t.mesh === hit.object));
});

function updateInfo() {
  if (!focused) return;
  ui.infoBody.innerHTML = focused.infoHTML(simDate);
}

// ---- HUD wiring ------------------------------------------------------------
const ui = {
  date: document.getElementById("date"),
  speed: document.getElementById("speed"),
  play: document.getElementById("play"),
  scrub: document.getElementById("scrub"),
  info: document.getElementById("info"),
  infoName: document.getElementById("info-name"),
  infoBody: document.getElementById("info-body"),
};

// scrub bar spans ±100 years around "now" anchor.
const anchor = Date.now();
const SCRUB_SPAN = 100 * 365.25 * DAY;
ui.scrub.addEventListener("input", () => {
  const t = parseFloat(ui.scrub.value);             // -1..1
  simDate = new Date(anchor + t * SCRUB_SPAN);
  smallDirty = true;
  demoCue = null;
});
function syncScrub() {
  ui.scrub.value = ((simDate.getTime() - anchor) / SCRUB_SPAN).toString();
}

document.getElementById("slower").onclick = () => { demoCue = null; setSpeedIdx(speedIdx - 1); };
document.getElementById("faster").onclick = () => { demoCue = null; setSpeedIdx(speedIdx + 1); };
ui.play.onclick = () => {
  playing = !playing;
  // "paused" can also mean speed 0 (shared links & approach jumps hold their
  // moment that way) — resuming from that state must un-zero the speed too,
  // or play does nothing and the button looks broken.
  if (playing && speedDays === 0) setSpeedIdx(SPEEDS.indexOf(1));
  ui.play.textContent = playing ? "⏸" : "▶";
};
document.getElementById("now").onclick = () => { demoCue = null; simDate = new Date(); setSpeedIdx(SPEEDS.indexOf(1)); smallDirty = true; };
document.getElementById("log").onclick = (e) => {
  logScale = !logScale;
  e.target.classList.toggle("on", logScale);
  rebuildOrbits(centuriesSinceJ2000(julianDate(simDate)));
  rebuildTrails();
  rebuildInterstellarTrails();
  rebuildFamousCometOrbits();
  rebuildOort();
  controls.maxDistance = logScale ? MAX_DIST.log : MAX_DIST.linear;
  smallDirty = true;
};
document.getElementById("galaxy").onclick = (e) => {
  galaxy.visible = !galaxy.visible;
  apexArrow.g.visible = galaxy.visible;   // Sun's motion + Galactic N ride with the galaxy layer
  gnArrow.g.visible = galaxy.visible;
  e.target.classList.toggle("on", galaxy.visible);
};
document.getElementById("north").onclick = (e) => {
  eclArrow.g.visible = !eclArrow.g.visible;
  e.target.classList.toggle("on", eclArrow.g.visible);
};
document.getElementById("dwarfs").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  for (const b of bodies) if (b.kind === "dwarf") {
    b.hidden = !v; b.mesh.visible = v; b.orbit.visible = v;
  }
};
document.getElementById("moons").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  moonLayer.visible = v;
};
document.getElementById("size").oninput = (e) => {
  sizeBoost = parseFloat(e.target.value);
  for (const b of bodies) b.mesh.scale.setScalar(bodySize(b.spec) * (b.kind === "dwarf" ? 0.8 : 1));
};
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;   // don't hijack keys while typing in search
  if (e.key === " ") { ui.play.click(); e.preventDefault(); }
  if (e.key === "ArrowRight") { demoCue = null; setSpeedIdx(speedIdx + 1); }
  if (e.key === "ArrowLeft") { demoCue = null; setSpeedIdx(speedIdx - 1); }
  if (e.key === "Escape") clearFocus();
  if (e.key === "h" || e.key === "H") recenter();
});
document.getElementById("recenter").onclick = recenter;
document.getElementById("info-x").onclick = clearFocus;   // touch-friendly esc

// ---- search / go-to --------------------------------------------------------
const searchEl = document.getElementById("search");
const resultsEl = document.getElementById("results");
function matches(q) {
  q = q.trim().toLowerCase();
  return q ? targets.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8) : [];
}
function renderResults() {
  const hits = matches(searchEl.value);
  resultsEl.innerHTML = "";
  hits.forEach((t, i) => {
    const d = document.createElement("div");
    d.textContent = t.name;
    if (i === 0) d.classList.add("sel");
    d.onclick = () => goTo(t);
    resultsEl.appendChild(d);
  });
  resultsEl.classList.toggle("show", hits.length > 0);
}
function goTo(t) {
  focusTarget(t);
  searchEl.value = ""; searchEl.blur();
  resultsEl.classList.remove("show");
}
searchEl.addEventListener("input", renderResults);
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const h = matches(searchEl.value)[0]; if (h) goTo(h); }
  else if (e.key === "Escape") { searchEl.value = ""; searchEl.blur(); resultsEl.classList.remove("show"); }
});

// ---- label projection ------------------------------------------------------
const proj = new THREE.Vector3();
// Collect every label that could show this frame with a priority, then place
// greedily highest-priority-first, hiding any that would overlap one already
// placed. Keeps the view readable when bodies bunch up near the Sun.
function updateLabels() {
  const cands = [];
  const add = (src, el, world, prio) => cands.push({ src, el, world, prio });

  for (const b of bodies) {
    if (b.hidden) { b.label.style.display = "none"; continue; }
    add(b, b.label, b.mesh.position, b.kind === "dwarf" ? 2 : 0);
  }
  for (const m of moons) {                     // only when zoomed in near the parent
    if (moonLayer.visible && camera.position.distanceTo(m.parent.mesh.position) < m.dispR * 9)
      add(m, m.label, m.mesh.position, 4);
    else m.label.style.display = "none";
  }
  for (const sc of spacecraft) {
    if (craftLayer.visible && sc.marker.visible) add(sc, sc.label, sc.marker.position, 3);
    else sc.label.style.display = "none";
  }
  for (const a of approaches) {            // only label the flagged/focused ones
    if (approachLayer.visible && (a.near || a === focused)) add(a, a.label, a.mesh.position, 2);
    else a.label.style.display = "none";
  }
  for (const o of interstellar) {
    if (interstellarLayer.visible) add(o, o.label, o.mesh.position, 2);
    else o.label.style.display = "none";
  }
  for (const fc of famousComets) {
    if (famousLayer.visible) add(fc, fc.label, fc.mesh.position, 3);
    else fc.label.style.display = "none";
  }
  for (const k in markerEls) {
    if (markerGroup[k].visible) add(null, markerEls[k], markerWorld[k], 1);
    else markerEls[k].style.display = "none";
  }

  const placed = [];
  cands.sort((a, b) => (a.src === focused ? -1 : a.prio) - (b.src === focused ? -1 : b.prio));
  for (const c of cands) {
    proj.copy(c.world).project(camera);
    if (proj.z >= 1) { c.el.style.display = "none"; continue; }
    const x = (proj.x * 0.5 + 0.5) * innerWidth, y = (-proj.y * 0.5 + 0.5) * innerHeight;
    const w = c.el.textContent.length * 6.6 + 14, h = 14, lx = x + 2, ty = y - 7;
    let clash = false;
    for (const r of placed)
      if (lx < r[0] + r[2] && lx + w > r[0] && ty < r[1] + r[3] && ty + h > r[1]) { clash = true; break; }
    if (clash && c.src !== focused) { c.el.style.display = "none"; continue; }
    placed.push([lx, ty, w, h]);
    c.el.style.display = "block";
    c.el.style.left = `${x}px`;
    c.el.style.top = `${y}px`;
  }
}

// ---- small bodies: asteroids / NEOs / comets (Tier 2, JPL SBDB) -----------
// Thousands of bodies propagated in-browser from committed JSON snapshots
// (refreshed by the M3 GitHub Action). Per-body rotation coefficients are
// precomputed once; each update is just a Kepler solve + 3 dot products, and
// updates are throttled (small bodies move slowly) so cost is independent of
// framerate. Drawn as points — the asteroid belt & scattered orbits emerge.
const SMALL_STRIDE = 12;   // [a, e, b, ma, ep, n, P11,P12,P21,P22,P31,P32]
const ROCK = TEX.rockSprite();   // shared rock sprite for all small-body layers

// ---- data freshness --------------------------------------------------------
// Every Action-committed JSON carries a "generated" timestamp. Show the OLDEST
// one (the weakest link) so the HUD honestly reports how fresh the "live" data
// is — and call out any layer whose fetch failed outright.
const dataStatus = { oldest: null, failed: [] };
function noteData(json) {
  const t = json?.generated ? Date.parse(json.generated) : NaN;
  if (!Number.isNaN(t)) dataStatus.oldest = dataStatus.oldest === null ? t : Math.min(dataStatus.oldest, t);
  renderDataStatus();
}
function noteDataFail(name) {
  dataStatus.failed.push(name);
  renderDataStatus();
}
// Narrow screens hide the whole .hint block (no room), which used to take the
// freshness chip with it — reparent the chip into the HUD there instead.
// Keep this width in sync with the .hint display:none breakpoint in index.html.
const narrowMQ = matchMedia("(max-width: 1080px)");
function placeDataStatus() {
  const el = document.getElementById("data-status");
  (narrowMQ.matches ? document.querySelector(".hud") : document.querySelector(".hint")).appendChild(el);
}
placeDataStatus();
narrowMQ.addEventListener("change", placeDataStatus);
addEventListener("resize", placeDataStatus);   // some embedders resize without an MQ change event

function renderDataStatus() {
  const el = document.getElementById("data-status");
  if (!el) return;
  const bits = [];
  if (dataStatus.oldest !== null) bits.push(`JPL data refreshed ${new Date(dataStatus.oldest).toISOString().slice(0, 10)}`);
  if (dataStatus.failed.length) bits.push(`⚠ ${dataStatus.failed.join(" / ")} data unavailable`);
  el.textContent = bits.join(" · ");
  el.style.color = dataStatus.failed.length ? "#e08080" : "";
}

function buildStride(rows) {
  // e ≥ 0.995 (near-parabolic/long-period comets) is dropped: the fixed-iteration
  // elliptic Kepler solve below diverges there. Hyperbolic visitors get their own
  // propagator (interstellar layer); the in-between cases just aren't drawn.
  const keep = rows.filter((r) => r[1] > 0 && r[2] != null && r[2] < 0.995 && r[7] != null);
  const n = keep.length;
  const D = new Float64Array(n * SMALL_STRIDE), pha = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const r = keep[k];                       // [name,a,e,i,om,w,ma,ep,H,pha]
    const a = r[1], e = r[2], i = r[3], om = r[4], w = r[5], ma = r[6], ep = r[7], p = r[9];
    const cw = Math.cos(w * DEG), sw = Math.sin(w * DEG);
    const cO = Math.cos(om * DEG), sO = Math.sin(om * DEG);
    const cI = Math.cos(i * DEG), sI = Math.sin(i * DEG);
    const o = k * SMALL_STRIDE;
    D[o] = a; D[o+1] = e; D[o+2] = a * Math.sqrt(1 - e * e);
    D[o+3] = ma; D[o+4] = ep; D[o+5] = 0.9856076686 / (a * Math.sqrt(a)); // deg/day
    D[o+6] = cw*cO - sw*sO*cI; D[o+7] = -sw*cO - cw*sO*cI;
    D[o+8] = cw*sO + sw*cO*cI; D[o+9] = -sw*sO + cw*cO*cI;
    D[o+10] = sw*sI; D[o+11] = cw*sI;
    pha[k] = p ? 1 : 0;
  }
  return { D, n, pha };
}

function computeLayer(L, jd) {
  const D = L.D, n = L.n, pos = L.pos;
  for (let k = 0; k < n; k++) {
    const o = k * SMALL_STRIDE, e = D[o+1];
    let M = (D[o+3] + D[o+5] * (jd - D[o+4])) % 360; if (M < 0) M += 360; if (M > 180) M -= 360;
    M *= DEG;
    let E = M + e * Math.sin(M);
    for (let it = 0; it < 5; it++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = D[o] * (Math.cos(E) - e), yp = D[o+2] * Math.sin(E);
    const X = D[o+6]*xp + D[o+7]*yp, Y = D[o+8]*xp + D[o+9]*yp, Z = D[o+10]*xp + D[o+11]*yp;
    const rAU = Math.hypot(X, Y, Z) || 1e-9, s = mapRadius(rAU) / rAU;
    pos[k*3] = X * s; pos[k*3+1] = Z * s; pos[k*3+2] = -Y * s;
  }
}

async function loadSmall(name, { size, color, highlight }) {
  let json;
  try { json = await (await fetch(`./data/${name}.json`)).json(); }
  catch (e) { console.warn(`small bodies "${name}" failed to load`, e); noteDataFail(name); return; }
  noteData(json);
  const { D, n, pha } = buildStride(json.data);
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const opts = { size, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false,
                 map: ROCK, alphaTest: 0.45 };   // shaded rock sprite instead of a square
  if (highlight) {   // NEOs: PHAs red, others orange (vertex colours)
    const col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      col[k*3] = 1; col[k*3+1] = pha[k] ? 0.30 : 0.62; col[k*3+2] = pha[k] ? 0.30 : 0.26;
    }
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    opts.vertexColors = true;
  } else opts.color = color;
  const points = new THREE.Points(geom, new THREE.PointsMaterial(opts));
  points.frustumCulled = false;
  scene.add(points);
  const btn = document.getElementById(name);
  points.visible = btn ? btn.classList.contains("on") : true;
  const L = { name, D, n, pos, geom, points };
  smallLayers.push(L); smallByName[name] = L;
  computeLayer(L, julianDate(simDate));
  geom.attributes.position.needsUpdate = true;
}

let lastSmallMs = 0;
function maybeUpdateSmall(now) {
  if (!smallLayers.length) return;
  if (!smallDirty) {
    if (!playing || speedDays === 0) return;   // static → nothing to do
    if (now - lastSmallMs < 90) return;         // ~11 Hz is plenty for slow bodies
  }
  const jd = julianDate(simDate);
  for (const L of smallLayers) {
    if (!L.points.visible) continue;
    computeLayer(L, jd);
    L.geom.attributes.position.needsUpdate = true;
  }
  lastSmallMs = now; smallDirty = false;
}

for (const nm of ["asteroids", "neos", "comets", "tnos"]) {
  document.getElementById(nm).onclick = (e) => {
    const v = !e.target.classList.contains("on");
    e.target.classList.toggle("on", v);
    const L = smallByName[nm];
    if (L) { L.points.visible = v; if (v) smallDirty = true; }
    if (nm === "comets") famousLayer.visible = v;   // named greats ride this toggle
  };
}

loadSmall("asteroids", { size: 2.6, color: 0x9a8f7a });
loadSmall("neos", { size: 2.3, highlight: true });
loadSmall("comets", { size: 2.8, color: 0x6fd3e6 });
loadSmall("tnos", { size: 2.4, color: 0xa9c4e6 });   // Kuiper belt: icy pale blue

// ---- Oort cloud (schematic) ------------------------------------------------
// A spherical shell of icy nuclei from ~2,000 to ~50,000 AU — 66× beyond
// Neptune at its inner edge, so it only fits on screen in log-distance mode
// (enabling the layer flips log mode on). Isotropic on purpose: it's a sphere,
// not a disc — that's the whole visual point. Density thins outward.
const OORT_N = 4500, OORT_RMIN = 2000, OORT_RMAX = 50000;
const oortDir = new Float32Array(OORT_N * 3);   // unit directions (ecliptic AU frame)
const oortRad = new Float64Array(OORT_N);       // radii in AU
for (let k = 0; k < OORT_N; k++) {
  const z = Math.random() * 2 - 1, ph = Math.random() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
  oortDir[k*3] = s * Math.cos(ph); oortDir[k*3+1] = s * Math.sin(ph); oortDir[k*3+2] = z;
  oortRad[k] = OORT_RMIN * Math.pow(OORT_RMAX / OORT_RMIN, Math.pow(Math.random(), 1.6));
}
const oortGeom = new THREE.BufferGeometry();
oortGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(OORT_N * 3), 3));
const oortPts = new THREE.Points(oortGeom, new THREE.PointsMaterial({
  size: 2.2, sizeAttenuation: false, map: ROCK, alphaTest: 0.3, transparent: true,
  opacity: 0.45, color: 0x9fb4d8, depthWrite: false }));
oortPts.frustumCulled = false;
oortPts.visible = false;
scene.add(oortPts);
function rebuildOort() {   // static shell; recompute only when the radial map changes
  const pos = oortGeom.attributes.position.array;
  for (let k = 0; k < OORT_N; k++) {
    const v = toScene({ x: oortDir[k*3] * oortRad[k], y: oortDir[k*3+1] * oortRad[k], z: oortDir[k*3+2] * oortRad[k] });
    pos[k*3] = v.x; pos[k*3+1] = v.y; pos[k*3+2] = v.z;
  }
  oortGeom.attributes.position.needsUpdate = true;
  markerWorld.oort.copy(toScene({ x: OORT_RMIN * 1.4, y: 0, z: 0 }));
}
markerEls.oort = makeMarker("Oort cloud · schematic");
markerWorld.oort = new THREE.Vector3();
markerGroup.oort = oortPts;
rebuildOort();
document.getElementById("oort").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  oortPts.visible = v;
  if (v && !logScale) document.getElementById("log").click();   // it only reads in log mode
};

// ---- spacecraft (Tier 3, JPL Horizons) ------------------------------------
// Active missions don't follow Keplerian orbits, so instead of elements we
// carry Horizons-sampled state vectors (committed daily by the Action) and
// interpolate. Each craft shows a trajectory trail + a marker that appears
// only while the scrubbed date is within its data window.
const craftLayer = new THREE.Group(); scene.add(craftLayer);
const SAT = TEX.satelliteSprite();   // shared satellite icon for all spacecraft markers
const spacecraft = [];

function interpCraft(sc, jd) {
  const t = sc.t, n = t.length;
  if (jd <= t[0] || jd >= t[n - 1]) return null;   // outside coverage
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= jd) lo = mid; else hi = mid; }
  const f = (jd - t[lo]) / (t[hi] - t[lo]), p = sc.p;
  return {
    x: p[lo*3]   + (p[hi*3]   - p[lo*3])   * f,
    y: p[lo*3+1] + (p[hi*3+1] - p[lo*3+1]) * f,
    z: p[lo*3+2] + (p[hi*3+2] - p[lo*3+2]) * f,
  };
}

function rebuildTrails() {
  for (const sc of spacecraft) {
    const flat = [], p = sc.p;
    for (let k = 0; k < sc.t.length; k++) {
      const v = toScene({ x: p[k*3], y: p[k*3+1], z: p[k*3+2] });
      flat.push(v.x, v.y, v.z);
    }
    sc.trail.geometry.setPositions(flat);
  }
}

// Keep a world-space marker sprite at a roughly constant on-screen size, so it
// reads as a small icon at any zoom instead of ballooning over a nearby planet
// (e.g. JWST at L2 sits ~on Earth at this scale). The factors are fractions of
// camera distance — one place to tune every marker family's apparent size.
const MARKER_PX = { craft: 0.028, approach: 0.013, approachNear: 0.017, interstellar: 0.02 };
function markerScale(worldPos, k) {
  // Constant-screen-size, but capped to a fraction of the marker's distance
  // from the Sun: zoomed far out, an uncapped icon pinned at ~1 AU grows to
  // world size ≫ its solar distance and visually swallows the Sun (JWST
  // "inside the Sun"). The cap keeps it clear of the origin at any zoom —
  // it shrinks toward a dot when the whole system is in frame, which is the
  // honest rendering anyway; it uncaps again as the camera closes in.
  return Math.min(k * camera.position.distanceTo(worldPos), worldPos.length() * 0.35);
}

// Legibility fudge: an object sitting almost on top of a planet (JWST at L2, a
// NEO at closest approach) is nudged radially outward to a minimum world gap so
// it reads as a separate point. Returns the planet it was pushed from (for a
// leader line), or null if it was already clear. Mutates pos in place.
const EXPLODE_GAP = 2.6;
const _ev = new THREE.Vector3();
function explodeFromPlanets(pos) {
  let nearest = null, nd = Infinity;
  for (const b of bodies) {
    if (b.kind === "dwarf") continue;
    const dd = pos.distanceToSquared(b.mesh.position);
    if (dd < nd) { nd = dd; nearest = b; }
  }
  if (!nearest) return null;
  // gap must clear even a Jupiter-sized sphere (mesh scale up to 4.2, and the
  // body-size slider can inflate it further)
  const gap = Math.max(EXPLODE_GAP, nearest.mesh.scale.x * 1.8);
  if (nd >= gap * gap) return null;
  _ev.copy(pos).sub(nearest.mesh.position);
  if (_ev.lengthSq() < 1e-8) _ev.set(1, 0, 0);   // coincident: arbitrary direction
  _ev.setLength(gap);
  pos.copy(nearest.mesh.position).add(_ev);
  return nearest;
}

function updateSpacecraft(jd) {
  for (const sc of spacecraft) {
    const pos = interpCraft(sc, jd);
    sc.lastPos = pos;
    if (!pos) { sc.marker.visible = false; sc.leader.visible = false; continue; }
    sc.marker.visible = true;
    sc.marker.position.copy(toScene(pos));
    // nudge L2/orbiter craft off their planet — and draw a leader line back to
    // it so the offset reads as "attached to Earth", not "floating in space"
    const from = explodeFromPlanets(sc.marker.position);
    if (from) {
      sc.leader.geometry.setFromPoints([from.mesh.position, sc.marker.position]);
      sc.leader.visible = true;
    } else sc.leader.visible = false;
    sc.marker.scale.setScalar(markerScale(sc.marker.position, MARKER_PX.craft));
  }
}

async function loadSpacecraft() {
  let json;
  try { json = await (await fetch("./data/spacecraft.json")).json(); }
  catch (e) { console.warn("spacecraft failed to load", e); noteDataFail("spacecraft"); return; }
  noteData(json);
  for (const c of json.craft) {
    const t = Float64Array.from(c.t), p = Float64Array.from(c.p);
    const col = new THREE.Color(c.color);

    const trailMat = new LineMaterial({ color: col, linewidth: 1.3, transparent: true, opacity: 0.5 });
    trailMat.resolution.set(innerWidth, innerHeight);
    const trail = new Line2(new LineGeometry(), trailMat);
    craftLayer.add(trail);

    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SAT, color: col, transparent: true, depthWrite: false }));
    marker.scale.setScalar(3.0);
    craftLayer.add(marker);

    const leader = new THREE.Line(   // planet ↔ marker tether when exploded off it
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x5a6470, transparent: true, opacity: 0.55 }));
    leader.visible = false;
    craftLayer.add(leader);

    const label = document.createElement("div");
    label.className = "label craft";
    label.textContent = c.name;
    labelLayer.appendChild(label);

    const sc = {
      name: c.name, t, p, trail, marker, leader, label, mesh: marker,
      infoHTML: (date) => {
        // mission metadata rides in the JSON (fields absent in pre-07/02 data)
        const meta =
          (c.mission ? `<div><span>Mission</span><b>${c.mission}</b></div>` : "") +
          (c.launch ? `<div><span>Launched</span><b>${c.launch}</b></div>` : "") +
          (c.agency ? `<div><span>Agency</span><b>${c.agency}</b></div>` : "") +
          (c.size ? `<div><span>Size</span><b>${c.size}</b></div>` : "") +
          (c.mass ? `<div><span>Mass at launch</span><b>${c.mass}</b></div>` : "");
        const q = sc.lastPos;
        if (!q) return `<div><span>Type</span><b>Spacecraft</b></div>` + meta +
          `<div><span>Status</span><b>outside data window</b></div>`;
        const r = Math.hypot(q.x, q.y, q.z);
        const pe = planetPosition(PLANETS.earth, date);
        const dE = Math.hypot(q.x - pe.x, q.y - pe.y, q.z - pe.z);
        // craft parked near Earth (JWST at L2) read better in km; far ones in AU
        const dEtxt = dE < 0.05 ? `${Math.round(dE * 149597871).toLocaleString()} km` : `${dE.toFixed(2)} AU`;
        const lt = (au) => { const s = au * 499.0;   // light seconds per AU
          return s < 90 ? `${s.toFixed(1)} s` : s < 5400 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`; };
        return `<div><span>Type</span><b>Spacecraft</b></div>` + meta +
          `<div><span>Distance from Sun</span><b>${r.toFixed(2)} AU</b></div>` +
          `<div><span>Distance from Earth</span><b>${dEtxt}</b></div>` +
          `<div><span>Light time from Earth</span><b>${lt(dE)}</b></div>`;
      },
    };
    label.addEventListener("click", () => focusTarget(sc));
    spacecraft.push(sc); targets.push(sc);
  }
  craftLayer.visible = document.getElementById("craft")?.classList.contains("on") ?? true;
  rebuildTrails();
  updateSpacecraft(julianDate(simDate));
}
loadSpacecraft();

document.getElementById("craft").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  craftLayer.visible = v;
};

// ---- close approaches to Earth (JPL CAD + SBDB) ---------------------------
// The objects that will pass near Earth, flagged. Each is a real NEO with an
// orbit (from SBDB) we propagate like any small body; the CAD approach date +
// miss distance drive the list and the "approaching now" pulse/flag line.
const approachLayer = new THREE.Group(); scene.add(approachLayer);
const approaches = [];
let demoCue = null;   // approach the demo button is driving: auto-slows near the pass
const APPROACH_GLOW = glowTexture();   // soft halo, pulsed on the object nearest its closest approach
const flagLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xff5aa6, transparent: true, opacity: 0.85 }));
flagLine.visible = false; scene.add(flagLine);
const approachOrbitMat = new LineMaterial({ color: 0xff6fb0, linewidth: 1.4, transparent: true, opacity: 0.6 });
approachOrbitMat.resolution.set(innerWidth, innerHeight);
const approachOrbit = new Line2(new LineGeometry(), approachOrbitMat);
approachOrbit.visible = false; scene.add(approachOrbit);

function shortName(s) {
  let r = s.replace(/\s*\(.*?\)\s*/g, "").trim();
  if (!r) r = s.replace(/[()]/g, "").trim();
  return r;
}

// ---- physical estimates (size / mass / volume) ------------------------------
// Size: SBDB's measured diameter (radar/occultation/thermal) when it has one,
// else derived from absolute magnitude H at an assumed albedo of 0.14 — the
// standard D = 1329/√p · 10^(−H/5), good to ~×2 either way. Mass is ALWAYS an
// estimate for these bodies: a sphere of that diameter at an assumed bulk
// density (stony rubble ~2.6 g/cm³ for NEOs, fluffy ice ~0.6 g/cm³ for comet
// nuclei — 67P measured 0.53). Order-of-magnitude honest, so rows say "est."
const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
              "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const sup = (n) => String(n).split("").map((c) => SUP[c]).join("");
const estDiamKm = (H) => 1329 / Math.sqrt(0.14) * Math.pow(10, -H / 5);
const fmtDiam = (km) => km < 1 ? `~${Math.round(km * 1000)} m`
  : `~${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
function fmtMass(kg) {
  const e = Math.floor(Math.log10(kg));
  return `~${(kg / 10 ** e).toFixed(1)}×10${sup(e)} kg`;
}
function sizeMassRows(dKm, density, measured, label = "Size") {
  const r = dKm * 500;                                  // radius in m
  const vol = 4 / 3 * Math.PI * r ** 3;                 // m³
  const volTxt = vol >= 1e9 ? `~${Math.round(vol / 1e9).toLocaleString()} km³`
    : vol >= 1e6 ? `~${(vol / 1e6).toFixed(vol < 1e7 ? 1 : 0)} million m³`
    : `~${Math.round(vol).toLocaleString()} m³`;
  return `<div><span>${label}</span><b>${fmtDiam(dKm)}${measured ? "" : " (est.)"}</b></div>` +
    `<div><span>Est. mass</span><b>${fmtMass(vol * density)}</b></div>` +
    `<div><span>Volume</span><b>${volTxt}</b></div>`;
}

async function loadApproaches() {
  let json;
  try { json = await (await fetch("./data/close_approaches.json")).json(); }
  catch (e) { console.warn("close approaches failed to load", e); noteDataFail("approaches"); return; }
  noteData(json);
  for (const o of json.objects) {
    const el = { a: o.a, e: o.e, i: o.i, om: o.om, w: o.w, ma: o.ma, epoch: o.ep,
                 n: 0.9856076686 / (o.a * Math.sqrt(o.a)) };
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({   // rock sprite, tinted so it still flags as an approach
      map: ROCK, color: 0xff5aa6, transparent: true, depthWrite: false }));
    approachLayer.add(marker);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({     // breathing halo, shown only while approaching
      map: APPROACH_GLOW, color: 0xff5aa6, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(7); glow.visible = false;
    approachLayer.add(glow);
    const label = document.createElement("div");
    label.className = "label approach";
    label.textContent = shortName(o.name);
    labelLayer.appendChild(label);
    const a = {
      name: shortName(o.name), mesh: marker, glow, label, approach: o,
      posAt: (d) => smallBodyPosition(el, d),
      orbitPts: (n) => smallBodyOrbit(el, n),
      infoHTML: (date) => {
        const p = smallBodyPosition(el, date), r = Math.hypot(p.x, p.y, p.z);
        const km = o.ld * 384400;      // LD → km (centre-to-centre)
        const alt = km - 6371;         // height above Earth's surface
        const D = o.di ?? (o.h != null ? estDiamKm(o.h) : null);   // measured beats H-derived
        return `<div><span>Type</span><b>Near-Earth object</b></div>` +
          `<div><span>Closest approach</span><b>${o.cd} UTC</b></div>` +
          `<div><span>Miss distance</span><b>${o.ld.toFixed(2)} LD · ${Math.round(km).toLocaleString()} km</b></div>` +
          // 42,164 km = geostationary-ring radius from Earth's centre — the
          // headline fact for Apophis 2029: it passes beneath our GEO satellites
          (km < 42164 ? `<div><span>How close?</span><b>inside the geostationary ring — ${Math.round(alt).toLocaleString()} km above the surface</b></div>` : "") +
          `<div><span>Relative speed</span><b>${o.v} km/s</b></div>` +
          (D ? sizeMassRows(D, 2600, o.di != null) : "") +
          `<div><span>Distance from Sun</span><b>${r.toFixed(3)} AU</b></div>`;
      },
    };
    label.addEventListener("click", () => focusTarget(a));
    approaches.push(a); targets.push(a);
  }
  approachLayer.visible = document.getElementById("approaches")?.classList.contains("on") ?? true;
  buildApproachList();
  updateApproaches(julianDate(simDate));
  if (matchMedia("(max-width: 700px)").matches)   // phones: start the list collapsed
    document.getElementById("approach-panel").classList.add("collapsed");

  // The 2029 Apophis pass (0.10 LD) is the showpiece — one click cues it up:
  // jump to 3 days before closest approach, focus it, play at 1 d/s so the
  // rock visibly sweeps past Earth (pulsing halo + flag line take over).
  const apophis = approaches.find((a) => a.approach.des === "99942");
  const demoBtn = document.getElementById("apophis-demo");
  if (apophis && demoBtn) {
    demoBtn.hidden = false;
    demoBtn.onclick = () => {
      goToApproach(apophis);                              // jump + focus (pauses)
      simDate = new Date(simDate.getTime() - 3 * DAY);    // start the run-up
      setSpeedIdx(SPEEDS.indexOf(1));                     // …and roll at 1 d/s
      playing = true; ui.play.textContent = "⏸";
      smallDirty = true;
      demoCue = apophis;                                  // updateDemo slows the final approach
    };
  }
}

function updateApproaches(jd) {
  let flag = null, flagDt = 1e9;
  for (const a of approaches) {
    a.mesh.position.copy(toScene(a.posAt(simDate)));
    explodeFromPlanets(a.mesh.position);       // lift a close-approach NEO off Earth so it's visible
    const dt = Math.abs(jd - a.approach.jd);
    a.near = dt < 3;                       // within 3 days of closest approach
    const ms = markerScale(a.mesh.position, a.near ? MARKER_PX.approachNear : MARKER_PX.approach);
    a.mesh.scale.setScalar(ms);
    a.glow.position.copy(a.mesh.position);
    a.glow.scale.setScalar(ms * 4.5);
    a.glow.visible = a.near && approachLayer.visible;
    if (a.near) a.glow.material.opacity = 0.30 + 0.22 * (0.5 + 0.5 * Math.sin(performance.now() / 520));
    if (a.near && dt < flagDt) { flag = a; flagDt = dt; }
  }
  if (flag && approachLayer.visible) {     // draw Earth ↔ approaching object
    flagLine.geometry.setFromPoints([bodyByKey.earth.mesh.position.clone(), flag.mesh.position.clone()]);
    flagLine.visible = true;
  } else flagLine.visible = false;
  if (focused && approachLayer.visible && approaches.includes(focused)) {
    const flat = [];
    for (const p of focused.orbitPts(256)) { const v = toScene(p); flat.push(v.x, v.y, v.z); }
    approachOrbit.geometry.setPositions(flat);
    approachOrbit.visible = true;
  } else approachOrbit.visible = false;
}

// While the demo button is driving the clock: cruise in at 1 d/s, drop to
// 1 h/s inside ±12 h of closest approach so the skim reads in real time, then
// hand the controls back once the rock is clear. Any manual speed/scrub input
// cancels the cue — the user has taken over.
function updateDemo(jd) {
  if (!demoCue || !playing) return;
  const dt = jd - demoCue.approach.jd;
  if (dt > 0.5) { setSpeedIdx(SPEEDS.indexOf(1)); demoCue = null; }
  else if (Math.abs(dt) <= 0.5 && speedDays !== HOUR) setSpeedIdx(SPEEDS.indexOf(HOUR));
}

function buildApproachList() {
  const list = document.getElementById("approach-list");
  document.getElementById("approach-count").textContent = `${approaches.length}`;
  list.innerHTML = "";
  for (const a of [...approaches].sort((x, y) => x.approach.jd - y.approach.jd)) {
    const ld = a.approach.ld, cls = ld < 1 ? "ca-red" : ld < 2 ? "ca-orange" : "";
    const row = document.createElement("div");
    row.className = "ca-row";
    row.innerHTML = `<span class="ca-date">${a.approach.cd.split(" ")[0]}</span>` +
      `<span class="ca-name">${a.name}</span>` +
      `<span class="ca-ld ${cls}">${ld.toFixed(2)}</span>`;
    row.onclick = () => goToApproach(a);
    list.appendChild(row);
  }
}

function goToApproach(a) {
  demoCue = null;   // the demo re-arms after this call; a plain row click just cancels
  simDate = new Date((a.approach.jd - 2440587.5) * 86400000);   // jump to the moment
  setSpeedIdx(SPEEDS.indexOf(0));                                // pause on it
  playing = false; ui.play.textContent = "▶";                    // show it honestly
  smallDirty = true;
  approachLayer.visible = true;
  document.getElementById("approaches").classList.add("on");
  updatePositions(); updateApproaches(julianDate(simDate));     // place everything at the date
  focusTarget(a);
}
loadApproaches();

document.getElementById("approaches").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  approachLayer.visible = v;
  document.getElementById("approach-panel").classList.toggle("hidden", !v);
};
document.getElementById("approach-head").onclick = () =>
  document.getElementById("approach-panel").classList.toggle("collapsed");

// ---- interstellar visitors (1I/'Oumuamua, 2I/Borisov, 3I/ATLAS) -----------
// Objects from beyond the solar system on hyperbolic (unbound) trajectories —
// they fall in, whip around the Sun once, and leave forever. Drawn like the
// spacecraft: a trajectory + a marker propagated along it with the scrubber.
const interstellarLayer = new THREE.Group(); scene.add(interstellarLayer);
const interstellar = [];
for (const [, el] of Object.entries(INTERSTELLAR)) {
  const col = new THREE.Color(el.color);
  const trailMat = new LineMaterial({ color: col, linewidth: 1.6, transparent: true, opacity: 0.6 });
  trailMat.resolution.set(innerWidth, innerHeight);
  const trail = new Line2(new LineGeometry(), trailMat);
  interstellarLayer.add(trail);
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({   // rock sprite, tinted per object
    map: ROCK, color: col, transparent: true, depthWrite: false }));
  interstellarLayer.add(marker);
  const label = document.createElement("div");
  label.className = "label interstellar";
  label.textContent = el.name;
  label.style.color = "#" + col.getHexString();
  labelLayer.appendChild(label);
  const obj = {
    name: el.name, el, mesh: marker, trail, label,
    posAt: (d) => interstellarPosition(el, d),
    infoHTML: (date) => {
      const p = interstellarPosition(el, date), r = Math.hypot(p.x, p.y, p.z);
      return `<div><span>Type</span><b>Interstellar object</b></div>` +
        `<div><span>Discovered</span><b>${el.disc}</b></div>` +
        `<div><span>Perihelion</span><b>${el.peri}</b></div>` +
        `<div><span>Size (est.)</span><b>${el.size}</b></div>` +
        `<div><span>Eccentricity</span><b>${el.e.toFixed(2)} — unbound</b></div>` +
        `<div><span>Distance from Sun</span><b>${r.toFixed(2)} AU</b></div>` +
        `<div style="opacity:.6"><span>origin</span><b>interstellar space</b></div>`;
    },
  };
  label.addEventListener("click", () => focusTarget(obj));
  interstellar.push(obj); targets.push(obj);
}
function rebuildInterstellarTrails() {
  for (const o of interstellar) {
    const flat = [];
    for (const p of interstellarPath(o.el)) { const v = toScene(p); flat.push(v.x, v.y, v.z); }
    o.trail.geometry.setPositions(flat);
  }
}
function updateInterstellar() {
  for (const o of interstellar) {
    o.mesh.position.copy(toScene(o.posAt(simDate)));
    o.mesh.scale.setScalar(markerScale(o.mesh.position, MARKER_PX.interstellar));
  }
}
interstellarLayer.visible = document.getElementById("interstellar")?.classList.contains("on") ?? true;
rebuildInterstellarTrails();
updateInterstellar();

document.getElementById("interstellar").onclick = (e) => {
  const v = !e.target.classList.contains("on");
  e.target.classList.toggle("on", v);
  interstellarLayer.visible = v;
};

// ---- famous comets (named & focusable) -------------------------------------
// The Tier-2 comet point-cloud is anonymous. These greats get real orbits +
// labels + info cards — same SBDB element format as the dwarfs/approaches, so
// the same propagator. Data: tools/fetch_famous_comets.py (curated, e ≲ 0.97).
// They ride the `comets` layer toggle rather than adding another button.
const famousLayer = new THREE.Group(); scene.add(famousLayer);
const FAMOUS_COL = 0x6fd3e6;             // matches the comet point layer
const famousComets = [];

async function loadFamousComets() {
  let json;
  try { json = await (await fetch("./data/comets_famous.json")).json(); }
  catch (e) { console.warn("famous comets failed to load", e); noteDataFail("famous comets"); return; }
  noteData(json);
  for (const c of json.comets) {
    const el = { a: c.a, e: c.e, i: c.i, om: c.om, w: c.w, ma: c.ma, epoch: c.ep,
                 n: 0.9856076686 / (c.a * Math.sqrt(c.a)) };
    const orbitMat = new LineMaterial({ color: FAMOUS_COL, linewidth: 1.1, transparent: true, opacity: 0.35 });
    orbitMat.resolution.set(innerWidth, innerHeight);
    const orbit = new Line2(new LineGeometry(), orbitMat);
    famousLayer.add(orbit);
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ROCK, color: FAMOUS_COL, transparent: true, depthWrite: false }));
    famousLayer.add(marker);
    const label = document.createElement("div");
    label.className = "label comet";
    label.textContent = c.name;
    label.style.color = "#8fdcea";
    labelLayer.appendChild(label);
    const periodYr = Math.pow(c.a, 1.5);
    const fc = {
      name: c.name, el, mesh: marker, orbit, label,
      posAt: (d) => smallBodyPosition(el, d),
      infoHTML: (date) => {
        const p = smallBodyPosition(el, date), r = Math.hypot(p.x, p.y, p.z);
        return `<div><span>Type</span><b>Comet</b></div>` +
          `<div><span>Known for</span><b>${c.note}</b></div>` +
          `<div><span>Period</span><b>${periodYr.toFixed(1)} yr</b></div>` +
          `<div><span>Perihelion</span><b>${(c.a * (1 - c.e)).toFixed(2)} AU</b></div>` +
          (c.di ? sizeMassRows(c.di, 600, true, "Nucleus") : "") +
          `<div><span>Distance from Sun</span><b>${r.toFixed(2)} AU</b></div>`;
      },
    };
    label.addEventListener("click", () => focusTarget(fc));
    famousComets.push(fc); targets.push(fc);
  }
  famousLayer.visible = document.getElementById("comets")?.classList.contains("on") ?? true;
  rebuildFamousCometOrbits();
  updateFamousComets();
}
function rebuildFamousCometOrbits() {   // orbits are fixed; rebuild only on the log toggle
  for (const fc of famousComets) {
    const flat = [];
    for (const p of smallBodyOrbit(fc.el, 256)) { const v = toScene(p); flat.push(v.x, v.y, v.z); }
    fc.orbit.geometry.setPositions(flat);
  }
}
function updateFamousComets() {
  for (const fc of famousComets) {
    fc.mesh.position.copy(toScene(fc.posAt(simDate)));
    fc.mesh.scale.setScalar(markerScale(fc.mesh.position, MARKER_PX.interstellar));
  }
}
loadFamousComets();

// ---- shareable URL state ---------------------------------------------------
// The hash mirrors the scene — #YYYY-MM-DD/BodyName — so a moment can be linked
// directly (e.g. #2029-04-13/Apophis flies straight to the flyby). The body
// name is URI-encoded ("3I/ATLAS" → 3I%2FATLAS), so the first literal "/" is
// the separator. replaceState keeps updates out of back-button history.
let lastHash = "", lastHashMs = 0;
function syncHash(now) {
  if (now - lastHashMs < 1500) return;
  lastHashMs = now;
  const h = "#" + simDate.toISOString().slice(0, 10) +
    (focused ? "/" + encodeURIComponent(focused.name) : "");
  if (h !== lastHash) { lastHash = h; history.replaceState(null, "", h); }
}
(function restoreFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  const cut = raw.indexOf("/");
  const dpart = cut < 0 ? raw : raw.slice(0, cut);
  const name = cut < 0 ? "" : decodeURIComponent(raw.slice(cut + 1));
  if (/^\d{4}-\d{2}-\d{2}$/.test(dpart)) {
    simDate = new Date(dpart + "T00:00:00Z");
    setSpeedIdx(SPEEDS.indexOf(0));            // hold the shared moment
    playing = false; ui.play.textContent = "▶";  // …and show it honestly
    smallDirty = true;
  }
  if (name) {
    const tryFocus = (attempt) => {            // async layers fill targets late
      const t = targets.find((x) => x.name.toLowerCase() === name.toLowerCase()) || matches(name)[0];
      if (t) { updatePositions(); focusTarget(t); }
      else if (attempt < 40) setTimeout(() => tryFocus(attempt + 1), 250);
    };
    tryFocus(0);
  }
})();

// ---- main loop -------------------------------------------------------------
let last = performance.now();
let lastOrbitT = null;
function tick(now) {
  const dt = (now - last) / 1000; last = now;

  if (playing && speedDays !== 0) {
    simDate = new Date(simDate.getTime() + speedDays * DAY * dt);
  }

  const T = updatePositions();
  // rebuild orbit ellipses only when elements have drifted noticeably
  if (lastOrbitT === null || Math.abs(T - lastOrbitT) > 0.02) {
    rebuildOrbits(T); lastOrbitT = T;
  }
  maybeUpdateSmall(now);
  updateSpacecraft(julianDate(simDate));
  updateApproaches(julianDate(simDate));
  updateDemo(julianDate(simDate));
  updateInterstellar();
  updateFamousComets();

  if (focused) {
    controls.target.lerp(focused.mesh.position, 0.14);
    if (flyDist !== null) {   // ease the camera to a framing distance, keeping angle
      controls.enableDamping = false;   // don't let damping fight the programmatic move
      const off = camera.position.clone().sub(focused.mesh.position);
      const d = off.length() || 1;
      const want = focused.mesh.position.clone().addScaledVector(off.multiplyScalar(1 / d), flyDist);
      camera.position.lerp(want, 0.12);
      if (Math.abs(d - flyDist) < Math.max(0.4, flyDist * 0.03)) { flyDist = null; controls.enableDamping = true; }
    }
  } else {
    controls.target.lerp(ORIGIN, homeFly ? 0.12 : 0.05);
    if (homeFly) {
      controls.enableDamping = false;
      camera.position.lerp(HOME, 0.1);
      if (camera.position.distanceTo(HOME) < 6) { homeFly = false; controls.enableDamping = true; }
    }
  }

  controls.update();
  updateLabels();
  ui.date.textContent = simDate.toISOString().slice(0, 10);
  syncScrub();
  syncHash(now);
  if (focused) updateInfo();

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  for (const b of bodies) b.orbit.material.resolution.set(innerWidth, innerHeight);
  for (const sc of spacecraft) sc.trail.material.resolution.set(innerWidth, innerHeight);
  for (const o of interstellar) o.trail.material.resolution.set(innerWidth, innerHeight);
  for (const fc of famousComets) fc.orbit.material.resolution.set(innerWidth, innerHeight);
  approachOrbitMat.resolution.set(innerWidth, innerHeight);
}
addEventListener("resize", resize);
resize();
setSpeedIdx(speedIdx);
rebuildOrbits(centuriesSinceJ2000(julianDate(simDate)));
requestAnimationFrame(tick);
