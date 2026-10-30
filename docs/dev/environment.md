# Development environment

Run `make env-check` first. It checks every item below and prints the command
that fixes each failure. Optional tools print a warning naming what needs them.

| Tool | Version | Notes |
|---|---|---|
| Rust (rustup) | 1.92.0, pinned by `rust-toolchain.toml` with target `wasm32-unknown-unknown`, `rustfmt`, `clippy` | Crates declare `rust-version = "1.89"` |
| wasm-bindgen-cli | 0.2.129 | Must equal the `wasm-bindgen = "=0.2.129"` crate pin: `cargo install wasm-bindgen-cli --version 0.2.129 --locked` |
| Node | 24.x | |
| pnpm | 12.x | The `app/` workspace; `app/package.json` pins `packageManager` |
| Vite+ (`vp`) | 1.x | `make vendor-lecturn` builds the pinned Lecturn with it (see Vendored Lecturn). Install: `curl -fsSL https://vite.plus \| bash`; `. ~/.config/vite-plus/env` puts `vp` on PATH in the current shell |
| Lecturn checkout | has the commit in `vendor/lecturn/PIN` | `git clone https://github.com/Nurozen/lecturn ../lecturn` from the repo root, or set `LECTURN_REPO`. `git -C ../lecturn fetch` after a re-pin |
| gfortran, cmake (optional) | GCC 15.2; cmake 3.20 or later | The native CEA build (`rw-cea-sys`, feature `cea`): `make check` (`check-cea`), `make kit`, `make cea-tables` |
| pdftotext (poppler, optional) | any | Maintainers: extracting equations from the literature in `citations.toml` |
| JDK 21 (optional) | 21 | Maintainers: runs OpenRocket for the oracle goldens and `tests/oracle/cache/` (see Maintainer-only inputs). env-check finds it via `$JAVA_HOME`, `/usr/libexec/java_home -v 21`, Homebrew's `openjdk@21`, or `java` on PATH |

## Pitfalls

- **Homebrew cargo shadows rustup.** `/opt/homebrew/bin/cargo` ignores
  `rust-toolchain.toml` and cannot add targets. Put `~/.cargo/bin` first:
  `export PATH="$HOME/.cargo/bin:$PATH"`. The Makefile does this for child
  processes, and it calls `$(HOME)/.cargo/bin/cargo` by absolute path because
  macOS make 3.81 resolves simple recipe commands with the PATH it started with.
- **`ELECTRON_RUN_AS_NODE=1`.** Some agent shells export it, which makes
  Electron run as plain Node. Make targets `unexport` it. Outside make, use
  `env -u ELECTRON_RUN_AS_NODE <cmd>`.
- **Electron binary.** Electron 44 has no install script. It downloads its
  binary on first use (`node_modules/electron/install.js`). pnpm 12 controls
  install scripts with `allowBuilds` in `app/pnpm-workspace.yaml`, which
  replaces pnpm 10's `onlyBuiltDependencies`.
- **pnpm minimum release age.** The user-level pnpm config enforces a minimum
  release age. pnpm records exemptions for fresh pins under
  `minimumReleaseAgeExclude` in `app/pnpm-workspace.yaml`.

## Setup

```sh
git clone https://github.com/Nurozen/lecturn ../lecturn   # once
export PATH="$HOME/.cargo/bin:$PATH"
make env-check
make vendor-lecturn   # builds vendor/lecturn/*.tgz, then installs app/
(cd app && pnpm install --frozen-lockfile)
make check
```

`app/package.json` depends on the vendored Lecturn tarballs, so `pnpm install`
in `app/` fails until `make vendor-lecturn` has run once.

## Maintainer-only inputs

These inputs are not in the repository, and the targets that need them fail
with a message naming the missing file:

