# RocketWright task runner. See docs/dev/environment.md.
# Homebrew's cargo shadows rustup's and cannot add targets, so ~/.cargo/bin wins.
PATH := $(HOME)/.cargo/bin:$(PATH)
export PATH
# Some agent shells export ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
unexport ELECTRON_RUN_AS_NODE
# Keep build dirs small: many agent worktrees build at once on one disk.
export CARGO_INCREMENTAL ?= 0
export CARGO_PROFILE_DEV_DEBUG ?= 0
export CARGO_PROFILE_TEST_DEBUG ?= 0
SHELL := /bin/bash
# macOS make 3.81 resolves simple recipe commands with its *startup* PATH (the
# export above only reaches child processes), so call rustup's cargo by path.
# Where rustup lives elsewhere (GitHub's macOS runners), use the cargo on PATH.
CARGO := $(or $(wildcard $(HOME)/.cargo/bin/cargo),$(shell command -v cargo))
export CARGO

PNPM := pnpm --dir app

# ---- determinism on one shared machine (R1.3, GATE-flake) ----------------------
# Concurrent load (other worktrees building, parallel pnpm suites) used to make
# `make check` flaky: SIGKILLed Rust test binaries, E0463 in docs-check, and a
# nested `cargo run` in the rw-wasm I4 test failing with no stderr. So: cap
# parallelism, build the `rocketwright` binaries once up front, and hand their
# paths to every consumer through env (no nested cargo inside test stages).
#   CARGO_BUILD_JOBS   rustc jobs per cargo invocation (cargo -j)
#   RUST_TEST_THREADS  test threads per Rust test binary
#   PNPM_TEST_JOBS     packages `pnpm -r test` runs at once (--workspace-concurrency)
# Each package's `test` script passes `--fsModuleCachePath node_modules/.vitest-cache`
# (package-local): vitest 5 defaults to one cache at app/node_modules, and parallel
# runs that clear it on a lockfile change race (ENOTEMPTY rmdir).
export CARGO_BUILD_JOBS ?= 6
export RUST_TEST_THREADS ?= 4
PNPM_TEST_JOBS ?= 2
PNPM_TEST := $(PNPM) -r --workspace-concurrency=$(PNPM_TEST_JOBS)
# The workspace target dir (CARGO_TARGET_DIR wins) and the two sidecar builds,
# each copied to its own path because cargo writes both feature sets to
# target/debug/rocketwright (and `cargo test -p rw-cli` leaves the `doubles`
# one there through the dev-dependency):
#   RW_PLAIN_BIN    no doubles: `make dev`, the desktop default
#                   (apps/desktop/src/backend.ts), docs-check, seed-fixture,
#                   bar-visual, bar-live. `xtask audit` fails if it has doubles.
#   RW_DOUBLES_BIN  `--features doubles`: the TS suites and e2e only.
RW_TARGET = $(abspath $(or $(CARGO_TARGET_DIR),target))
RW_DEBUG_BIN = $(RW_TARGET)/debug/rocketwright
RW_PLAIN_BIN = $(RW_TARGET)/rw-plain/rocketwright
RW_DOUBLES_BIN = $(RW_TARGET)/rw-doubles/rocketwright
# $(call install_bin,<dest>,<want doubles: yes|no>): copies the fresh
# target/debug build to <dest> atomically, after checking its --version names
# (or does not name) `doubles`, so a concurrent cargo build of the other
# feature set cannot slip in.
define install_bin
	@v=$$("$(RW_DEBUG_BIN)" --version) || exit 1; \
	case "$$v" in *doubles*) has=yes ;; *) has=no ;; esac; \
	if [ "$$has" != "$(2)" ]; then echo "make: $(RW_DEBUG_BIN) is '$$v' (want doubles=$(2)); rerun" >&2; exit 1; fi; \
	mkdir -p "$(dir $(1))" && cp "$(RW_DEBUG_BIN)" "$(1).tmp.$$$$" && mv -f "$(1).tmp.$$$$" "$(1)"
endef

