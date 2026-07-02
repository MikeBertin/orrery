# Orrery — the solar system in 3D

A live, scrubable 3D model of everything we can track in the solar system,
plotted from real orbital data. Vanilla + Three.js, ships static to GitHub
Pages. Sister project to **Lynceus** (JWST galaxy ML).

**▶ Live: [mikebertin.github.io/orrery](https://mikebertin.github.io/orrery/)** —
try [the Apophis 2029 flyby](https://mikebertin.github.io/orrery/#2029-04-13/Apophis)
or [Halley's return](https://mikebertin.github.io/orrery/#2061-07-28/1P%2FHalley).

> An *orrery* is a mechanical model of the solar system. This is the software one.

## The "static site + real-time data" trick

GitHub Pages only serves static files — but a **scheduled GitHub Action** runs
in the cloud, fetches live data, and commits it back as JSON. The site reads
those files. "Real-time" = "refreshed on a cadence." Most of the solar system
doesn't need fetching at all, giving a three-tier model:

| Tier | Bodies | Source | How | Refresh |
|------|--------|--------|-----|---------|
| **1 Analytic** | Sun, 8 planets, major moons | JPL Keplerian elements (baked into JS) | computed in-browser for any date | never — exact, offline |
| **2 Elements** | asteroids, NEOs, comets | JPL Small-Body DB | elements → JSON, Kepler-propagated client-side | weekly Action |
| **3 Sampled** | spacecraft (Voyager, JWST, Parker, Juno…) | JPL Horizons | position tables → JSON, interpolated client-side | daily Action |

The time-scrubber works on Tier 1 across centuries for free. The only thing
this can't do is sub-second live tracking — meaningless at AU scale anyway.

## Locked decisions (2026-06-30)

1. **Scope:** everything trackable, incl. active spacecraft.
2. **Architecture:** static site on Pages; a scheduled GitHub Action is the
   "backend" that fetches live data into committed JSON. No runtime server.
3. **Time:** full time-scrubber (rewind / fast-forward / jump-to-date / now).
4. **Stack:** vanilla JS + Three.js (CDN), no framework. Chiron/Hermes house style.
5. **Codename:** Orrery.

## Milestones

- **M1 — offline core** ✅ *(built)*: Three.js scene, Sun + 8 planets on real
  analytic orbits ([ephem.js](web/ephem.js), JPL Standish elements), time
  engine (play/pause, variable speed, ±100yr scrub, jump-to-date), orbit
  ellipses, log-distance toggle, body-size slider, click-to-focus + info card,
  starfield, floating labels.
- **M2 — moons & dwarf planets** ✅ *(built)*: 5 dwarf planets (Ceres, Pluto,
  Haumea, Makemake, Eris) on real osculating orbits from JPL SBDB (new
  small-body propagator in [ephem.js](web/ephem.js), the same element format M3
  will use); 16 major moons across 7 parents rendered schematically (real
  periods/inclinations/order, exaggerated radii so they read on zoom — labels
  gate on proximity). `dwarfs` & `moons` HUD toggles. Per-body textures deferred.
- **M3 — small bodies (Tier 2)** ✅ *(built)*: [tools/fetch_smallbodies.py](tools/fetch_smallbodies.py)
  pulls ~9k largest asteroids, ~2.5k NEOs, ~2.3k comets from JPL SBDB into
  compact `web/data/*.json`; a scheduled **GitHub Action**
  ([data.yml](.github/workflows/data.yml)) refreshes & commits them weekly — the
  "backend". Client propagates all ~14k bodies in-browser (precomputed rotation
  coeffs + throttled Kepler solve) as point clouds; `asteroids` / `NEOs` /
  `comets` layer toggles; PHAs highlighted red. **This proves the static-Pages +
  live-data architecture end to end.**
- **M4 — spacecraft (Tier 3)** ✅ *(built)*: [tools/fetch_spacecraft.py](tools/fetch_spacecraft.py)
  pulls sampled state vectors from **JPL Horizons** for 10 active missions
  (Voyagers, New Horizons, Parker, JWST, Juno, Lucy, Solar Orbiter, Europa
  Clipper, Psyche) → `web/data/spacecraft.json`; the daily Action refreshes
  them. Client draws each craft's trajectory **trail** + a marker that
  interpolates between samples and appears only within its data window.
  `spacecraft` toggle.
- **M5 — polish & ship** *(in progress)*: ✅ label collision-avoidance
  (priority-ranked, focused always wins), ✅ search / go-to box with smooth
  camera fly-to, ✅ JPL data credit, ✅ **data-freshness chip** (HUD shows the
  oldest `generated` stamp among the loaded JSONs, and calls out any layer
  whose fetch failed), ✅ **shareable URLs** (`#YYYY-MM-DD/Body`, e.g.
  `#2029-04-13/Apophis` — restores the date paused and flies to the body),
  ✅ **Apophis demo button** in the approaches panel (cues the 2029 pass:
  jumps 3 days out, focuses, plays at 1 d/s). Remaining: OG image and **deploy
  to `mikebertin.github.io/orrery`** (init repo + push so the data Actions
  start running).
- **Kuiper belt** ✅ *(built)*: ~6,400 trans-Neptunian objects from JPL SBDB
  (`sb-class=TNO`) through the same element→point-cloud pipeline as the
  asteroids — the icy ring at 30–50 AU plus the scattered disc, finally
  giving Pluto, Haumea, Makemake and Eris their context. `Kuiper belt`
  toggle; refreshed by the same Action.
- **Oort cloud** ✅ *(built)*: a schematic isotropic shell of ~4,500 points
  from 2,000–50,000 AU (density thinning outward). Its inner edge is 66×
  beyond Neptune, so the `Oort cloud` toggle flips on log-distance mode —
  the one view where the whole solar system *and* its cometary halo fit on
  screen. That sphere-vs-disc contrast is the point.
- **Info cards** ✅: every clickable thing explains itself — planets carry
  mass/radius/volume/day/year/moon-count, dwarf planets their mass, discovery
  + a "known for" note, moons their mass, spacecraft their
  mission/launch/agency, comets their claim to fame + nucleus size/mass,
  NEOs their pass details, interstellar visitors their eccentricity and size.
  Small-body sizes use SBDB's measured diameter when one exists (Apophis:
  340 m by radar), else an H-magnitude estimate; mass/volume are derived from
  size at an assumed bulk density (stony for NEOs, fluffy ice for comet
  nuclei) and labelled as estimates.
- **Famous comets** ✅ *(built)*: the comet point-cloud is anonymous, so eight
  greats get names, real orbits and info cards — 1P/Halley, 2P/Encke,
  9P/Tempel 1, 55P/Tempel–Tuttle (Leonids), 67P/Churyumov–Gerasimenko
  (Rosetta), 81P/Wild 2 (Stardust), 103P/Hartley 2, 109P/Swift–Tuttle
  (Perseids). [tools/fetch_famous_comets.py](tools/fetch_famous_comets.py) →
  SBDB elements → `web/data/comets_famous.json` (refreshed by the Action);
  they ride the `comets` layer toggle. (Two-body propagation drifts vs. the
  perturbed truth over decades — Halley's 2061 perihelion lands ~5 months
  late; fine for visualisation.)
- **Interstellar objects** ✅ *(built)*: the three known visitors from beyond
  the solar system — **1I/'Oumuamua** (2017), **2I/Borisov** (2019) and
  **3I/ATLAS** (2025) — on their real **hyperbolic** (unbound, e>1) trajectories.
  Needed a hyperbolic-Kepler propagator ([ephem.js](web/ephem.js) `interstellarPosition`);
  each is drawn as an open trajectory + marker, focusable, with an info card
  showing its eccentricity and perihelion. `interstellar` toggle.
- **Close approaches to Earth** ✅ *(built)*: [tools/fetch_close_approaches.py](tools/fetch_close_approaches.py)
  pulls upcoming Earth close passes from JPL's **CAD API** (next 15 yr, <0.05 AU)
  + each object's orbit from SBDB → `web/data/close_approaches.json` (50 closest).
  Flagged as magenta markers, listed in a click-to-jump panel (date · object ·
  miss distance in lunar distances), with a pulse + Earth flag-line during the
  pass. Led by **Apophis, 0.10 LD on 2029-Apr-13**. `⚠ approaches` toggle.

## Run locally

```sh
cd web && python3 -m http.server 8000   # http://localhost:8000
```

## Look & feel

Planets/moons/Sun are rendered with **procedural textures** ([textures.js](web/textures.js)) —
3D value noise sampled on the sphere (no seams, no image assets): Earth's
oceans/land/ice, red Mars, Jupiter's banded belts + Great Red Spot, Saturn's
ringed bands, the ice giants, a granulated Sun with corona, and tinted moons.
Each planet has its real **axial tilt** and spins at its **sidereal rate**; the
Sun lights one hemisphere so you get a day/night terminator. `go to` / click
smoothly flies the camera in to a close framing.

## Layout

```
orrery/
  web/
    index.html     # HUD + scene shell (house style)
    ephem.js       # analytic ephemeris + small-body Kepler propagator
    textures.js    # procedural planet/moon/ring/sun textures (noise-based)
    orrery.js      # Three.js renderer + time engine + layers
    data/          # Action-committed JSON: asteroids / neos / comets / spacecraft / approaches / famous comets
  tools/
    fetch_smallbodies.py          # SBDB    → web/data/{asteroids,neos,comets}.json
    fetch_spacecraft.py           # Horizons → web/data/spacecraft.json
    fetch_close_approaches.py     # CAD+SBDB → web/data/close_approaches.json
    fetch_famous_comets.py        # SBDB    → web/data/comets_famous.json
  .github/workflows/
    pages.yml      # deploy web/ to Pages (on push to main)
    data.yml       # daily: refresh SBDB + Horizons data, commit → triggers deploy
```

## Accuracy note

Tier-1 positions use the JPL approximate Keplerian elements (Standish), valid
**1800–2050** to a few arcminutes — ideal for visualisation. Outside that range
positions drift; M2+ will swap in higher-order theory (VSOP87) if needed.