- **OpenRocket checkout** (`make kit`, `make parity`). The example `.ork`
  files are read as data from
  [OpenRocket](https://github.com/openrocket/openrocket) (GPL-3.0-or-later):
  `RW_OPENROCKET` for `make kit`, `RW_ORK_EXAMPLES` (the
  `core/src/main/resources/datafiles/examples` directory) for `make parity`,
  default `../openrocket`. Never commit `.ork` files.
- **`tests/oracle/cache/`** (gitignored; `make kit`). The generic-curve
  variant `case1-generic.ork` comes from the maintainers' oracle harness
  (`oracle/regen-cache.sh` in their OpenRocket worktree, which
  `scripts/kit/build-kit.sh` runs when present; `RW_KIT_VARIANT` names a file
  instead). `make parity` with `RW_PARITY_FETCH=1` downloads missing motor
  curves into `tests/oracle/cache/thrustcurve/`. The committed goldens in
  `tests/oracle/*.json` come from the same harness.
- **Bar reference material** (`make bar*`, `pnpm bar:calibrate`,
  `pnpm bar:packet`): the concept exemplar PNGs and the embed mockups
  (`RW_BAR_EXEMPLARS`, `RW_BAR_EMBED_ASSETS`); see `bar-tooling.md`.

## Vendored Lecturn (plan B7)

The chat pane is Lecturn (`lecturn` server and `@lecturn/embed`), vendored as
tarballs built from the Lecturn commit in `vendor/lecturn/PIN`.
`make vendor-lecturn` (a prerequisite of `dev`, `e2e`, `bar-visual`, and
`bar-live`) runs `scripts/vendor-lecturn.sh` when the PIN, the script, or
`app/packages/ui/generated/lecturn-theme.json` changes, then runs `pnpm update
lecturn @lecturn/embed` in `app/` (a plain `pnpm install` keeps an installed
tarball of the same version even when its bytes changed). The script:

- fails on theme drift: the pinned commit's
  `examples/embed-host/src/rocketwright-theme.json` must equal
  `app/packages/ui/generated/lecturn-theme.json` byte for byte. RocketWright's
  file is the source (decision 14), so the error usually says to copy it into
  Lecturn and re-pin, or to regenerate it first when it is stale. Allowlisted
  variables newer than Lecturn's copy (`--destructive` since pin4, the stop
  button, mapped to `--rw-danger`; `--success` and `--success-foreground`
  since pin5, the tool row check, mapped to the teal `--rw-success`) are
  generated into
  `app/packages/ui/generated/lecturn-theme-host.json` instead, which the
  hosts send on top and the drift check does not compare;
- builds in a temporary `git worktree add --detach` of the commit in the
  Lecturn checkout (`LECTURN_REPO`, default the nearest `../lecturn` above
  this repo; the script names the clone command when there is none), never in
  the editable Lecturn worktree, and removes it on exit
  (`KEEP_WORKTREE=1` keeps it, `LECTURN_WORKTREE=<dir>` reuses one). No repo
  `.env` is linked, so the build has Lecturn Connect and telemetry off
  (`build` in `lecturn-pack.json`);
- packs with Lecturn's `node apps/server/scripts/cli.ts pack`, checks the
  server tarball has `dist/client/index.html`, and runs Lecturn's
  `scripts/smoke-pack-install.ts --asar --patches --layout both` with the
  desktop's Electron (`RW_ELECTRON`; default the installed desktop package's
  Electron, else the pin's zip in Electron's download cache, else a download
  through the pinned `electron` package's installer): clean installs into empty dirs (hoisted, and isolated with
  the kit's `publicHoistPattern`) probing `node:sqlite`, a node-pty spawn, fff
  search, the Cursor helper lookup, and `serve`, under Node, Electron as node,
  and Electron from an `app.asar` with unpacked natives (plan D3). The
  script runs a copy of the smoke that waits through the server's startup
  503 (`Retry-After`, since 847fc19f3f); Lecturn's own copy fails on it;
