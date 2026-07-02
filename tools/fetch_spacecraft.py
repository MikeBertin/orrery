#!/usr/bin/env python3
"""Fetch active-spacecraft trajectories from JPL Horizons and write JSON the
Orrery web app interpolates.

This is Tier 3 of the data model. Spacecraft don't follow Keplerian orbits
(thrust, gravity assists), so there are no elements to propagate — instead
Horizons gives sampled state vectors, which a daily GitHub Action commits and
the client interpolates between. Positions are heliocentric Ecliptic-of-J2000
(AU), the same frame as the analytic planets.

Output: web/data/spacecraft.json
  { "generated": <ISO8601>,
    "craft": [ { "name","color","launch","agency","mission","t":[JD…],"p":[x,y,z, …] }, … ] }
"""
import json, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUT = Path(__file__).resolve().parent.parent / "web" / "data"

# id (NAIF) · name · colour · window · step · launch · agency · mission ·
# size · launch mass. Windows are generous; fetch_window clamps to each
# craft's available SPK coverage. Metadata feeds the click info cards.
CRAFT = [
    ("-31",  "Voyager 1",          "#8fd0ff", "1990-01-01", "2035-01-01", "60 d",
     "1977-09-05", "NASA", "Grand Tour flybys; now in interstellar space — the farthest human-made object",
     "3.7 m dish + booms", "825 kg"),
    ("-32",  "Voyager 2",          "#a7bcff", "1990-01-01", "2035-01-01", "60 d",
     "1977-08-20", "NASA", "Only craft to visit Uranus & Neptune; in interstellar space since 2018",
     "3.7 m dish + booms", "825 kg"),
    ("-98",  "New Horizons",       "#ff9de2", "2006-02-01", "2035-01-01", "30 d",
     "2006-01-19", "NASA", "First Pluto flyby (2015), then Arrokoth (2019); leaving the system",
     "2.2×2.7 m — piano-sized", "478 kg"),
    ("-96",  "Parker Solar Probe", "#ffce6b", "2018-08-13", "2026-08-01", "2 d",
     "2018-08-12", "NASA", "Skims the corona at ~6 M km — the fastest human-made object",
     "3 m tall · 2.3 m heat shield", "685 kg"),
    ("-170", "JWST",               "#7fe0c8", "2022-01-25", "2027-06-01", "3 d",
     "2021-12-25", "NASA/ESA/CSA", "Infrared space telescope orbiting Sun–Earth L2",
     "6.5 m mirror · 21×14 m sunshield", "6,161 kg"),
    ("-61",  "Juno",               "#ff8f5a", "2016-07-05", "2025-09-15", "3 d",
     "2011-08-05", "NASA", "Jupiter polar orbiter — interior, gravity and aurorae",
     "20 m across (solar arrays)", "3,625 kg"),
    ("-49",  "Lucy",               "#c8a0ff", "2021-10-17", "2033-01-01", "10 d",
     "2021-10-16", "NASA", "Touring the Jupiter Trojan asteroids — 8+ flybys through 2033",
     "13 m tip-to-tip", "1,550 kg"),
    ("-144", "Solar Orbiter",      "#ffe08a", "2020-02-11", "2029-01-01", "4 d",
     "2020-02-10", "ESA/NASA", "Close-in solar observatory imaging the Sun's poles",
     "18 m across (arrays)", "1,800 kg"),
    ("-159", "Europa Clipper",     "#9fe0ff", "2024-10-15", "2030-06-01", "10 d",
     "2024-10-14", "NASA", "En route to Europa — ocean-habitability survey (arrives 2030)",
     "30.5 m across — largest planetary probe", "6,065 kg"),
    ("-255", "Psyche",             "#cfd0d8", "2023-10-14", "2029-06-01", "10 d",
     "2023-10-13", "NASA", "En route to the metal asteroid 16 Psyche (arrives 2029)",
     "24.8 m across (arrays)", "2,608 kg"),
    ("-121", "BepiColombo",        "#e8b46a", "2018-10-21", "2026-11-01", "5 d",
     "2018-10-20", "ESA/JAXA", "Twin Mercury orbiters — arriving Nov 2026 after nine flybys",
     "6.3 m stack · 30 m arrays", "4,100 kg"),
    ("-91",  "Hera",               "#9fe08f", "2024-10-08", "2027-06-01", "5 d",
     "2024-10-07", "ESA", "Surveying Didymos–Dimorphos, the asteroid DART deflected (arrives Dec 2026)",
     "1.6×1.7 m box + 5 m arrays", "1,801 kg"),
    ("-64",  "OSIRIS-APEX",        "#ff9ec0", "2023-09-25", "2029-09-01", "10 d",
     "2016-09-08", "NASA", "OSIRIS-REx extended — chasing Apophis to its 2029 Earth flyby",
     "6.2 m across (arrays)", "2,110 kg"),
]


