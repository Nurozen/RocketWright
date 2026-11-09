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
| `drev-tm-9703_geometry.md` | Table I (pdf p 36) and Figure 2 (pdf p 53) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-VII_linear-theory.csv` | Table VII (pdf p 43) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-IX_multiple-fit.csv` | Table IX (pdf pp 48–49) | Claude | Luke Hanzon, 2026-11-08 |
| `drev-tm-9703_table-X_fin-cant-roll.csv` | Table X (pdf p 50) | Claude | Luke Hanzon, 2026-11-08 |

The geometry file lives in `../../../references/validation-data/transcribed/`; the
CSV files above are copies placed here so the test suite can embed them with
`include_str!` without reaching outside `repo/`.

## Usage

`basic_finner_baseline` integration test (`crates/rw-aero/tests/`) uses
`drev-tm-9703_table-IX_multiple-fit.csv` as the reference for a baseline
error report against the current rw-aero model (Phase 1 — report only, no
pass/fail thresholds yet except for Cmq which is marked incomparable).

## Fixture compromise: fin cross-section

DREV Basic Finner fins are sharp-LE wedge sections: LE radius 0.004 cal
(≈ 0.12 mm) and 0.08 cal full thickness at the base (Table I, Figure 2).
rw-aero has no wedge cross-section (**Gap fin-wedge**; Phase 2). The fixture
uses `cross_section = "airfoil"`, which is the best available choice:

- LE drag: eq 3.89 (rounded formula). Lower than stagnation drag ("square"),
  but still higher than a true sharp wedge LE. At M 1.1–4.3 this gives
  fn_LE ≈ 0.35–0.48 on A_ref (see drag breakdown in test output).
- TE drag: zero for "airfoil". The correct value for a blunt wedge TE is
  full base_cd (what "square" gives). The gap is documented in the drag
  breakdown table in `basic_finner_baseline.rs`.

This choice makes CX0 too high at all Mach groups (RMS error +84.4% at
Phase 1 baseline). Both LE overestimation and missing TE drag contribute.

## Open items

- Cmq normalisation (qd/V or qd/2V) is not stated in the report nomenclature
  (pdf p 12). Do not score Cmq until confirmed against BARDAS documentation.
- Table VIII (single 6DOF fits, pdf pp 44–47) has not been transcribed.
- Wedge fin-section thickness definition: 0.08 cal stated at the base (Table
  I). Whether this is half-thickness (semi-angle ~2.3°) or full-thickness
  (semi-angle ~4.6°) matters for the LE/TE drag when Gap fin-wedge is closed.
  Confirm before the wedge cross-section is added in Phase 2.
- Gap fin-wedge: no wedge cross-section in rw-aero; "airfoil" used as above.
  Phase 2 task: add `FinCrossSection::Wedge` with correct LE and TE drag.
- Supersonic single-fin CNα: Niskanen (3.49) K₁ = 2/β equals the Ackeret
  one-surface pressure coefficient. The K₂ term in (3.49) would cancel in a
  two-surface derivation; its presence suggests the formula integrates the
  windward surface only (two-surface flat-plate lift slope = 4/β = 2K₁).
  rw-aero `single_fin_cna_supersonic` matches (3.49) exactly. See parity-log
  section "rw-aero DREV-TM-9703 Basic Finner baseline". Phase 2 investigation.