- writes `vendor/lecturn/{lecturn.tgz,lecturn-embed.tgz}` and `patches/`
  (gitignored: Lecturn's third-party patches would trip the clean-room
  denylist scan) and `lecturn-pack.json` (committed), and fails unless
  `app/pnpm-workspace.yaml` carries the kit's pnpm settings (`allowBuilds`,
  `publicHoistPattern: ['@cursor/sdk-*']`, `patchedDependencies` pointing at
  `../vendor/lecturn/patches/`).

Re-pin with `scripts/vendor-lecturn.sh <lecturn-commit>` (rewrites PIN), then
`pnpm -C app update lecturn @lecturn/embed`; or write the commit into PIN and
run `FORCE=1 make vendor-lecturn`, which does both. Commit PIN,
`lecturn-pack.json`, and `app/pnpm-lock.yaml` together. `FORCE=1` rebuilds the
current pin.

`app/pnpm-lock.yaml` records each tarball's sha512, so builds must be
reproducible: two builds of one commit pack byte-identical tarballs once the
script normalizes Rolldown's random asset-placeholder ids in sourcemap
`sourcesContent`. At an unchanged pin (PIN as committed) the script fails when a rebuilt tarball
no longer matches the lockfile (`scripts/vendor/lecturn-kit.ts lock`).

Packaging: `app/` stays an isolated pnpm install. The Cursor helper is found
through the public hoist, and an asar package must use Lecturn's layout
(hoisted tree in `app.asar`, `*.node`/`*.dylib`/`spawn-helper` unpacked,
`@cursor/sdk-*` copied beside the archive as real files; see the notes in
`lecturn-pack.json`), which the smoke's asar row proves.

### Lecturn connection (plan B8)

The app server child (`app/apps/server/src/lecturn/connection.ts`) calls
`connect()` from `@lecturn/embed/node` and registers RocketWright
(`lecturn/registration.ts`: app id `dev.rocketwright.app`, tool prefix `rw`,
the same `rocketwright` binary as `RW_SIDECAR_BIN` for `headlessTools`).
Its `instructions` are the provider-neutral runtime block; the agent docs
restate it (`docs/agents/SKILL.md`, In the RocketWright app), so change both
together.
Every opened project becomes a Lecturn workspace keyed by its realpath. The
child connects only when it has a Lecturn base dir:

- `RW_LECTURN_BASE_DIR`: the Lecturn sidecar's state dir; it wins over the
  `--lecturn-base-dir` default, and Electron main passes it as that arg
  when set (else `<userData>/lecturn`). A plain `node src/rpc/cli.ts` with
  neither runs without Lecturn.
- `RW_USER_DATA_DIR`: the desktop app's Electron profile (`userData`) for a
  visible window. Every harness launch sets a temp one
  (`app/e2e/lecturn-env.ts`), so no run writes under the real
  `~/Library/Application Support/Electron`; hidden runs always use a fresh
  temp profile, removed on exit.
- `LECTURN_HOME`: where a user's own Lecturn server would be found (the
  helper's default is `~/.lecturn`).
- `RW_NODE`: the Node that runs the Lecturn sidecar (default: the child's
  own Node).
- `LECTURN_TEST_PROVIDERS=1`: Lecturn's scripted test provider, set by e2e only.

`make dev`, `make e2e`, `make bar-visual` and `make bar-live` set
`LECTURN_HOME` and `RW_LECTURN_BASE_DIR` to a fresh `/tmp/rw-lecturn.*` pair
unless they are already set, and the Playwright global setup does the same,
so no run reads or writes `~/.lecturn`. The live B4(b) launch
(`b4b-live.ts`) makes its own temp pair when none is set, and
`app/e2e/bar/visual.ts` always gives each page a fresh pair with the
scripted provider on (`LECTURN_TEST_PROVIDERS=1`,
`LECTURN_SCRIPTED_PROVIDER_SCRIPTS`, the provider instance in
`<base>/userdata/settings.json`; `app/e2e/lecturn-env.ts`). `b4a.spec.ts`
and `node scripts/bar/live-smoke.ts --rehearse` also get a fresh pair, with
their turn's scripts file (`app/e2e/fixtures/scripted/b4a.json`, `b4b.json`)
and the scripted model as the default, and send the prompt through the
embedded pane's bridge (`app/e2e/embed.ts`).

