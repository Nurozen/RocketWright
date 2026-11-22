# Provenance: Basic Finner DREV-TM-9703

## Source

Dupuis, A. D. and Hathaway, W. "Aeroballistic Range Tests of the Basic Finner Reference
Projectile at Supersonic Velocities". DREV-TM-9703, Defence Research Establishment
Valcartier, August 1997. DTIC ADA636861.

URL: https://archive.org/details/DTIC_ADA636861  
SHA-256 of PDF: b6ddd7d29ed431ac75995792641621adb20c77995bb513819a1900b7ec8d940e  
License: Approved for public release; distribution unlimited (Crown copyright, Canada)

Citation key in `docs/dev/citations.toml`: `drev-tm-9703`

## Files

| File | Source in report | Transcribed by | Checked by |
|---|---|---|---|
| `drev-tm-9703_table-VII_linear-theory.csv` | Table VII (pdf p 43) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-IX_multiple-fit.csv` | Table IX (pdf pp 48–49) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-X_fin-cant-roll.csv` | Table X (pdf p 50) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-X_model-mach.csv` | Mach of each Table X model: shot and Mach from Table VIII (pdf pp 44–47), mid-range Mach from Table IV (pdf pp 39–40) | Claude, 2026-11-15 | not yet checked by a second reader |

Table X prints no Mach number. The companion file joins each of its 16
models to the Table VIII shot of that model (the last two digits of the shot
number are the model number) and records that shot's Mach, with the Table IV
mid-range Mach of the model as a second reading. The two agree within 0.011
for all 16, and the test asserts that.

The tables are transcribed as printed and credited in `NOTICE.md`. They sit
here so the test suite can embed them with `include_str!`.

The fixture geometry is not a file in this directory. It is inline in
`crates/rw-aero/tests/basic_finner_baseline.rs` (`basic_finner()`), from these
places in the report:

- d = 30 mm, l = 10 cal, CG at 5.50 cal: Table I (pdf p 36).
- Cone, fin planform (1 cal × 1 cal), fin thickness 0.08 cal at the base of
  the fin, and LE radius 0.004 cal: section 3.1 and Figure 2 (pdf p 53).

## Usage

The `basic_finner_baseline` integration test (`crates/rw-aero/tests/`) has two
report-mode tests against the current rw-aero model:

- `basic_finner_baseline_vs_drev` reads `drev-tm-9703_table-IX_multiple-fit.csv`.
  It fails on a non-finite output, on a Table IX that does not have 8 rows or
  has a used cell that does not parse, and on an error above a sanity bound:
  RMS CX0 ≤ 0.24, CNα ≤ 0.225, Cmα ≤ 0.101, CP ≤ 0.293 cal, and the signed CP
  error (model minus DREV, positive aft = static margin over-predicted) within
  −0.05 to +0.42 cal at every Mach group. The current values are 0.217, 0.205,
  0.092, 0.267 cal and +0.042 to +0.384 cal. Cmq is scored in qd/2V
  against Table IX's C_mq + C_mα̇: each Mach group from M 1.2 within a factor
  of 1.5 (spec R5; currently 0.78 to 1.09, RMS 13.3%). M 1.077 is in the
  transonic blend and is printed without scoring.
- `basic_finner_roll_forcing_vs_drev_table_x` reads Table X and the model-Mach
  file. It scores the 12 models at M 1.80 to 4.47 (RMS Cl_δ error ≤ 0.064,
  every model/measured ratio within 0.84 to 1.23; currently 0.058 and 0.92 to
  1.12) and prints the four at M 1.06 to 1.38 without scoring them.

The bounds sit about 10% outside the current values. Tighten them when the
physics improves. The CP bounds and the upper Cl_δ ratio are wider than they
were on the "airfoil" fixture (0.092 cal, +0.20 cal, 1.10): with the wedge
fin lift the model static margin is over-predicted by up to 0.38 cal (see
the parity-log section). Table VII is kept as data and no code reads it.

## Fixture fin cross-section

DREV Basic Finner fins are sharp-LE wedge sections: LE radius 0.004 cal
(≈ 0.12 mm) and 0.08 cal thickness at the base of the fin (section 3.1,
Figure 2). The fixture uses `cross_section = "wedge"` with
`thickness` = 0.08 cal = 2.4 mm, the trailing-edge thickness, so the wedge
half-angle is atan(0.04) = 2.29°. The leading-edge radius is taken as sharp.

- LE drag: the wedge forebody pressure K₁δ + C₂δ² + K₃δ³ on the frontal area
  N t s from M 1.5, blended to zero at M 0.9. fn_LE is 0.008 to 0.026 on
  A_ref over M 1.077 to 4.300.
- TE drag: the full base_cd on the blunt 0.08 cal base. fn_TE is 0.095 to
  0.024.
- Lift: the wedge thickness term 4C₂δ + 6K₃δ² on top of the flat-plate load.

CX0 is now too low at all 8 Mach groups (RMS error 21.7%, −15.7% to
−26.2%). Until the wedge section existed the fixture used "airfoil" and CX0
was too high at all 8 (RMS 84.4%), because eq 3.89 is a rounded-edge law.

## Open items

- Cmq normalisation is qd/2V: eqs [1]-[2] of the report's section 7
  (pdf pp 28–29) fix it. The range value is C_mq + C_mα̇; rw-aero's linear
  pitch damping is the same sum, applied to the pitch rate alone.
- Table VIII (single 6DOF fits, pdf pp 44–47) has not been transcribed, apart
  from the shot and Mach of the 16 canted-fin models in
  `drev-tm-9703_table-X_model-mach.csv`. That file needs a second reader.
- CX0 is 16% to 26% low. The 0.004 cal leading-edge radius is not modelled
  (estimated +0.04 to +0.05 on A_ref) and the base law 0.25/M may be low
  for these bases; see the parity-log CX0 paragraph.
- Supersonic CNα is 14% to 26% low against Table IX with the current fin
  model (both faces loaded, tip Mach-cone relief, wedge thickness lift).
  Supersonic K_B(T) is faded to zero from M 1.5 and would add about 0.4 to
  CNα at M 2.375; the model has no supersonic body lift. See
  the parity-log section "rw-aero DREV-TM-9703: Basic Finner supersonic
  validation".
- M 1.077 and 1.293 sit in the M 0.9 to 1.5 blend, where roll damping is 4 to
  11 times the measured Clp.
