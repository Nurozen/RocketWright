---
name: rocketwright
description: Design, check, render, and simulate model rockets with RocketWright (the rw / rocketwright CLI, *.rw.toml files, or the app's RocketWright MCP tools). Use whenever a task touches a RocketWright project (a directory with rocketwright.toml), asks to build or change a rocket, fix stability, add parts on anchors, pick a motor, or report flight numbers. Covers the edit-check-render loop, the file format, units, expressions, anchors, and diagnostic codes.
---

# RocketWright

## Answer rules (read first)

- Write rw: references as plain text (rw:c/fins), never inside backticks or
  code blocks, so they render as links. Tool, file, and field names in a
  reply need no code formatting either. Example reply: The fins rw:c/fins
  now span 50 mm, and the strict check is clean.
- Report only what `rw` printed or a render showed. Quote numbers exactly
  as printed, with the unit.
- No recommendations, rules of thumb, causes, or predictions unless a tool
  output shows them, or you ran the tool that tests them (a what-if
  `rw check --strict --set ...`, `--sim quick`, `rw sim`). Otherwise leave
  them out.
- Describe a render with the legend `rw render` prints under the PNG path
  (each part's `x` station range and `r` radial extent, and relations such
  as `fins: aft end 25.4 mm past the body aft end (overhang)`) and with
  `rw eval` / `rw check` dims. Do not read positions or "flush" off the picture.
- Never pipe `rw` edits (`set`, `add`, `rm`, `mv`, `import`, `init`,
  `motor import`, a mutating `rw call`) or `rw check` through `head` or
  `tail`, and never redirect their output away (`>/dev/null`, `2>/dev/null`,
  `&>/dev/null`, `> file`): their outputs are already short, and the strict
  section is the check. Read them whole.
- Edit with `rw set`, `rw add`, `rw rm`, `rw mv`, not `rw call model_patch`
  (it runs no strict check). To remove a field (back to its default), use
  `rw set <path> --unset` or `rw rm <path>`
  (`rw rm sims.<id>.launch_into_wind`). After any `rw call` that writes,
  run `rw check --strict` and read it whole.

RocketWright projects are plain TOML (rocketwright.toml, rocket.rw.toml,
configs/*.rw.toml, sims/*.rw.toml), and the rw CLI checks, draws, and
flies them. The full briefing is [rocketwright-model.md](rocketwright-model.md).
It covers the format, units, expressions, the anchor table for each component
type, the MCP tools, and five worked edits. The code table is
[diagnostics.md](diagnostics.md). Read the briefing before your first edit
in a session.

MCP tool names in these docs are bare (design_check). A host may add a
prefix; in Lecturn every tool is `rw_<tool>` (rw_design_check, for Claude
mcp__lecturn__rw_design_check). Call the name your host lists.

## In the RocketWright app

The app's agent pane is Lecturn, on whichever provider the user picked.
Lecturn hands the agent RocketWright's runtime block, which applies to any
provider:

- The thread's workspace root is the project directory; the tools are
  rw_<tool>.
- Write rw: refs as plain text (rw:c/fins, rw:run/<id>), never in backticks
  or code blocks, so they render as chips. Mentioned refs arrive as chips;
  read their values with rw_model_get before relying on them.
- Change the model only through the tools (rw_model_patch,
  rw_component_add, rw_component_remove, ...), never by editing the files.
  dry_run: true previews a change.
- Call rw_design_check after every edit and fix errors first. Never claim an
  edit, design, or simulation succeeded without a passing check (and, for a
  simulation, a complete run).
- Look with rw_render, rw_viewport_render (the live viewport), or
  rw_plot_render (a Results plot).
- rw_simulate returns a job_id: poll rw_job_status until complete or
  failed. rw_engine_simulate returns the finished run.
- Imports, exports, network fetches, and large jobs may need the user's
  approval. Do not retry a refused or unapproved call unless the user asks.

## The loop

After **every** edit:

1. Read the strict check. `rw set`, `rw add`, `rw rm`, `rw mv`, `rw import`,
   and `rw motor import` run `rw check --strict` themselves and end with a
   `check --strict: <status>` section. Exit `0` is clean; exit `1` means the
   edit is written but the strict check found errors, warnings, or a failed
   `[[assert]]`; exit `2` means a usage or I/O error (nothing written). After
   an edit made any other way (your file editor, `rw call model_patch`), run
   `rw check --strict`.
2. If it fails, read the first diagnostic: its RW-Exxx code, its path
   (/c/fins/span), and its hint. Fix that one and go back to step 1.
3. Look: run `rw render --view profile` (add `--view anchors` when placing
   parts) and open the PNG. Its printed legend gives each drawn part's
   station range and radial extent and the part-to-parent relations; describe
   the render from those lines. In the app, use the render or
   viewport_render tool for 3D views.
4. If flight numbers matter, run `rw sim <sim>` and `rw run summary <sim>`, or
   over MCP call simulate and poll job_status until it is complete.

Never say an edit, a design, or a flight "works", "is stable", or "passes"
without a clean strict check from this turn (an edit's `check --strict: clean`
section, or `rw check --strict` exit 0). The `delta:` line an edit prints is
lenient and does not count. Never pipe an edit through `head` or `tail` or
redirect it to `/dev/null`: that hides the strict section.
Quote numbers exactly as printed, do not round: copy every digit and the printed
unit (`187.34 m`, not `187 m` or `187.3 m`). Text
output is in the project's display units (default mm, g, m/s, m for flight
distances, s, deg), and `rw history compare` and `rw diff run` print the
absolute change next to the percent: never convert, subtract, or compute
numbers by hand or with a script over `series.csv` or JSON.

**Say only what a tool output or a render showed.** Do not attribute a
change to a component, phase or cause unless a tool output shows it (use
`rw history compare <a> <b> --breakdown`, the `rw diff run` phase rows,
and the mass.components (the mass breakdown) and aero.terms fields of
`rw check --json`).
Do not cite outside rules of thumb or predict flight effects without
running the sim. If you want to say something you have not tested, run the
tool that tests it or label it explicitly as untested.

- Which part a mass, CG, CNa, or CP change came from:
  `rw history compare step:1 live --breakdown` prints each component's mass
  and CG and each aero term's CNa and CP, before -> after (absolute change,
  percent). Name a component only with its row's numbers.
- Where two flights part: `rw diff run <a> <b>` (or `--golden <json>`) ends
  with `phases` rows in time order (rail exit, burnout, apogee, deployment,
  landing: time, altitude, speed, with `a - b` and `delta %`). Say where a
  gap opens ("already at burnout", "only after apogee") only by quoting
  those rows.
- A limit or a threshold ("the floor is 3.6 cal", "below 1 cal it is
  unstable") is a claim to test: run the what-if
  (`rw check --strict --set <path>=<value>`, add `--sim quick` for a flight)
  at the value you name, or call it untested.

Timing questions ("how long before apogee does the chute open?", "is the
delay too long?") are answered by the derived timing fields:
`rw run summary <sim> --fields deploy_minus_apogee,delay_minus_optimum,coast_time`
(signed, negative = before apogee; `--fields` alone explains each).

## Quick start

```rw
rw init --template simple-rocket
rw check --strict
rw set params.fin_span.value="50 mm"
rw render --view profile
rw sim baseline
rw run summary baseline --fields apogee,max_velocity,time_to_apogee
```

## Essentials

- Create projects in the working directory: `rw init --template simple-rocket` with no directory argument. Pass a directory only when asked for one.

- **Units are mandatory**: `"54 mm"`, `"1050 kg/m^3"`, `"5 deg"`. Only `0` and
  dimensionless fields (cd, count) may be bare. Quote values in the shell:
  `rw set c.fins.span="30 mm"`.
- **Expressions** start with `=`: `"= params.body_length"`,
  `"= c.nose.od"`, `"= max(c.body.length / 2 - 20 mm, 0)"`.
- **Placement** is `attach = { to = "<id>.<anchor>", at = "<own anchor>", offset = "5 mm" }`.
  `<tube>.inner` puts a part inside, `<body>.outer` puts it on the surface.
  `rw render --view anchors` shows every anchor.
- **Paths** for `rw set`: `c.<id>.<field>`, `params.<name>.value`,
  `configs.<id>.motors.<mount>.motor`, `sims.<id>.wind.speed`. Remove a
  field with `rw set <path> --unset` or `rw rm <path>`.
- **Preview** with `--dry-run`, and try what-ifs with
  `rw check --strict --set <path>=<value>` (nothing is written; the same
  paths as `rw set`). Add `--sim quick` to fly the what-if: it flies the
  overridden model.
- **Ratios are in the report**: `rw check` prints the length in calibers and
  the fineness ratio (`length 563 mm (22.702 cal), ..., fineness 22.702`;
  JSON dims.length_cal and dims.fineness). Quote them; never divide length
  by diameter yourself.
- **Units of the output**: `--units si` prints SI text; `--json` is always SI
  with a `units` map. `[display_units]` in `rocketwright.toml` sets the
  display units (length = "mm", mass = "g", altitude = "m").
- **Undo**: run `rw history log`, then
  `rw call history_restore '{"version":"step:<n>"}'`.
- **Motors**: `rw motor search --diameter "18 mm"` lists the generic curves
  available offline (18 mm generic:RW_A8G, generic:RW_B4G, generic:RW_C6G;
  24 mm generic:RW_D10G; 38 mm generic:RW_I261G, generic:RW_I1294G,
  generic:RW_I60G).
- **Unstable** (RW-E101): increase the fin span or root chord, or add nose
  weight, and read the edit's `check --strict:` section.
- **Recovery** (RW-W250): every parachute or streamer needs a deployment
  event in some configuration: `rw set configs.<id>.deploy.<chute>.event=apogee`,
  or `ejection` with a motor `delay`.
- **No Monte Carlo**: each simulation is one deterministic flight; the
  simulate tool's mc above 1 returns not_implemented. Fly explicit
  variations (`rw check --strict --set <path>=<value> --sim quick`, or one sim
  per case) and compare them with `rw diff run`.
- **Substituted motor** (RW-W103, after `rw import`): keep the generic curve
  with `rw set configs.<id>.motors.<mount>.accept_substitution=true`; the
  strict check is then clean.

## Install as a Claude Code skill

1. Build the CLI and put it on `PATH` as both `rocketwright` and `rw`:
   `cargo build --release -p rw-cli`, then symlink
   `target/release/rocketwright` to `~/.local/bin/rocketwright` and
   `~/.local/bin/rw`.
2. Link this directory as a skill, for one user or for one project:

   ```sh
   ln -s "$PWD/docs/agents" ~/.claude/skills/rocketwright
   ln -s "$PWD/docs/agents" <project>/.claude/skills/rocketwright
   ```

   Claude Code loads `SKILL.md`. It reads `rocketwright-model.md` and
   `diagnostics.md` from the same directory on demand.
3. Check it: `rw --version`, then the quick start above in an empty directory.

The briefing is verified in this repository by `cargo xtask docs-check`. It
runs every `rw` block in this file and the briefing on a temp project, checks
the stated exit codes, and checks that every `rw` command and flag mentioned
exists.