A harness started by hand (Electron, `scripts/bar/*.ts`) must set
`LECTURN_HOME`, `RW_LECTURN_BASE_DIR` and `RW_USER_DATA_DIR` itself, under
one temp dir, so nothing lands in `~/.lecturn` or the real Electron profile:

```sh
t=$(mktemp -d /tmp/rw-lecturn.XXXXXX)
export LECTURN_HOME=$t/home RW_LECTURN_BASE_DIR=$t/base RW_USER_DATA_DIR=$t/electron
```

W-B2 (`make bar-live`, B16) plays the user's Lecturn client with an admin
session written into the temp base dir (`lecturn auth session issue
--base-dir <dir> ... --token-only`, `scripts/bar/lecturn-admin.ts`); it
never reads `~/.lecturn`.

- `RW_LIVE=1 make bar-live [PROVIDER=claude|codex]`: the B4(b) turn, then the
  approval follow-up on a temp copy of `fixtures/research-vehicle`
  (Supervised `rw_engine_simulate` with no duration, approved; the same call
  in Full access and in Auto with no card; `simulate mc=500` is
  `not_implemented`). Each launch gets a fresh pair whose
  `<base>/userdata/settings.json` makes the provider's model the default;
  the provider's CLI (`claude` or `codex`) must be on `PATH` and logged in.
  `result.json` carries the follow-up under `follow_up`, apart from the
  B4(b) limits. Before that launch closes, the B4(b) thread gets W-B2
  step 3 (B16b, `scripts/bar/mention.ts`): `rw:c/fins` from the
  viewport's `@` into the composer strip, the span question, the span
  string from the turn's own `rw_model_get`/`rw_design_check` result in the
  reply, and a trusted click on the reply's `rw:c/fins` chip that must
  select the fins; recorded under `mention` (`NO_MENTION=1` skips it;
  `--rehearse` replays `app/e2e/fixtures/scripted/b4b-mention.json`).
- `make bar-live ATTACH=1` (W-B2.4): one pair for the run, the scripted
  provider on the sidecar and on a `lecturn serve --base-dir $LECTURN_HOME`
  user server the harness starts and stops; no network. Writes
  `attach-result.json` (live switch; closed: Apps > RocketWright listing,
  a turn from the user's Lecturn web client with RocketWright closed, the
  closed banner and error, reopen; fallback after a restart; a running
  sidecar turn holds the switch, and a subtitle write re-copies nothing). The
  closed check pairs a headless Chromium with the user server
  (`app/e2e/lecturn-web.ts`).

### Embedded agent pane (plan B10)

The agent pane's body is the Lecturn embed once the child's Lecturn
connection is up (`lecturn.status` connecting or connected); page controls
(Changed fields, Run configurations, Missing inputs) sit in the RocketWright
strip `AgentExtras`, outside the embed's rect.

- Desktop: the page reports the rect and the project it shows over the
  preload's `lecturn-embed:*` channel (`@rw/contracts` `embedPane.ts`), and
  main mounts `@lecturn/embed/electron`'s view there (`apps/desktop/src/lecturn.ts`),
  from `embed.target` over its RPC, with `app/packages/ui/generated/lecturn-theme.json`
  (plus `lecturn-theme-host.json`) and no thread switcher. The page's per-page
  composer placeholder goes to main, and the guest's ref-label asks
  (`lecturn/appRefs.describe`) come back to the page, which names `rw:` refs
  from its model. Menus and dialogs over the pane are covered by a
  snapshot of the guest while the view is hidden (D11). A live switch to a
  user's Lecturn reloads the same view at the mapped thread (D25).