# Lecturn isolation (B8): every dev, e2e and bar run points Lecturn at temp
# dirs and never at ~/.lecturn: LECTURN_HOME (where a user's Lecturn server
# would be found) and RW_LECTURN_BASE_DIR (the Lecturn sidecar's state, so
# fixtures can be imported and `lecturn pair --base-dir` can target it).
# Values already in the env win. `$(lecturn_env)` makes one fresh pair per
# make run under /tmp (kept for inspection) and expands to the assignments;
# e2e alone adds LECTURN_TEST_PROVIDERS=1 (Lecturn's scripted test provider).
define lecturn_env
$(if $(or $(RW_LECTURN_TMP),$(and $(LECTURN_HOME),$(RW_LECTURN_BASE_DIR))),,$(eval RW_LECTURN_TMP := $(shell mktemp -d /tmp/rw-lecturn.XXXXXX)))LECTURN_HOME="$${LECTURN_HOME:-$(RW_LECTURN_TMP)/home}" RW_LECTURN_BASE_DIR="$${RW_LECTURN_BASE_DIR:-$(RW_LECTURN_TMP)/base}"
endef

.PHONY: help env-check check check-fast check-rust check-ts check-cea schema schema-check merge-gate audit docs-check test-gpu \
	e2e wasm dev parity cea-tables cea-data seed-fixture \
	bar bar-visual bar-parity bar-agent bar-live kit package bin-plain bin-doubles vendor-lecturn

help:
	@echo "targets: env-check check check-fast check-cea schema schema-check merge-gate audit docs-check e2e wasm test-gpu dev parity"
	@echo "         cea-tables cea-data seed-fixture bar bar-visual bar-parity bar-agent bar-live kit package vendor-lecturn"

env-check:
	@scripts/env-check.sh

# ---- gates (D16) -------------------------------------------------------------
# Stage 0 (M1.2): Rust fmt/clippy/test/audit + pnpm typecheck/lint/test.
# Lint is oxlint (app/.oxlintrc.json) over every package plus app/e2e and
# scripts/; `lint:self-test` fails if app/lint-fixtures/planted.ts stops failing.
# Stage 2 (M1.9): `make wasm` runs between the Rust and TS halves, because
# @rw/rw-wasm typechecks and tests against the generated pkg/.
# Stage 1 (M1.6): `schema-check` fails on drift between the Rust types,
# schema/, and app/packages/contracts/src/generated/ (invariant I3).
# Stage 3 (M1.18): `make e2e` (Playwright/Electron, incl. b4a.spec.ts) in
# `check` and `merge-gate`. Stage 4 (RL2): `check-cea` in `check` only (not
# `check-fast`/`merge-gate`): it builds the vendored NASA CEA from source.
check-rust:
	$(CARGO) fmt --all --check
	$(CARGO) clippy --workspace --all-targets -- -D warnings
	$(CARGO) test --workspace
	$(CARGO) test -p rw-liquid --features acceptance
	$(MAKE) audit
	$(MAKE) docs-check

# The plain CLI (no doubles) at RW_PLAIN_BIN, as `make dev`, the desktop app,
# docs-check, and `rw` users run it.
bin-plain:
	$(CARGO) build -q -p rw-cli --bin rocketwright
	$(call install_bin,$(RW_PLAIN_BIN),no)

# The `doubles` CLI at RW_DOUBLES_BIN, which every TS suite and e2e spec
# shares through RW_SIDECAR_BIN (their own cargo fallbacks only run outside make).
bin-doubles:
	$(CARGO) build -q -p rw-cli --features doubles --bin rocketwright
	$(call install_bin,$(RW_DOUBLES_BIN),yes)

# TS halves get the prebuilt sidecar; an explicit RW_SIDECAR_BIN wins. app/
# installs the vendored Lecturn tarballs, so vendor-lecturn comes first.
check-ts: vendor-lecturn bin-doubles
	$(PNPM) -r typecheck
	$(PNPM) run lint
	$(PNPM) run lint:self-test
	RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(RW_DOUBLES_BIN)}" $(PNPM_TEST) test
	$(PNPM) run bar:typecheck
	$(PNPM) run bar:test
	$(PNPM) run bar:lint-checklists

# Regenerates schema/ and the TS contracts from the Rust types.
schema:
	$(CARGO) xtask schema
	$(PNPM) --filter @rw/contracts gen

schema-check: vendor-lecturn
	$(CARGO) xtask schema --check
	$(PNPM) --filter @rw/contracts gen:check

