# Metric paths

Dotted paths into the `rw check` report (IF7). `CheckDelta.changed`, `[[assert]]`,
and `[report]` use them. `rw_check::metrics::metric_map` is the source of truth.
Values are SI and rounded to 6 significant figures.

| Path | Dimension |
|---|---|
| `dims.length`, `dims.max_diameter`, `dims.fin_span` | length |
| `dims.length_cal` | calibers of `stability.ref_diameter` (dimensionless) |
| `dims.fineness` | length over `dims.max_diameter` (dimensionless) |
| `dims.components.<id>.{x_fore,x_aft,length,od,id}` | length |
| `mass.{dry,liftoff,burnout,propellant}` | mass |
| `mass.{cg,cg_burnout}` | length (station) |
| `mass.{ixx,iyy}` | inertia |
| `mass.components.<id>.mass`, `mass.components.<id>.cg` | mass, length |
| `aero.cp` | length (station) |
| `aero.{cna,cd,mach}` | dimensionless |
| `aero.alpha` | angle |
| `aero.terms.<id>.cna`, `aero.terms.<id>.cp` | dimensionless, length |
| `stability.{liftoff,burnout,min}` | calibers (dimensionless) |
| `stability.liftoff_pct_length` | percent of overall length |
| `stability.ref_diameter` | length |
| `motor.<mount>.total_impulse`, `.burn_time`, `.thrust_to_weight` | impulse, time, dimensionless |
| `clearance.<rule>.<a>.<b>.{required,actual}` | the row's `dim` |
| `sim.<run-summary key>` (with `--sim quick`) | from the key suffix: `_m`, `_ms`, `_ms2`, `_s` |

List rows are keyed by component, mount, or rule, never by index.

## Short names (`[[assert]]` and `[report]` only)

- `cg` → `mass.cg`, `cp` → `aero.cp`, `length` → `dims.length`, `diameter` → `dims.max_diameter`,
  `length_cal` → `dims.length_cal`, `fineness` → `dims.fineness`.
- `motor.thrust_to_weight` is the smallest value over all motors.
- `motor_fit` is 1 when every motor fits its mount, else 0.
- Bare run-summary keys (`apogee_m`, `rail_exit_velocity_ms`) are available when a quick sim ran.

Expressions may also use `params.<name>` and `c.<id>.<field>`. Fields are evaluated shape
fields such as `c.fins.span` or `c.nose.shoulder.od`. In these expressions `1 cal` means
one caliber (dimensionless), not a calorie.

Assertions take the form `<expr> <op> <expr>`, where `op` is one of `>= <= > < == !=`.
Both sides are compared in SI after rounding to 6 significant figures. A bare number compared
with a dimensional value is read as SI.
