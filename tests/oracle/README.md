# Oracle goldens and the B2 parity scoreboard

`tests/oracle/` holds OpenRocket's numbers for the B2 cases (spec B2, plan D25).
The oracle agent exports them through the one-way valve (`allowlist.txt`); every
exported JSON validates against `schema/oracle-golden.json`. The oracle harness
that runs OpenRocket lives in the maintainers' OpenRocket worktree, not here, so
regenerating the goldens or `cache/` is maintainer-only
(`docs/dev/environment.md`, Maintainer-only inputs). BAR owns this
README, `keymap.json`, and `tolerances.json`; they are not exports.

| File | Owner | Contents |
|---|---|---|
| `case<n>-generic.json` | oracle (valve) | Golden for the generic-curve variant: the **gate** matrix |
| `case<n>-original.json` | oracle (valve) | Golden for the unmodified example: summary keys only, import check (M2.5) |
| `case<n>-generic.series.json`, `case<n>.aero_sweep.json`, `case<n>.geometry.json`, `case<n>.provenance.json` | oracle (valve) | Series, CD/CNα/CP sweep, component tree in SI, provenance |
| `keymap.json` | BAR | Spec B2 key map (S:177): oracle summary key → `RunSummary` key; static key → check metric path |
| `tolerances.json` | BAR | Spec B2 tolerances (S:179) by case group, plus the `loosened` log |
| `cache/` | gitignored | ThrustCurve downloads under `make parity` |

## Running the scoreboard

```
make bar-parity [CASE=1|2..7|1,3,5] [KEYS=apogee_m,mass.cg] [GATE=1]
```

`scripts/bar/parity.ts` pairs each golden with our run record and writes
`target/parity/scoreboard.json` (`artifacts/reviews/rocketwright_bar/parity/`
when a maintainer workspace `artifacts/` sits above the repo; `--out`
overrides). Report
mode exits 0. `GATE=1` exits 1 unless every toleranced row of the `generic`
matrix for the selected cases passes. Every invocation first runs a self-test
that plants a motor-digest mismatch and requires `mismatch`.

Each row is `{matrix, case, key, golden_key, ours, golden, delta, delta_pct, tol, pass, status, reason?}`;
`key` is our name, `delta = ours − golden` in SI, values at six significant figures.

| status | meaning |
|---|---|
| `not-run` | the golden or our run record is absent |
| `mismatch` | setup differs (below); the row is never scored |
| `missing` | both files exist but one side has no value for the key |
| `report` | compared, no tolerance for this case and key |
| `pass` / `fail` | compared against `tolerances.json` |

### Mismatch check (before scoring)

Every row of a case is `mismatch` when any of these differ between our run and
the golden: `geometry_sha256`, `conditions_hash`, `config_id`, `sim_name`,
`motor_digest`. The golden is also rejected when its `conditions_hash` or
`motor_digest` does not recompute from its own `conditions` and `motors`
(the rules of `rw_api::oracle::{conditions_hash, motor_digest}`, mirrored in TS).

### Our run record

`target/parity/ours/case<n>-<matrix>.json` (override with `--ours <dir>` or
`RW_PARITY_OURS`), assembled with `oursFromRun()` from a `RunManifest`,
`RunSummary`, and `CheckReport`, or written by a producer (`PRODUCERS` in
`parity.ts`; `make bar-parity` passes `--refresh`, which runs them first). Case 1:
`cargo test -p rw-cli --test parity_case1` (M1.42b) runs `rw check`, `rw sim`, and
`rw diff run --golden` on a copy of `fixtures/case1` and builds the record from
the CLI outputs only. It also writes the run's series as
`case1-generic.series.csv` and adds the fields triage reads (`source`, `run_id`,
`series_csv`, `integrator`, and `check` extras `mass.liftoff`, `mass.burnout`,
`aero.cd`, `aero.mach`); the scorer ignores them:

```json
{
  "kind": "ours", "case": 1, "matrix": "generic",
  "sim_name": "<golden sim name>", "config_id": "<golden config id>",
  "geometry_sha256": "<sha256 of the case<n>.geometry.json the fixture was authored from>",
  "conditions_hash": "sha256:<…>", "motor_digest": "<sorted curve sha256s joined by \\n, sha256>",
  "summary": { "apogee_m": 0, "max_velocity_ms": 0 },
  "check": { "mass.cg": 0, "aero.cp": 0, "aero.cna": 0, "stability.liftoff": 0 }
}
```

`sim_name` and `config_id` are the golden-side identities the fixture maps to.

### Triage (M1.42b)

`scripts/bar/triage.ts` (run by `make bar-parity` after the scoreboard, report
only) splits each case's flight delta into per-term rows: **mass/CG** (static,
and mass(t)/CG(t) worst over the burn), **CP/CNa** (static), **CD(M)** (CD at the
check Mach, coast CD at each `aero_sweep` Mach, mean burn CD against the series),
**thrust** (impulse, burnout time, worst thrust(t)), and **integrator** (the
golden's RK4 at 0.05 s vs the shipped DP5(4) apogee; flagged above 0.5 %). It
writes `triage-table.{json,md}` beside the scoreboard and embeds the report in
`scoreboard.json` as `triage`. Rows from the rw-sim triage test
(`target/parity/triage.json`, `{"rows": [TriageRow]}`, fields as in `triage.ts`:
`case, term, key, phase, unit, ours, ref, ref_label, flag, note?, source`) are
appended with their own `source`.

## Tolerance policy (S:179)

Tolerances may be tightened after measurement. They may be loosened only with
recorded evidence of a motor-curve mismatch: add an entry to `tolerances.json`
`loosened` and a row below, with our curve digest beside OpenRocket's.

| date | case | key | from → to | our curve sha256 | OpenRocket curve sha256 | evidence |
|---|---|---|---|---|---|---|

## Sim per case

Pinned when the goldens land (M1.44 case 1, M2.4b cases 2-7).

| case | sim name | config id | generic motor |
|---|---|---|---|
| 1 | `Simulation 5` | `5d9a2765-395d-4d9c-9678-38eed0988c72` | `RW_C6G` (delay 7 s) |
