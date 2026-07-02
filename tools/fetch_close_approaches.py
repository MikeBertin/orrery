#!/usr/bin/env python3
"""Fetch upcoming Earth close approaches from JPL's CAD API, then each object's
orbit from SBDB, so Orrery can flag & plot the objects that will pass near Earth.

Output: web/data/close_approaches.json
  { "generated": <ISO8601>,
    "objects": [ { name, des, jd, cd, ld (lunar distances), v (km/s),
                   a,e,i,om,w,ma,ep }, … ] }   # sorted by miss distance
The orbital elements let the client propagate & draw each object like any small
body; ld/jd/v drive the flag + the "close approaches" list.
"""
import json, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

CAD = "https://ssd-api.jpl.nasa.gov/cad.api"
SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
OUT = Path(__file__).resolve().parent.parent / "web" / "data"
AU_PER_LD = 1 / 389.17          # AU per lunar distance (1 AU ≈ 389.17 LD)
MAX_OBJECTS = 50                # cap: the closest N passes (keeps it curated)


def get_json(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            if attempt == 3:
                raise
            print(f"    retry {attempt+1} ({e})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def num(x):
    try:
        return round(float(x), 6)
    except (TypeError, ValueError):
        return None


def sbdb_elements(des):
    url = f"{SBDB}?{urllib.parse.urlencode({'sstr': des, 'full-prec': 'true'})}"
    try:
        d = get_json(url)
        o = d["orbit"]
        e = {x["name"]: x["value"] for x in o["elements"]}
        return {
            "a": num(e.get("a")), "e": num(e.get("e")), "i": num(e.get("i")),
            "om": num(e.get("om")), "w": num(e.get("w")), "ma": num(e.get("ma")),
            "ep": num(o.get("epoch")),
        }
    except Exception as ex:
        print(f"    SBDB failed for {des}: {ex}", file=sys.stderr)
        return None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    params = {
        "body": "Earth",
        "date-min": now.strftime("%Y-%m-%d"),
        "date-max": (now + timedelta(days=365 * 15)).strftime("%Y-%m-%d"),
        "dist-max": "0.05", "sort": "dist", "fullname": "true", "h-max": "30",
    }
    print("→ CAD: upcoming Earth close approaches", file=sys.stderr)
    cad = get_json(f"{CAD}?{urllib.parse.urlencode(params)}")
    cols = cad["fields"]
    rows = [dict(zip(cols, r)) for r in cad.get("data", [])]
    print(f"  {len(rows)} approaches; keeping closest per object", file=sys.stderr)

    # closest approach per object (already dist-sorted → first seen is closest)
    best = {}
    for r in rows:
        best.setdefault(r["des"], r)
    ordered = sorted(best.values(), key=lambda r: float(r["dist"]))[:MAX_OBJECTS]

    objects = []
    for r in ordered:
        des = r["des"]
        el = sbdb_elements(des)
        time.sleep(0.4)
        if not el or el["a"] is None or el["e"] is None or el["e"] >= 1:
            continue
        objects.append({
            "name": (r.get("fullname") or des).strip(),
            "des": des,
            "jd": num(r["jd"]), "cd": r["cd"],
            "ld": round(float(r["dist"]) / AU_PER_LD, 3),
            "v": round(float(r["v_rel"]), 2),
            **el,
        })
        print(f"    {objects[-1]['name'][:30]:30s} {objects[-1]['ld']:6.2f} LD", file=sys.stderr)

    payload = {"generated": now.isoformat(timespec="seconds"), "objects": objects}
    (OUT / "close_approaches.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {len(objects)} objects -> close_approaches.json", file=sys.stderr)


if __name__ == "__main__":
    main()
