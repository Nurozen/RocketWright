# Generic motor curves: provenance

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
   Sample at `tau = i / 40` for `i = 0..40`. Every breakpoint lies on that grid,
   so the trapezoid integral of the samples equals `Itot` before rounding.
   Values are written as `t` to 0.1 ms and `F` to 1 mN.
3. Propellant mass: `m_prop = Itot / (Isp * g0)` with `g0 = 9.80665 m/s^2`,
   rounded to 1 mg. Assumed delivered `Isp`: `bp` 80.0 s, `apcp` 180.0 s.
4. Dry mass and length:
   - `bp` (single-use black powder, `Type="single-use"`): `L` is chosen;
     `m_dry = 12.000 g * (d / 18 mm)^2 * (L / 70 mm)`, rounded to 1 mg
     (an assumed 12 g for an 18 mm x 70 mm motor: casing, nozzle, delay, and
     ejection charge, scaled by casing volume).
   - `apcp` (reloadable composite, `Type="reload"`): an aluminium casing
     (density 2700 kg/m^3) with wall `w = d / 20` and bore `b = d - 2 w`.
     The grain (density 1750 kg/m^3) fills 65% of the bore:
     `L_grain = m_prop / (1750 * 0.65 * pi b^2 / 4)`.
     `L = L_grain + 2 d` (closures and nozzle), rounded to 1 mm.
     `m_dry = rho_case * (pi (d - w) w L + 2 (pi d^2 / 4) (d / 6))`
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
| 0.000 | 0.00 |
| 0.050 | 1.20 |
| 0.100 | 2.50 |
| 0.175 | 1.70 |
| 0.300 | 0.85 |
| 0.800 | 0.75 |
| 0.925 | 0.45 |
| 1.000 | 0.00 |

### Normalized thrust shape `apcp`

| tau | phi |
|---|---|
| 0.000 | 0.00 |
| 0.025 | 0.90 |
| 0.050 | 1.15 |
| 0.150 | 1.10 |
| 0.500 | 1.05 |
| 0.800 | 0.95 |
| 0.900 | 0.70 |
| 0.975 | 0.15 |
| 1.000 | 0.00 |

### Parameters

| Motor | Family | Class | d (mm) | L (mm) | Itot (N s) | tb (s) | F avg (N) | F peak (N) | m_prop (g) | m_dry (g) | m(0) (g) | cg (mm) | Delays (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `RW_A8G` | bp | A | 18 | 70 | 2.40 | 0.300 | 8.00 | 21.477 | 3.059 | 12.000 | 15.059 | 35.0 | 3-5 |
| `RW_B4G` | bp | B | 18 | 70 | 4.80 | 1.200 | 4.00 | 10.738 | 6.118 | 12.000 | 18.118 | 35.0 | 2-4-6 |
| `RW_C6G` | bp | C | 18 | 70 | 9.60 | 1.600 | 6.00 | 16.107 | 12.237 | 12.000 | 24.237 | 35.0 | 3-5-7 |
| `RW_D10G` | bp | D | 24 | 70 | 16.84 | 1.608 | 10.47 | 28.114 | 21.465 | 21.333 | 42.798 | 35.0 | 3-5-7 |
| `RW_I261G` | apcp | I | 38 | 269 | 356.23 | 1.364 | 261.17 | 318.875 | 201.808 | 195.291 | 397.099 | 134.5 | 6-10-14 |
| `RW_I1294G` | apcp | I | 38 | 306 | 424.47 | 0.328 | 1294.12 | 1580.075 | 240.466 | 216.818 | 457.284 | 153.0 | 6-10-14 |
| `RW_I60G` | apcp | I | 38 | 340 | 486.71 | 8.148 | 59.73 | 72.933 | 275.726 | 236.599 | 512.325 | 170.0 | 6-10-14 |

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
| `RW_A8G.eng` | `e2a80ffa6405a11694ad946fbf5a02fac76411b6840131aa6642d7e7426e213c` |
| `RW_A8G.rse` | `9134b687de80eeb162c2fda9cfd482beaa5bf01ec1f51222a3909df563af1f89` |
| `RW_B4G.eng` | `addb481d11ae250981c96dc0ea28ac0af89f423be71139761487e82911ec4e28` |
| `RW_B4G.rse` | `07db95685a2489bc4791dfe6c47967b9a0560473ba888fdf1f05c10d2c1b83f8` |
| `RW_C6G.eng` | `36a2f673d15c6e0e4eea6b58c8224464f93d0fb2c169638afb6fe95528c4ccac` |
| `RW_C6G.rse` | `025d61aa8d954cbb564b70b0f03a2add19e7495f043028ccdf120c0309b4c92b` |
| `RW_D10G.eng` | `40d86884157a17e8fc0c019eb72ceacb3c203a6e286934ef02bc27d3dc8ef1e3` |
| `RW_D10G.rse` | `d34ff7ac951eb0ac1a7a277f5cbf5e69a1dd8aa4ad12b4103c1c71cc844eb3e4` |
| `RW_I1294G.eng` | `530a47f9bce766bc54c0977368714b220691edbb8f783aa43d2ba273dd1d8b0d` |
| `RW_I1294G.rse` | `d2f7dbb4e1e1a56c6e94677e09c9a3cbb27ee31d1dfb4fe695b6801e49d9bf83` |
| `RW_I261G.eng` | `d9b64374cc8e555ff2d6124dc7be8a06bdf546c1be20654943175158417c2190` |
| `RW_I261G.rse` | `b9274083be781bdd52ce45702ed1935da9186f9deea689a773fd0ac324240225` |
| `RW_I60G.eng` | `1eaaa4d63664ea93879d3c84760acc6519bab38a704cfd6f22903648022f7c99` |
| `RW_I60G.rse` | `93c0294724b5a6517cb9d4b70133c0c7404a4955f3eb396a40d32f8734b78387` |
