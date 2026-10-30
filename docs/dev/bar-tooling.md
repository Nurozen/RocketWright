# Visual bar tooling (B1)

The visual bar (spec B1) compares app captures with the six concept exemplars.
Its spec lives as data in `tests/bar/`; the scripts live in `app/e2e/`.

The reference images are maintainer-only and not in this repository: the
concept exemplar PNGs (`$RW_BAR_EXEMPLARS`), the approved embedded-chat mockup
and no-regression captures (`$RW_BAR_EMBED_ASSETS`), and the concept notes the
`source` fields in `tests/bar/` cite (`concepts.md`). In the maintainers'
workspace the scripts find them in a gitignored `artifacts/` directory above
the repo and write their reports under `artifacts/reviews/rocketwright_bar/`;
elsewhere reports go to `target/bar/`. Without the images, `bar:calibrate`,
`bar:packet`, and the visual captures stop with a message naming the variable;
`bar:typecheck`, `bar:test`, and `bar:lint-checklists` (part of
`make check`) need none of them.

| File | Contents |
|---|---|
| `tests/bar/tokens.json` | concepts.md §2 colour tokens (`value` + `accept` references), typography roles, spacing, layout fractions, forbidden list, DOM `bindings`, and per-page image `probes` |
| `tests/bar/regions.json` | Region selectors (`[data-rw-region=…]`) and per-page exemplar rects with the dimensions checked at ±5% |
| `tests/bar/checklists/NN.json` | Page checklists: items `{id, kind, testid, milestone, source, text, level}`. Validated by a non-builder critic and frozen at BC0 (M1.15b, `FROZEN.sha256`); later changes need a D-row |
| `tests/bar/critic-prompt.md` | Critic instructions; quotes S:169 allowed deviations verbatim, C§2 forbidden, C§6 defects |
| `tests/bar/art-numbers.txt`, `art-defects.json` | Illustrative art values and C§6 defect patterns that no checklist item may contain |

Commands (from `app/`):

- `pnpm bar:calibrate` runs the token script in image mode on the exemplar PNGs (`$RW_BAR_EXEMPLARS`). The exemplars must pass their own tables. When the art and a table disagree, fix the probe or add the measured value to the token's `accept` list with a note.
- `pnpm bar:tokens --image <png> --page NN [--out report.json]` scores a PNG capture (1536×1024, DPR 1).
- `measureDom(page, "NN")` from `e2e/visual-tokens.ts` scores the live DOM through any Playwright-compatible `page.evaluate`: computed colours of bound elements (CIEDE2000, pass at ΔE ≤ 3), region bounding boxes (±5%), and font sizes (reported, not gating).
- `pnpm bar:lint-checklists` validates the checklists, rejects art numbers and C§6 defects, checks the critic prompt, and verifies `FROZEN.sha256`. Every commit after the freeze commit that touches `tests/bar/checklists/` must cite a plan D-row (`D<n>`) in its message (D23). To change a frozen checklist: edit it, run `pnpm bar:lint-checklists --freeze`, and commit with the D-row id. It first plants defect items and fails unless they are caught.
- `pnpm bar:packet --page NN --capture <png> --tokens <report>` builds the critic packet (exemplar, capture, reports, checklist, prompt, manifest). It refuses clean-room-restricted input paths. Pages 01 and 06 also carry `mockup.png` (the approved embedded-chat mockup) and `current.png` (the page's no-regression capture) from `$RW_BAR_EMBED_ASSETS`; the manifest's `references` names each image's source and the region it governs (D23, `PAGE_REFERENCES` in `e2e/bar/packet.ts`).
- With the Lecturn embed as the pane (D31), `measureDom` takes the embed as a second page: bindings, typography roles and regions with an `embed` selector in `tokens.json` / `regions.json` are read in the embed's webContents (Lecturn's own `data-*` and test-id hooks), offset by the `agent.embed` rect, against the page's `embed` rects (the approved mockup's composer box). `paneProbes` are located there and sampled from the composite capture (`measurePanePixels`); `pane pane-background` (the embed must paint `bg/canvas`) is a shell row. The desktop passes the guest as `embed` to the `--measure` module once `lecturn/ready` arrived and calls its `measureCapture` export on the composite PNG.

### Live captures (`make bar-visual PAGES=01,02,03,04`)