# Vendored Lecturn (plan B7, docs/dev/environment.md): scripts/vendor-lecturn.sh
# builds the server and @lecturn/embed at vendor/lecturn/PIN in a temporary
# Lecturn worktree, smoke-tests the kit (clean install, Electron as node,
# app.asar) and fails on theme drift (decision 14); then app/ installs the
# tarballs. Re-runs when PIN, the script or the theme file changes (the stamp
# records the vendored commit). LECTURN_REPO=<dir> names the Lecturn
# checkout; FORCE=1 rebuilds.
#   LECTURN_INSTALL=update  (default) `pnpm update lecturn @lecturn/embed`: a
#                           plain install skips a same-version tarball whose bytes changed
#   LECTURN_INSTALL=frozen  (default when CI is set) `pnpm install --frozen-lockfile`:
#                           the lockfile is authoritative, and the script has already
#                           checked the rebuilt tarballs against it
#   LECTURN_INSTALL=none    tarballs only (the CI kit job)
LECTURN_INSTALL ?= $(if $(CI),frozen,update)
LECTURN_STAMP := vendor/lecturn/.stamp
vendor-lecturn: $(LECTURN_STAMP)
# FORCE=1 also makes the stamp out of date.
.PHONY: vendor-lecturn-force
vendor-lecturn-force:
$(LECTURN_STAMP): vendor/lecturn/PIN scripts/vendor-lecturn.sh app/packages/ui/generated/lecturn-theme.json $(if $(FORCE),vendor-lecturn-force)
	scripts/vendor-lecturn.sh
	@case "$(LECTURN_INSTALL)" in \
	  update) echo "$(PNPM) update lecturn @lecturn/embed"; $(PNPM) update lecturn @lecturn/embed ;; \
	  frozen) echo "$(PNPM) install --frozen-lockfile"; $(PNPM) install --frozen-lockfile ;; \
	  none) ;; \
	  *) echo "make: LECTURN_INSTALL must be update, frozen or none" >&2; exit 2 ;; \
	esac

# Prerequisites run left to right (no -j): Rust, schema drift, wasm, then TS
# (schema-check and check-ts vendor Lecturn first when its stamp is stale).
check-fast: check-rust schema-check wasm check-ts

check: check-fast check-cea e2e

# Stage 4 (RL2, M4.1-M4.2): builds third_party/cea with gfortran + cmake (in
# OUT_DIR, about 1 min per profile) and runs the live CEA tests (RP-1311 ex
# 8-14, LOX/ethanol, custom reactants, relocated data, static link), then
# `cargo xtask tables --verify` (committed tables vs native CEA, Acc 8a),
# then the sidecar's native-CEA engine path (M4.6 `liquid_flow --features cea`:
# custom N2O(L)/IPA(L) equals a direct rw-cea-sys call, relocated binary).
# Required on macOS; elsewhere it skips with a message when the toolchain is
# missing (non-gating, R11).
check-cea:
	@if ! command -v gfortran >/dev/null || ! command -v cmake >/dev/null; then \
	  if [ "$$(uname)" = Darwin ]; then \
	    echo "check-cea: gfortran and cmake are required (brew install gcc cmake)" >&2; exit 1; \
	  fi; \
	  echo "check-cea: skipped (no gfortran/cmake; non-gating outside macOS)"; exit 0; \
	fi; \
	$(CARGO) clippy -p rw-cea-sys --features cea --all-targets --release -- -D warnings && \
	$(CARGO) test -p rw-cea-sys --features cea --release && \
	$(CARGO) clippy -p xtask --features cea --all-targets -- -D warnings && \
	$(CARGO) run --quiet -p xtask --features cea -- tables --verify && \
	$(CARGO) clippy -p rw-cli --features cea --all-targets -- -D warnings && \
	$(CARGO) test -p rw-cli --features cea --test liquid_flow

merge-gate: check-fast e2e

# Clean-room and purity gate (M1.3, docs/dev/clean-room.md).
audit:
	$(CARGO) xtask audit
	$(CARGO) xtask audit --self-test

# Agent briefing (M1.56): generated tables current (`cargo xtask diag-docs`
# rewrites them), every `rw` command/flag in docs/agents/ exists, and every
# fenced `rw` block runs with its stated exit code on a temp project.
# Reuses the workspace target dir: the CLI is built by `bin-plain` (one cargo,
# not one nested inside `cargo run -p xtask`), then handed over as RW_BIN.
docs-check: bin-plain
	RW_BIN="$(RW_PLAIN_BIN)" $(CARGO) xtask docs-check

