// demo-capture.js — records web/demo.gif, the README hero montage.
//
// Drives the local dev server through five beats on ONE page load (no reloads,
// so the scene, data and camera stay continuous) with Playwright + the system
// Chrome, records one continuous .webm, and prints its filename. A second ffmpeg
// pass turns the .webm into an optimised palette-based GIF.
//
// The arc: overview → planets in motion → the Apophis 2029 skim → the whole
// system + Oort halo in log mode → an intimate fly-in to ringed Saturn.
//
//   # 1. dev server on :8055  (see .claude/launch.json → orrery-web)
//   cd web && python3 -m http.server 8055
//
//   # 2. record the webm  (needs: npm i playwright  +  Google Chrome installed)
//   node demo-capture.js                       # writes ./page@<hash>.webm
//
//   # 3. webm -> gif  (needs ffmpeg) — 1.4× speed-up, 640px wide, 12 fps.
//   #    The full-motion 3D starfield compresses badly, so keep it small to
//   #    stay well under GitHub's ~10 MB inline-animation cap (this lands ~8 MB).
//   V=$(ls -t *.webm | head -1)
//   FILT="setpts=PTS/1.4,fps=12,scale=640:-1:flags=lanczos"
//   ffmpeg -i "$V" -vf "$FILT,palettegen=max_colors=144:stats_mode=diff" -y palette.png
//   ffmpeg -i "$V" -i palette.png -lavfi "$FILT[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:new=1" -y web/demo.gif
//
// Re-record whenever the look changes; the GIF goes stale like og.jpg does.

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8055';
const W = 1280, H = 760;
const OUT = process.env.OUT_DIR || '.';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Click a HUD control by id and give the scene a beat to react.
const tap = async (page, id, after = 250) => { await page.click('#' + id); await sleep(after); };

// Drag across the canvas to orbit the camera (OrbitControls), dx/dy in px.
async function orbit(page, dx, dy, ms = 1400) {
  const box = await page.locator('#scene').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await sleep(ms / steps);
  }
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);

  // 0 — Landing hero: inner system on real orbits, everything loaded.
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await sleep(2600);                 // let the SBDB/Horizons JSON land + settle
  await tap(page, 'now', 300);       // clean, known "today" framing
  await sleep(800);

  // 1 — Time in motion: speed up and watch the planets sweep their orbits.
  await tap(page, 'play', 150);      // ensure running
  for (let i = 0; i < 4; i++) await tap(page, 'faster', 140);
  await sleep(2600);
  for (let i = 0; i < 2; i++) await tap(page, 'slower', 120);

  // 2 — The Apophis 2029 skim: the purpose-built cinematic cue. Jumps to three
  //     days out, focuses Apophis, plays in at 1 d/s and auto-slows at closest
  //     approach as the asteroid threads past Earth (0.10 lunar distances).
  await tap(page, 'apophis-demo', 300);
  await sleep(6000);

  // 3 — The whole system + its cometary halo: deselect, pull back, flip to log
  //     distance and reveal the Oort cloud shell, then slowly orbit the view.
  await tap(page, 'info-x', 200);
  await tap(page, 'recenter', 600);
  await tap(page, 'log', 700);
  await tap(page, 'oort', 1000);     // Oort forces log mode on — the grand scale
  await orbit(page, 240, -36, 2000);
  await sleep(400);

  // 4 — Intimate detail: back to real distances and fly in to ringed Saturn —
  //     procedural texture, axial tilt, sidereal spin, day/night terminator.
  await tap(page, 'oort', 250);
  await tap(page, 'log', 600);
  await page.fill('#search', 'Saturn');
  await sleep(350);
  await page.press('#search', 'Enter');
  await sleep(3400);

  await context.close();             // finalizes the video
  await browser.close();

  const fs = require('fs');
  const vids = fs.readdirSync(OUT).filter(f => f.endsWith('.webm'));
  console.log('VIDEO:', vids.join(', '));
})();