One command per round: it builds the sidecar (no doubles) and the web bundle, then for each page writes
`dist/bar-visual/<page>/{capture.png,tokens.json,regions.json,drive.json,report.txt}` and the critic packet in `packet/`.

- A page with a capture script, `app/e2e/capture/pages/<NN>.ts` (01-04), runs the real app on the live sidecar. The script works on a freshly seeded research vehicle (`fixtures/research-vehicle/seed.sh`, M1.55: history steps 01-04, Rev 07, real runs), as `/tmp/<x>/Research vehicle`. It runs in the desktop hidden window (`--project … --drive <script>`, `RW_TEST_HOOKS=1`, 1536×1024 at DPR 1). Pages without a script capture the static shell.
- A capture script is a desktop `--drive` module that receives `{page, rpcUrl, serverUrl, guest}`. It reaches window state only through the `app_*` broker hooks (`test.call`, I12) and ordinary product RPC such as `sim.run`. It waits on the page's own DOM attributes, not on timers. `guest()` reads the mounted Lecturn pane: its main frame and its MCP Apps card frames, through Electron's frame API (never a second debugger).
- Pages 02-05 with the embed import their bundle (`seedEmbedThreads` in `capture/embed.ts`, which calls `hooks.seedBundle`) and wait until the guest shows the thread; no live turn.
- Canned chats live in `app/e2e/fixtures/threads/<NN>.json` (one entry per thread, in order; messages may carry `mentions`, tool `steps`, and result `cards`). `app/e2e/fixtures/convert-threads.ts` turns them into the Lecturn bundles `tests/fixtures/lecturn/<NN>.bundle.json`, which the capture scripts import with `app_seed_thread {bundle}`; the window opens the last thread in the embedded pane. (B17 removed the old chat that stored them in `.rw/threads/`.)
- With the Lecturn embed as the pane (B13), the same chats are Lecturn thread bundles, `tests/fixtures/lecturn/<NN>.bundle.json`. Regenerate them with `node app/e2e/fixtures/convert-threads.ts` after editing a thread fixture, `step-card.html` or `run-card.html`; `--check` (and `bar:test`) fails on drift. A bundle's project is the `{workspaceRoot}` / `{projectName}` template, its timestamps are relative to `FIXTURE_CLOCK`, and a run card's run is `{runId:<sim>}` (a fixture card `{kind: "run", ref: "rw:sim/<sim>"}`, B14). `app_seed_thread {bundle}` substitutes them (the sim's complete run in the seeded project) and imports the bundle through the app's Lecturn connection, then the window opens the last thread.
  - Each tool row is the item a live call leaves (`app/e2e/fixtures/lecturn-live/tool-items.json`, a live scripted turn's rows; `lecturn-fixtures.test.ts` compares the field sets): `toolName` `lecturn.rw_<tool>`, title `rw_<tool>`, the app `toolSource`, and the CallToolResult with `_meta["lecturn/summary"]` (the only `lecturn/*` key pin16 keeps) as output (a card tool's: `structuredContent: { lecturnMcpApp, result }`). A step's `card` (`{kind, ref, title}`) is that call's card and must be a card the tool draws (`TOOL_CARDS`; step and run cards only, a render card has no stored picture).
  - Lecturn imports a bundle as run-less history and never keeps an imported turn open: card-less rows next to each other fold into one "Used RocketWright integration" row, and the agent's text between calls goes behind a turn fold. Keep the opened turn's rows apart with card rows; `pane-budget.test.ts` fails a shown turn that folds or does not fit (sizes measured in the CP-W1 r3 captures).
- Imported history is settled, so the run card, the pending approval and the composer chip of pages 01 and 06 come from live scenarios, `app/e2e/fixtures/scripted/visual-0{1,6}.json`. They are run by Lecturn's scripted provider in Supervised, with an admin session acting as the user and approving the scenario's first `approve` app approvals. The host then inserts the scenario's mention. Before the capture, `capture/pane-checks.ts` asserts in the guest that the run card reports complete in its narrow form with a charted series, that one app approval card shows Decline and Approve, that the strip holds the `rw:c/fins` chip, that the composer shows Supervised, and that no thread switcher is rendered. A failed check aborts the capture. `visual.ts` gives every page its own temp `LECTURN_HOME` and `RW_LECTURN_BASE_DIR` with the scripted provider on.
- Step result cards (`kind: "step"`) point at real seeded steps; `e2e/__tests__/capture.test.ts` checks each ref and title against `seed.expected.json`.
- 01: "Fin revision" then "Assembly review" are seeded; "Assembly review" is open with its step card bound to step 02, Recovery bay is selected, explode is 0.6, and the view is Iso.
- 04: the seeded runs (Baseline and Higher altitude Complete, Fin revision Outdated, Recovery test Not run) are waited for, Baseline and Higher altitude are overlaid, and "Flight comparison" is open. A run not in its seeded state is listed under `pending runs` and never faked.

UI contract for builders: shell regions carry `data-rw-region` with the names in `regions.json`; elements named by checklist `testid`s and token `bindings` carry `data-testid`. The active header tab draws its underline as `border-bottom-color`, and selected rows set `aria-selected="true"`.

## Parity scoreboard (B2)

`make bar-parity [CASE=…] [KEYS=…] [GATE=1]` runs `scripts/bar/parity.ts`: two matrices
(`generic` gates, `original` reports), one row per key-map key, setup mismatches
(geometry, conditions, config, sim, motor digest) rejected before scoring. Data,
statuses, our run record format, and the tolerance policy: `tests/oracle/README.md`.
After the scoreboard it runs `scripts/bar/triage.ts`: per-term rows (mass/CG,
CP/CNα, CD(M), thrust, integrator) from our run record and series against the
golden, its series, and the aero sweep, embedded in the scoreboard as `triage`
(`tests/oracle/README.md`, Triage). Case 1's record comes from
`cargo test -p rw-cli --test parity_case1` (the `rw` binary end to end).
Tests: `app/e2e/__tests__/{parity,triage}.test.ts` (part of `bar:test`).

## Agent loop (B3)

`make bar-agent TASK=T1..T5 [KIT=dist/kit]` runs `scripts/bar/agent-loop.ts`: per task a
fresh Agent SDK agent (`cwd` = new temp dir, `settingSources: []`, `strictMcpConfig: true`,
no MCP servers, tools Bash/Read/Write/Edit, kit `bin/` first on PATH). It is a no-op unless
`RW_LIVE=1`, and it exits 1 naming each missing kit file. Outputs go to
`<bar out>/agent-loop/T<n>/` (`messages.jsonl`, `transcript.json`, `score.json`, `renders/`).
`renders/` holds every PNG the agent rendered or looked at: each file under any `renders/`
directory in the working directory (the project may sit in a subdirectory) and every other
`*.png` there, by relative path, plus each PNG it opened with Read from elsewhere, under
`renders/read/` (`pngArchive` in `agent-loop.ts`).
`--score <transcript.json>` re-scores a saved transcript. Kit layout: `tests/agent-loop/kit.json`.
Tasks, seeds, and completion predicates: `tests/agent-loop/tasks/T<n>.json`.
The scorer (`scripts/bar/agent-loop-score.ts`) is a pre-filter, and the critics give the verdict (D15).
A task fails on any of: more than 40 tool calls; a mutation (`rw init|set|add|rm|mv|import`,
a mutating `rw call`, or a Write/Edit/shell write to a `*.toml`) not followed by `rw check`
before the next mutation or the answer; an answer number found in no tool output (calculator
output such as `python`/`awk`/`echo` does not count; the agent's own `rw` arguments and `.toml`
content do; small integers 0-10 are exempt); or a failed completion predicate.
An answer number is backed when it equals a tool number at the printed precision
(trailing zeros, thousands separators, exponent form, and the sign are ignored: `0.430`
and `-0.43` back `0.43`), or when it is a correct rounding of a tool number to fewer
decimals, half-up or banker's (`187.3` or `187` for a printed `187.34`; `0.2` or `0.3`
for `0.25`; plan D28, B3 round 11). A rounding keeps the sign: a number written with a
sign (`+0.11`, `-0.4`) needs a tool number of that sign, while an unsigned one is a
magnitude as in the exact rule (`0.024 s sooner` for `-0.024496 s`). A range (`3.6-3.9`)
is checked end by end. A truncation (`52.6` for `52.68`), a rounding to tens (`190`), and
any derived figure (a difference, a ratio, a unit conversion), rounded or not, stay
unbacked: rounding a printed value is presentation, not computation. The skill doc still
tells agents to quote numbers exactly as printed (B3 round 8).
A check's pass/fail comes from its own output (the last `check: <status>` line or JSON
`status`; `warnings` fail under `--strict`), because `rw check; echo "EXIT=$?"` exits 0.
An `rw` edit command (`init`, `set`, `add`, `rm`, `mv`, `import`, `motor import`) runs the
strict check itself and prints it as a `check --strict: <status>` section (JSON:
`check_strict_status`). That section is a check event right after the edit: `clean`
passes, `warnings` and `errors` fail. In a call with several `rw` edits, the n-th section
belongs to the n-th edit; an edit whose section was cut off (`| head`) still needs its own
`rw check`. Piping a mutating `rw` command (an edit, or a mutating `rw call`) or an
`rw check` / `rw call design_check` through `head` or `tail` (`2>&1 | tail -20`, also
`|&` and later stages of the pipeline) is itself a discipline violation, even when the cut
kept the strict section (B3 round 12; `truncatedRwOutputs`). Reads, `--help`, dry runs,
sims, and other filters (`| grep`) are not flagged. File edits and `rw call` mutations print no section. An
`echo`/`printf` is a calculator only when it prints a literal number above 10 or a command
substitution, so `echo "EXIT=$?"` does not hide the call's `rw` output. An `rw` edit that
prints `error:` and records no step is not a mutation. `1600x900` is two numbers.
Tests: `app/e2e/__tests__/agent-loop.test.ts` (synthetic transcripts, part of `bar:test`).