# Stage 2 (M1.9): rw-wasm -> app/packages/rw-wasm/pkg (wasm-bindgen --target web),
# asserting the wasm-bindgen CLI equals the crate pin.
wasm:
	scripts/build-wasm.sh

# M1.9 GPU gate; needs a logged-in GUI session (not part of check-fast).
test-gpu:
	$(PNPM) --filter desktop test:gpu

# Stage 3 (M1.18): e2e on the live sidecar over the seeded research vehicle
# (M1.53b, M1.55; no contract JSON): Playwright specs app/e2e/*.spec.ts
# (page01 on the web bundle, b4a.spec.ts driving Electron; the JSON report
# feeds `make bar`), then the desktop page-04 spec (vitest, hidden Electron
# window). Builds the sidecar (RW_SIDECAR_BIN overrides) and the web bundle.
#   PAGES=01,04  only those pages' specs (01-03, 05: page0N.spec.ts on the web bundle, 06: page06-eng/page06-visual/fluid/cfd.spec.ts, 04: page04.spec.ts)
#   LIVE=1       accepted for the plan's `make e2e PAGES=01,04 LIVE=1`; live is the only mode
comma := ,
E2E_PAGES := $(subst $(comma), ,$(PAGES))
E2E_PW := $(if $(PAGES),$(strip $(foreach p,$(filter 01 02 03 05,$(E2E_PAGES)),e2e/page$(p).spec.ts) $(if $(filter 06,$(E2E_PAGES)),e2e/page06-eng.spec.ts e2e/page06-visual.spec.ts e2e/page06-rail.spec.ts e2e/fluid.spec.ts e2e/cfd.spec.ts)),all)
E2E_DESKTOP := $(if $(PAGES),$(filter 04,$(E2E_PAGES)),04)
E2E_BIN = $(RW_DOUBLES_BIN)
e2e: vendor-lecturn
	@if [ -z "$$RW_SIDECAR_BIN" ]; then $(MAKE) -s bin-doubles; fi
	$(PNPM) --filter @rw/web build
	$(if $(E2E_PW),$(lecturn_env) LECTURN_TEST_PROVIDERS=1 RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(E2E_BIN)}" $(PNPM) exec playwright test -c e2e/playwright.config.ts $(filter-out all,$(E2E_PW)))
	$(if $(E2E_DESKTOP),$(lecturn_env) LECTURN_TEST_PROVIDERS=1 RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(E2E_BIN)}" RW_E2E_SKIP_BUILD=1 $(PNPM) run e2e:desktop)

# ---- later steps ---------------------------------------------------------------
# M1.52 desktop dev loop: builds the plain sidecar (no doubles, RW_PLAIN_BIN),
# rw-wasm, and the web bundle, then starts Electron 44 (`env -u
# ELECTRON_RUN_AS_NODE`) on a fresh /tmp copy of fixtures/research-vehicle.
# Electron spawns the app server (apps/server/src/rpc/cli.ts) and serves the
# bundle on http://127.0.0.1.
#   PROJECT=<dir>  open that project in place instead
#   BROWSER=1      no Electron: serve the app for a browser (prints RW_APP_URL, OPEN=1 opens it)
#   SMOKE=1        hidden window (or, with BROWSER=1, an RPC round trip); checks the live project, exits
DEV_PROJECT_ARGS = $(if $(PROJECT),--project "$(abspath $(PROJECT))",--dev-project)
DEV_SIDECAR = $(RW_PLAIN_BIN)
dev: vendor-lecturn wasm bin-plain
	$(PNPM) --filter @rw/web build
	cd app/apps/desktop && $(lecturn_env) RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(DEV_SIDECAR)}" env -u ELECTRON_RUN_AS_NODE \
	  $(if $(BROWSER),node src/backend.ts --browser $(if $(OPEN),--open,),./node_modules/.bin/electron src/main.ts -ApplePersistenceIgnoreState YES) \
	  $(DEV_PROJECT_ARGS) $(if $(SMOKE),--smoke,)
# M2.5 (maintainer-only input): `rw import ork` on OpenRocket's examples 1-7
# (read as data from an openrocket/ checkout above the repo or
# $$RW_ORK_EXAMPLES; never committed; docs/dev/environment.md), then
# `rw check` must exit 0; flight numbers vs the original matrix are report
# mode (target/parity/import.json). RW_PARITY_FETCH=1 also fetches missing
# curves from ThrustCurve.org into tests/oracle/cache/ (network, I10).
parity:
	RW_PARITY=1 $(CARGO) test -p rw-cli --test import_parity -- --nocapture