- Plain web: the page mounts the iframe itself (`@lecturn/embed/browser`).
- `rocketwright://open?workspace=<dir>&thread=<id>`: packaged desktop runs
  (dev: `RW_REGISTER_PROTOCOL=1`) register the scheme, hold the
  single-instance lock, and open the project, then the thread. Other dev and
  test runs take no lock.
- The embed is the only agent pane: B17 removed the old chat and its
  `RW_AGENT_PANE` / `?pane=` / `VITE_RW_AGENT_PANE` switches. Without Lecturn
  the pane says so in the rect; the static shell (no server) shows a still
  picture of a canned exchange.

## Make targets

`make check` grows in stages. Stage 0 runs `cargo fmt --check`, `cargo
clippy --workspace -- -D warnings`, `cargo test --workspace`, `cargo xtask
audit` (plus the audit self-tests), `pnpm -r typecheck`, `lint` (oxlint with
`app/.oxlintrc.json` over every package, `app/e2e`, and `scripts/`, then
`lint:self-test`, which fails unless `app/lint-fixtures/planted.ts` fails), and `test`,
and the bar tooling checks (`bar:typecheck`, `bar:test`, `bar:lint-checklists`;
see `bar-tooling.md`). Stage 2 (M1.9) adds `make wasm` between the Rust and TS
halves, because `@rw/rw-wasm` typechecks and tests against the generated
`app/packages/rw-wasm/pkg/`. Stage 1 (M1.6) adds `make schema-check`
(`cargo xtask schema --check` and `pnpm --filter @rw/contracts gen:check`),
which fails when the Rust types, `schema/`, and
`app/packages/contracts/src/generated/` disagree; `make schema` regenerates
both. Stage 3 adds e2e (M1.18) and stage 4 adds `make check-cea` (RL2, `check` only). `make check-fast` is stages 0-2,
and `make merge-gate` adds e2e.
`schema-check` and `check-ts` depend on `vendor-lecturn` (app/ installs its
tarballs), so a stale or missing kit is vendored first.

`make package` builds the desktop app with electron-builder into
`dist/desktop/` (macOS dmg and zip, Linux AppImage); CI and the release
workflow are described in [`releasing.md`](releasing.md).

`make docs-check` (`cargo xtask docs-check`, in `check-rust` since M1.56)
guards the agent briefing in `docs/agents/`. It fails when the generated
tables are stale (`cargo xtask diag-docs` rewrites `diagnostics.md` and the
`<!-- generated:* -->` blocks of `rocketwright-model.md`), when a `rw`
command or flag mentioned there does not exist, or when a fenced `rw` block
does not exit with its stated code on a temp project.

### Determinism under load (R1.3)

`make check` must pass on a shared 24 GB machine with other worktrees
building. The Makefile therefore:

- caps parallelism: `CARGO_BUILD_JOBS=6` (cargo `-j`), `RUST_TEST_THREADS=4`,
  and `PNPM_TEST_JOBS=2` (`pnpm -r --workspace-concurrency` for `pnpm -r
  test`). All three are `?=` defaults; override on the command line.
