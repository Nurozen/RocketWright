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
  RMS CX0 ≤ 0.90, CNα ≤ 0.30, Cmα ≤ 0.275, CP ≤ 0.092 cal, and the signed CP
  error (model minus DREV, positive aft = static margin over-predicted) within
  −0.05 to +0.20 cal at every Mach group. The current values are 0.844, 0.271,
  0.250, 0.083 cal and −0.032 to +0.178 cal. Cmq is printed but not scored.
- `basic_finner_roll_forcing_vs_drev_table_x` reads Table X and the model-Mach
  file. It scores the 12 models at M 1.80 to 4.47 (RMS Cl_δ error ≤ 0.14,
  every model/measured ratio within 0.70 to 1.10; currently 0.127 and 0.75 to
  1.01) and prints the four at M 1.06 to 1.38 without scoring them.

The bounds sit about 10% outside the current values. Tighten them when the
physics improves. Table VII is kept as data and no code reads it.

## Fixture compromise: fin cross-section

DREV Basic Finner fins are sharp-LE wedge sections: LE radius 0.004 cal
(≈ 0.12 mm) and 0.08 cal thickness at the base of the fin (section 3.1,
Figure 2). rw-aero has no wedge cross-section (literature-map **Gap 15**).
The fixture uses `cross_section = "airfoil"`, which is the best
available choice:

- LE drag: eq 3.89 (rounded formula). Lower than stagnation drag ("square"),
  but still higher than a true sharp wedge LE. At M 1.1–4.3 this gives
  fn_LE ≈ 0.35–0.48 on A_ref (see drag breakdown in test output).
- TE drag: zero for "airfoil". A blunt wedge TE takes the full base_cd (what
  "square" gives). The drag breakdown table in the test output shows both
  terms.

CX0 is too high at all 8 Mach groups (RMS error 84.4%). The LE overestimate causes this. The missing TE drag works the
other way: adding it would raise the model CX0 further, so today it offsets
part of the LE overestimate.

## Open items

- Cmq normalisation is qd/2V: eqs [1]-[2] of the report's section 7
  (pdf pp 28–29) fix it. The test prints the apparent rw-aero Cmq in qd/2V.
  Cmq stays unscored because rw-aero pitch damping is quadratic in pitch rate
  and has no linear Cmq.
- Table VIII (single 6DOF fits, pdf pp 44–47) has not been transcribed, apart
  from the shot and Mach of the 16 canted-fin models in
  `drev-tm-9703_table-X_model-mach.csv`. That file needs a second reader.
- Wedge fin-section profile: section 3.1 and Figure 2 give 0.08 cal as the
  thickness at the base of the fin. With 0.08 cal the full thickness over a
  1 cal chord, a single-wedge semi-angle is atan(0.04) = 2.29°. Reading 0.08
  cal as a half-thickness would give 4.57°. Confirm the profile from Figure 2
  before the wedge cross-section is added.
- Gap 15: no wedge cross-section in rw-aero; "airfoil" used as above.
  Open: add `FinCrossSection::Wedge` with LE and TE drag.
- Supersonic CNα is 16% to 35% low against Table IX with the current fin
  model (both faces loaded, tip Mach-cone relief). Supersonic K_B(T) is
  faded to zero from M 1.5 and would add about 0.3 to CNα at M 2.375; the
  model has no supersonic body lift and loads the fins as flat plates. See
  the parity-log section "rw-aero DREV-TM-9703: Basic Finner supersonic
  validation".
- M 1.077 and 1.293 sit in the M 0.9 to 1.5 blend, where roll damping is 4 to
  11 times the measured Clp.