# M4.2: regenerate data/thermo/*.rwtbl with native CEA (about 2-4 min), then
# `cargo xtask tables --verify`. Commit the tables (D19d).
cea-tables:
	$(CARGO) run --quiet -p xtask --features cea -- tables
# M4.1b: install this build's thermo.lib/trans.lib into
# $(PREFIX)/share/rocketwright/cea/ (beside $(PREFIX)/bin/<binary>).
cea-data:
	@test -n "$(PREFIX)" || { echo "usage: make cea-data PREFIX=<dir>" >&2; exit 2; }
	$(CARGO) run --quiet -p rw-cea-sys --features cea --release --bin rw-cea-probe -- --install-data "$(PREFIX)"
# M1.55 (D10a): fixtures/research-vehicle/seed.sh on a fresh DEST (real rw
# commands under RW_CLOCK: steps 01-04, Rev 07, runs), then the check against
# seed.expected.json (titles, origins, revision, run statuses, hashes).
seed-fixture:
	@test -n "$(DEST)" || { echo "usage: make seed-fixture DEST=<new dir>" >&2; exit 2; }
	$(MAKE) -s bin-plain
	RW="$${RW:-$(DEV_SIDECAR)}" node scripts/fixtures/seed.ts "$(DEST)"
# Bar scoreboard (M1.18): refreshes the B2 parity report, then aggregates every
# bar's outputs into target/bar/scoreboard.{md,json} (artifacts/reviews/
# rocketwright_bar/ in a maintainer workspace). Report mode: exits 0.
bar:
	node scripts/bar/scoreboard.ts --self-test
	node scripts/bar/parity.ts
	node scripts/bar/scoreboard.ts
# B1 visual bar (M1.19 shell rows, M1.53 live captures): per page, one command
# writes dist/bar-visual/<page>/{capture.png,tokens.json,regions.json,report.txt}
# and the critic packet (packet/). Pages with a capture script
# (app/e2e/capture/pages/<id>.ts: 01-06; variants such as PAGES=06-engineering run
# <id>-<variant>.ts) run the real app on the live sidecar
# (built here, no doubles) over a fresh copy of fixtures/research-vehicle, driven
# through the RW_TEST_HOOKS=1 app_* broker hooks; other pages capture the static
# shell. ROWS=shell (default) gates the shell rows and lists page-body rows as
# pending; ROWS=all gates every row. Critic packet scope: FIDELITY=1 (fidelity
# verdicts; the page's fidelity milestone, 01-04 M3), BC=BC5 (that checkpoint's
# milestone; fidelity on from BC5), MILESTONE=M3 (override); default M1.
# Needs a GUI session (Electron window).
bar-visual: vendor-lecturn wasm bin-plain
	$(PNPM) --filter @rw/web build
	$(lecturn_env) RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(DEV_SIDECAR)}" node app/e2e/bar/visual.ts --pages "$(or $(PAGES),01)" --rows "$(or $(ROWS),shell)" \
	  $(if $(filter 1 true yes,$(FIDELITY)),--fidelity,) $(if $(BC),--bc "$(BC)",) $(if $(MILESTONE),--milestone "$(MILESTONE)",)
# B2 parity scoreboard (M1.16): report mode exits 0; GATE=1 fails on any
# non-passing toleranced generic-matrix row. CASE=1|2..7, KEYS=apogee_m,...
# --refresh first rewrites our run records (case 1: the M1.42 parity test).
bar-parity:
	node scripts/bar/parity.ts --self-test
	node scripts/bar/triage.ts --self-test
	@# Triage (per-term table) runs even when the gate fails; the gate's status wins.
	CARGO="$(CARGO)" CASE="$(CASE)" KEYS="$(KEYS)" node scripts/bar/parity.ts --refresh $(if $(GATE),--gate,); \
	  s=$$?; CASE="$(CASE)" node scripts/bar/triage.ts || exit $$?; exit $$s
# B3 fresh-agent runner + scorer (RL4): TASK=T1..T5 (default all), KIT=<dir>
# (default dist/kit, built by `make kit` at M2.11). Non-gating: a no-op unless
# RW_LIVE=1 (network + your Claude credentials). Never in `make check`.
bar-agent:
	node scripts/bar/agent-loop.ts --task "$(or $(TASK),all)" $(if $(KIT),--kit "$(KIT)",) $(if $(OUT),--out "$(OUT)",)
