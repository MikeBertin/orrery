// demo-capture.js — records the three README GIFs, one continuous shot each:
//
//   wide     web/demo-wide.gif     the Sun with everything revolving at
//                                  30 d/s while the camera slowly pans,
//                                  bringing the Milky Way's bright core
//                                  (real galactic coordinates) behind it
//   jupiter  web/demo-jupiter.gif  fly-in to Jupiter, the Galileans
//                                  whirling (Io laps in ~1.8 s at 1 d/s)
//   apophis  web/demo-apophis.gif  the built-in 2029 demo cue: Apophis
//                                  threads past Earth at 0.10 LD, the
//                                  clock auto-slowing at closest approach
//
// Each shot is its own page load + its own .webm (written to OUT_DIR/<shot>/),
// recorded with Playwright + the system Chrome.
//
//   # 1. dev server on :8055  (see .claude/launch.json → orrery-web)
//   cd web && python3 -m http.server 8055
//
//   # 2. record  (needs: npm i playwright  +  Google Chrome installed)
//   node demo-capture.js                # or SHOT=wide node demo-capture.js
//
//   # 3. webm -> gif  (needs ffmpeg) — and CADENCE MATTERS: the webm is 25 fps,
//   #    so pick speed×fps pairs that sample every Nth frame EXACTLY, or camera
//   #    pans judder (uneven frame steps). Two proven recipes:
//   #      jupiter/apophis: ×1.333 → 33.33 fps content, fps=50/3 = every 2nd
//   #      wide:            ×1.5   → 37.5  fps content, fps=12.5 = every 3rd
//   #    (wide is full-frame starfield motion — it compresses ~2× worse than
//   #    the dark close-ups, hence the lower rate + 600px to stay under
//   #    GitHub's ~10 MB inline-animation cap. trim= skips the load settle.)
//   V=$(ls -t <shot>/*.webm | head -1)
//   # jupiter: trim=start=2.9   apophis: trim=start=2.7   — then:
//   FILT="trim=start=<T>,setpts=(PTS-STARTPTS)*0.75,fps=50/3,scale=640:-1:flags=lanczos"
//   # wide:
//   FILT="trim=start=3.4:end=14.8,setpts=(PTS-STARTPTS)/1.5,fps=12.5,scale=600:-1:flags=lanczos"
//   ffmpeg -i "$V" -vf "$FILT,palettegen=max_colors=128:stats_mode=diff" -y palette.png
//   ffmpeg -i "$V" -i palette.png -lavfi "${FILT}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:new=1" -y web/demo-<shot>.gif
//   # NB the ${FILT} braces: zsh parses $FILT[x] as a subscript and silently
//   # empties it — the graph then starts with ';' and ffmpeg says
//   # "No such filter: ''".
//
// Re-record whenever the look changes; the GIFs go stale like og.jpg does.

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8055';
const W = 1280, H = 720;
const OUT = process.env.OUT_DIR || '.';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Click a HUD control by id and give the scene a beat to react.
const tap = async (page, id, after = 250) => { await page.click('#' + id); await sleep(after); };

// Drag across the canvas to orbit the camera (OrbitControls), dx/dy in px.
// Eased (cosine) so the pan starts and ends gently instead of snapping.
// GOTCHA: the floating body labels are pointer-events:auto and sit ABOVE the
// canvas — a mousedown that lands on one goes to the label (possibly focusing
// that body) and the drag never reaches OrbitControls. Probe for empty sky.
async function orbit(page, dx, dy, ms = 1400) {
  const [cx, cy] = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const spots = [[.5, .5], [.42, .38], [.58, .34], [.35, .55], [.62, .55], [.45, .25], [.3, .4]]
      .map(([fx, fy]) => [Math.round(W * fx), Math.round(H * fy)]);
    for (const [x, y] of spots) {
      const el = document.elementFromPoint(x, y);
      if (el && el.id === 'scene') return [x, y];
    }
    return spots[0];
  });
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = Math.max(30, Math.round(ms / 33));
  for (let i = 1; i <= steps; i++) {
    const e = (1 - Math.cos((Math.PI * i) / steps)) / 2;   // ease in-out
    await page.mouse.move(cx + dx * e, cy + dy * e);
    await sleep(ms / steps);
  }
  await page.mouse.up();
}

// ---- the three shots -------------------------------------------------------

const SHOTS = {
  // The Sun with everything revolving around it; a slow pan swings the Milky
  // Way's bright galactic core through the background.
  async wide(page) {
    await tap(page, 'now', 300);
    // NOTE: the app auto-plays on load — do NOT tap #play here, it PAUSES.
    await tap(page, 'faster', 120);                        // 1 d/s → 7 d/s
    await tap(page, 'faster', 200);                        // → 30 d/s
    await sleep(1500);
    await orbit(page, 340, -30, 5200);                     // slow sweep, core rises behind
    await sleep(2600);
  },

  // Jupiter close-up: the app's own smooth fly-in, then hold while the four
  // Galilean moons whirl (Io's period is 1.77 d — a lap every ~1.8 s at 1 d/s).
  async jupiter(page) {
    await page.fill('#search', 'Jupiter');
    await sleep(300);
    await page.press('#search', 'Enter');
    await sleep(3200);                                     // fly-in
    await sleep(5800);                                     // hold: moons orbit, GRS turns
  },

  // The Apophis 2029 skim — the built-in demo cue does the cinematography:
  // jumps three days out, focuses, cruises in at 1 d/s, auto-slows to 1 h/s
  // inside ±12 h of closest approach (0.10 LD, inside the geostationary ring).
  async apophis(page) {
    await tap(page, 'apophis-demo', 300);
    await sleep(10500);
  },
};

// ---- runner ----------------------------------------------------------------

(async () => {
  const which = process.env.SHOT ? [process.env.SHOT] : Object.keys(SHOTS);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const name of which) {
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      // DSF 1, not 2: at 2× headless Chrome renders the WebGL scene at 4×
      // the pixels and drops ~25% of frames — the recording stutters. 1280px
      // native is already 2× the final GIF width.
      deviceScaleFactor: 1,
      recordVideo: { dir: `${OUT}/${name}`, size: { width: W, height: H } },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(BASE + '/', { waitUntil: 'load' });
    // camera drags sweep across the HTML labels and would select their text
    // (blue highlights all over the frame) — kill selection for the shoot
    await page.addStyleTag({ content: '*{user-select:none!important;-webkit-user-select:none!important}' });
    await sleep(2600);                 // let the SBDB/Horizons JSON land + settle
    await SHOTS[name](page);
    await context.close();             // finalizes the video
    console.log('DONE:', name);
  }

  await browser.close();
})();
