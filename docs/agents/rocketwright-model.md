# RocketWright model briefing for agents

## Answer rules (read first)

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
  `tail`: their outputs are already short. Read them whole.

RocketWright is a model-rocket CAD and flight simulator driven by text files
and the `rw` command line (the same commands are MCP tools inside the app).
You design a rocket by editing TOML files or by running `rw set`, `rw add`,
`rw rm`, and `rw mv`. Then you check the design with `rw check --strict`, look
at it with `rw render`, and fly it with `rw sim`.

This document is self-contained: an agent with no other context can build,
check, and iterate on a rocket with it. `cargo xtask docs-check` runs every
`rw` block below on a fresh temp project and fails if a command, flag, or exit
code here is wrong. The tables marked "generated" come from the code
(`cargo xtask diag-docs`).

## The rules

1. **Never claim success without a strict check.** Every edit command
   (`rw set`, `rw add`, `rw rm`, `rw mv`, `rw import`, `rw motor import`,
   `rw init`) runs `rw check --strict` itself after it writes and prints the
   result as a `check --strict: <status>` section, with every diagnostic. It
   exits 1 when that check is not clean (the edit is still written). Read that
   section after every edit command, before the next edit, sim, or answer.
   After any other edit (your own file editor, `rw call model_patch`), run
   `rw check --strict`. A design is done only when the last strict check of
   the current turn is clean. `rw check` without `--strict` exits 0 on
   warnings; do not use it to claim success. The `delta:` line of an edit is
   lenient and does not count. Never pipe an edit through `head` or `tail`:
   it cuts the strict section off.
2. **Fix diagnostics in order.** Every finding has a code (`RW-E101`), a path
   into the model (`/c/fins/span`), and a hint. The first error often causes
   the ones after it. Fix it, check again, repeat.
3. **Never hand-compute numbers.** Masses, CG, CP, stability, apogee: quote
   them from `rw check`, `rw eval`, `rw sim`, `rw run summary`, `rw diff run`,
   or `rw history compare` output, exactly as printed and with the printed
   unit (`CG 357.92 mm`). Text output is already in the project's display
   units (default mm, g, m/s, m for flight distances, s, deg). Do not convert
   units, subtract two outputs, or work out a time, a rate, or a difference
   yourself, by hand or with a script over `series.csv` or JSON. For a change
   between designs, quote the before, after, and change columns of
   `rw history compare` (absolute change and percent). For flight numbers
   (apogee, max velocity, time to apogee, burnout altitude, event times), use
   `rw run summary <sim>`.
4. **Look before you describe.** Run `rw render --view profile` (and
   `--view anchors` when placing parts), then open the PNG. Describe it with
   the legend the command prints (station range, radial extent, relations).
   In the app, use `render` with an `iso` view or `viewport_render`.
5. **Units always.** Every dimensional value is a string with a unit,
   `"54 mm"`. A bare number is accepted only for `0` and for dimensionless
   fields (`cd`, `count`).
6. **Simulations are jobs over MCP.** `simulate` returns a `job_id`. Poll
   `job_status` until `state` is `complete` or `failed`. Never report flight
   numbers from a job that is not `complete`.
7. **Say only what a tool output or a render showed.** Do not attribute a
   change to a component, phase or cause unless a tool output shows it (use
   `rw history compare <a> <b> --breakdown`, the `rw diff run` phase rows,
   `rw check --json` `mass.components` (the mass breakdown) / `aero.terms`).
   Do not cite outside rules of thumb or predict flight effects without
   running the sim. If you want to say something you have not tested, run
   the tool that tests it or label it explicitly as untested. A limit you
   name ("the floor is 3.6 cal") is a claim: check the value with a what-if
   (`rw check --strict --set <path>=<value>`, `--sim quick` for a flight) or
   call it untested.

Exit codes for every command: `0` clean, `1` failure (check errors, warnings
under `--strict`, a failed `[[assert]]`, a failed diff or sim), `2` usage or
I/O error.

## Install

`rw` is the short name of the `rocketwright` binary. Build it once from the
repository and put both names on `PATH`:

```sh
cargo build --release -p rw-cli
ln -sf "$PWD/target/release/rocketwright" ~/.local/bin/rocketwright
ln -sf "$PWD/target/release/rocketwright" ~/.local/bin/rw
rw --version
```

`rw --help` and `rw <command> --help` list every command and flag. `rw schema`
lists the published JSON Schemas, and `rw schema rocket` prints the full model
schema with every field, its unit dimension (`x-unit-dimension`), and whether
it takes expressions (`x-expr`). To install this briefing as a Claude Code
skill, see [`SKILL.md`](SKILL.md).

## Project layout

```text
my-rocket/
  rocketwright.toml       manifest: format, name, default_config, [display_units], [lib.sha256]
  rocket.rw.toml          the rocket: params, components (c.*), materials, asserts, report
  parts/*.rw.toml         optional; merged into the rocket by `include`
  configs/<id>.rw.toml    a flight configuration: motors per mount, deployment
  sims/<id>.rw.toml       a simulation: config, launch rail, atmosphere, wind
  engines/<id>.rw.toml    a liquid engine and its feed graph (see Liquid engines)
  lib/                    project library: components/, materials/, motors/ (*.eng, *.rse)
  renders/                rw render output (derived, safe to delete)
  runs/<sim>/<run_id>/    rw sim output: summary.json, events.json, manifest.json, series.csv
  .rw/                    history, lock, and sidecar socket (never edit; gitignored)
```

The `.rw.toml` files and `rocketwright.toml` are the canonical model.
Everything else (renders, runs, the 3D view) is derived from them. You may
edit the TOML files directly with your editor, or through `rw set`, `rw add`,
`rw rm`, and `rw mv`. Both are fine. Run `rw check --strict` after either.

## File format

`rocket.rw.toml`, abridged from `rw init --template simple-rocket`:

```toml
name = "Simple rocket"

[params.fin_span]            # a named, ranged design parameter
value = "45 mm"
min = "25 mm"
max = "80 mm"
step = "5 mm"
doc = "Fin height, root to tip"

[c.nose]                     # component id `nose`; ids are [a-z][a-z0-9_]*
type = "nose_cone"
material = "polystyrene"
shape = "ogive"              # conical, ogive, ellipsoid, power, parabolic, haack
length = "110 mm"
od = "24.8 mm"
thickness = "1.5 mm"
shoulder = { length = "25 mm", od = "24.1 mm", thickness = "1.5 mm" }

[c.body]
type = "body_tube"
attach = { to = "nose.base" }            # sits behind the nose
material = "cardboard"
length = "450 mm"
od = "= c.nose.od"                       # an expression
id = "24.1 mm"

[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }   # fin trailing edge on the body's aft end
material = "balsa"
count = 3
root_chord = "65 mm"
tip_chord = "30 mm"
span = "= params.fin_span"
sweep = "35 mm"
thickness = "2.4 mm"

[c.mount]
type = "inner_tube"
attach = { to = "body.aft", at = "aft", offset = "3 mm" }
material = "cardboard"
length = "75 mm"
od = "19.6 mm"
id = "18.8 mm"
motor_mount = true

[materials.balsa]
density = "160 kg/m^3"            # bulk; canopies use surface_density, cords line_density

[[assert]]                        # a design rule; a failure fails `rw check --strict`
id = "stable"
expr = "stability.liftoff >= 1 cal"
message = "keep at least one caliber of static margin at liftoff"

[report]
values = ["= c.fins.span", "= c.body.length"]
```

`configs/baseline.rw.toml` puts a motor in each motor mount and names the
recovery events. A parachute or streamer that no configuration deploys
(event `never` everywhere, or `ejection` with no motor `delay`) is
`RW-W250`; set its event with `rw set configs.baseline.deploy.chute.event=apogee`
(the `[deploy.chute]` table is created when missing).
`sims/baseline.rw.toml` flies one configuration:

