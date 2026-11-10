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

The tables are transcribed as printed and credited in `NOTICE.md`. They sit
here so the test suite can embed them with `include_str!`.

The fixture geometry is not a file in this directory. It is inline in
`crates/rw-aero/tests/basic_finner_baseline.rs` (`basic_finner()`), from these
places in the report:

- d = 30 mm, l = 10 cal, CG at 5.50 cal: Table I (pdf p 36).
- Cone, fin planform (1 cal × 1 cal), fin thickness 0.08 cal at the base of
  the fin, and LE radius 0.004 cal: section 3.1 and Figure 2 (pdf p 53).

## Usage

The `basic_finner_baseline` integration test (`crates/rw-aero/tests/`) uses
`drev-tm-9703_table-IX_multiple-fit.csv` as the reference for a baseline error
report against the current rw-aero model. Only Table IX is consumed today;
Tables VII and X are kept as data and no code reads them.

The test runs in report mode. It fails on a non-finite output, on a Table IX
that does not have 8 rows or has a used cell that does not parse, and on an RMS
error above a sanity ceiling: CX0 ≤ 0.90, CNα ≤ 0.50, CP ≤ 0.90 cal. The
ceilings sit just above the Phase 1 baseline (0.844, 0.466, 0.848 cal) and
ratchet down when the physics improves. Cmq is printed but not scored.

## Fixture compromise: fin cross-section

DREV Basic Finner fins are sharp-LE wedge sections: LE radius 0.004 cal
(≈ 0.12 mm) and 0.08 cal thickness at the base of the fin (section 3.1,
Figure 2). rw-aero has no wedge cross-section (literature-map **Gap 15**;
Phase 2). The fixture uses `cross_section = "airfoil"`, which is the best
available choice:

- LE drag: eq 3.89 (rounded formula). Lower than stagnation drag ("square"),
  but still higher than a true sharp wedge LE. At M 1.1–4.3 this gives
  fn_LE ≈ 0.35–0.48 on A_ref (see drag breakdown in test output).
- TE drag: zero for "airfoil". A blunt wedge TE takes the full base_cd (what
  "square" gives). The drag breakdown table in the test output shows both
  terms.

CX0 is too high at all 8 Mach groups (RMS error 84.4% at the Phase 1
baseline). The LE overestimate causes this. The missing TE drag works the
other way: adding it would raise the model CX0 further, so today it offsets
part of the LE overestimate.

## Open items

- Cmq normalisation is qd/2V: eqs [1]-[2] of the report's section 7
  (pdf pp 28–29) fix it. The test prints the apparent rw-aero Cmq in qd/2V.
  Cmq stays unscored because rw-aero pitch damping is quadratic in pitch rate
  and has no linear Cmq.
- Table VIII (single 6DOF fits, pdf pp 44–47) has not been transcribed.
- Wedge fin-section profile: section 3.1 and Figure 2 give 0.08 cal as the
  thickness at the base of the fin. With 0.08 cal the full thickness over a
  1 cal chord, a single-wedge semi-angle is atan(0.04) = 2.29°. Reading 0.08
  cal as a half-thickness would give 4.57°. Confirm the profile from Figure 2
  before the wedge cross-section is added.
- Gap 15: no wedge cross-section in rw-aero; "airfoil" used as above.
  Phase 2 task: add `FinCrossSection::Wedge` with LE and TE drag.
- Supersonic single-fin CNα: Niskanen (3.49) as implemented
  (`single_fin_cna_supersonic`) uses the one-surface K₁ = 2/β, which gives the
  4-fin set half the 2D linear-theory slope of the lifting pair (4/β vs 8/β
  on A_fin/A_ref). This is one factor in the CNα gap, not all of it;
  supersonic K_B(T), the finite-span tip factor, and the shared roll-damping
  path are the other open items. See the parity-log section "rw-aero
  DREV-TM-9703: Basic Finner supersonic validation". Phase 1b investigation.
