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
import json, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUT = Path(__file__).resolve().parent.parent / "web" / "data"

# id (NAIF) · name · colour · window · step · launch · agency · mission.
# Windows are generous; Horizons clamps to each craft's available SPK coverage
# and we keep whatever returns. Metadata feeds the click info cards.
CRAFT = [
    ("-31",  "Voyager 1",          "#8fd0ff", "1990-01-01", "2035-01-01", "60 d",
     "1977-09-05", "NASA", "Grand Tour flybys; now in interstellar space — the farthest human-made object"),
    ("-32",  "Voyager 2",          "#a7bcff", "1990-01-01", "2035-01-01", "60 d",
     "1977-08-20", "NASA", "Only craft to visit Uranus & Neptune; in interstellar space since 2018"),
    ("-98",  "New Horizons",       "#ff9de2", "2006-02-01", "2035-01-01", "30 d",
     "2006-01-19", "NASA", "First Pluto flyby (2015), then Arrokoth (2019); leaving the system"),
    ("-96",  "Parker Solar Probe", "#ffce6b", "2018-08-13", "2026-08-01", "2 d",
     "2018-08-12", "NASA", "Skims the corona at ~6 M km — the fastest human-made object"),
    ("-170", "JWST",               "#7fe0c8", "2022-01-25", "2027-06-01", "3 d",
     "2021-12-25", "NASA/ESA/CSA", "Infrared space telescope orbiting Sun–Earth L2"),
    ("-61",  "Juno",               "#ff8f5a", "2016-07-05", "2025-09-15", "3 d",
     "2011-08-05", "NASA", "Jupiter polar orbiter — interior, gravity and aurorae"),
    ("-49",  "Lucy",               "#c8a0ff", "2021-10-17", "2033-01-01", "10 d",
     "2021-10-16", "NASA", "Touring the Jupiter Trojan asteroids — 8+ flybys through 2033"),
    ("-144", "Solar Orbiter",      "#ffe08a", "2020-02-11", "2029-01-01", "4 d",
     "2020-02-10", "ESA/NASA", "Close-in solar observatory imaging the Sun's poles"),
    ("-159", "Europa Clipper",     "#9fe0ff", "2024-10-15", "2030-06-01", "10 d",
     "2024-10-14", "NASA", "En route to Europa — ocean-habitability survey (arrives 2030)"),
    ("-255", "Psyche",             "#cfd0d8", "2023-10-14", "2029-06-01", "10 d",
     "2023-10-13", "NASA", "En route to the metal asteroid 16 Psyche (arrives 2029)"),
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
    for cmd, name, color, start, stop, step, launch, agency, mission in CRAFT:
        print(f"→ {name} ({cmd})", file=sys.stderr)
        try:
            text = horizons_vectors(cmd, start, stop, step)
        except Exception as e:
            print(f"    FAILED: {e}", file=sys.stderr)
            continue
        t, p = parse_vectors(text)
        if not t:
            note = text.split("\n")[0] if text else "no response"
            print(f"    no vectors ({note})", file=sys.stderr)
            continue
        out.append({"name": name, "color": color, "launch": launch,
                    "agency": agency, "mission": mission, "t": t, "p": p})
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
