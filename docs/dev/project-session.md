# Project session, lock, forwarding, history, watcher (M1.25b-M1.29)

`rw_project::Session` is the only writer of project files (I1) and runs every
`rw_api::Command` (I2). Code: `crates/rw-project/src/{layout,library,session,lock,history,watch,check}.rs`,
`crates/rw-cli/src/forward.rs`.

## Layout (`layout.rs`, `library.rs`)

- Sources: `rocketwright.toml`, `*.rw.toml`/`*.rw.json` outside `lib/`, `runs/`,
  `renders/`, and hidden directories (depth <= 4). `parts/*.rw.toml` merge by `include`.
- Library: `lib/components/*.rw.toml`, `lib/materials/*.rw.toml`, `lib/motors/*.eng|*.rse`.
  `rocketwright.toml [lib.sha256]` pins each file:
  - mismatch, or a recorded file missing: `RW-E006 lib-hash` (error; the file is not used);
  - file with no recorded hash: `RW-W003 lib-unrecorded` (warning; used).
- Library materials merge into evaluation as defaults (project definitions win).
  Component presets and motors are search-only (`library_search`, `library_show`).
- `Session::lib_record` writes the current hashes into `[lib.sha256]` (a normal step).

## Mutation pipeline (`session.rs`)

ops -> `TomlStore::preview` -> eval (+library) -> `Checker` -> dry run returns
-> atomic write (temp + rename) -> own-write set -> history step -> events ->
`MutationOut { step: "step:<n>", model_hash, delta }`.

- The checker is a seam (`Checker`). The default `StaticChecker` builds
  geometry, motors, mass, and aero from the evaluated model and runs
  `rw_check::check_static`; deltas are `CheckDelta::between`, and step
  metrics carry the liftoff mass and margin. Motor refs resolve through the
  library (`generic:<id>`, `lib:<path>[#<designation>]`, or a designation;
  hash-mismatched files are not used). `StaticCheckDouble` (diagnostics and
  dimensions, zero physics) remains for write-path tests.
- A no-op mutation writes nothing and records no step (D3).
- Opening a writer session records `Initial snapshot` (first time) or
  `External edit` (files changed while no owner ran); an unchanged tree adds nothing.

## Lock and forwarding (D4; `lock.rs`, `forward.rs`)

- `.rw/lock`: exclusive `flock` for the owner's lifetime, record
  `{pid, socket, started}`. The kernel drops the flock on any exit (`kill -9`
  included), so a stale record never blocks. The file is never unlinked
  (unlinking a flocked file lets two owners lock different inodes).
