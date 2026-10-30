#!/usr/bin/env python3
"""Convert the openrocket-database parts files into RocketWright presets.

Reads every `orc/*.orc` (and `*.ORC`) file of the Apache-2.0
`openrocket-database` checkout (plan D21, M2.13; never the copy inside the
OpenRocket submodule) and writes one `lib/presets/<stem>.json` per parts
file. Python 3, standard library only, byte-deterministic.

Each preset keeps the catalog's own values and units ("0.976 in", "1.2 oz")
in RocketWright source form (`type = "body_tube"`, `od`, `id`, ...).
Densities are SI by material type (OpenRocket ignores the
`UnitsOfMeasure` attribute): bulk kg/m^3, surface kg/m^2, line kg/m.
Fields the catalog lacks (parachute `cd`, packed sizes) are left for the
user to set when adding a part. Parts of kinds RocketWright has no preset
mapping for are skipped and counted.

Usage:
    python3 -I scripts/presets/gen_presets.py <openrocket-database dir> <out dir>
    python3 -I scripts/presets/gen_presets.py <openrocket-database dir> <out dir> --check
"""

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

DENSITY_UNIT = {"BULK": "kg/m^3", "SURFACE": "kg/m^2", "LINE": "kg/m"}
DENSITY_KEY = {"BULK": "density", "SURFACE": "surface_density", "LINE": "line_density"}
SHAPES = {
    "OGIVE": "ogive",
    "CONICAL": "conical",
    "ELLIPSOID": "ellipsoid",
    "POWER": "power",
    "PARABOLIC": "parabolic",
    "HAACK": "haack",
}
TUBES = {
    "BodyTube": "body_tube",
    "TubeCoupler": "coupler",
    "LaunchLug": "launch_lug",
    "CenteringRing": "centering_ring",
    "EngineBlock": "engine_block",
}


def slug(text):
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or "part"


def num(el):
    try:
        return float(el.text.strip())
    except (AttributeError, ValueError):
        return None


def qty(part, tag):
    """`"<value> <unit>"` for a positive dimension, else None."""
    el = part.find(tag)
    v = num(el)
    if v is None or v <= 0:
        return None
    unit = el.get("Unit", "m").strip()
    return f"{el.text.strip()} {unit}"


def text(part, tag):
    el = part.find(tag)
    return " ".join(el.text.split()) if el is not None and el.text else ""


def materials_of(root):
    out = {}
    mats = root.find("Materials")
    if mats is None:
        return out
    for m in mats:
        name = text(m, "Name")
        kind = text(m, "Type").upper()
        d = num(m.find("Density"))
        if not name or kind not in DENSITY_KEY or d is None:
            continue
        out[(name, kind)] = {
            DENSITY_KEY[kind]: f"{m.find('Density').text.strip()} {DENSITY_UNIT[kind]}",
            "doc": name,
        }
    return out


def shoulder(part, length_tag, od_tag):
    length, od = qty(part, length_tag), qty(part, od_tag)
    if length is None or od is None:
        return None
    return {"length": length, "od": od}


def component(part, mat_slug, line_slug):
    """RocketWright source form of one catalog part, or None if unmapped."""
    tag = part.tag
    c = {}
    if tag in TUBES:
        c["type"] = TUBES[tag]
        for k, t in (("length", "Length"), ("od", "OutsideDiameter"), ("id", "InsideDiameter")):
            v = qty(part, t)
            if v is not None:
                c[k] = v
        need = ("length", "id") if tag in ("CenteringRing", "EngineBlock") else ("length", "od")
    elif tag == "BulkHead":
        c["type"] = "bulkhead"
        for k, t in (("length", "Length"), ("od", "OutsideDiameter")):
            v = qty(part, t)
            if v is not None:
                c[k] = v
        need = ("length",)
    elif tag == "NoseCone":
        c["type"] = "nose_cone"
        c["shape"] = SHAPES.get(text(part, "Shape").upper())
        c["length"] = qty(part, "Length")
        c["od"] = qty(part, "OutsideDiameter")
        filled = text(part, "Filled").lower() == "true"
        th = qty(part, "Thickness")
        if th is not None and not filled:
            c["thickness"] = th
        sh = shoulder(part, "ShoulderLength", "ShoulderDiameter")
        if sh is not None:
            c["shoulder"] = sh
        need = ("shape", "length", "od")
    elif tag == "Transition":
        c["type"] = "transition"
        c["shape"] = SHAPES.get(text(part, "Shape").upper())
        c["length"] = qty(part, "Length")
        c["fore_od"] = qty(part, "ForeOutsideDiameter")
        c["aft_od"] = qty(part, "AftOutsideDiameter")
        filled = text(part, "Filled").lower() == "true"
        th = qty(part, "Thickness")
        if th is not None and not filled:
            c["thickness"] = th
        for k, lt, dt in (
            ("fore_shoulder", "ForeShoulderLength", "ForeShoulderDiameter"),
            ("aft_shoulder", "AftShoulderLength", "AftShoulderDiameter"),
        ):
            sh = shoulder(part, lt, dt)
            if sh is not None:
                c[k] = sh
        need = ("shape", "length", "fore_od", "aft_od")
    elif tag == "Parachute":
        c["type"] = "parachute"
        c["diameter"] = qty(part, "Diameter")
        lc = num(part.find("LineCount"))
        if lc is not None and lc > 0:
            c["line_count"] = int(lc)
        ll = qty(part, "LineLength")
        if ll is not None:
            c["line_length"] = ll
        if line_slug:
            c["line_material"] = line_slug
        need = ("diameter",)
    elif tag == "Streamer":
        c["type"] = "streamer"
        c["length"] = qty(part, "Length")
        c["width"] = qty(part, "Width")
        need = ("length", "width")
    else:
        return None
    if any(c.get(k) is None for k in need):
        return None
    c = {k: v for k, v in c.items() if v is not None}
    if mat_slug:
        c["material"] = mat_slug
    mass = qty(part, "Mass")
    if mass is not None:
        c["override"] = {"mass": mass}
    return c