def horizons_vectors(cmd, start, stop, step):
    params = {
        "format": "text", "COMMAND": f"'{cmd}'", "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'VECTORS'",
        "CENTER": "'500@10'", "REF_PLANE": "'ECLIPTIC'",
        "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'", "VEC_TABLE": "'1'",
        "OUT_UNITS": "'AU-D'", "CSV_FORMAT": "'YES'",
    }
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            if attempt == 3:
                raise
            print(f"    retry {attempt+1} ({e})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def fetch_window(cmd, start, stop, step):
    """Query vectors; if Horizons rejects the window because the craft's SPK
    coverage ends earlier (or starts later) than requested, clamp to the
    boundary it reports and retry. Keeps CRAFT windows generous without
    breaking when a mission's kernel ends (e.g. Hera stops at rendezvous)."""
    for _ in range(3):
        text = horizons_vectors(cmd, start, stop, step)
        if "$$SOE" in text:
            return text
        m = re.search(r"No ephemeris for target .* after A\.D\. (\d{4}-[A-Za-z]{3}-\d{2})", text)
        if m:
            stop = m.group(1)
            print(f"    coverage ends {stop}; clamping", file=sys.stderr)
            continue
        m = re.search(r"No ephemeris for target .* prior to A\.D\. (\d{4}-[A-Za-z]{3}-\d{2})", text)
        if m:
            start = m.group(1)
            print(f"    coverage starts {start}; clamping", file=sys.stderr)
            continue
        return text
    return text


def parse_vectors(text):
    """Pull JD + X,Y,Z (AU) from the $$SOE…$$EOE CSV block."""
    t, p = [], []
    if "$$SOE" not in text:
        return t, p
    block = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    for line in block.strip().splitlines():
        f = [c.strip() for c in line.split(",")]
        if len(f) < 5:
            continue
        try:
            t.append(round(float(f[0]), 6))
            p.extend([round(float(f[2]), 8), round(float(f[3]), 8), round(float(f[4]), 8)])
        except ValueError:
            continue
    return t, p


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    out = []
    for cmd, name, color, start, stop, step, launch, agency, mission, size, mass in CRAFT:
        print(f"→ {name} ({cmd})", file=sys.stderr)
        try:
            text = fetch_window(cmd, start, stop, step)
        except Exception as e:
            print(f"    FAILED: {e}", file=sys.stderr)
            continue
        t, p = parse_vectors(text)
        if not t:
            note = text.split("\n")[0] if text else "no response"
            print(f"    no vectors ({note})", file=sys.stderr)
            continue
        out.append({"name": name, "color": color, "launch": launch,
                    "agency": agency, "mission": mission,
                    "size": size, "mass": mass, "t": t, "p": p})
        print(f"    {len(t)} samples", file=sys.stderr)
        time.sleep(0.5)   # be polite to Horizons

    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "craft": out,
    }
    (OUT / "spacecraft.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {len(out)} craft -> spacecraft.json", file=sys.stderr)


if __name__ == "__main__":
    main()
