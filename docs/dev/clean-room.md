# Clean-room policy

RocketWright implements rocket physics from published literature and from
permissively licensed code (RocketPy, NASA CEA, Lecturn). It contains no code
copied or translated from GPL or LGPL projects (OpenRocket, openMotor, JSBSim,
OpenSCAD). OpenRocket also serves as the parity oracle: an isolated harness
runs it and exports numbers as JSON. This page is the policy and the procedure
for spec R8 and Acceptance 7. The brief every builder agent gets is in
[`builder-brief.md`](builder-brief.md).

## Policy

- **Study, then re-implement.** Reading a GPL or LGPL project's source to
  understand how it approaches a problem is allowed. Copying its code, or
  translating it line by line into Rust or TypeScript, is not. Write the
  implementation from the theory and the published literature, in
  RocketWright's own structure and names (never OpenRocket's class names: the
  audit's denylist), and cite the literature the method comes from on every
  physics function (see Citations). If the only source of a method is the
  GPL code itself, find the paper or report it implements, or leave the method
  out and record the gap.
- **Literature.** Equations, data, and methods may come from any published
  source, cited. Never copy text, figures, or tables from copyrighted books
  and papers (for example Sutton & Biblarz).
- **Permissive code.** Code from MIT, BSD, or Apache-2.0 projects (RocketPy,
  NASA CEA, Lecturn, three.js) may be ported with attribution (rule 5).
- **Data.** ThrustCurve motor files are never committed or bundled (no data
  license); `make parity` caches downloads in the gitignored
  `tests/oracle/cache/`. OpenRocket `.ork` files are never committed. The
  oracle goldens and the case fixtures built from them are OpenRocket-derived
  data, credited in `NOTICE.md` under OpenRocket's GPL-3.0-or-later.
- **Licensing.** RocketWright is AGPL-3.0-or-later ([`LICENSE`](../../LICENSE)).
  Third-party material and its licenses are listed in
  [`NOTICE.md`](../../NOTICE.md), with the license texts in
  [`LICENSES/`](../../LICENSES/).

The same rules apply to people and to agent builders.

## Roster

| Role | Who | May read | Never |
|---|---|---|---|
| Oracle agent | Exactly one agent, which runs OpenRocket to produce goldens | Its harness (`openrocket/oracle/`), OpenRocket and its docs, the example `.ork` files | Writes RocketWright code other than the exported goldens and `tests/oracle/denylist.or.txt` |
| Builders | Physics, core, app, liquid, and bar-tooling agents | The literature, permissive code (with attribution), GPL/LGPL sources to understand an approach, `tests/oracle/*.json`, `.ork` files as importer test data under `make parity` | Copying or translating GPL/LGPL code; copying text, figures, or tables from copyrighted works |
| Reviewer | One agent per milestone | Repo source, the literature, and the same references as builders | The same as builders |
| Critics | Fresh agents per checkpoint | Their packet only, never repo source | Everything else |

The planner (or integrator) assigns roles. An agent keeps one role for its
whole session.

## Rules

1. **Study, don't copy.** Reading GPL or LGPL source to understand an approach
   is allowed; code that lands in the repository is written from the theory,
   in RocketWright's own structure and names (the policy above).
2. **Sources.** Equations come from the published literature declared in
   `docs/dev/citations.toml` (Niskanen, the OpenRocket technical documentation,
   NACA/NASA reports). Copy no prose or figures. Cite the page number.
3. **One-way valve.** Oracle output reaches the repo only through
   `openrocket/oracle/export.sh`, which copies files whose names match
   `tests/oracle/allowlist.txt` (`case<n>-generic.json`,
   `case<n>-generic.series.json`, `case<n>.aero_sweep.json`,
   `case<n>.geometry.json`, `case<n>.provenance.json`, `case<n>-original.json`,
   `denylist.or.txt`) and aborts on any other file. Each JSON validates against
   `schema/oracle-golden.json`: numbers and component names, no free-text field
   over 200 characters. Never `.ork` files, never OpenRocket database curves.
   `-original` goldens carry summary keys only. Physics builders commit the
   generic motor curves before the oracle uses them; the oracle reads them as
   files and never edits them.
4. **OpenRocket worktree hygiene** (oracle only). Before and after every oracle
   run, `git -C openrocket status --porcelain` must print only `?? oracle/`.
   If the database submodule pointer moved, restore it with
   `git -C openrocket submodule update --checkout core/resources-src/datafiles/openrocket-database`.
5. **Attribution.** Ported code (permissively licensed projects only) keeps a
   header or per-function note
   `// Ported from <Project> (<License>) <path>[:<fn>]`, and `NOTICE.md` gets a
   row for the project in the "Ported source code" table in the same change.
   When the upstream license requires its text to accompany copies (MIT, BSD,
   Apache-2.0), add a verbatim copy to `LICENSES/` in the same change.

## Citations

Every `pub fn` in the physics crates (`rw-geom`, `rw-mass`, `rw-aero`,
`rw-atmos`, `rw-motor`, `rw-sim`, `rw-thermo`, `rw-liquid`) has one of these in
the comment and attribute block directly above it:

```rust
/// Normal-force slope of the nose.
/// cite: niskanen2013 eq 3.19 p 34
pub fn cn_alpha_nose(..) -> f64

// Ported from RocketPy (MIT) rocketpy/motors/motor.py:total_mass
pub fn total_mass(..) -> f64

/// cite: n/a builder, no physics
pub fn new(..) -> Self
```

- `cite:` takes `<lit-id> <kind> <n> p <page>`, where `<kind>` is `eq`, `tab`,
  `fig`, or `sec`, and `<page>` is a PDF page number or range (`50-52`). Text
  may follow the page. Several `cite:` lines are allowed.
- `<lit-id>` must be declared in `docs/dev/citations.toml` (step M1.4). The
  audit accepts top-level tables (`[niskanen2013]`), tables one level down
  (`[lit.niskanen2013]`), and arrays of tables with an `id` field
  (`[[source]] id = "niskanen2013"`).
- `cite: n/a <reason>` is for constructors, getters, and conversions. The
  reviewer's sampling checks that it is not used for physics.
- A `Ported from` note in the file's leading comment block covers every
  function in the file.
- Exempt: the frozen IF type stubs (`src/types.rs`, `src/types_*.rs`,
  `src/types/`), test doubles (`src/doubles.rs`, `src/doubles_*.rs`,
  `src/doubles/`), `#[cfg(test)]` items, and `tests/`, `benches/`, `examples/`.
  A `pub fn` whose body is only `let _ = ...;` bindings and a `todo!(...)` (a
  frozen IF signature from M1.5 whose body has not landed) is also exempt; the
  citation becomes required when the body is written.

Each milestone the reviewer samples 3 physics functions against the cited
equations and pages.

## The audit

`cargo xtask audit` runs in `make check` and `make check-fast`
(`crates/xtask/src/audit.rs`). It scans every tracked or untracked-but-not-ignored
file and fails when:

| Check | Fails when |
|---|---|
| `denylist` | A file's contents or path name one of the two OpenRocket Java package roots (built in) or an entry of `docs/dev/clean-room-denylist.txt` or `tests/oracle/denylist.or.txt` (the oracle's class-name export, M1.43). Both list files are required and must hold at least one entry. Plain identifiers match as whole identifiers; entries with `.` or `/` match as substrings. Only the two list files are excluded. |
| `citation` | A physics `pub fn` has no citation, a `cite:` line is malformed, or its lit-id is not in `citations.toml`. `cite:` comment lines in the non-physics crates are checked the same way (well-formed, known lit-id). Every directory under `crates/` must be classified in `PHYSICS_CRATES` or `NON_PHYSICS_CRATES` (`audit.rs`), so a new crate cannot skip the check. A `Ported from` note only counts when it is well-formed (`Ported from <Project> (<License>) ...`). |
| `notice` | A `Ported from <Project> (` note names a project with no row in the `NOTICE.md` "Ported source code" table; the file carrying the note is not covered by a backticked path in that row's "Used in" column (`{a,b}` brace groups and directory entries are allowed); a backticked path in that column does not exist; or a `Ported from <Name>` note lacks its `(<License>)`. |
| `layering` | A pure crate's normal dependency tree (`cargo tree -e normal --target all`) reaches `rw-project`, `rw-cli`, `rw-cea-sys`, `xtask`, `rand`, `getrandom`, `tokio`, `mio`, `notify`, `gix`, or `rmcp` (invariant I5). |
| `doubles` | Any workspace member other than `xtask` builds with the `doubles` feature on in its normal (non-dev) dependency graph, or a release command line in a Makefile, `.cargo/`, `scripts/`, or `package.json` enables it, or a built binary on disk (`target/release/rocketwright`, the dev-app `target/rw-plain/rocketwright`, `dist/kit/bin/rocketwright`) carries a build-provenance marker listing `doubles`, or no marker at all (a stale build: rebuild or delete it). Turn doubles on only from `[dev-dependencies]` or test commands. |
| `ork` | Any `.ork` file is tracked, or untracked and not ignored (`tests/oracle/cache/` is ignored). |
| `motor-provenance` | A file under `lib/motors/` (other than `.md`) has a sha256 that its nearest `PROVENANCE.md` does not contain. |

Options:

- `cargo xtask audit --citations-only`: the citation check alone (M1.4).
- `cargo xtask audit --root <dir>`: audit another checkout.
- `cargo xtask audit --self-test`: builds a good and a bad fixture repository
  in a temp dir. It passes when the good fixture has no findings, the bad one
  trips every check with the expected counts, and `xtask audit --root` exits 0
  and 1 on them.

Adding to the denylist: the oracle agent writes OpenRocket class names to
`tests/oracle/denylist.or.txt`. DATA owns `docs/dev/clean-room-denylist.txt`
and adds only names specific to OpenRocket's implementation, never plain
domain words that RocketWright uses itself.

## Breach procedure

If the audit or a review shows that forbidden material reached the repository
(code copied or translated from a GPL or LGPL project, copied literature,
ThrustCurve files), by an agent or any other contributor:

1. Stop the builder. Quarantine the modules that carry the copied material.
2. Rewrite those modules from the literature with a fresh builder that has not
   seen the quarantined code.
3. Record the incident (who, what path, which modules, the rewrite commit) in
   `docs/dev/clean-room-log.md`.
