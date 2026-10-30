# RocketWright

RocketWright is agent-driven rocket design and simulation for hobbyists. A
Rust core (model, checks, aerodynamics, flight simulation, liquid engines)
runs behind the `rocketwright`/`rw` CLI, a stdio MCP server, a WASM build, and
an Electron desktop app whose agent pane is an embedded
[Lecturn](https://github.com/Nurozen/lecturn). Every number a user sees comes
from the engine, never from a model's arithmetic.

Setup is in [README.md](README.md); toolchain details and pitfalls are in
[docs/dev/environment.md](docs/dev/environment.md). These are defaults, not
hard rules; the developer's instructions win. If a rule here fights the task,
say so before breaking it.

## Where code lives

- `crates/`: the Rust workspace. Pure crates (`rw-model`, `rw-units`,
  `rw-geom`, `rw-mass`, `rw-aero`, `rw-atmos`, `rw-motor`, `rw-sim`,
  `rw-thermo`, `rw-liquid`, `rw-check`, `rw-draw`, `rw-ork`, `rw-api`,
  `rw-wasm`) do no I/O; native crates (`rw-project`, `rw-cli`, `rw-cea-sys`,
  `xtask`) own files, processes, and NASA CEA. `rw-cli` is the CLI, MCP
  server, and app sidecar.
- `app/`: the pnpm workspace. `apps/desktop` (Electron main), `apps/server`
  (app server child, Lecturn connection), `apps/web` (UI), `packages/`
  (contracts, UI tokens, rw-wasm, the bar-only `bar-agent`), `e2e/`
  (Playwright, bar tooling).
- `schema/` and `app/packages/contracts/src/generated/`: generated from the
  Rust types. Never edit them by hand.
- `docs/agents/`: the agent briefing and skill shipped to users;
  `docs/dev/`: contributor docs.
- `fixtures/`, `templates/`, `lib/` (motors, presets), `data/thermo/`
  (committed CEA tables), `tests/` (oracle goldens, bar data, validation).
- `third_party/cea/`: vendored NASA CEA (Apache-2.0). `vendor/lecturn/`: the
  pinned Lecturn kit (`PIN` and `lecturn-pack.json` committed, tarballs built
  by `make vendor-lecturn`).

## Build and test

Put rustup's cargo first (`export PATH="$HOME/.cargo/bin:$PATH"`); Homebrew's
`cargo` ignores `rust-toolchain.toml`.

- Smallest proof first: `cargo test -p <crate>`, `cargo clippy -p <crate>
  --all-targets -- -D warnings`, `pnpm --dir app --filter <package> test`,
  `pnpm --dir app --filter <package> typecheck`.
- `make check-fast`: fmt, clippy, Rust tests, `cargo xtask audit`,
  `make docs-check`, schema drift, WASM, TS typecheck/lint/tests, bar tooling
  checks. Run it when a change crosses Rust, schema, and TS.
- `make check`: `check-fast` plus native CEA (`check-cea`, needs gfortran and
  cmake) and the Playwright/Electron e2e specs (needs a GUI session).
- Do not run the full gates repeatedly as a substitute for focused tests; they
  rebuild everything. The Makefile caps parallelism (`CARGO_BUILD_JOBS`,
  `RUST_TEST_THREADS`, `PNPM_TEST_JOBS`) because several worktrees often build
  on one machine.
- After changing Rust types that cross the wire: `make schema`, and commit the
  regenerated `schema/` and TS contracts with the change.
- After changing diagnostics or commands: `cargo xtask diag-docs` regenerates
  the tables in `docs/agents/`; `make docs-check` runs every fenced `rw` block.
- `make dev` runs the desktop app on a temp copy of
  `fixtures/research-vehicle`.

## Invariants

- **Single writer.** Only the Rust session writes a project; the app host and
  UI change it through sidecar tool calls and id-keyed model patches. See
  [docs/dev/project-session.md](docs/dev/project-session.md).
- **Purity.** `clippy.toml` disallows filesystem, clock, thread, and RNG calls.
  Pure crates `#![deny]` them and native crates `#![allow]` them; a new crate
  must pick one.
- **Generated contracts.** The Rust types are the source of `schema/` and the
  TS contracts; `make schema-check` fails on drift.
- **WASM equals the sidecar.** The in-page preview must match the sidecar's
  evaluation exactly.
- **Deterministic output.** Reports and run records are byte-stable: sorted
  keys and fixed precision.
- **Offline.** No network at runtime; motor library and thermo tables ship
  with the binary. The one exception is the ThrustCurve search and download
  the user explicitly asks for (`rw motor thrustcurve`, the
  `thrustcurve_search`/`thrustcurve_fetch` tools, Search ThrustCurve in the
  motor picker); its client lives in `rw-cli` (`src/thrustcurve.rs`), never in
  the session or a pure crate. Downloaded files are the user's, never
  bundled or committed. Other network access is opt-in test tooling only.
- **Stable diagnostics.** Diagnostic codes keep their meaning; new ones go in
  their documented range.
- **Never the user's repo.** History lives in `.rw/`, never in the user's git
  repository.
- **No test doubles in shipped binaries.** The `doubles` feature is for tests
  and e2e only (`target/rw-doubles/`); `make dev`, docs-check, and releases use
  the plain build (`target/rw-plain/`). `cargo xtask audit` checks.

## Clean room and provenance

RocketWright is AGPL-3.0-or-later and clean-room with respect to GPL and LGPL
projects. Details: [docs/dev/clean-room.md](docs/dev/clean-room.md).

- OpenRocket, openMotor, JSBSim, and OpenSCAD (GPL/LGPL) may be read to
  understand an approach. Never copy their code or translate it line by line.
  Re-implement from the theory and cite the published source.
- MIT, BSD, and Apache-2.0 code (RocketPy, NASA CEA, Lecturn) may be reused:
  put `// Ported from <Project> (<License>) <path>[:<fn>]` on the ported code
  and add a row to `NOTICE.md` in the same change.
- Every `pub fn` in the physics crates carries `/// cite: <lit-id> eq <n> p
  <page>` (lit-ids in `docs/dev/citations.toml`), a `Ported from` note, or
  `/// cite: n/a <reason>` for non-physics helpers.
- Never write OpenRocket package or class names into the repository
  (`docs/dev/clean-room-denylist.txt`). Never commit `.ork` files. A motor file
  under `lib/motors/` needs its sha256 in the nearest `PROVENANCE.md`.
- `cargo xtask audit` enforces all of this in every gate.

## Machine safety

- Never kill processes by name or pattern (`pkill -f`, `pgrep | kill`). Other
  worktrees and dev servers run on the same machine. Kill only a PID you
  started.
- Never touch the developer's live Lecturn state in `~/.lecturn`. Make targets
  point Lecturn at fresh `/tmp/rw-lecturn.*` dirs; a harness started by hand
  must set `LECTURN_HOME`, `RW_LECTURN_BASE_DIR`, and `RW_USER_DATA_DIR` to a
  temp dir itself (see environment.md).
- Some agent shells export `ELECTRON_RUN_AS_NODE=1`; run Electron with
  `env -u ELECTRON_RUN_AS_NODE` outside make.
- Temp projects belong under `/tmp`, not macOS's long `$TMPDIR`: the sidecar's
  Unix socket path is limited to about 104 bytes.

## Docs and comments

- `docs/agents/` is user-facing and checked by `make docs-check`; keep it in
  the product's voice. The app's runtime instructions
  (`app/apps/server/src/lecturn/registration.ts`) and `docs/agents/SKILL.md`
  state the same rules; change both together.
- `docs/dev/` records decisions and traps that the code cannot show. Rewrite
  the affected text when behavior changes; do not append history.
- Comments say why. Code comments cite plan ids (`M1.18`, `D19`, `B7`, `I5`)
  from the maintainers' plan, which is not in this repository; keep them
  accurate but do not add them to user-facing docs.
- Some targets read maintainer-only inputs (an OpenRocket checkout, the oracle
  cache, bar reference images); see environment.md, Maintainer-only inputs.

## Commits and pull requests

- Conventional commit titles in plain language:
  `fix(vendor): find the Lecturn checkout reliably`.
- Body: the problem in a sentence or two, then the fix. End with the model and
  harness if an agent did the work.
- One problem per PR; UI changes need before/after screenshots attached to the
  PR, not committed.
- Never commit plans, research notes, or scratch files; `artifacts/` is
  gitignored as a safety net.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.