### Kit (`make kit`, M2.11)

`scripts/kit/build-kit.sh` writes `dist/kit/`: `bin/rocketwright` (release, plain), `bin/rw`
(symlink), `bin/rocketwright-render` (launcher for `lib/RocketWright Render.app`, an unsigned
`electron-builder --dir` build of `apps/desktop/src/render-main.ts` with the web bundle),
`docs/` (`docs/agents/*.md`), and `data/` (`A simple model rocket.ork` copied from the
OpenRocket checkout at build time, `case1-generic.ork` from `tests/oracle/cache/`, and
`tests/oracle/case1-generic.json`). The `.ork` files are data and never committed. A missing
input fails the build before anything is compiled and names the file. `RW_KIT_SKIP_APP=1`
keeps an existing renderer app.

### Round 5 (M2.11 formal run) root causes and fixes

All five tasks were red on the live score. The saved transcripts were then re-scored after
the scorer fixes above, and only T2 passed. The other four failures are real behaviour:
- T1 and T3: edits were not followed by `rw check --strict`. Agents read the mutation's own
  `check: clean` line as the gate. Fix: that line now reads `delta: <status> (lenient; the
  gate is rw check --strict)`, and rule 1 of the skill doc says so.
- T1, T3, T5: numbers converted from m to mm, or read off a PNG's labels. Fix: rule 3, and
  the render section says to quote numbers from the text output.
