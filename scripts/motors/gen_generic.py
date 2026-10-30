#!/usr/bin/env python3
"""Generate RocketWright's generic solid motor curves (plan steps M1.36a, M2.4a).

Every number here is RocketWright's own: each motor is built from its impulse
class, diameter, total impulse, and burn time only (plus a length for the
single-use family), using one normalized thrust shape and one assumed specific
impulse per propellant family. No vendor, ThrustCurve, or OpenRocket curve was
consulted.

Usage (from the repository root):

    python3 scripts/motors/gen_generic.py          # (re)write lib/motors/generic/
    python3 scripts/motors/gen_generic.py --check  # fail if the files differ

Output is byte-deterministic. `cargo test -p rw-motor --test generic_files`
verifies the written files against the recipe documented in PROVENANCE.md.
"""

from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "lib" / "motors" / "generic"

G0 = 9.80665  # standard gravity, m/s^2 (exact by definition)

# Recipe constants.
SAMPLES = 40  # uniform segments over the burn

# Family "bp": single-use black-powder motors (M1.36a: A-C 18 mm; M2.4a: D 24 mm).
BP_ISP_S = 80.0  # assumed delivered specific impulse, s
BP_DRY_REF_G = 12.0  # assumed dry mass of an 18 mm x 70 mm single-use motor, g
BP_REF_D_MM = 18.0
BP_REF_L_MM = 70.0

# Family "apcp": reloadable composite high-power motors (M2.4a: I 38 mm).
APCP_ISP_S = 180.0  # assumed delivered specific impulse, s
APCP_RHO_PROP = 1750.0  # assumed propellant density, kg/m^3
APCP_LOADING = 0.65  # assumed fraction of the casing bore filled by grain
APCP_RHO_CASE = 2700.0  # aluminium casing and closures, kg/m^3
APCP_WALL_FRAC = 1.0 / 20.0  # casing wall thickness / outer diameter
APCP_CLOSURE_FRAC = 1.0 / 6.0  # each solid closure's thickness / outer diameter
APCP_END_ALLOW = 2.0  # length allowance for closures + nozzle, in diameters

# Normalized thrust shapes: (tau = t / t_burn, phi = relative thrust).
# Piecewise linear. Every breakpoint is a multiple of 1/SAMPLES, so the sampled
# curve contains the breakpoints and its trapezoid integral is exact.
# "bp": ignition rise, a short boost peak, a long sustain plateau, tail-off.
SHAPE = [
    (0.0, 0.0),
    (0.05, 1.2),
    (0.10, 2.5),
    (0.175, 1.7),
    (0.30, 0.85),
    (0.80, 0.75),
    (0.925, 0.45),
    (1.0, 0.0),
]
# "apcp": fast rise to a slight initial hump, a gently regressive plateau,
# then a tail-off.
SHAPE_APCP = [
    (0.0, 0.0),
    (0.025, 0.90),
    (0.05, 1.15),
    (0.15, 1.10),
    (0.50, 1.05),
    (0.80, 0.95),
    (0.90, 0.70),
    (0.975, 0.15),
    (1.0, 0.0),
]
SHAPES = {"bp": SHAPE, "apcp": SHAPE_APCP}

