// ephem.js — analytic heliocentric ephemeris for the major planets.
//
// Uses the JPL "Keplerian Elements for Approximate Positions of the Major
// Planets" table (E.M. Standish, JPL/Caltech). Each element is a value at
// J2000 plus a linear rate per Julian century. Valid 1800 AD – 2050 AD with
// accuracy of a few arcminutes — more than enough to plot the solar system,
// and it needs no network and no data files: positions for ANY date are
// computed in the browser. That is what makes the time-scrubber free.
//
// Angles in the table are degrees; a, in AU. Output is heliocentric J2000
// ecliptic coordinates in AU: { x, y, z }.

const DEG = Math.PI / 180;

// a (AU) | e | I (deg) | L (deg) | longPeri ϖ (deg) | longNode Ω (deg)
// second row of each entry is the per-century rate.
export const PLANETS = {
  mercury: {
    name: "Mercury", color: 0xb6b0a8, radius: 0.38,
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  venus: {
    name: "Venus", color: 0xe8c596, radius: 0.95,
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  },
  earth: {
    name: "Earth", color: 0x6b93d6, radius: 1.0,
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  },
  mars: {
    name: "Mars", color: 0xc1440e, radius: 0.53,
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  jupiter: {
    name: "Jupiter", color: 0xd8ca9d, radius: 11.2,
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  saturn: {
    name: "Saturn", color: 0xe3d9a6, radius: 9.45, ring: true,
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  uranus: {
    name: "Uranus", color: 0xa6e0e0, radius: 4.0,
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  neptune: {
    name: "Neptune", color: 0x5b8fd4, radius: 3.88,
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
};

// Julian Date (TT, close enough to UTC for this purpose) from a JS Date.
export function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Centuries since J2000.0 (JD 2451545.0).
export function centuriesSinceJ2000(jd) {
  return (jd - 2451545.0) / 36525.0;
}

// Solve Kepler's equation M = E - e*sinE  (M, E in degrees; e dimensionless).
function solveKepler(Mdeg, e) {
  const eStar = e / DEG;            // e in degrees, for the e*sinE term
  let E = Mdeg + eStar * Math.sin(Mdeg * DEG);
  for (let i = 0; i < 8; i++) {
    const dM = Mdeg - (E - eStar * Math.sin(E * DEG));
    const dE = dM / (1 - e * Math.cos(E * DEG));
    E += dE;
    if (Math.abs(dE) < 1e-7) break;
  }
  return E;                          // degrees
}

// Resolve the six elements at centuries T past J2000.
export function elementsAt(planet, T) {
  const [a0, e0, I0, L0, w0, O0] = planet.el;
  const [aR, eR, IR, LR, wR, OR] = planet.rate;
  return {
    a: a0 + aR * T,
    e: e0 + eR * T,
    I: I0 + IR * T,
    L: L0 + LR * T,
    wbar: w0 + wR * T,   // longitude of perihelion ϖ
    O: O0 + OR * T,      // longitude of ascending node Ω
  };
}

// Orbital-plane → heliocentric J2000 ecliptic (AU). Shared by the planets and
// the small-body (dwarf-planet / asteroid / comet) propagators.
//   a (AU), e, ω arg.perihelion (deg), I incl (deg), Ω node (deg), E ecc.anom (deg)
// Rotate a perifocal (orbital-plane) position into heliocentric J2000 ecliptic.
function rotatePerifocal(xp, yp, omegaDeg, IDeg, ODeg) {
  const cw = Math.cos(omegaDeg * DEG), sw = Math.sin(omegaDeg * DEG);
  const cO = Math.cos(ODeg * DEG), sO = Math.sin(ODeg * DEG);
  const cI = Math.cos(IDeg * DEG), sI = Math.sin(IDeg * DEG);
  return {
    x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    z: (sw * sI) * xp + (cw * sI) * yp,
  };
}
function orbitalToEcliptic(a, e, omegaDeg, IDeg, ODeg, Edeg) {
  const E = Edeg * DEG;
  return rotatePerifocal(a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), omegaDeg, IDeg, ODeg);
}

// Heliocentric J2000 ecliptic position (AU) from resolved Standish elements.
export function positionFromElements(k) {
  const { a, e, I, L, wbar, O } = k;
  let M = L - wbar;                              // mean anomaly
  M = ((M % 360) + 540) % 360 - 180;            // wrap to [-180,180]
  const E = solveKepler(M, e);
  return orbitalToEcliptic(a, e, wbar - O, I, O, E);
}

// ---------------------------------------------------------------------------
// Small bodies: dwarf planets / asteroids / comets, given as osculating
// elements at an epoch (JPL SBDB format). a (AU), e, i/om/w (deg), ma mean
// anomaly at epoch (deg), n mean motion (deg/day), epoch (JD). This is exactly
// the element set the M3 GitHub Action will pull from SBDB.
export const DWARFS = {
  ceres:    { name: "Ceres",    color: 0x9a8f80, radius: 0.074, epoch: 2461200.5, a: 2.765552595, e: 0.0796922951, i: 10.58802780, om: 80.24862682, w: 73.29421453, ma: 274.41934638, n: 0.21430445064843 },
  pluto:    { name: "Pluto",    color: 0xc9a880, radius: 0.186, epoch: 2457588.5, a: 39.58862939, e: 0.2518378779, i: 17.14771141, om: 110.29238405, w: 113.70900152, ma: 38.68366347, n: 0.003956838955553 },
  haumea:   { name: "Haumea",   color: 0xe6ddd2, radius: 0.128, epoch: 2461200.5, a: 43.06029024, e: 0.1944430149, i: 28.20847393, om: 121.78605613, w: 240.69054725, ma: 223.21041188, n: 0.003488097731817 },
  makemake: { name: "Makemake", color: 0xd6b89a, radius: 0.112, epoch: 2461200.5, a: 45.57093317, e: 0.1588889954, i: 29.02785604, om: 79.29483382, w: 297.09227334, ma: 169.93799620, n: 0.003203850120050 },
  eris:     { name: "Eris",     color: 0xd8d8e0, radius: 0.183, epoch: 2461200.5, a: 67.93394688, e: 0.4382385348, i: 43.92582795, om: 36.00477044, w: 150.79492358, ma: 211.77443428, n: 0.001760247770619 },
};

// ---------------------------------------------------------------------------
// Interstellar objects — visitors from beyond the solar system, on HYPERBOLIC
// orbits (e > 1, unbound: they pass through once and leave). Elements from JPL
// SBDB: q perihelion distance (AU), e, i/om/w (deg), tp perihelion time (JD).
export const INTERSTELLAR = {
  oumuamua: { name: "1I/'Oumuamua", color: 0xff6b6b, disc: "Oct 2017", peri: "2017-09-09", e: 1.201133796, q: 0.2559115813, i: 122.7417063, om: 24.5969096, w: 241.8105360, tp: 2458006.007321 },
  borisov:  { name: "2I/Borisov",   color: 0x66d9e8, disc: "Aug 2019", peri: "2019-12-08", e: 3.356475783, q: 2.0065208785, i: 44.0526425, om: 308.1477292, w: 209.1236864, tp: 2458826.052846 },
  atlas:    { name: "3I/ATLAS",     color: 0xb98cff, disc: "Jul 2025", peri: "2025-10-29", e: 6.141351449, q: 1.3564810572, i: 175.1164571, om: 322.1696089, w: 128.0228697, tp: 2460977.995263 },
};

const GK = 0.01720209895;   // Gaussian gravitational constant (rad/day, AU)

// Perifocal position for a hyperbolic orbit at Julian date jd.
function hyperbolicXY(el, jd) {
  const a = el.q / (1 - el.e);                  // semi-major axis < 0
  const n = GK / Math.sqrt(Math.pow(-a, 3));    // mean motion (rad/day)
  const M = n * (jd - el.tp);                   // hyperbolic mean anomaly
  let H = Math.asinh(M / el.e);                 // initial guess
  if (!isFinite(H)) H = M >= 0 ? 1 : -1;
  for (let k = 0; k < 100; k++) {               // Newton on  M = e·sinh H − H
    const dH = (el.e * Math.sinh(H) - H - M) / (el.e * Math.cosh(H) - 1);
    H -= dH;
    if (Math.abs(dH) < 1e-11) break;
  }
  return {
    xp: a * (Math.cosh(H) - el.e),
    yp: -a * Math.sqrt(el.e * el.e - 1) * Math.sinh(H),
  };
}

// Heliocentric ecliptic position (AU) of an interstellar object at a JS Date.
export function interstellarPosition(el, date) {
  const { xp, yp } = hyperbolicXY(el, julianDate(date));
  return rotatePerifocal(xp, yp, el.w, el.i, el.om);
}

// The hyperbolic trajectory (AU), swept out to ~targetAU on both branches.
export function interstellarPath(el, targetAU = 48, n = 260) {
  const a = el.q / (1 - el.e), absa = Math.abs(a);
  const hMax = Math.acosh(targetAU / absa + el.e);
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const H = -hMax + 2 * hMax * (k / n);
    pts.push(rotatePerifocal(
      a * (Math.cosh(H) - el.e),
      -a * Math.sqrt(el.e * el.e - 1) * Math.sinh(H),
      el.w, el.i, el.om));
  }
  return pts;
}

// Heliocentric ecliptic position (AU) of a small body at a JS Date.
export function smallBodyPosition(el, date) {
  const jd = julianDate(date);
  let M = el.ma + el.n * (jd - el.epoch);
  M = ((M % 360) + 540) % 360 - 180;
  const E = solveKepler(M, el.e);
  return orbitalToEcliptic(el.a, el.e, el.w, el.i, el.om, E);
}

// Full orbit ellipse (AU) for a small body — sweeps eccentric anomaly.
export function smallBodyOrbit(el, n = 256) {
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push(orbitalToEcliptic(el.a, el.e, el.w, el.i, el.om, (k / n) * 360));
  return pts;
}

// Convenience: heliocentric ecliptic position (AU) of a planet at a JS Date.
export function planetPosition(planet, date) {
  const T = centuriesSinceJ2000(julianDate(date));
  return positionFromElements(elementsAt(planet, T));
}

// Sample a full orbit ellipse at the given epoch — sweeps eccentric anomaly
// 0..2π using the elements resolved at T. Returns array of {x,y,z} in AU.
export function orbitSamples(planet, T, n = 256) {
  const k = elementsAt(planet, T);
  const { a, e, I, wbar, O } = k;
  const omega = wbar - O;
  const cw = Math.cos(omega * DEG), sw = Math.sin(omega * DEG);
  const cO = Math.cos(O * DEG), sO = Math.sin(O * DEG);
  const cI = Math.cos(I * DEG), sI = Math.sin(I * DEG);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const E = (i / n) * 2 * Math.PI;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    pts.push({
      x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      z: (sw * sI) * xp + (cw * sI) * yp,
    });
  }
  return pts;
}