- T4: a mass delta was subtracted by hand. Fix: `rw history compare` prints the absolute
  change next to the percent change.
- T5: the golden was flown with no wind but the imported sim has wind, so the agent diffed
  the conditions with python. Fix: `rw diff run --golden` lists each differing
  `conditions.<key>`, and the skill doc gives the matching-sim recipe. The agent also found
  that the importer read OpenRocket's radian wind direction as degrees (fixed in `rw-ork`).

Follow-up (B3-cli), so that agents never hand-compute a number or skip the gate:
- Every edit command runs `rw check --strict` itself, prints the full `check --strict:
  <status>` section with diagnostics, and exits 1 unless it is clean (the step is still
  recorded). The scorer counts that section as the check that follows the edit (above).
  `fixtures/research-vehicle/seed.sh` accepts that exit 1 for its edits (the vehicle has a
  liftoff T/W warning).
- Text output (`check`, `eval`, `sim`, `run summary`, `diff run`, `history compare`, and
  edit deltas) prints values in the project's `[display_units]` (default mm, g, m/s, m for
  flight distances, s, deg) with the unit attached. `--units si` prints SI; `--json` stays
  SI and carries a `units` map. Param range hints quote the bound as written (`30 mm`).
- `rw history compare` and `rw diff run` print the absolute change in display units next
  to the percent (`diff run`'s `a - b` has the sign of `delta %`).
- `rw run summary <sim|run> [--fields a,b]` prints every summary field (apogee, max
  velocity, time to apogee, burnout altitude, drift, ...) and the flight events, so no
  agent reads `series.csv` or `events.json` with a script for a summary number.

### Round 8 (B3 critic) fixes

- `rw render --view profile` drew rail buttons as a square on the centreline. Rail buttons
  (spool silhouette) and launch lugs (tube) now sit on the body outline at their radial
  position, on the lower outline when their roll puts them below the axis
  (`crates/rw-draw/tests/surface.rs`, golden `surface.profile.{svg,png}`).
- `RW-W250 recovery-never-deploys`: a parachute or streamer that no configuration deploys
  (event `never` everywhere, or `ejection` with only plugged motors). The hint names the
  field: `rw set configs.<id>.deploy.<chute>.event=apogee`. `rw set` now creates a missing
  table under an existing component, configuration, or sim (`[deploy.<chute>]`) by setting
  it one level up.
- `RW-W103 motor-substituted` is accepted with `accept_substitution = true` on the
  configuration's motor (`rw set configs.<id>.motors.<mount>.accept_substitution=true`);
  the strict check is then clean. The import's own `RW-W103` lines are warnings, not errors.
- `rw diff run --golden` scores with `tolerances.json` beside the golden, or the built-in
  copy of `tests/oracle/tolerances.json` when there is none (the kit's `data/` has only the
  golden, so every row printed `tol -`). Each row prints its tolerance (`none`) and result
  (`pass`, `FAIL`, `not gated`, `not scored`), followed by `gated: <n> key(s) ...` and
  `no tolerance (compared, not gated): <keys>`.
- The scorer's number rule is exact-precision (above), and `renders/` archives every PNG.

### Round 11 (B3) scorer and golden-diff fixes

T1 and T5 were red only on the numbers gate, and every flagged number was a rounding of a
printed one (T1 `3.6-3.9 cal` for `3.603` and `3.9059`; T5 `CG +0.11 mm` for the diff's
`+0.10505 mm`, `1.79 m` for `+1.7921 m`). Fixes:
- The scorer accepts correct roundings (above, D28); derived values stay unbacked. The
  saved round-11 transcripts re-scored with `--score` (in each task's `rescored/`) all pass.
- `rw diff run --golden`: against a golden, the columns read `a (ours)` and `b (golden)`,
  and the golden's static block (CG, CP, CNa, stability) gets its own `static (...)` rows
  after the flight rows, each with ours, golden, the change in display units, percent,
  tolerance, and result. The static rows come from the run's own model: the live model
  when the run is current, else the history step its model was recorded at, with a
  `note:` line naming it (`RunDiffOut.notes`). Before, an outdated run silently lost its
  static rows, leaving the agent to subtract CG and CP by hand. The skill doc's
  golden-diff recipe says to quote these rows.

### Round 12 (B3) answer rules, render legend, and the pipe rule

T2-T4 passed the critics; T1 and T5 failed on (a) `rw set ... | tail -25`,
`rw check --strict ... | tail -20`, and `rw call model_patch ... | tail -20` despite the doc
rule, and (b) prose no tool printed: outside rules of thumb and untested, physically
backwards design advice (T1), and a render described as "fins flush with the aft end" when
the case 1 fins overhang the tube by 25.4 mm (T5). Fixes:
- `docs/agents/SKILL.md` and `rocketwright-model.md` open with an "Answer rules" block:
  report only what `rw` printed or a render showed; no recommendations, rules of thumb,
  causes, or predictions unless a tool output shows them or the agent ran the tool that
  tests them; describe renders from the render legend and `rw eval` / `rw check` dims;
  never pipe `rw` edits or checks through `head`/`tail`.
- `rw render` prints a legend under the PNG path (`RenderResult.legend` in `--json`, SI):
  per drawn component its `x` station range and `r` radial extent in display units, then
  `relations` (`fins: aft end 25.4 mm past the body aft end (overhang)`, `... flush with
  ...`, `lug: at 250 mm, 50% along body`, `mmt: aft end 5 mm past the body aft end`).
  Golden: `crates/rw-cli/tests/golden/cli/render.legend.case1.txt`.
- The scorer fails the discipline gate on a piped `rw` edit or check (above). Re-scoring
  the saved round-12 transcripts flags T1 calls 7-8 and T5 call 15.