# Per-motor inputs: (name, family, class, dia mm, len mm or None (derived),
# Itot N*s, t_burn s, delays s). Burn times are multiples of 4 ms so every
# sample time is exact at the written 0.1 ms precision. M2.4a rows take the
# class, diameter, total impulse (to 0.01 N s), and burn time (to 4 ms) of each
# oracle case 2-7 motor mount from tests/oracle/case*.geometry.json `fields`.
MOTORS = [
    # M1.36a: 18 mm single-use (case 1; also the C mounts of cases 2, 3, 6).
    ("RW_A8G", "bp", "A", 18.0, 70.0, 2.4, 0.30, [3, 5]),
    ("RW_B4G", "bp", "B", 18.0, 70.0, 4.8, 1.20, [2, 4, 6]),
    ("RW_C6G", "bp", "C", 18.0, 70.0, 9.6, 1.60, [3, 5, 7]),
    # M2.4a: 24 mm single-use D (case 4).
    ("RW_D10G", "bp", "D", 24.0, 70.0, 16.84, 1.608, [3, 5, 7]),
    # M2.4a: 38 mm reloadable composite I: case 7 booster (mid thrust), case 5
    # (high thrust, short burn), case 7 sustainer (low thrust, long burn).
    ("RW_I261G", "apcp", "I", 38.0, None, 356.23, 1.364, [6, 10, 14]),
    ("RW_I1294G", "apcp", "I", 38.0, None, 424.47, 0.328, [6, 10, 14]),
    ("RW_I60G", "apcp", "I", 38.0, None, 486.71, 8.148, [6, 10, 14]),
]



def fmt(x: float, nd: int) -> str:
    s = f"{x:.{nd}f}"
    return "0." + "0" * nd if s.startswith("-") and float(s) == 0 else s


def shape_at(shape, tau: float) -> float:
    for (t0, p0), (t1, p1) in zip(shape, shape[1:]):
        if t0 <= tau <= t1:
            return p0 + (p1 - p0) * (tau - t0) / (t1 - t0)
    raise ValueError(tau)


def shape_area(shape) -> float:
    return sum((t1 - t0) * (p0 + p1) / 2 for (t0, p0), (t1, p1) in zip(shape, shape[1:]))


def apcp_geometry(dia_mm: float, prop_kg: float) -> tuple[float, float]:
    """(length mm, dry mass g) of a reloadable composite motor."""
    d = dia_mm / 1000.0
    wall = APCP_WALL_FRAC * d
    bore = d - 2.0 * wall
    grain_len = prop_kg / (APCP_RHO_PROP * APCP_LOADING * math.pi * bore**2 / 4.0)
    length = round((grain_len + APCP_END_ALLOW * d) * 1000.0)  # whole mm
    tube = APCP_RHO_CASE * math.pi * (d - wall) * wall * (length / 1000.0)
    closures = 2.0 * APCP_RHO_CASE * (math.pi * d**2 / 4.0) * (APCP_CLOSURE_FRAC * d)
    return float(length), round((tube + closures) * 1000.0, 3)


def build(name, family, cls, dia, length, itot, tburn, delays):
    shape = SHAPES[family]
    if family == "bp":
        prop_g = round(itot / (BP_ISP_S * G0) * 1000.0, 3)
        dry_g = round(
            BP_DRY_REF_G * (dia / BP_REF_D_MM) ** 2 * (length / BP_REF_L_MM), 3
        )
        kind = "single-use"
    else:
        prop_g = round(itot / (APCP_ISP_S * G0) * 1000.0, 3)
        length, dry_g = apcp_geometry(dia, prop_g / 1000.0)
        kind = "reload"
    init_g = round(dry_g + prop_g, 3)
    k = itot / (tburn * shape_area(shape))  # N per unit phi

    # Sample and round to the written precision; the mass column is computed
    # from the *written* points so m(end) is exactly the dry mass.
    pts = []
    for i in range(SAMPLES + 1):
        tau = i / SAMPLES
        t = float(fmt(tau * tburn, 4))
        f = float(fmt(k * shape_at(shape, tau), 3))
        pts.append((t, f))
    cum = [0.0]
    for (t0, f0), (t1, f1) in zip(pts, pts[1:]):
        cum.append(cum[-1] + (t1 - t0) * (f0 + f1) / 2)
    i_curve = cum[-1]
    rows = []
    for (t, f), c in zip(pts, cum):
        m = dry_g + prop_g * (1.0 - c / i_curve)
        rows.append((t, f, m))
    peak = max(f for _, f in pts)
    cg = length / 2.0
    return {
        "name": name,
        "family": family,
        "kind": kind,
        "cls": cls,
        "dia": dia,
        "len": length,
        "itot": itot,
        "tburn": tburn,
        "delays": delays,
        "prop_g": prop_g,
        "dry_g": dry_g,
        "init_g": init_g,
        "k": k,
        "rows": rows,
        "peak": peak,
        "avg": itot / tburn,
        "cg": cg,
        "i_curve": i_curve,
    }