- builds `rocketwright` once per flavour before its consumers, each copied
  to its own path (cargo writes both flavours to `target/debug/rocketwright`,
  so nothing reads that path): `bin-plain` (no features) installs
  `target/rw-plain/rocketwright`, which `docs-check` (`RW_BIN`), `make dev`,
  and the desktop app's default sidecar use; `bin-doubles` (`--features
  doubles`) installs `target/rw-doubles/rocketwright`, which every TS suite
  and e2e spec gets through `RW_SIDECAR_BIN`. No test stage runs a nested
  `cargo build`/`cargo run`; the in-test cargo fallbacks only run outside make.
- `rocketwright --version` names non-default features (`rocketwright 0.1.0
  (features: doubles)`), and the binary embeds a build-provenance marker.
  `cargo xtask audit` reads it from `target/release/rocketwright`,
  `target/rw-plain/rocketwright`, and `dist/kit/bin/rocketwright` and fails
  when one was built with `doubles` or predates the marker (rebuild it).
- opens the desktop hidden window with retries: `main.ts` polls the app origin
  until it answers, and when Electron rejects the first navigation
  (`ERR_FAILED (-2) loading 'about:blank'`) it destroys the window and tries
  a fresh one (4 attempts, within `--timeout-ms`).
- tolerates two load-only timing effects in tests: the `render3d`
  absent-renderer test retries an exec that the OS SIGKILLed (a real crash
  still fails), and the server `model.patch` RPC test accepts the sidecar's
  notifications split across two coalesced patches (same keys, each once).

`make test-gpu` (`pnpm --filter desktop test:gpu`) is the WebGPU gate. It needs
a logged-in GUI session, so it is not part of `check-fast`. See
`docs/dev/spikes.md` (M1.9).

E2e specs run on the live sidecar over the seeded research vehicle (M1.53b;
contract JSON stays in unit tests). `make e2e [PAGES=01,04]` builds the sidecar
(`--features doubles` at `target/rw-doubles/`, the server tests' artifact;
`RW_SIDECAR_BIN` overrides) and
the web bundle, then runs:
- Playwright (`app/e2e/playwright.config.ts`, `pnpm --dir app e2e [spec]`): the
  global setup seeds one pristine project (`RW_E2E_SEEDED`), starts the app
  server on a copy (`RW_E2E_RPC_URL`, `RW_E2E_HTTP_URL`, `RW_E2E_PROJECT`), and
  serves the web bundle (`RW_E2E_WEB_URL`). `page01.spec.ts` drives the web
  bundle; its inspector numbers equal `rw check --json`. `b4a.spec.ts` opens a
  copy in Electron with the embedded Lecturn pane and
  Lecturn's scripted provider replaying `app/e2e/fixtures/scripted/b4a.json`.
- `pnpm --dir app e2e:desktop [page04]` (vitest, `app/e2e/vitest.config.ts`):
  `page04.spec.ts` opens a seeded copy in the desktop hidden window (`--project`,
  1536x1024, DPR 1), drives it with `app/e2e/page04.drive.ts`, and checks the
  report against the seeded runs' `summary.json`/`series.csv`. Writes
  `dist/e2e/page04/`. `RW_E2E_SKIP_BUILD=1` reuses `apps/web/dist`.
All need a GUI session (Electron). Seeded copies live under `/tmp` (not macOS's
long `$TMPDIR`) so `.rw/sidecar.sock` stays under the 104-byte socket path limit.

`make seed-fixture DEST=<dir>` runs `fixtures/research-vehicle/seed.sh` (real
`rw` commands under `RW_CLOCK`: steps 01 Initial concept, 02 Assembly layout,
the Fin revision run, 03 Fin revision, 04 Flight runs (launch rail on both flight sims) tagged Rev 07, then
the Baseline and Higher altitude runs; Recovery test Not run) and checks the
result against `seed.expected.json` (`scripts/fixtures/seed.ts`: titles,
origins, times, revision, run statuses, hash relationships; no physics numbers).

## Purity (invariant I5)

The root `clippy.toml` disallows filesystem, clock, thread, and RNG calls.
Pure crates opt in with `#![deny(clippy::disallowed_methods,
clippy::disallowed_types)]`, and native crates (`rw-project`, `rw-cli`,
`rw-cea-sys`, `xtask`) opt out with `#![allow(..)]`. A new crate must pick one.
`rw-cea-sys` is outside `default-members`. Build it with `-p rw-cea-sys`.