```toml
# configs/baseline.rw.toml
name = "Baseline"
[motors.mount]                 # key = the id of an inner_tube with motor_mount = true
motor = "generic:RW_C6G"       # from `rw motor search`
delay = "5 s"
[deploy.chute]                 # key = a parachute or streamer id
event = "ejection"             # ejection (needs a motor delay), apogee, altitude, timer, never

# sims/baseline.rw.toml
name = "Baseline"
config = "baseline"
[launch]
rail_length = "1 m"
rod_angle = "5 deg"
[atmosphere]
model = "ussa1976"
[wind]
speed = "2 m/s"
direction = "270 deg"
```

### Model paths

`rw set` and `model_patch` address the model as one JSON document:

| Path (CLI form) | JSON pointer | What |
|---|---|---|
| `c.<id>.<field>` | `/c/<id>/<field>` | a component field (`c.fins.span`) |
| `c.<id>.attach.offset` | `/c/<id>/attach/offset` | a nested field |
| `params.<name>.value` | `/params/<name>/value` | a parameter value |
| `materials.<name>.density` | `/materials/<name>/density` | a material |
| `configs.<id>.motors.<mount>.motor` | `/configs/<id>/motors/<mount>/motor` | a configuration |
| `sims.<id>.wind.speed` | `/sims/<id>/wind/speed` | a simulation |
| `project.display_units.length` | `/project/display_units/length` | the manifest |

`rw set` parses each value as JSON first, then falls back to text. So `3`
and `true` are numbers and booleans, while `30 mm` and `ogive` are strings.
Quote dimensional values in the shell: `c.fins.span="30 mm"`. An unquoted
`c.body.length=450` writes the number 450, which is `RW-E021` (worked edit 5).

## Units

Write a quantity as `"<number> <unit>"`. The space is optional (`"54mm"`), and
fractions work (`"1/4 in"`). Compound units use `*`, `/`, and `^`:
`"1050 kg/m^3"`, `"9.6 N*s"`, `"67 g/m^2"`. Each field has one dimension
(`rw schema rocket` shows it as `x-unit-dimension`). The wrong dimension is
`RW-E023`, an unknown symbol is `RW-E022`, and a missing unit is `RW-E021`.
Text output (`rw check`, `rw eval`, `rw sim`, `rw run summary`, `rw diff run`,
`rw history compare`, and the delta and strict check of every edit) prints each
value in the project's display units with the unit attached: `CG 357.92 mm`,
`mass liftoff 57.4 g`, `apogee 350.83 m`. The units come from
`[display_units]` in `rocketwright.toml`. Keys are dimension names (`length`,
`mass`, `velocity`, `time`, `angle`, `area`, `volume`, `inertia`,
`acceleration`) plus `altitude` for flight distances (apogee, burnout altitude,
drift). Defaults: `length = "mm"`, `mass = "g"`, `velocity = "m/s"`,
`altitude = "m"`, `time = "s"`, `angle = "deg"`, `area = "cm^2"`,
`volume = "cm^3"`, `inertia = "g*cm^2"`. Stability is in calibers (`cal`).
`--units si` prints SI instead. `--json` output is always SI (m, kg, s, rad)
and carries a `units` map naming the SI unit of each dimension.

Units by dimension (generated):

<!-- generated:units -->
| Dimension | Units |
|---|---|
| dimensionless | `%` |
| length | `m`, `km`, `cm`, `mm`, `um` (`µm`, `μm`), `in`, `ft`, `yd`, `mi`, `nmi` |
| mass | `kg`, `g`, `mg`, `t`, `lb` (`lbm`, `lbs`), `oz`, `slug` |
| time | `s` (`sec`), `ms`, `us` (`µs`, `μs`), `min`, `h` (`hr`), `d` |
| temperature | `K`, `degC` (`°C`), `degF` (`°F`), `degR` (`°R`) |
| angle | `rad`, `mrad`, `deg` (`°`), `arcmin`, `arcsec`, `rev` |
| volume | `L` (`l`), `mL` (`ml`), `cc`, `gal` |
| velocity | `kph`, `mph`, `kn` (`kt`) |
| acceleration | `gn` |
| force | `N`, `mN`, `kN`, `dyn`, `kgf`, `lbf`, `ozf` |
| pressure | `Pa`, `hPa`, `kPa`, `MPa`, `GPa`, `bar`, `mbar`, `atm`, `psi`, `ksi`, `torr`, `mmHg`, `inHg` |
| impulse | `Ns` |
| angular_velocity | `rpm` |
| energy, torque | `J`, `kJ`, `MJ`, `cal`, `kcal`, `Wh`, `kWh`, `BTU` (`Btu`) |
| power | `W`, `kW`, `MW`, `hp` |
| frequency | `Hz`, `kHz` |
| kinematic_viscosity | `St`, `cSt` |
| dynamic_viscosity | `P`, `cP` |
<!-- /generated:units -->

## Expressions

A string value that starts with `=` is an expression, evaluated with units:

```toml
od = "= c.nose.od"
length = "= params.body_length - 2 * c.nose.length"
span = "= clamp(params.fin_span, 30 mm, 60 mm)"
offset = "= max(c.body.length / 2 - 20 mm, 0)"
```

- Refs: `params.<name>` (the param's value) and `c.<id>.<field>` (another
  component's *input* field, never an evaluated output such as its station).
- Operators `+ - * / ^` and parentheses; functions `min`, `max`, `clamp`,
  `abs`, `sqrt`; the constant `pi`.
- Dimensions must agree: `40 mm + 1 kg` is `RW-E043`. A bare `0` matches any
  dimension, and any other bare number is dimensionless.
- An unknown ref is `RW-E041`, a cycle is `RW-E042`, and division by zero is
  `RW-E045`.
- `[[assert]] expr` and `[report] values` may also name check results
  (`stability.liftoff`, `mass.cg`, `aero.cp`).
- A param outside its `min`/`max` is `RW-E011`. Prefer changing a param
  (`params.fin_span.value`) over overwriting the expression that uses it.

## Anchors and attach

Every component except the first body component (the nose) has an `attach`
table that places one of its own anchors on an anchor of another component:

```toml
attach = { to = "<target id>.<target anchor>", at = "<own anchor>", offset = "5 mm", spin = "60 deg" }
```

- `to` (required): `body.aft`, `nose.inner`, `mount.fore`, ...
- `at` (optional): this component's anchor that lands on `to`. The default
  mirrors `to`. An aft-facing target anchor (`aft`, `base`, `root_te`,
  `motor_retainer`, `outlet`) takes the child's fore end (`fore`, `tip`,
  `root_le`, `attach`). A fore-facing one (`fore`, `tip`, `root_le`) takes its
  aft end, and `mid` takes `mid`.
- `offset`: axial shift, positive aft. `spin`: roll about the body axis.
  `radial`: `outer`, `inner`, `axis`, or a radius.
- Containment follows from the target anchor. `<tube>.inner` puts the child
  *inside* the tube, `<body>.outer` puts it *on the surface*, and any other
  anchor is positional (on a body-chain target the target becomes the parent).
  The pair must be allowed (the table below), or the check reports `RW-E030`.
- The parent tree is derived and never written. `rw eval` prints it with
  stations, and `rw render --view anchors` draws every anchor.

Common placements:

| Goal | `attach` |
|---|---|
| Body tube behind the nose | `{ to = "nose.base" }` |
| Fins flush with the aft end | `{ to = "body.aft", at = "root_te" }` |
| Fins 10 mm forward of the aft end | `{ to = "body.aft", at = "root_te", offset = "-10 mm" }` |
| Motor mount sticking out 3 mm | `{ to = "body.aft", at = "aft", offset = "3 mm" }` |
| Engine block at the mount's forward end | `{ to = "mount.inner", at = "fore" }` |
| Parachute 45 mm into the body | `{ to = "body.fore", at = "attach", offset = "45 mm" }` |
| Nose weight inside the nose | `{ to = "nose.inner", offset = "40 mm" }` |
| Rail button on the body surface | `{ to = "body.outer", offset = "150 mm" }` |
| Launch lug centred on the body | `{ to = "body.mid", at = "fore", spin = "60 deg" }` |

Component types (generated: anchors, where each type may go, and required
fields; `fin<n>` is a per-fin anchor `fin0`, `fin1`, ...). Optional fields such
as `name`, `material`, `finish`, `appearance`, `instances`, `override`, and
`joint` are in `rw schema rocket`.

<!-- generated:components -->
| `type` | Anchors | May go (containment: parent types) | Required fields |
|---|---|---|---|
| `nose_cone` | `tip` `base` `shoulder_fore` `shoulder_aft` `inner` | first body component | `shape`, `length` (length), `od` (length) |
| `body_tube` | `fore` `aft` `mid` `inner` `outer` | first body component; axial of `nose_cone`, `body_tube`, `transition` | `length` (length), `od` (length) |
| `transition` | `fore` `aft` `shoulder_fore` `shoulder_aft` `inner` | first body component; axial of `nose_cone`, `body_tube`, `transition` | `shape`, `length` (length), `fore_od` (length), `aft_od` (length) |
| `trapezoidal_fin_set` | `root_le` `root_te` `tip_le` `tip_te` `tab_fore` `tab_aft` `fin<n>` | surface of `nose_cone`, `body_tube`, `transition` | `count`, `root_chord` (length), `tip_chord` (length), `span` (length), `sweep` (length), `thickness` (length) |
| `elliptical_fin_set` | `root_le` `root_te` `tip_le` `tip_te` `tab_fore` `tab_aft` `fin<n>` | surface of `nose_cone`, `body_tube`, `transition` | `count`, `root_chord` (length), `span` (length), `thickness` (length) |
| `freeform_fin_set` | `root_le` `root_te` `tab_fore` `tab_aft` `fin<n>` | surface of `nose_cone`, `body_tube`, `transition` | `count`, `points`, `thickness` (length) |
| `tube_fin_set` | `fore` `aft` `fin<n>` | surface of `nose_cone`, `body_tube`, `transition` | `count`, `length` (length), `od` (length) |
| `inner_tube` | `fore` `aft` `motor_retainer` `inner` `outer` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length), `od` (length) |
| `coupler` | `fore` `aft` `mid` `inner` `outer` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length), `od` (length) |
| `centering_ring` | `fore` `aft` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length), `id` (length) |
| `bulkhead` | `fore` `aft` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length) |
| `engine_block` | `fore` `aft` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length), `id` (length) |
| `launch_lug` | `fore` `aft` `mid` | surface of `nose_cone`, `body_tube`, `transition` | `length` (length), `od` (length) |
| `rail_button` | `fore` `aft` `mid` `top` | surface of `nose_cone`, `body_tube`, `transition` | `od` (length), `id` (length), `height` (length) |
| `parachute` | `attach` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `diameter` (length), `cd` (dimensionless), `packed_length` (length), `packed_diameter` (length) |
| `streamer` | `attach` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `length` (length), `width` (length), `packed_length` (length), `packed_diameter` (length) |
| `shock_cord` | `attach` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `cord_length` (length), `packed_length` (length), `packed_diameter` (length) |
| `mass_component` | `fore` `aft` `cg` | inner of `nose_cone`, `body_tube`, `transition`, `inner_tube`, `coupler` | `mass` (mass), `length` (length) |
| `tank` | `fore` `aft` `inner` `outlet` | inner of `body_tube`, `coupler` | `length` (length), `od` (length), `wall` (length), `end_cap` |
<!-- /generated:components -->

## Commands

| Command | Use it to |
|---|---|
| `rw init --template simple-rocket [dir]` | start a project in the working directory (or in `dir` when you are asked for one); `minimum` is the other template |
| `rw check --strict` | check the design (the gate) |
| `rw check --strict --json` | the full report: `status`, `diagnostics`, `dims` (`length`, `max_diameter`, `length_cal`, `fineness`, ...), `mass` (with the mass breakdown `mass.components[]`: `component`, `mass`, `cg`, `override`), `aero` (with the per-component terms `aero.terms[]`: `component`, `cna`, `cp`, `model`), `stability`, `motor`, `clearance`, `assertions`, `report` |
| `rw check --strict --set <path>=<value>` | a what-if: check with overrides, writing nothing (repeat `--set`; the paths are the `rw set` paths) |
| `rw check --strict --sim quick` | also fly a quick simulation of the configuration (with `--set`, of the overridden model: a what-if flight) |
| `rw check --config <id>` / `--variant <name>` | check another configuration or variant |
| `rw set <path>=<value>... [--dry-run] [--label <title>]` | change fields |
| `rw set <path>... --unset`, `rw rm <path>` | remove fields (back to their defaults), e.g. `rw rm sims.flight.launch_into_wind`; the same strict-check output as any edit |
| `rw add <id> '<component JSON>'` | add a component (`@file.json` reads a file) |
| `rw rm <id> [--recursive]` | remove a component (and what attaches to it); a dotted path removes a field instead |
| `rw mv <id> <target>.<anchor> [--at <anchor>] [--offset <len>]` | re-attach a component |
| `rw eval [<json pointer>]` | the evaluated model: tree, stations, anchors (`rw eval /components/0`) |
| `rw render --view <view> [--compare <version>]` | draw `renders/<config>.<view>.png`; with `--compare`, the red/amber/green diff against that version |
| `rw sim <sim> [--force]` | fly a simulation by id or display name (`rw sim "Simulation 5"`); a cached run is reused unless `--force` |
| `rw run summary <sim\|run> [--fields <list>]` | a finished run's summary (apogee, max velocity, time to apogee, burnout altitude, drift, derived timing such as `deploy_minus_apogee` and `delay_minus_optimum`, ...) and its events, in display units; `--fields apogee,max_velocity` picks fields, `--fields` alone explains each |
| `rw motor search [--class C] [--diameter "18 mm"]` | find motors; `rw motor show <id>` for one |
| `rw engine design <id>`, `rw engine sim <id> [--duration "10 s"]` | size a liquid engine (`engines/<id>.rw.toml`): chamber, nozzle, injector, feed budget, tanks, blowdown; `sim` writes `runs/engine.<id>/<run>/` (`engine.json`, `series.csv`) |
| `rw cfd import <file.csv\|dir> [--study <id>] [--dry-run]` | import a CFD point dataset (CSV header `x,y,z` in m, body frame; optional `vx,vy,vz`, named scalars; `# rw-cfd: units=p:Pa; time=0.5` lines; one `<prefix>_t<s>.csv` per step) into `runs/cfd.<id>/<run>/cfd.json` with `provenance = cfd`, for page 06 Imported CFD; display only, never an engineering number; prints each scalar's range |
| `rw motor import <file.eng\|file.rse>` | copy a motor file into `lib/motors/` and record its sha256; refs `lib:motors/<file>#<designation>` |
| `rw motor thrustcurve search [<query>] [--manufacturer M] [--diameter "18 mm"] [--impulse-class C]` | search thrustcurve.org for real motors (network: only when the user asks); lists motor id, manufacturer, designation, class, diameter, total impulse, burn time; needs no project and writes nothing |
| `rw motor thrustcurve fetch <motor id\|designation> [--format eng\|rse] [--dry-run]` | download that motor's data file into `lib/motors/` as `rw motor import` does (sha256, strict check), recording its source under `[lib.source]`; refs `lib:motors/<Maker>_<designation>.eng#<designation>` |
| `rw lib search [--kind material]` | search the project library and the built-in parts presets (`preset:<catalog>/<part>`, openrocket-database, Apache-2.0) |
| `rw import ork <file.ork> [<dir>]` | import an OpenRocket design: a new project in `<dir>`, or (inside a project) replace its model as one step |
| `rw export <format> <path> [--config <id>] [--run <ref>] [--allow-outside]` | write `ork`, `rasp` (the configuration's motors), `glb`, `stl` (mm), or `csv` (a run's series, needs `--run`); the path must be inside the project unless `--allow-outside` |
| `rw history log`, `rw history show <version>` | list steps, show one |
| `rw history compare <a> <b> [--visual] [--breakdown]` | metric deltas with units, components removed/changed/added, and the edits between versions; `--breakdown` adds each component's mass and CG and each aero term's CNa and CP (before -> after, absolute change, percent) |
| `rw history tag <name> [<version>]` | name a revision (`rev:01`) |
| `rw diff model <a> <b>` | the field-level change between versions |
| `rw diff run <a> [<b>] [--golden <json>]` | compare runs, or a run with a reference: `a`, `b`, `a - b` in display units, `delta %`, each row's tolerance and result, and the keys compared without a tolerance; against a golden also the static rows (CG, CP, CNa, stability); then the `phases` rows (time, altitude, speed at rail exit, burnout, apogee, deployment, landing) |
| `rw fmt [--check]`, `rw validate` | canonical formatting; schema-only validation |
| `rw schema [<name>]` | list or print a JSON Schema |
| `rw call <tool> '<json>'` | run any MCP tool by name from the shell (prints the tool JSON, runs no strict check) |
| `--units si\|display`, `--json` | any command: text in SI instead of display units; JSON output (SI, with a `units` map) |