def rse(m) -> str:
    delays = ",".join(str(d) for d in m["delays"])
    attrs = [
        ("mfg", "RocketWright"),
        ("code", m["name"]),
        ("Type", m["kind"]),
        ("dia", fmt(m["dia"], 1)),
        ("len", fmt(m["len"], 1)),
        ("initWt", fmt(m["init_g"], 3)),
        ("propWt", fmt(m["prop_g"], 3)),
        ("delays", delays),
        ("auto-calc-mass", "0"),
        ("auto-calc-cg", "0"),
        ("avgThrust", fmt(m["avg"], 3)),
        ("peakThrust", fmt(m["peak"], 3)),
        ("throatDia", "0."),
        ("exitDia", "0."),
        ("Itot", fmt(m["itot"], 3)),
        ("burn-time", fmt(m["tburn"], 3)),
        ("massFrac", fmt(100.0 * m["prop_g"] / m["init_g"], 2)),
        ("Isp", fmt(m["itot"] / (m["prop_g"] / 1000.0 * G0), 2)),
    ]
    head = " ".join(f'{k}="{v}"' for k, v in attrs)
    lines = [
        '<engine-database>',
        '  <engine-list>',
        f'    <engine {head}>',
        '      <comments>RocketWright generic motor (class '
        f'{m["cls"]}). Authored from class, diameter, total impulse, and burn time '
        'only; recipe in lib/motors/generic/PROVENANCE.md. m = total motor mass (g), '
        'cg = mm from the forward end.</comments>',
        '      <data>',
    ]
    for t, f, mass in m["rows"]:
        lines.append(
            f'        <eng-data t="{fmt(t, 4)}" f="{fmt(f, 3)}" '
            f'm="{fmt(mass, 3)}" cg="{fmt(m["cg"], 1)}"/>'
        )
    lines += ['      </data>', '    </engine>', '  </engine-list>', '</engine-database>', '']
    return "\n".join(lines)


def eng(m) -> str:
    delays = "-".join(str(d) for d in m["delays"])
    lines = [
        f'; {m["name"]}: RocketWright generic class {m["cls"]} motor.',
        "; Authored from class, diameter, total impulse, and burn time only;",
        "; recipe in lib/motors/generic/PROVENANCE.md. Same points as the .rse.",
        f'{m["name"]} {fmt(m["dia"], 0)} {fmt(m["len"], 0)} {delays} '
        f'{fmt(m["prop_g"] / 1000.0, 6)} {fmt(m["init_g"] / 1000.0, 6)} RocketWright',
    ]
    # RASP: the curve starts implicitly at (0, 0); write points with t > 0.
    for t, f, _ in m["rows"][1:]:
        lines.append(f"   {fmt(t, 4)} {fmt(f, 3)}")
    lines.append("")
    return "\n".join(lines)


