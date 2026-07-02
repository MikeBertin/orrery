#!/usr/bin/env python3
"""Fetch orbital elements for a curated list of famous periodic comets from JPL
SBDB, so Orrery can draw them as named, focusable objects (the anonymous comet
point-cloud stays; these get orbits + labels).

Curation rule: elliptic solver only — keep e ≲ 0.97 (near-parabolic greats like
Hale-Bopp need a different propagator; see buildStride's e<0.995 cutoff).

Accuracy note: SBDB returns one osculating element set (often decades old, e.g.
Halley's is the 1986 apparition). Two-body propagation across decades drifts
vs. the truly perturbed orbit — Halley's 2061 perihelion lands ~5 months late.
Fine for visualization; don't use for prediction.

Output: web/data/comets_famous.json
  { "generated": <ISO8601>,
    "comets": [ { name, des, note, a,e,i,om,w,ma,ep }, … ] }
"""
import json, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
OUT = Path(__file__).resolve().parent.parent / "web" / "data"

# des → (display name, why it's famous)
FAMOUS = {
    "1P":   ("1P/Halley",            "returns 2061"),
    "2P":   ("2P/Encke",             "shortest period, 3.3 yr"),
    "9P":   ("9P/Tempel 1",          "Deep Impact target, 2005"),
    "55P":  ("55P/Tempel–Tuttle",    "Leonid meteors' parent"),
    "67P":  ("67P/Churyumov–Gerasimenko", "Rosetta/Philae, 2014"),
    "81P":  ("81P/Wild 2",           "Stardust sample return"),
    "103P": ("103P/Hartley 2",       "EPOXI flyby, 2010"),
    "109P": ("109P/Swift–Tuttle",    "Perseid meteors' parent"),
}


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


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    comets = []
    for des, (name, note) in FAMOUS.items():
        url = f"{SBDB}?{urllib.parse.urlencode({'sstr': des, 'full-prec': 'true'})}"
        try:
            d = get_json(url)
            o = d["orbit"]
            e = {x["name"]: x["value"] for x in o["elements"]}
            el = {
                "a": num(e.get("a")), "e": num(e.get("e")), "i": num(e.get("i")),
                "om": num(e.get("om")), "w": num(e.get("w")), "ma": num(e.get("ma")),
                "ep": num(o.get("epoch")),
            }
        except Exception as ex:
            print(f"    SBDB failed for {des}: {ex}", file=sys.stderr)
            continue
        if el["a"] is None or el["e"] is None or el["e"] >= 0.995:
            print(f"    skipping {name}: unusable elements {el}", file=sys.stderr)
            continue
        comets.append({"name": name, "des": des, "note": note, **el})
        print(f"    {name:35s} a={el['a']:7.2f}  e={el['e']:.3f}", file=sys.stderr)
        time.sleep(0.4)

    payload = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "comets": comets}
    (OUT / "comets_famous.json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {len(comets)} comets -> comets_famous.json", file=sys.stderr)


if __name__ == "__main__":
    main()