Versions are `live`, `step:<n>`, `rev:<NN>`, `commit:<sha>`, or `run:<id>`
(the step that run's model was recorded at). Every write records a history
step in `.rw/` (never in your git repository). To undo, run
`rw call history_restore '{"version":"step:<n>"}'` (Revert in the app's
history strip and Compare view does the same). This is a new step, so nothing
is lost.

### What a mutation prints

`rw set`, `rw add`, `rw rm`, `rw mv`, `rw import`, `rw motor import`, and
`rw init` print the step, the files written, the **check delta**, and then
their own **strict check**:

```text
recorded step:2
  M rocket.rw.toml
delta: clean (lenient)
  mass.liftoff: 57.4 g -> 57.673 g (+0.2736 g)
  stability.liftoff: 5.2068 cal -> 5.3654 cal (+0.15856 cal)
check --strict: clean (static) config baseline
  length 563 mm (22.702 cal), diameter 24.8 mm, fineness 22.702
  mass liftoff 57.673 g, CG 358.76 mm, CP 491.83 mm, CNa 30.491
  stability liftoff 5.3654 cal, burnout 7.2032 cal, min 5.3654 cal
  motor generic:RW_C6G in mount: fits true, T/W 10.608
```

The delta lists every metric that changed (`old -> new (change)`) and the
diagnostics that appeared or were resolved; it uses the lenient status. The
`check --strict:` section is the same report as `rw check --strict`, with its
diagnostics. It is the gate: the command exits 1 unless it is `clean`. With
`--json` the shape is:

```json
{
  "step": "step:2",
  "model_hash": "b1ca3b41...",
  "dry_run": false,
  "files": [{ "path": "rocket.rw.toml", "status": "M" }],
  "delta": {
    "status": "clean",
    "model_hash": "b1ca3b41...",
    "changed": { "stability.liftoff": [5.2069, 3.603], "aero.cp": [0.48705, 0.44383] },
    "new_diagnostics": [],
    "resolved_diagnostics": ["RW-E101@/c/fins/span"]
  },
  "check_strict_status": "clean",
  "check_strict": { "status": "clean", "diagnostics": [], "...": "the rw check --json report" },
  "units": { "length": "m", "mass": "kg", "...": "SI" }
}
```

A mutation that leaves errors or warnings **is still written** and exits 1.
Fix forward, or restore a step. `--dry-run` previews the delta without writing
and runs no strict check; try a what-if with `rw check --strict --set`.

### Looking at the design

- `rw render --view profile`: side profile with stations. `fin`: the fin
  planform. `stations`: the station table. `anchors`: every named anchor.
  These 2D views need nothing but the CLI.
- `iso`, `top`, `side`, `front`, `rear`, `exploded`, `section`: 3D views that
  need `rocketwright-render` (shipped with the app). Without it the command
  exits 2 with a hint. In the app, call `render` or `viewport_render`.
  `exploded` pulls the parts apart along the axis (`--explode`, default 1).
  `section` cuts the model open on the body x-z plane: cut faces are
  hatched, so the bays and the motor mount show inside.
- `--config <id>` picks the configuration and `--imgsize 1600x600` sets the
  exact size.
- `--compare <version>` draws what changed since that version: removed parts
  red, changed parts amber (with the old outline dashed), added parts green,
  the rest dimmed. It works with `profile` and the 3D views
  (`renders/<config>.<view>.compare.png`). `rw history compare <a> <b>
  --visual` draws the same profile for any two versions.
- Every render prints a legend of what it drew under the PNG path: per
  component its station range (`x`, from the nose tip) and radial extent
  (`r`, from the axis) in display units, then `relations`: where fins end
  against their tube's aft end (`aft end 25.4 mm past the body aft end
  (overhang)`, `aft end flush with ...`, `aft end ... forward of ...`), where
  a rail button or lug sits along its tube (`lug: at 250 mm, 50% along
  body`, one line per instance), and an inner part reaching past its tube's
  aft end. `--json` carries the same under `legend` (`components`,
  `relations`), in SI. The `fin` view lists only fin sets; the 3D views list
  internals only when exploded.
- Open the PNG, then describe the rocket from the legend lines: the parts,
  their order, where they sit. Do not describe a render you have not opened,
  and never state a position, a size, or "flush" that the legend or
  `rw eval` / `rw check` dims do not print. Do not read numbers off the
  labels drawn in the image.

An excerpt, on an imported OpenRocket example whose fins overhang the tube:

```
renders/<config>.profile.png (1200x348)
drawn (x: stations from the nose tip, r: radius from the axis, mm):
  body (body_tube): x 100-400 mm, r 11.5-12.5 mm
  lug (launch_lug, on body): x 232.5-267.5 mm, r 12.5-19.5 mm
  fins (trapezoidal_fin_set, x3, on body): x 349.2-425.4 mm, r 12.5-42.5 mm
relations:
  lug: at 250 mm, 50% along body
  fins: aft end 25.4 mm past the body aft end (overhang)
```

```rw norun
rw render --view iso --imgsize 1600x900
```

## MCP tools

The same operations are MCP tools (`rocketwright mcp --project <dir>`, and
inside the app through its Lecturn agent pane). Each mutating tool takes
`dry_run` and returns the same check delta as the CLI.
Tool names below are bare. A host may add a prefix; in Lecturn every tool is
`rw_<tool>` (`rw_simulate`, for Claude `mcp__lecturn__rw_simulate`). Call the
name your host lists.

<!-- docs-check: tools -->

| Tool | CLI | Notes |
|---|---|---|
| `model_get` | `rw eval` | read-only |
| `model_patch` | `rw set` | `{"ops":[{"op":"replace","path":"/c/fins/span","value":"30 mm"}]}` (RFC 6902) |
| `component_add` | `rw add` | `{"id":"lug2","component":{...}}` |
| `component_remove` | `rw rm` | destructive |
| `design_check` | `rw check` | `{"strict":true}`, the gate after every edit |
| `render` | `rw render` | `{"view":"profile"}` |
| `simulate` | `rw sim` | returns `job_id` unless the run is cached |
| `job_status` | | poll a job until `complete` or `failed` |
| `job_cancel` | | |
| `run_list`, `run_diff` | `rw diff run` | |
| `motor_search`, `library_search` | `rw motor search`, `rw lib search` | read-only |
| `import_file` | `rw motor import` | `{"path":"/abs/K828FJ.eng","kind":"motor"}`; needs the user's approval |
| `thrustcurve_search` | `rw motor thrustcurve search` | `{"query":"Estes C6"}`; network, read-only; only when the user asks |
| `thrustcurve_fetch` | `rw motor thrustcurve fetch` | `{"motor":"<motor id>"}`; network; needs the user's approval, which names the host |
| `history_list`, `history_show`, `history_compare`, `history_tag`, `history_restore` | `rw history ...` | |
| `model_diff` | `rw diff model` | |
| `engine_design`, `engine_simulate` | `rw engine design`, `rw engine sim` | `{"engine":"demo"}`; the design lists `missing_inputs` and `RW-E22x` rule findings |
| `cfd_import` | `rw cfd import` | `{"path":"fixtures/cfd","study":"tank"}`; writes `runs/cfd.<id>/<run>/`, `provenance` `cfd`; needs the user's approval |
| `project_validate`, `schema_get` | `rw validate`, `rw schema` | |
| `import_file`, `export_file` | `rw import ork`, `rw motor import`, `rw export` | need the user's approval |

App-only tools (they act on the live window the user sees):

<!-- docs-check: app-tools -->

| Tool | Use |
|---|---|
| `viewport_render` | capture the 3D viewport as an image |
| `viewport_select`, `viewport_set_camera` | select a component; move the camera |
| `plot_render` | capture a results plot |

MCP Apps cards: hosts that support MCP Apps draw a card under some tool
results. `simulate`, `engine_simulate`, `job_status` and `run_diff` declare
`ui://rw/run-card` (stats plus the altitude or thrust chart; `run_diff` draws
both runs' altitude traces); a `simulate` that starts a job shows a one-line
status there, and the full card is on the `job_status` that completes the run;
the editing
tools (`component_add`, `component_remove`, `model_patch`, `import_file`,
`history_restore`) and `history_show` declare `ui://rw/step-card`; `render` and
`history_compare` declare `ui://rw/render-card`. Cards read a run's samples
with `run_series` and a stored render's PNG with `render_picture`, tools listed
with `_meta.ui.visibility: ["app"]` that hosts hide from you; read summaries
from the tool results instead.

Tool rows: every tool declares a short MCP `title` (`motor_search` is "Find
motors", `simulate` "Run simulation"), and every result carries
`_meta["lecturn/summary"]`, one line under 120 characters on what that call
found or why it failed ("3 candidates", "Flight · Apogee 305 m", "Tank study ·
Study 01", "Needs approval").
Hosts show them on the chat's tool rows for the user. Take numbers from the
result itself, never from the summary.

Polling a simulation job:

```json
→ simulate      {"sim": "baseline"}
← {"sim": "baseline", "run_id": "273d19df9074", "status": "running", "cached": false, "job_id": "job-1"}
→ job_status    {"job_id": "job-1"}
← {"job_id": "job-1", "kind": "simulate", "state": "running", "progress": 0.4}
→ job_status    {"job_id": "job-1"}
← {"job_id": "job-1", "kind": "simulate", "state": "complete", "progress": 1, "run_id": "273d19df9074", "summary": {"apogee_m": 384.38, ...}}
```

Report the `summary` of the `complete` state, not the earlier responses. A
cache hit returns `status: "complete"` with `summary` and no `job_id`. Jobs do
not survive a sidecar restart, so use `run_list` to find finished runs. From
the CLI, `rw sim` blocks until the run finishes.

## Liquid engines

`engines/<id>.rw.toml` describes a pressure-fed liquid engine: propellants
(`n2o`, `lox`, `ethanol`, `ipa`, `rp1`, `ch4` use the shipped tables; CEA
species names such as `"N2O(L)"` use native CEA in the sidecar), mixture
ratio, chamber pressure, thrust, `expansion_ratio` or `exit_pressure`,
`contraction_ratio`, `l_star`, `injector`, `fluid_model`, and a feed graph:

```toml
[feed.node.tank_a]
kind = "tank"               # tank | valve | line | engine | sensor
fluid = "n2o"
pressure = "50 bar"         # initial ullage pressure
pressurant = "n2"
component = "ox_tank"       # a `tank` component, or an inline `tank = {...}`
station = "200 mm"          # viewport placement: station and radial offset
radial = "-350 mm"

[[feed.edge]]
from = "tank_a"
to = "engine"
diameter = "10 mm"
length = "0.6 m"
bc = "open"                 # open | closed | check_valve | orifice
```

Mount it in a configuration with `engine = "<id>"` in place of `motor`:
`rw sim` flies its generated thrust curve. Unset inputs are warnings
`RW-W210` (fluid model), `RW-W211` (edge `bc`), `RW-W212` (the rest); design
rules are `RW-E220`..`RW-E229` (injector drop 15-25% of Pc, L* band,
contraction >= 2, exit pressure 0.4-3x ambient, 10% tank margin, hoop safety
factor >= 2 on the wall material's `yield_strength`, feed pressure). A valve
node without `flow_area` is sized to take the pressure the design point
leaves over.

### Visual flow studies

A sim with `kind = "visual_flow"` is a page 06 study, not a flight: the GPU
liquid in one tank of an engine drains with that engine's engineering
blowdown while the vehicle tilts.

```toml
# sims/study_01.rw.toml
name = "Study 01"
kind = "visual_flow"
config = "baseline"
[visual_flow]
engine = "demo"
attitude = "scripted_tilt"   # scripted_tilt | run (replay a flight: replay = "<flight sim>")
duration = "10 s"            # default 10 s
tilt = "50 deg"              # mean tilt from vertical (default 50 deg)
swing = "10 deg"             # rocking amplitude (default 10 deg)
period = "4 s"               # rocking period (default 4 s)
# tank = "tank_a"            # default: the oxidizer branch's tank
```

`rw sim study_01` writes `runs/study_01/<run>/manifest.json` and `visual.json`
(the tilt, the body-frame specific force, relative flow and fill, and the tank
fill fraction over time) with `provenance = "visual"`: never quote them as
engineering numbers; the engine's own numbers come from `rw engine sim`.
`run_list` leaves studies out unless asked for one by id. Inconsistent studies
are `RW-E068`.

## Worked edits

The blocks below are one session, run top to bottom by `cargo xtask
docs-check`. A trailing `# exit N` gives the expected exit code; the default
is 0.

### 0. Start a project, check it, look at it

```rw
rw init --template simple-rocket
rw check --strict
rw eval
rw render --view profile
rw render --view anchors
```

`rw init` ends with its own `check --strict: clean` section. `rw check
--strict` prints the same report headed `check: clean`: the length (also in
calibers of the reference diameter) and diameter, the fineness ratio (length
over maximum diameter), the liftoff mass, CG, CP, CNa, the stability margin in calibers, the
motor fit and thrust-to-weight, and each assert, in display units (`length
563 mm`, `mass liftoff 57.4 g`). Open `renders/baseline.profile.png` and
`renders/baseline.anchors.png`, and describe the rocket from the legend
`rw render` printed (`fins: aft end flush with the body aft end`).

### 1. Change a parameter and read the delta

Lengthen the body through its param. Preview with `--dry-run`, then apply:

```rw
rw set params.body_length.value="500 mm" --dry-run
rw set params.body_length.value="500 mm" --label "Longer body"
rw check --strict
```

The delta lists every metric that moved (`dims.length`, `mass.cg`,
`stability.liftoff`, ...) with its change, and the `check --strict:` section
after it is the gate. Quote those numbers. Do not estimate them. (The
`rw check --strict` after an `rw` edit repeats its section; it is needed only
after an edit made some other way.)

### 2. Make the rocket unstable, then fix it

Shrinking the fins moves the CP forward of the CG:

```rw
rw set c.fins.span="8 mm" c.fins.root_chord="25 mm" c.fins.tip_chord="10 mm" c.fins.sweep="10 mm"  # exit 1
rw check --strict  # exit 1
```

The `rw set` is written, but its strict section fails, so it exits 1. The
check fails with two findings: the stability error, and the failed assert
from `rocket.rw.toml`:

```text
check: errors (static) config baseline
  length 613 mm (24.718 cal), diameter 24.8 mm, fineness 24.718
  mass liftoff 56.018 g, CG 378.17 mm, CP 287.05 mm, CNa 3.5376
  stability liftoff -3.6744 cal, burnout -1.4223 cal, min -3.6744 cal
  motor generic:RW_C6G in mount: fits true, T/W 10.922
  assert stable stability.liftoff >= 1 cal: FAIL (keep at least one caliber of static margin at liftoff)
  RW-E101 error /c/fins/span: Unstable: the stability margin is -3.67 cal at liftoff and -3.67 cal at its minimum during the burn (CP is forward of the CG) (hint: Move the CP aft: increase c.fins.span or the root chord, or add nose weight.)
```

(The numbers here are illustrative: they change as the physics improves.
Read yours from your own output.)

Follow the hint. Try a fix as a what-if first (`--set` writes nothing), then
apply it. Put the span back on its param, so `params.fin_span` drives it again:

```rw
rw check --strict --set c.fins.span="40 mm" --set c.fins.root_chord="60 mm" --set c.fins.tip_chord="30 mm" --set c.fins.sweep="30 mm"
rw set c.fins.span="= params.fin_span" c.fins.root_chord="65 mm" c.fins.tip_chord="30 mm" c.fins.sweep="35 mm"
rw check --strict
```

The delta's `resolved` lines show `RW-E101` went away, and the `check
--strict: clean` section (exit 0) is the evidence. Never report the rocket as
stable from the `delta:` line alone.

### 3. Add parts on named anchors, and see why `--strict` matters

Add a rail button on the body surface and a nose weight inside the nose:

```rw
rw add button_fore '{"type":"rail_button","name":"Rail button","attach":{"to":"body.outer","offset":"150 mm"},"material":"polystyrene","od":"9.5 mm","id":"4 mm","height":"8 mm"}'
rw add nose_weight '{"type":"mass_component","name":"Nose weight","attach":{"to":"nose.inner","offset":"40 mm"},"mass":"70 g","length":"15 mm"}'  # exit 1
rw check
rw check --strict  # exit 1
```

The nose weight is written, but `rw add` exits 1: its strict section reports
`check --strict: warnings` with `RW-W102`, liftoff thrust-to-weight below 5.
Plain `rw check` exits 0 on that warning; `--strict` turns it into a failure. That is why
the rule says `--strict`. Fix it as the hint says (less mass), then check and
look:

```rw
rw set c.nose_weight.mass="10 g"
rw check --strict
rw render --view profile
```

### 4. Swap the motor, simulate, compare

```rw
rw motor search --diameter "18 mm"
rw set configs.baseline.motors.mount.motor=generic:RW_B4G configs.baseline.motors.mount.delay="3 s"
rw check --strict
rw sim baseline
rw history log
rw history compare step:1 live
rw history compare step:1 live --breakdown
rw diff model step:1 live
rw history tag "B4 baseline"
```

`rw history compare --breakdown` lists, after the metrics, a
`breakdown mass` block (`mass.components.<id>.mass` and `.cg` for every
component) and a `breakdown aero` block (`aero.terms.<id>.cna` and `.cp`),
each `before -> after (change, percent)`. When two edits both moved a
metric (a longer body and longer fins both add mass), these rows say how
much each component moved: quote them, and never credit one component with
the whole change. In `--json` they are `breakdown[]` rows (`key`, `a`, `b`,
`delta`, `delta_pct`, `unit`, SI). The same per-component values for one
version are `mass.components[]` and `aero.terms[]` in `rw check --json`.

`rw sim` prints the summary (`apogee`, `max_velocity`, `time_to_apogee`,
`rail_exit_velocity`, `landing_velocity`, `min_stability`, ...) in display
units. Report those values as printed. Running it again reuses the cached run
until the model changes. `rw run summary` prints every summary field of a
finished run (burnout time and altitude, optimum delay, drift, ...) and its
flight events (time, altitude, and velocity of liftoff, rail exit, burnout,
apogee, deployment, landing), so no number needs a script over `series.csv`:

```rw
rw run summary baseline
rw run summary baseline --fields apogee,max_velocity,time_to_apogee
rw run summary baseline --fields
```

`--json` gives the same run in SI (`summary.apogee_m`, `events[].t`).

**What-if flights.** To see how a change would fly before writing it, add
`--sim quick` to a what-if check. It flies the overridden model, so each
`--set` value gives its own apogee:

```rw
rw check --strict --sim quick --set params.fin_span.value="30 mm"
rw check --strict --sim quick --set params.fin_span.value="60 mm"
```

Compare the `quick sim:` lines. Nothing is written, so `rw sim` still flies
the model on disk; after an `rw set`, `rw sim` flies the edited model under a
new run id.

**Derived timing.** Never subtract event times or delays yourself: the
summary already has the differences, signed and labelled. Each recovery
deployment has `deploy_minus_apogee` (deployment time minus apogee time;
negative = before apogee), `deploy_altitude`, and `deploy_velocity`. Each
motor with an ejection delay has `ejection_delay` and `delay_minus_optimum`
(configured delay minus optimum delay; negative = the charge fires before
apogee). `burnout_time` and `coast_time` (apogee minus the last burnout) sit
beside them. `rw sim` prints them too, one row per device or motor mount,
with the direction in words:

```rw
rw run summary baseline --fields deploy_minus_apogee,deploy_altitude,delay_minus_optimum,coast_time
```

A row reads `deploy_minus_apogee (chute)  -0.43 s (before apogee)`: quote it
as printed. In `--json` they are `summary.deployments[]`
(`deploy_minus_apogee_s`, `deploy_altitude_m`, `deploy_velocity_ms`,
`source`) and `summary.ejections[]` (`delay_s`, `optimum_delay_s`,
`delay_minus_optimum_s`, `source`), plus `summary.coast_time_s`.

### 5. Recover from a units mistake

An unquoted number is JSON, so `450` is written as a bare number:

```rw
rw set c.body.length=450  # exit 1
rw check --strict  # exit 1
```

The first finding is `RW-E021 error rocket.rw.toml /c/body/length: unit-missing`.
The errors after it (`RW-E154`, `RW-E157`, `RW-E101`) are knock-on effects of
a body with no valid length. Fix the first one and check again:

```rw
rw set c.body.length="= params.body_length"
rw check --strict
rw fmt --check
rw validate
```

### Motors from ThrustCurve

The built-in generic curves work offline and are the default. When the user
asks for a real motor (an Estes C6-5, an AeroTech H128W), RocketWright can
search thrustcurve.org and download that motor's data file. This is the only
network access RocketWright makes, and only on request: the user's machine
downloads the file into the project, and RocketWright never bundles it.

1. `rw motor thrustcurve search "Estes C6"` lists matches with their motor
   ids (a delay suffix such as `-5` is ignored; ThrustCurve designations have
   no delay).
2. `rw motor thrustcurve fetch <motor id>` saves `lib/motors/Estes_C6.eng`
   (`--format rse` for RockSim, which carries mass and CG per sample),
   records its sha256 under `[lib.sha256]` and its origin, motor id, data
   file id, page URL, and download time under `[lib.source]`, and prints the
   ref and its own `check --strict:` section.
3. Assign the ref and check:
   `rw set configs.<id>.motors.<mount>.motor=lib:motors/Estes_C6.eng#C6`.
   Set the configuration's `delay` to one of the delays the file lists.

Errors say why and write nothing: `RW-E015` (thrustcurve.org could not be
reached; exit 2), `RW-E016` (no such motor, or no data file in that format),
`RW-E017` (the designation matches several motors: pass the motor id or
`--manufacturer`). Over MCP, `thrustcurve_fetch` asks the user first.

### Imported designs

`rw import ork` keeps every component's OpenRocket UUID in `import.uuid`,
turns placements into `attach` offsets and automatic radii into expressions
(`od = "= c.body.od"`). A motor curve embedded in the file is copied into
`lib/motors/`; a motor with no curve offline is replaced by the nearest
generic curve and reported as `RW-W103 motor-substituted` (the original
designation stays in the configuration's `import`). Anything approximated or
skipped is `RW-W010`. `rw import` ends with its own `check --strict:` section
and exits 1 unless it is clean: OpenRocket does not check fit or
interference, so an imported design can report `RW-E15x` clearance errors
that were in the file all along, and a substituted motor is a warning.
To keep the generic curve, accept it on the configuration's motor:
`rw set configs.<id>.motors.<mount>.accept_substitution=true` writes
`accept_substitution = true` under `[motors.<mount>]`, and `RW-W103` is no
longer reported for that motor, so the strict check can be clean.

To compare an imported flight with an oracle golden, run
`rw diff run <run> --golden <golden.json>`. When the run was flown under
other conditions than the golden, the diff says `mismatch conditions_hash`
and lists each differing key (`conditions.wind_speed_ms: run 2.0 vs golden
0.0`). Make a sim file with those values (same `name` as the golden's
`sim_name`), run `rw check --strict`, fly it, and diff again. Report the `a`,
`b`, `a - b`, and `delta %` columns as printed (`a` is ours, `b` the golden;
`a - b` is in display units, with the same sign as `delta %`). The `tol` and
`result` columns give each row's tolerance and verdict (`pass`, `FAIL`; `not
gated` when the key has no tolerance, `not scored` while the setup
mismatches). The lines after the table count the gated keys and name every
key compared without a tolerance: the overall `pass` rests only on the gated
keys.

When the golden has a static block, the flight rows are followed by a
`static (...)` heading and the rows `mass.cg`, `aero.cp`, `aero.cna`, and
`stability.liftoff`: ours from `rw check` of the run's configuration, the
golden's value, the change in display units (`+0.10505 mm`), the percent,
the tolerance, and the result. They come from the run's own model, so a run
flown before a later edit still compares the design it flew (a `note:` line
names the history step). Quote the CG, CP, CNa, and stability differences
from these rows; never subtract the `rw check` CG or CP from the golden's
`static` values yourself.

Every `rw diff run` (two runs or a golden) ends with a `phases (...)` block:
the main flight's events in time order, `rail_exit`, `burnout`, `apogee`,
`deployment` (the last one), and `landing`, each with `.t_s`,
`.altitude_m`, and `.velocity_ms` (no apogee speed, no landing altitude),
both sides, `a - b`, and `delta %`. They are compared, never gated. Read
where two flights part from them: when `burnout.velocity_ms` already
differs, the gap is open at burnout, not only in the coast. Do not say a
difference comes from one phase (boost, coast, descent) unless these rows
show it. In `--json` they are `phases[]`.

## Pitfalls

- `rw check` without `--strict` hides warnings. The gate is a clean strict
  check: an edit's own `check --strict: clean` section, or `rw check --strict`
  exiting 0.
- `rw set ... | head` cuts off the edit's strict section; then run
  `rw check --strict` before the next edit.
- Overwriting an expression (`c.fins.span="30 mm"`) detaches it from its
  param. Prefer `params.<name>.value`, or write the expression back.
- A mass or recovery item inside a nose cone needs room: its station must lie
  inside the cone. `RW-E157` names a part that sticks out of its tube.
- Fin chords longer than the tube they sit on are `RW-E154`.
- `rw eval` paths are JSON pointers into the *evaluated* model
  (`/components/<i>`), not source paths. Read source fields from the TOML or
  `rw check --json`.
- Unknown keys in a TOML file are ignored. `rw validate` reports them as
  `RW-W001` (`rw check` does not), so after editing a file by hand, run
  `rw validate` and read its warnings: a typo such as `spann` silently does
  nothing.
- Another process (the app) may own the project (`.rw/lock`). CLI writes are
  then forwarded to it automatically. `RW-E007` means it is unreachable.
- Monte Carlo is not implemented (a non-goal of this release). Every
  simulation is one deterministic flight, and the `simulate` tool's `mc`
  argument above 1 returns a `not_implemented` error. Omit `mc`. To study
  dispersion, fly explicit variations instead: what-ifs with
  `rw check --strict --set <path>=<value> --sim quick`, or one sim file per
  case (for example several wind speeds), then compare them with `rw diff run`.

## Diagnostic codes (generated)

Also in [`diagnostics.md`](diagnostics.md).

<!-- generated:diagnostics -->
| Code | Slug | Severity | Meaning |
|---|---|---|---|
| `RW-E001` | `parse-error` | error | The file is not valid TOML or JSON. |
| `RW-E002` | `schema-error` | error | A value has the wrong type, or a required field is missing. |
| `RW-E003` | `duplicate-id` | error | The same id is defined in two source files. |
| `RW-E004` | `include-missing` | error | An `include` names a part file that is not in the project. |
| `RW-E005` | `unknown-file` | error | The path is not a RocketWright source file. |
| `RW-E006` | `lib-hash` | error | A file under `lib/` does not match the sha256 recorded in `rocketwright.toml [lib]`, or a recorded file is missing. |
| `RW-E007` | `locked-by` | error | Another live process owns the project (`.rw/lock`); mutating calls go through its sidecar. |
| `RW-E008` | `motor-dialect` | error | An imported motor file is neither a RASP `.eng` nor a RockSim `.rse` file, or does not parse as one. |
| `RW-E010` | `bad-override` | error | A variant or `--set` override names an unknown param or field, or gives an invalid value. |
| `RW-E011` | `param-out-of-range` | error | A param value lies outside its `min`/`max`. |
| `RW-E012` | `param-not-a-choice` | error | A param value is not one of its `choices`. |
| `RW-E013` | `param-dimension` | error | A param's `min`, `max`, `step`, or `choices` differ in dimension from its value. |
| `RW-E014` | `unknown-variant` | error | The selected variant is not defined under `[variants]`. |
| `RW-E015` | `thrustcurve-unreachable` | error | A ThrustCurve search or download the user asked for could not reach thrustcurve.org (offline, timed out, or the server answered with an error); nothing was written. |
| `RW-E016` | `thrustcurve-not-found` | error | ThrustCurve has no motor matching the request, or the motor has no data file in the requested format. |
| `RW-E017` | `thrustcurve-ambiguous` | error | A designation matches several ThrustCurve motors; pass the motor id or a manufacturer. |
| `RW-E020` | `quantity-syntax` | error | A quantity cannot be parsed. |
| `RW-E021` | `unit-missing` | error | A bare number on a dimensional field (only `0` may omit the unit). |
| `RW-E022` | `unknown-unit` | error | The unit symbol is not in the unit table. |
| `RW-E023` | `dimension-mismatch` | error | The unit has the wrong dimension for the field. |
| `RW-E030` | `invalid-parent` | error | The containment rule table does not allow this component in that parent. |
| `RW-E040` | `expr-syntax` | error | An `=` expression cannot be parsed. |
| `RW-E041` | `expr-unknown-ref` | error | An expression refers to a param or input field that does not exist. |
| `RW-E042` | `expr-cycle` | error | Expressions refer to each other in a cycle. |
| `RW-E043` | `expr-dimension` | error | An expression mixes dimensions or has the wrong dimension for its field. |
| `RW-E044` | `expr-not-numeric` | error | An expression refers to a value that is not a number or quantity. |
| `RW-E045` | `expr-domain` | error | An expression divides by zero or leaves the domain of a function. |
| `RW-E050` | `attach-missing` | error | A component other than the first body component has no `attach`. |
| `RW-E051` | `attach-unknown-target` | error | `attach.to` names a component that does not exist. |
| `RW-E052` | `attach-unknown-anchor` | error | `attach.to` names an anchor the target component does not have. |
| `RW-E053` | `attach-unknown-self-anchor` | error | `attach.at` names an anchor this component does not have. |
| `RW-E054` | `attach-cycle` | error | Components attach to each other in a cycle. |
| `RW-E055` | `stage-invalid` | error | A `[stage]` names a component that is not on the body chain, or its `override` does not cover the whole stage (`subtree = true`, no `cd`). |
| `RW-E056` | `instances-invalid` | error | An `instances` pattern is missing its spacing, scale, or a known preset. |
| `RW-E057` | `cut-invalid` | error | A `cut` component has no parent to cut from. |
| `RW-E059` | `config-invalid` | error | A configuration names an unknown mount, stage, or recovery component. |
| `RW-E060` | `sim-unknown-config` | error | A simulation names a configuration that does not exist. |
| `RW-E061` | `geometry-invalid` | error | A component dimension is out of range: a length that must be positive is not, an inner diameter is not below the outer, or a part does not fit its own shape. |
| `RW-E062` | `shape-param-range` | error | A nose or transition `shape_param` lies outside the range of its profile. |
| `RW-E063` | `material-unknown` | error | A component names a material that is not defined under `[materials]`. |
| `RW-E064` | `material-density` | error | A material lacks the density kind the component needs (bulk for solids, surface for canopies and streamers, line for cords), or a density is not positive. |
| `RW-E065` | `joint-invalid` | error | A `joint` sits on a component that cannot carry one, or has a zero `count`. |
| `RW-E066` | `appearance-invalid` | error | An `appearance` color is not `#rrggbb`, or roughness, metalness, or transmission is outside 0..1. |
| `RW-E067` | `sim-conditions-invalid` | error | A simulation condition is out of range (rail length, rod angle, site, atmosphere, wind, gravity, or integrator settings). |
| `RW-E068` | `visual-flow-invalid` | error | A `kind = "visual_flow"` study is inconsistent: it has no `[visual_flow]` table (or a flight has one), names an unknown engine or tank, has a duration or period that is not positive or a tilt outside 0..90 deg, or its `run` attitude names no flight sim to replay. |
| `RW-E100` | `no-reference-diameter` | error | The model has no reference diameter, so stability margins cannot be computed. |
| `RW-E101` | `unstable` | error | The CP is forward of the CG at liftoff or during the burn (negative stability margin). |
| `RW-E150` | `coupler-fit` | error | A coupler or shoulder is wider than the inner diameter of the tube it slides into. |
| `RW-E151` | `centering-ring-fit` | error | A centering ring is wider than its tube's inner diameter, or its bore is smaller than the mount tube. |
| `RW-E152` | `motor-fit` | error | The motor is wider than the mount's inner diameter or longer than the mount allows. |
| `RW-E153` | `fin-tab-wall` | error | A fin tab reaches deeper than the room between the body wall and the inner tube. |
| `RW-E154` | `fin-across-joint` | error | A fin root runs past the end of the body tube it is mounted on. |
| `RW-E155` | `recovery-volume` | error | The packed recovery items need more volume than their bay holds. |
| `RW-E156` | `overlap` | error | Two internal components occupy the same space. |
| `RW-E157` | `protrusion` | error | An internal component sticks out of its parent tube. |
| `RW-E200` | `feed-graph-invalid` | error | A liquid engine's feed graph is inconsistent: an edge names an unknown node, a tank node names a component that is not a `tank`, the graph has no single `engine` node, or a tank has no open path to the engine. |
| `RW-E201` | `engine-input-invalid` | error | A liquid engine input is out of range (a pressure, thrust, ratio, or volume that must be positive is not; a fraction outside 0..1; a tank fill larger than the tank; a node `volume` that disagrees with its tank geometry). |
| `RW-E220` | `injector-pressure-drop` | error | The injector pressure drop lies outside 15-25% of chamber pressure (SP-125 p 137): lower risks chugging, higher wastes feed pressure. |
| `RW-E221` | `l-star-range` | error | The characteristic length L* lies outside 0.38-3.05 m (15-120 in, SP-125 p 96). |
| `RW-E222` | `contraction-ratio` | error | The chamber contraction ratio Ac/At is below 2 (SP-125 p 97 gives 2-5 for pressure-fed engines). |
| `RW-E223` | `exit-pressure-range` | error | The nozzle exit pressure lies outside 0.4-3 times ambient at the design point: badly over- or under-expanded. |
| `RW-E224` | `tank-margin` | error | A tank's internal volume is less than 110% of its propellant load (SP-125 eq 8-1 ullage and reserve). |
| `RW-E225` | `tank-hoop-stress` | error | A tank's hoop stress at its working pressure leaves a safety factor below 2 on the wall material's yield strength. |
| `RW-E226` | `feed-pressure-low` | error | A tank's pressure is below the chamber pressure plus the injector and line losses at the design flow. |
| `RW-E227` | `thermo-unavailable` | error | No thermochemistry for the propellants or operating point: the pair is not tabulated and native CEA is not available, or the point lies outside the table. |
| `RW-E228` | `fluid-model-unsupported` | error | The engine's `fluid_model` is not supported yet (two-phase self-pressurizing N2O needs an equation of state; use single_phase_liquid). |
| `RW-E229` | `propellant-unknown` | error | A tank holds a liquid or pressurant with no density or gas data in the built-in table. |
| `RW-W001` | `unknown-field` | warning | A key is not part of the schema and is ignored. |
| `RW-W002` | `joint-count-missing` | warning | A shear-pin or screw joint has no `count`. |
| `RW-W003` | `lib-unrecorded` | warning | A file under `lib/` has no sha256 in `rocketwright.toml [lib]`. |
| `RW-W010` | `import-approximated` | warning | An imported file holds something RocketWright cannot represent exactly; it was approximated or skipped (the message says which). |
| `RW-W101` | `motor-unresolved` | warning | A configured motor was not resolved to a thrust curve, so it is missing from mass and motor checks. |
| `RW-W102` | `low-thrust-to-weight` | warning | The liftoff thrust-to-weight ratio is below 5. |
| `RW-W103` | `motor-substituted` | warning | An imported motor had no curve offline, so the nearest built-in generic curve by impulse class and diameter stands in for it. Accept it with `accept_substitution = true` on the configuration's motor. |
| `RW-W150` | `fin-tab-short` | warning | A fin tab is shallower than the body wall, so it does not reach through it. |
| `RW-W210` | `fluid-model-missing` | warning | A liquid engine has no `fluid_model`, so its tank and feed analysis cannot run (missing input). |
| `RW-W211` | `feed-bc-missing` | warning | A feed-graph edge has no boundary condition `bc` (open, closed, check_valve, orifice) (missing input). |
| `RW-W212` | `engine-input-missing` | warning | A liquid engine lacks an input its design needs (nozzle area ratio or exit pressure, L*, contraction ratio, injector pressure drop, or a tank's fluid, pressure, pressurant, geometry, or fill) (missing input). |
| `RW-W250` | `recovery-never-deploys` | warning | A parachute or streamer deploys in no configuration: its event is `never` everywhere, or `ejection` with only plugged motors (no `delay`). |
<!-- /generated:diagnostics -->