def provenance(motors, files) -> str:
    def shape_table(shape):
        return "\n".join(f"| {fmt(t, 3)} | {fmt(p, 2)} |" for t, p in shape)

    params = "\n".join(
        f'| `{m["name"]}` | {m["family"]} | {m["cls"]} | {fmt(m["dia"], 0)} | {fmt(m["len"], 0)} | '
        f'{fmt(m["itot"], 2)} | {fmt(m["tburn"], 3)} | {fmt(m["avg"], 2)} | '
        f'{fmt(m["peak"], 3)} | {fmt(m["prop_g"], 3)} | {fmt(m["dry_g"], 3)} | '
        f'{fmt(m["init_g"], 3)} | {fmt(m["cg"], 1)} | '
        f'{"-".join(str(d) for d in m["delays"])} |'
        for m in motors
    )
    shas = "\n".join(f"| `{n}` | `{h}` |" for n, h in files)
    return f"""# Generic motor curves: provenance

RocketWright-authored generic solid motors used by templates, fixtures, the
offline `rw motor search` library, motor substitution on import, and the
oracle's generic-curve cases (plan steps M1.36a and M2.4a; spec "Motor data"
decision). They are not copies or fits of any vendor, ThrustCurve, or
OpenRocket curve. Each curve was built from its impulse class, diameter, total
impulse, and burn time only (plus a chosen length for the single-use family),
using the recipe below. No other curve was consulted.

Generator: `scripts/motors/gen_generic.py` (Python 3, standard library only,
byte-deterministic). Run `python3 scripts/motors/gen_generic.py --check` to
confirm the committed files match the recipe.
Verification: `cargo test -p rw-motor --test generic_files`.

## Recipe

1. Choose the inputs: propellant family, impulse class, diameter `d`, total
   impulse `Itot`, and burn time `tb` (a multiple of 4 ms, so every sample time
   is exact at the written precision). The single-use family also takes a
   length `L`. The average thrust is `Itot / tb`; rounded to the nearest newton
   it supplies the number in the designation (`A8` means about 8 N; the
   trailing `G` means generic). The M1.36a inputs (A-C) are RocketWright's
   choice. The M2.4a inputs (D, I) take the class, diameter, total impulse
   (rounded to 0.01 N s), and burn time (rounded to 4 ms) of each oracle case
   2-7 motor mount, as listed in `tests/oracle/case*.geometry.json` `fields`;
   masses, length, and the curve shape still come from this recipe only.
2. Thrust: one normalized piecewise-linear shape `phi(tau)` per family, with
   `tau = t / tb`. Breakpoints are listed below.
   Scale: `F(t) = k * phi(t / tb)` with `k = Itot / (tb * integral_0^1 phi dtau)`.
   Sample at `tau = i / {SAMPLES}` for `i = 0..{SAMPLES}`. Every breakpoint lies on that grid,
   so the trapezoid integral of the samples equals `Itot` before rounding.
   Values are written as `t` to 0.1 ms and `F` to 1 mN.
3. Propellant mass: `m_prop = Itot / (Isp * g0)` with `g0 = 9.80665 m/s^2`,
   rounded to 1 mg. Assumed delivered `Isp`: `bp` {fmt(BP_ISP_S, 1)} s, `apcp` {fmt(APCP_ISP_S, 1)} s.
4. Dry mass and length:
   - `bp` (single-use black powder, `Type="single-use"`): `L` is chosen;
     `m_dry = {fmt(BP_DRY_REF_G, 3)} g * (d / {fmt(BP_REF_D_MM, 0)} mm)^2 * (L / {fmt(BP_REF_L_MM, 0)} mm)`, rounded to 1 mg
     (an assumed {fmt(BP_DRY_REF_G, 0)} g for an 18 mm x 70 mm motor: casing, nozzle, delay, and
     ejection charge, scaled by casing volume).
   - `apcp` (reloadable composite, `Type="reload"`): an aluminium casing
     (density {fmt(APCP_RHO_CASE, 0)} kg/m^3) with wall `w = d / {fmt(1 / APCP_WALL_FRAC, 0)}` and bore `b = d - 2 w`.
     The grain (density {fmt(APCP_RHO_PROP, 0)} kg/m^3) fills {fmt(100 * APCP_LOADING, 0)}% of the bore:
     `L_grain = m_prop / ({fmt(APCP_RHO_PROP, 0)} * {fmt(APCP_LOADING, 2)} * pi b^2 / 4)`.
     `L = L_grain + {fmt(APCP_END_ALLOW, 0)} d` (closures and nozzle), rounded to 1 mm.
     `m_dry = rho_case * (pi (d - w) w L + 2 (pi d^2 / 4) (d / {fmt(1 / APCP_CLOSURE_FRAC, 0)}))`
     (tube plus two solid closures), rounded to 1 mg.
5. Mass column (`.rse` `m`, grams): the **total** motor mass,
   `m(t) = m_dry + m_prop * (1 - I(t) / I(tb))`, where `I(t)` is the
   cumulative trapezoid impulse of the written samples. So `m(0) = m_dry + m_prop`
   (`initWt`) and `m(tb) = m_dry`, and `m` decreases monotonically.
6. CG column (`.rse` `cg`): held at `L / 2` from the forward end, in mm
   (uniform-casing assumption).
7. Header: `Itot`, `burn-time`, and `avgThrust` are the chosen inputs.
   `peakThrust` is the largest sample. `Isp = Itot / (m_prop * g0)`.
   `massFrac = 100 * m_prop / initWt`. `throatDia` and `exitDia` are unspecified (0).
8. `.eng` (RASP): the same points with `t > 0` (the curve starts implicitly
   at (0, 0)). Header masses are in kg: propellant, then total. RASP readers
   derive mass depletion themselves; prefer the `.rse`, which carries `m` and
   `cg` per sample.

The test checks that the trapezoid integral of each file's curve equals the
header `Itot` within 0.1%, that `Itot` lies in the named class, that `m` is
monotone, that `m(0) - m(end)` equals the propellant mass, that `.eng` and
`.rse` agree, and that the hashes below match.

### Normalized thrust shape `bp`

| tau | phi |
|---|---|
{shape_table(SHAPE)}

### Normalized thrust shape `apcp`

| tau | phi |
|---|---|
{shape_table(SHAPE_APCP)}

### Parameters

| Motor | Family | Class | d (mm) | L (mm) | Itot (N s) | tb (s) | F avg (N) | F peak (N) | m_prop (g) | m_dry (g) | m(0) (g) | cg (mm) | Delays (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
{params}

### Oracle case mounts (M2.4a)

The generic-curve oracle matrix substitutes one file per motor mount. Listed
delays are nominal; the delay is set per configuration (for example 0 s on the
case 6 booster stages), so no separate zero-delay file is needed. The `apcp`
lengths come from the recipe, not from the mount.

| Case | Mount | Generic motor |
|---|---|---|
| 1 | 18 mm inner tube | `RW_C6G` |
| 2, 3 (cluster of 4), 6 (all three stages) | 18 mm | `RW_C6G` |
| 4 | 24 mm body tube | `RW_D10G` |
| 5 | 38 mm inner tube | `RW_I1294G` |
| 7 | 38 mm booster mount | `RW_I261G` |
| 7 | 38 mm sustainer mount | `RW_I60G` |

## sha256

| File | sha256 |
|---|---|
{shas}
"""


def main() -> int:
    check = "--check" in sys.argv[1:]
    motors = [build(*spec) for spec in MOTORS]
    outputs: dict[str, str] = {}
    for m in motors:
        want = f'RW_{m["cls"]}{round(m["avg"])}G'
        if m["name"] != want:
            raise SystemExit(f'{m["name"]}: designation should be {want}')
        outputs[f'{m["name"]}.rse'] = rse(m)
        outputs[f'{m["name"]}.eng'] = eng(m)
    files = [
        (n, hashlib.sha256(outputs[n].encode()).hexdigest()) for n in sorted(outputs)
    ]
    outputs["PROVENANCE.md"] = provenance(motors, files)
    bad = []
    for name, text in outputs.items():
        path = OUT / name
        if check:
            if not path.exists() or path.read_text() != text:
                bad.append(name)
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    if bad:
        print("out of date: " + ", ".join(bad), file=sys.stderr)
        return 1
    for m in motors:
        err = (m["i_curve"] - m["itot"]) / m["itot"]
        print(f'{m["name"]}: Itot {m["itot"]} curve {m["i_curve"]:.6f} ({err:+.2e})')
    return 0


if __name__ == "__main__":
    sys.exit(main())
