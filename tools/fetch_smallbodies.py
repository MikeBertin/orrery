#!/usr/bin/env python3
"""Fetch small-body orbital elements from JPL's SBDB Query API and write compact
JSON the Orrery web app propagates client-side.

This is the payload of the M3 GitHub Action (Tier 2 of the data model): it runs
in the cloud on a schedule, hits JPL, and commits the JSON — so the static
GitHub Pages site serves "live" small-body data with no server.

Outputs (to web/data/):
  asteroids.json  — the largest main-belt asteroids (bright => big)
  neos.json       — near-Earth objects (PHAs flagged)
  comets.json     — numbered/known comets

Compact schema per file:
  { "generated": <ISO8601>, "epoch_common": <JD or null>,
    "fields": ["name","a","e","i","om","w","ma","ep","H","pha"],
    "data": [ [ ... ], ... ] }
The elements are osculating (a AU; e; i/om/w/ma deg; ep JD); the client derives
mean motion from a, so no per-body 'n' is stored.
"""
import json, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
OUT = Path(__file__).resolve().parent.parent / "web" / "data"
FIELDS = ["full_name", "a", "e", "i", "om", "w", "ma", "epoch", "H", "pha"]


def query(params):
    """Run one SBDB query; return list of row-dicts."""
    qs = urllib.parse.urlencode(params)
    url = f"{API}?{qs}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                d = json.load(r)
            break
        except Exception as e:  # transient network / rate limit
            if attempt == 3:
                raise
            print(f"  retry {attempt+1} ({e})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    cols = d["fields"]
    return [dict(zip(cols, row)) for row in d.get("data", [])]


def num(x):
    try:
        return round(float(x), 6)
    except (TypeError, ValueError):
        return None


def clean_name(full):
    # "     1 Ceres (A801 AA)" -> "1 Ceres"; drop the provisional-desig paren
    s = " ".join(full.split())
    return s.split(" (")[0]


def rows_to_payload(rows):
    data, epochs = [], set()
    for r in rows:
        a, e = num(r.get("a")), num(r.get("e"))
        ep = num(r.get("epoch"))
        if a is None or e is None or ep is None:
            continue
        epochs.add(ep)
        pha = 1 if str(r.get("pha")).upper() == "Y" else 0
        data.append([
            clean_name(r["full_name"]), a, e,
            num(r.get("i")), num(r.get("om")), num(r.get("w")), num(r.get("ma")),
            ep, num(r.get("H")), pha,
        ])
    common = epochs.pop() if len(epochs) == 1 else None
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "epoch_common": common,
        "fields": ["name", "a", "e", "i", "om", "w", "ma", "ep", "H", "pha"],
        "data": data,
    }


def fetch(name, params):
    print(f"→ {name}: {params}", file=sys.stderr)
    rows = query(params)
    payload = rows_to_payload(rows)
    (OUT / f"{name}.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"  {len(payload['data'])} bodies -> {name}.json", file=sys.stderr)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    common = {"fields": ",".join(FIELDS)}

    # Largest main-belt asteroids: bright absolute magnitude ⇒ big. H<12 keeps
    # the few thousand biggest, which trace the belt cleanly without overloading
    # the per-frame Kepler propagation.
    fetch("asteroids", {**common, "sb-kind": "a",
                        "sb-cdata": json.dumps({"AND": ["H|LT|12"]})})

    # Near-Earth objects — cap to the larger/brighter ones so the layer stays
    # legible (PHAs are flagged for highlighting).
    fetch("neos", {**common, "sb-group": "neo",
                   "sb-cdata": json.dumps({"AND": ["H|LT|19"]})})

    # Comets — numbered/known; their eccentric, inclined orbits are iconic.
    fetch("comets", {**common, "sb-kind": "c"})


if __name__ == "__main__":
    main()