# B4(b) live smoke (M1.18 harness, M5.6 driver): non-gating until Q2; a no-op
# unless RW_LIVE=1 (network + your provider CLI's login). Never in `make check`.
# With RW_LIVE=1: builds rw-wasm, the web bundle, and the plain CLI
# (RW_SIDECAR_BIN overrides), then drives the real Electron app's embedded
# Lecturn pane on a fresh `rw init --template minimum` project.
#   OUT=<dir>        artifacts (default <bar out>/live/b4b; result.json is also copied there)
#   TIMEOUT_MIN=<n>  turn timeout (default 15)
# B16 (W-B2, CP-W2): the B4(b) turn, then the approval follow-up turn on a
# temp copy of fixtures/research-vehicle (Supervised approval, Full-access
# and Auto checks, simulate mc=500), recorded apart in result.follow_up.
#   PROVIDER=claude|codex  CP-W2 step 1 (default) or 2 (the CLI must be on PATH, logged in)
#   MODEL=<instance>/<model>  another Lecturn model   NO_FOLLOW_UP=1  skip the follow-up
#   ATTACH=1         CP-W2 step 4 (W-B2.4): live switch, closed, fallback, re-copy; scripted, no RW_LIVE needed
# B16b (CP-W2 step 3): the B4(b) thread's next turn, rw:c/fins from the
# viewport's @, the span question, the reply chip's click; result.mention.
#   NO_MENTION=1     skip it
bar-live: vendor-lecturn
	@if [ "$$RW_LIVE" = "1" ] || [ -n "$(ATTACH)" ]; then \
	  $(MAKE) -s wasm && $(PNPM) --filter @rw/web build && \
	  { [ -n "$$RW_SIDECAR_BIN" ] || $(MAKE) -s bin-plain; } || exit $$?; \
	fi
	$(lecturn_env) RW_SIDECAR_BIN="$${RW_SIDECAR_BIN:-$(RW_PLAIN_BIN)}" node scripts/bar/live-smoke.ts \
	  $(if $(OUT),--out-dir "$(OUT)",) $(if $(TIMEOUT_MIN),--timeout-min $(TIMEOUT_MIN),) \
	  $(if $(PROVIDER),--provider $(PROVIDER),) $(if $(MODEL),--model "$(MODEL)",) $(if $(NO_FOLLOW_UP),--no-follow-up,) $(if $(NO_MENTION),--no-mention,) $(if $(ATTACH),--attach,)
# B3 kit (M2.11, D8, D20): dist/kit/ with the release CLI built with native
# CEA (+ `rw` symlink) and its relocatable databases (share/rocketwright/cea/),
# the unsigned electron-builder `rocketwright-render` app, the skill docs, and
# dist/kit/data/ (the example .ork from ../openrocket, the cached variant from
# tests/oracle/cache/, the case-1 golden; the first two are maintainer-only
# inputs, docs/dev/environment.md). Fails naming any missing input.
# Ends with scripts/kit/test-kit.sh: the kit binary designs a custom
# N2O(L)/IPA(L) engine through native CEA with no env and no repo paths.
#   RW_KIT_NO_DATA=1  no data/ (the release kit: CI has neither .ork input)
kit:
	CARGO="$(CARGO)" scripts/kit/build-kit.sh

# Desktop release (docs/dev/releasing.md): the release CLI (no doubles), the
# WASM core and the web bundle, then scripts/desktop/package.ts stages the app
# (bundled main and server, a clean install of the vendored Lecturn kit with
# @cursor/sdk left out) and runs electron-builder for this host into
# dist/desktop/ (macOS: dmg + zip; Linux: AppImage).
#   TARGETS=dir   other electron-builder targets (dir: the unpacked app only)
#   VERSION=x.y.z the app version (default app/apps/desktop/package.json)
#   SIGNED=1      sign and notarize (macOS; the CSC_* and APPLE_API_* env, see the doc)
package: vendor-lecturn wasm
	$(CARGO) build --release -p rw-cli --bin rocketwright
	$(PNPM) --filter @rw/web build
	node scripts/desktop/package.ts $(if $(TARGETS),--targets "$(TARGETS)",) $(if $(VERSION),--version "$(VERSION)",) $(if $(SIGNED),--signed,)
