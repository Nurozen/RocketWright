# Provenance: NACA Report 1328 Tables I and II

## Source

Syvertson, C. A., and Dennis, D. H. "A Second-Order Shock-Expansion Method
Applicable to Bodies of Revolution Near Zero Lift". NACA Report 1328, 1957.

URL: https://ntrs.nasa.gov/citations/19930091011  
SHA-256 of PDF: 37b9cce582b4214ca7a89bf6ec20a81774394df8cdd77d9d16828b29e2276059  
License: public domain (NACA, U.S. Government work); NTRS distribution PUBLIC

Citation key in `docs/dev/citations.toml`: `naca-tr-1328`

## Files

| File | Source in report | Transcribed by | Checked by |
|---|---|---|---|
| `naca-tr-1328_tables-I-II_cna-xcp.csv` | Table I (pdf p 23, printed p 19) and Table II (pdf p 24, printed p 20) | Claude, from the rendered pages | Luke Hanzon, 2026-11-15 |

The file holds the rows that have a measured value: cone-cylinders and tangent
ogive-cylinders of nose fineness 3, 5 and 7 with 0, 2, 4, 6 and 10 diameters of
cylinder, at M 3.00, 4.24, 5.05 and 6.28 (120 rows; the tables print no
experiment at 8 diameters). Two columns of each table are kept: experiment,
and the report's own second-order shock-expansion result (for the ogives, its
ten-step solution). The other theory columns are not transcribed.

dC_N/dα is per radian on the base area; x̄/d is the centre of pressure in
diameters from the vertex.

Method: the two pages were rendered from the PDF and read by eye; the scan has
no usable text layer for the tables. Every row was then read a second time on
300-dpi crops of the pages (2026-11-15) and agreed. The second reader then
checked the values against the report and found no error, and confirmed the
column choice: the third column is the second-order shock-expansion result,
and for the ogives it is the ten-step solution.

## Usage

`tr_1328_tables_i_and_ii` in `crates/rw-aero/src/supersonic/body.rs` embeds
the file with `include_str!`. It compares the body-alone C_Nα and CP of
`supersonic::body` with both columns and holds the error statistics
(`docs/dev/parity-log.md`, supersonic body lift).