## NASA CEA (`rw-cea-sys`, feature `cea`, RL2)

`third_party/cea` is NASA CEA 3.3.4 vendored at `2f79a64`
(`third_party/cea/ROCKETWRIGHT.md`). With `--features cea`, the
`rw-cea-sys` build script builds it and links it statically; without the
feature the crate builds nothing native (so `make check-fast` needs no
gfortran). `make check-cea` (part of `make check`, stage 4) runs
`cargo clippy` and `cargo test -p rw-cea-sys --features cea --release`
(RP-1311 examples 8-14 against the reference outputs, compared by key; the
relocation test), then `cargo xtask tables --verify`.

- Toolchain: gfortran (Homebrew GCC; `FC` overrides) and cmake >= 3.20. A
  missing tool fails the build with an install hint.
- The build copies `third_party/cea` to `$OUT_DIR/cea-src`, applies
  `patches/0001-bindc-libtype.patch`, and builds there. Never build in place:
  CEA's top-level build writes into its source tree.
- `CMAKE_OSX_DEPLOYMENT_TARGET` follows `MACOSX_DEPLOYMENT_TARGET` (default
  11.0, rustc's arm64 default), which keeps ld quiet.
- GCC runtime archives come from `gfortran -print-file-name=libgfortran.a`
  and `-print-libgcc-file-name` and are copied into `$OUT_DIR` as
  `librw_{gfortran,quadmath,gcc,emutls_w}.a` (macOS ld64 has no `-l:file.a`,
  and `-lgfortran` would pick the dylib). Only those stale copies are deleted
  on rebuild (they inherit Homebrew's 0444 mode). A linked binary depends on
  `libSystem` only (tested with `otool -L`).
- The thermo/trans databases are compiled at build time
  (`$OUT_DIR/install/share/cea`, exported as `DEP_CEA_BINDC_DATA` and
  `rw_cea_sys::BUILD_DATA_DIR`, a build-tree path for in-tree tests and
  tools only). Shipped binaries find them with `Cea::locate_data_dir()`
  (`rw_cea_sys::data`): `$RW_CEA_DATA` (authoritative: a bad value is an
  error, never a fallback), then `<bin>/../share/rocketwright/cea/`, then
  `<X>.app/Contents/Resources/cea/`. `make cea-data PREFIX=<dir>` installs
  them as `<dir>/share/rocketwright/cea/`; `tests/relocate.rs` copies the
  `rw-cea-probe` binary plus `share/` to a temp dir, makes the build tree
  unreadable, and checks the solve matches the in-tree one.
- Errors: `CEA_FORTRAN_ABORT` (a Fortran `abort` CEA's setjmp guard
  recovered, e.g. an unknown species) is `CeaError::FortranAbort` with CEA's
  message; the database stays usable. FAC rocket solves return CEA 3's
  stations `[injector, infinity, combustor end, throat, exits...]`.
- The database is process global and CEA is not thread safe: `Cea::init`
  loads it once (absolute path, `OnceLock`), and every call runs under one
  Mutex. Parallelize table generation with processes.
- Unit strings are closed enums (`EnthalpyUnit`, `TempUnit`) that emit
  only CEA's exact lowercase spellings (`j/mole`, `kj/mole`, `kcal/mole`,
  `cal/mole`; `k`, `c`, `f`, `r`). CEA silently treats any other spelling as
  zero. In generated input decks, never write `kcal/mol` (CEA's deck parser
  reads it as cal/mol).
- Custom reactants (`rw_cea_sys::propellants`): N2O(L) h = 71.02 kJ/mol
  (saturated liquid, 298.15 K) and IPA(L) h = -318.1 kJ/mol (NIST), passed
  in J/mol. Both are absent from `thermo.inp`.

## Thermo tables (`data/thermo/*.rwtbl`, M4.2-M4.3)

`make cea-tables` (`cargo xtask tables`, about 2-4 min) solves every grid
node with native CEA and writes one `.rwtbl` per shipped pair: O/F step 0.025
over the pair's range, Pc 5-100 bar (9 log-spaced points, ratio <= 1.5),
17 supersonic area ratios 1.5-100, equilibrium and frozen-at-chamber flow.
The header records the CEA version, the `thermo.inp` SHA-256, the reactant
definitions, and the axes. Output is deterministic, so a regeneration with
an unchanged CEA is byte-identical. The tables are committed (D19d).

`cargo xtask tables --verify` (in `make check-cea`) fails when a committed
header differs from a fresh generation (CEA or `thermo.inp` changed: run
`make cea-tables`) and re-solves 10 random points per pair and mode
natively; Isp, c*, and Tc must interpolate within 0.5% (Acc 8a; observed
<= 0.27%). Frozen fuel-rich expansions (LOX pairs near the low-O/F end) do
not converge at some area ratios; those values are NaN, and a lookup that
touches one is an error rather than a guess.

`rw-thermo` (pure, wasm-safe) parses the bytes and interpolates
multilinearly in (O/F, ln Pc, ln eps); out-of-range points are errors, not
extrapolations. `make wasm` copies the tables to
`app/packages/rw-wasm/pkg/thermo/`; the `thermo_lookup` export takes the
bytes plus a query, and `@rw/rw-wasm` resolves `thermoTableUrl(pair)`
against the bundle (no network, I10).

## Desktop dev loop (`make dev`, M1.52)

`make dev` builds the sidecar (`rw-cli` with `doubles` until the Session
lands), rw-wasm, and the web bundle, then starts Electron 44 with `env -u
ELECTRON_RUN_AS_NODE`. Electron's main (`app/apps/desktop/src/main.ts`)
spawns the app server (`app/apps/server/src/rpc/cli.ts`, through `env -u
ELECTRON_RUN_AS_NODE node`), serves the bundle on `http://127.0.0.1:<port>`
(never `file://`: WASM needs http), and passes the server URLs both in the
page query (`rpc=`, `http=`) and through the preload as `window.rwDesktop`.

The RPC socket needs the server's per-launch secret: `RW_RPC_URL` (and
`AppServer.rpcUrl`) is `ws://127.0.0.1:<port>/rpc?token=<secret>`, and an
upgrade without it is refused (401). The preload's `rpcUrl` carries it; the
page URL keeps `rpc=` token-free and puts the secret in the fragment
(`#token=…`, never sent to a server), which the web entry reads
(`app/apps/web/src/rpcUrl.ts`). A browser `Origin`, when present, must also be
the app's own (localhost or `app://`); local tools without an Origin need only
the token. Drivers that open the socket themselves (e2e, bar captures) take
the URL from the server, the preload, or `rpc=` plus `#token=`.

- Project: a fresh `/tmp/rw-dev-*` copy of `fixtures/research-vehicle` (an
  empty temp project until the fixture lands); `PROJECT=<dir>` opens a
  project in place. Temp projects live under `/tmp` because the sidecar's
  Unix socket path is limited to about 104 bytes on macOS.
- `BROWSER=1`: no Electron. `node src/backend.ts --browser` prints
  `RW_APP_URL=…` for an ordinary browser; `OPEN=1` opens it.
- `SMOKE=1`: a hidden window waits for the shell and checks that the header
  names the opened project, prints JSON, and exits (needs a GUI session). With
  `BROWSER=1` it instead fetches the page and does an RPC `project.list`.
- Captures: `main.ts --render-out <png>` (or `--hidden` without a PNG) also
  accepts `--project <dir>` to capture against the live server.
- The preload is `preload.ts` with its types stripped at startup
  (`node:module` `stripTypeScriptTypes`): sandboxed preloads must be CommonJS
  and Electron does not strip preload types. An ESM main must not use
  top-level `await` before `app.whenReady()` (it deadlocks).