def convert(path, generic, rel):
    root = ET.parse(path).getroot()
    own = materials_of(root)
    used = {}
    presets = []
    seen = {}
    skipped = 0

    def material(el):
        if el is None or not el.text:
            return None
        name = " ".join(el.text.split())
        kind = el.get("Type", "BULK").upper()
        m = own.get((name, kind)) or generic.get((name, kind))
        if m is None:
            return None
        s = slug(name)
        used[s] = m
        return s

    comps = root.find("Components")
    for part in [] if comps is None else list(comps):
        mfr, pn = text(part, "Manufacturer"), text(part, "PartNumber")
        c = component(part, material(part.find("Material")), material(part.find("LineMaterial")))
        if c is None or not pn:
            skipped += 1
            continue
        c = {"name": f"{mfr} {pn}".strip(), **c}
        base = slug(pn)
        seen[base] = seen.get(base, 0) + 1
        pid = base if seen[base] == 1 else f"{base}_{seen[base]}"
        presets.append(
            {
                "id": pid,
                "manufacturer": mfr,
                "part_number": pn,
                "description": text(part, "Description"),
                "component": c,
            }
        )
    return {
        "source": rel,
        "license": "Apache-2.0",
        "materials": dict(sorted(used.items())),
        "presets": presets,
    }, skipped


def render(doc, upstream):
    head = {
        "upstream": upstream,
        "source": doc["source"],
        "license": doc["license"],
        "materials": doc["materials"],
    }
    lines = [json.dumps(p, ensure_ascii=False, sort_keys=True) for p in doc["presets"]]
    body = json.dumps(head, ensure_ascii=False, sort_keys=True, indent=1)[:-2]
    return body + ',\n "presets": [\n  ' + ",\n  ".join(lines) + "\n ]\n}\n"


def upstream_rev(db):
    try:
        rev = subprocess.run(
            ["git", "-C", db, "rev-parse", "--short=7", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        rev = "unknown"
    return f"https://github.com/openrocket/openrocket-database @ {rev}"


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    db, out = argv[1], argv[2]
    check = "--check" in argv[3:]
    orc = os.path.join(db, "orc")
    generic_root = ET.parse(os.path.join(orc, "generic_materials.orc")).getroot()
    generic = materials_of(generic_root)
    upstream = upstream_rev(db)
    stale = []
    total = skipped_total = 0
    names = sorted(n for n in os.listdir(orc) if n.lower().endswith(".orc"))
    for name in names:
        doc, skipped = convert(os.path.join(orc, name), generic, f"orc/{name}")
        if not doc["presets"]:
            continue
        stem = slug(os.path.splitext(name)[0])
        text_out = render(doc, upstream)
        dest = os.path.join(out, f"{stem}.json")
        total += len(doc["presets"])
        skipped_total += skipped
        if check:
            try:
                with open(dest, encoding="utf-8") as f:
                    if f.read() != text_out:
                        stale.append(dest)
            except OSError:
                stale.append(dest)
        else:
            with open(dest, "w", encoding="utf-8") as f:
                f.write(text_out)
    print(f"{total} presets, {skipped_total} catalog parts skipped", file=sys.stderr)
    if stale:
        print("stale: " + ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
