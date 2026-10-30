# Thermochemistry tables

Rocket performance tables for the shipped propellant pairs (R4.7), generated
by NASA CEA 3.3.4 (`third_party/cea`, Apache-2.0) from its `thermo.inp`
(NASA TP-2002-211556) with `make cea-tables` (`cargo xtask tables`). Format
and lookup: `crates/rw-thermo` (`.rwtbl` v1). Do not edit by hand; regenerate
and commit. `cargo xtask tables --verify` checks them against native CEA.

| File | Oxidizer | Fuel | O/F |
|---|---|---|---|
| `lox-ethanol.rwtbl` | O2(L), 90.17 K | C2H5OH(L), 298.15 K | 0.5-3.0 |
| `lox-rp1.rwtbl` | O2(L), 90.17 K | RP-1, 298.15 K | 1.0-3.6 |
| `lox-ch4.rwtbl` | O2(L), 90.17 K | CH4(L), 111.643 K | 1.5-4.5 |
| `lox-ipa.rwtbl` | O2(L), 90.17 K | IPA(L) custom, h = -318.1 kJ/mol | 0.6-3.2 |
| `n2o-ethanol.rwtbl` | N2O(L) custom, h = 71.02 kJ/mol | C2H5OH(L), 298.15 K | 2-10 |
| `n2o-ipa.rwtbl` | N2O(L) custom, h = 71.02 kJ/mol | IPA(L) custom | 2-10 |

Every table: O/F step 0.025; Pc 5-100 bar (9 log-spaced points); Ae/At 1.5,
1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 60, 80, 100; shifting
equilibrium and frozen at the chamber. Values are SI.