- Second owner: `RW-E007 locked-by <pid>` (`ApiErrorCode::Locked`, exit 2).
- The sidecar (`rocketwright mcp`, `mcp/relay.rs`): every instance is a relay
  front. The first takes the lock, binds the socket (a bind failure drops the
  lock and retries), then opens the session and the watcher; its stdio talks
  to an in-process server. Later instances relay their stdio to the owner's
  socket unchanged (`clientInfo.name = "rocketwright-relay"`, origin `mcp`, so
  no CLI-only commands). When the owner goes away a relay re-runs the election
  (promote or reconnect) and replays `initialize`, `initialized` and its
  subscriptions. Calls lost with the owner: read-only ones (catalogue
  `read_only`, read-only MCP methods) are resent once; mutations get
  `unavailable` with `outcome: "unknown"` (they commit before replying, so
  check `history_list` before retrying). Once the new upstream answers, the
  relay sends `resources/updated` for each subscription and
  `notifications/rw/upstream-changed`, on which `ProjectHost` resyncs its
  mirror. An upstream that closes without answering processed nothing, so
  its calls are resent without using up the retry. This happens on Linux:
  the kernel releases a dead owner's files newest first, so its relay
  connections close while its listener still accepts and its flock is
  still held, and a relay that re-elects in that window reaches the dead
  listener's backlog. Test hooks (`RW_TEST_HOOKS=1`): `RW_TEST_EXIT_BEFORE=<tool>` /
  `RW_TEST_EXIT_AFTER=<tool>` make the owner exit around a call. An owner whose stdio client leaves drains: it serves while
  relays are attached or jobs run, then exits. A `--no-socket` owner makes
  later instances exit 2 (`RW-E007`). `--list-tools` prints `tools/list` and
  exits without the lock. Socket paths over 103 bytes fall back to
  `$TMPDIR/rw-<hash12>.sock`, recorded in the lock. `RW_MCP_TRACE=1` logs the
  role on stderr. A directory without `rocketwright.toml` gets no session:
  contract-fixture doubles only (the app's offline tests). The server tests
  cover both: empty temp dirs (doubles) and copies of `fixtures/simple`
  (`tempProject(prefix, seed)`; real Session and check).
- CLI (`rocketwright call [--project D] [--label L] <tool> '<json>'`, the M1.30
  commands build on `forward::run`):
  - lock held + socket reachable: forward over `.rw/sidecar.sock` with
    `_meta["rw/origin"]="cli"` (CLI-only commands are allowed on the socket);
  - lock held + socket unreachable: exit 2, nothing written (no lock fallback);
  - no lock: in-process session (writer for non-read-only commands).

## History (D2/D3; `history.rs`)

- Private bare repo `.rw/history.git` (gix, opened isolated), one linear ref
  `refs/rw/history`, `commit_as` with CAS retry (first parent must be the head).
- Commit message trailer `Rw-Step: <HistoryStep JSON>`; `.rw/history/steps.jsonl`
  is a cache rebuilt from the trailers when it does not end at the head.
- Revisions: `refs/rw/rev/<NN>` -> commit (parent = tagged step) with an
  `Rw-Rev:` trailer `{number, name, step}`; never on the linear ref.
- Versions: `live`, `HEAD`, `step:<n>`, `rev:<NN>`, `commit:<sha or prefix>`.
- Never touches the user's repo (I15; test with a dirty index and 10 steps).
- `RW_CLOCK` pins step time (and run `started`): RFC 3339 UTC (`2026-10-15T14:04:00Z`) or Unix seconds.
- `rw --snapshot-label <title> <cmd>` titles the snapshot step an in-process
  writer records on open (`Initial snapshot` / `External edit` by default;
  `SessionOptions::with_snapshot_title`). Ignored when forwarding to a live owner.
- `history_tag` takes an optional `number` (`rw history tag <name> [version]
  --number N`); it must exceed every existing revision number.
- `fixtures/research-vehicle/seed.sh` builds its history this way (M1.55, D10a).

## Watcher (`watch.rs`)

- `notify` + `notify-debouncer-full` at 200 ms. Event kinds are not trusted;
  any batch touching a source or library path, or a directory that can hold
  them, calls `Session::sync_settled`, which compares content (own-write
  set, last-good texts) and re-reads. Directory events count because inotify
  watches a new directory only after it has seen it appear (files created in
  it before then send nothing), and a directory moved in or out reports only
  itself. Access events do not count, except a close after writing: inotify
  reports every `open`, including the sync's own reads, which would wake the
  watcher again.
- Nothing is applied while a changed source was modified less than 200 ms
  ago: a batch for another path (or an older event; the debouncer drops data
  events right after a create or rename-into-place) can fire in the middle
  of an in-place save, whose truncated, empty file parses. The watcher syncs
  again once the file has been quiet for 200 ms.
- A file that does not parse keeps the last good model and reports
  `RW-E001`/`RW-E002` in the check report until fixed. No step meanwhile.
- External steps carry `origin = watcher`. A forwarded CLI write and its
  watcher echo are one step.

## Runs and jobs (M1.28; `runs.rs`, `jobs.rs`, `session/runs_cmd.rs`)

- `run_id` = first 12 hex of blake3 over the JCS form of `{model_hash,
  config, sim, motors (curve sha256s), engine?, core_version, seed,
  integrator}`. Same inputs, same id: `simulate` answers a cache hit
  (`cached: true`, no job) unless `force`.
- `runs/<sim>/<id>/{manifest,summary,events}.json` + `series.csv` (header of
  `SERIES_COLUMNS` names, `t` first; the sim's `series_dt` grid plus exact
  event rows, 9 significant figures). Written into a hidden temp dir, then
  renamed. `summary.json` is canonical (sorted keys, 6 s.f.) and byte-stable;
  only `manifest.json` has wall-clock fields (`started`, `wall_time_s`).
- `run_list`: one entry per sim (its latest run), followed, when there is one,
  by the run that latest replaced (the newest earlier run on another model),
  with `superseded_by` = the latest run id, so an edit's before and after
  compare (B4(a)). The web keys such rows `<sim>@<run id>`; a rerun of a plotted
  sim plots the pair.
- Status is computed: `running` (an active job), `failed` (the sim's newest
  job failed), else `complete` when the manifest `model_hash` equals the
  current model's, otherwise `outdated`; `not_run` without a run.
- `JobQueue`: up to 2 workers started on demand. The flight (aero, mass,
  `rw_sim::simulate`) runs on a worker, never on the MCP loop or under the
  session lock. Listeners hear every state change and each 10 % of progress;
  the sidecar maps them to `notifications/resources/updated` for
  `rw://jobs/<id>` and `rw://runs/index`. No `notifications/progress` is sent.
- Test hook (I12): `RW_TEST_HOOKS=1 RW_TEST_SIM_DELAY_MS=<ms>` delays a job.
- `run_diff` with `golden`: rows per `OR_SUMMARY_KEYS` (+ the static keys
  from the check of the run's config when the run is current); tolerances
  from `tolerances.json` beside the golden (case group), overridden by `tol`;
  setup mismatches (conditions hash, config id, sim name, motor digest)
  unscore every row.

## CLI and MCP bodies (M1.30, M1.31; `crates/rw-cli`)

- `rw <cmd>` builds tool arguments and runs them through `forward::Conn`
  (socket to the live owner, else an in-process session). `--json` prints
  the tool output; exit 0 clean, 1 failure (check errors, `--strict`
  warnings, failed diff/sim, not-found/conflict, an edit that leaves
  errors), 2 usage or I/O (`ApiErrorCode::exit_code`; clap usage errors).
- `rw render --view profile|fin|stations|anchors [--imgsize WxH]`: rw-draw SVG
  rasterized by resvg; `--imgsize` gives the exact PNG size (scaled to fit,
  centred on white). Files `renders/<config>.<view>.{png,svg}` and
  `renders/manifest.json`, written through `Session::write_outputs`.
- `rw render --view iso|top|side|front|rear [--imgsize WxH] [--explode s]
  [--scheme check|pbr]` (RL3, `render3d.rs`): the session pipes the IF8
  `RenderRequest` to `rocketwright-render` (`$RW_RENDER`, else beside the
  binary, else the app bundle; none → exit 2 with a hint) and writes the
  returned PNG (the tone-mapped sRGB canvas output) to
  `renders/<config>.<view>.png` plus the manifest. WebGL2 or a fallback
  adapter → exit 2 unless `RW_RENDER_ALLOW_SOFTWARE=1`. See `spikes.md` RL3.
- `rw init` writes an embedded template (`templates/`, via `build.rs`) and a
  `.gitignore` with `.rw/`, then records the initial step.
- MCP: every tool runs on the real session, including `import_file`/`export_file`
  (M2.5/M2.6), `engine_design`/`engine_simulate` (M4.6), and `cfd_import`
  (M5.4, R6.15: `crates/rw-project/src/cfd.rs`, the record in
  `runs/cfd.<id>/<run>/`). Contract-fixture doubles answer only when the
  sidecar has no project. Descriptions (`mcp/descriptions.rs`) say when to
  use each tool and show the `CheckDelta` shape on mutating tools; `render`
  also returns the PNG as image content.
- Window renders (`viewport_render`, `plot_render`): the app server stores
  each PNG through the internal `render_store` (`mcp/store.rs`) at
  `renders/window/<op>.<sha256 prefix>.png`. Each store keeps the newest 50
  files of that op by mtime and deletes the rest (`Session::prune_outputs`);
  storing an existing picture again makes it the newest.

## Verification

```
for f in layout:: session:: lock:: history::; do cargo test -p rw-project --lib $f; done
cargo test -p rw-project --test watcher -- --test-threads=1
cargo test -p rw-cli --test forward
cargo test -p rw-project --lib runs:: jobs:: create::
cargo test -p rw-cli --test cli_e2e --test mcp_contract --test mcp_notify --test mcp_jobs
```
