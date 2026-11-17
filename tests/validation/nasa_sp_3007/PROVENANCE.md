# Provenance: NASA SP-3007 Table 2

## Source

Sims, J. L. "Tables for Supersonic Flow Around Right Circular Cones at Small
Angle of Attack". NASA SP-3007, 1964.

URL: https://ntrs.nasa.gov/citations/19640015103  
SHA-256 of PDF: 5cadc5141543d2fccc031a884cd48d44507d28a1f617096b64d353200aa2936c  
License: public domain (NASA, U.S. Government work); NTRS distribution PUBLIC

Citation key in `docs/dev/citations.toml`: `nasa-sp-3007`

## Files

| File | Source in report | Transcribed by | Checked by |
|---|---|---|---|
| `nasa-sp-3007_table-2_dcn-dalpha.csv` | Table 2 (pdf p 28, printed p 20) | Claude, from the rendered page | Luke Hanzon, 2026-11-15 (five flagged cells, then a spot check) |

Table 2 gives (dC_N/dα) at α = 0, per radian on the cone base area (the
report's eq (34), pdf p 14), for 16 free-stream Mach numbers from 1.5 to 20
and cone half-angles from 2.5° to 30° in steps of 2.5°, to 8 digits. The two
cells at M 1.5 for 27.5° and 30° are blank in the report and empty here.

Method: the page was rendered from the PDF and read by eye; the scan has no
usable text layer. The same standard as the NACA TR 1307 chart 16 ordinates:
our own reading, with a screen for misread digits. The screen is the fourth
difference of each column in Mach-row index and of each row in angle, which
shows no spike (`table_2_is_smooth` in `crates/rw-aero/src/supersonic/cone.rs`
holds it below 0.006).

Five cells have a digit that is overstruck or faint in the scan. The second
reader checked these five against the report and then spot-checked the rest of
the table (2026-11-15); the values stand as read:

| Mach | half-angle | value as read |
|---|---|---|
| 3.0 | 30.0° | 1.4497109 |
| 3.5 | 7.5° | 1.8487600 |
| 3.5 | 30.0° | 1.4647351 |
| 15 | 5.0° | 1.9449893 |
| 15 | 27.5° | 1.5922831 |

## Usage

This is model data, not only a test reference: the same values are the
constant `SP3007_CNA` in `crates/rw-aero/src/supersonic/cone.rs`, which
`cone_normal_force_slope` interpolates. `table_2_copy_matches_the_transcription`
embeds this file with `include_str!` and fails if the two differ, so a
correction is made in both places.
