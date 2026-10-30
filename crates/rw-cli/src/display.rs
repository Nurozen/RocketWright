//! Display units for the CLI's text output (B3 round 5: agents reason in mm
//! and g, and converted SI output by hand).
//!
//! Every text summary prints its values in the project's `[display_units]`
//! (`rocketwright.toml`), with the unit attached: `CG 357.92 mm`,
//! `mass liftoff 57.405 g`. Defaults: length `mm`, mass `g`, velocity `m/s`,
//! flight distances (`altitude`: apogee, burnout altitude, drift) `m`, time
//! `s`, angle `deg`, area `cm^2`, volume `cm^3`, inertia `g*cm^2`; anything
//! else is SI. A key is a dimension name (`length`, `mass`, `velocity`, ...,
//! as in `x-unit-dimension`) or `altitude`. `--units si` prints SI instead;
//! `--json` output stays SI and carries a `units` map.

use std::collections::BTreeMap;
use std::path::Path;

use rw_units::{DimKind, Unit, parse_unit};
use serde_json::{Map, Value, json};

/// `--units`: which units the text output uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UnitsMode {
    /// The project's `[display_units]` (with the defaults above).
    #[default]
    Display,
    /// SI (m, kg, s, rad, m/s), units still attached.
    Si,
}

impl UnitsMode {
    pub fn parse(s: &str) -> Option<UnitsMode> {
        match s {
            "display" => Some(UnitsMode::Display),
            "si" | "SI" => Some(UnitsMode::Si),
            _ => None,
        }
    }
}

/// What kind of quantity a printed value is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// A physical dimension, printed in that dimension's display unit.
    Dim(DimKind),
    /// A flight distance (apogee, burnout altitude, drift): `altitude`.
    Altitude,
    /// A unit printed as is in every mode (`cal`, `%`).
    Fixed(&'static str),
    /// A pure number.
    Plain,
}

/// The `display_units` key of the flight-distance class.
pub const ALTITUDE: &str = "altitude";

/// Default display units (keys as in `[display_units]`).
pub const DEFAULTS: &[(&str, &str)] = &[
    ("length", "mm"),
    ("mass", "g"),
    ("velocity", "m/s"),
    (ALTITUDE, "m"),
    ("time", "s"),
    ("angle", "deg"),
    ("acceleration", "m/s^2"),
    ("area", "cm^2"),
    ("volume", "cm^3"),
    ("inertia", "g*cm^2"),
];

/// The resolved unit table of one CLI invocation.
#[derive(Debug, Clone)]
pub struct Units {
    mode: UnitsMode,
    /// Class key → (symbol, unit). Only display mode fills it.
    table: BTreeMap<String, (String, Unit)>,
}

impl Default for Units {
    fn default() -> Self {
        Units::new(UnitsMode::Display, &BTreeMap::new())
    }
}

/// The dimension a class key stands for (`altitude` is a length).
fn key_dim(key: &str) -> Option<DimKind> {
    if key == ALTITUDE {
        Some(DimKind::Length)
    } else {
        DimKind::from_name(key)
    }
}

/// Parses `sym` as a unit of dimension `kind`, or `None`.
fn unit_of(sym: &str, kind: DimKind) -> Option<Unit> {
    let u = parse_unit(sym).ok()?;
    (u.dim == kind.dimension()).then_some(u)
}

impl Units {
    /// The defaults overlaid with `overrides` (a project's `[display_units]`).
    /// An entry with an unknown key, an unknown symbol, or the wrong
    /// dimension is ignored (the default stays).
    pub fn new(mode: UnitsMode, overrides: &BTreeMap<String, String>) -> Units {
        let mut table = BTreeMap::new();
        if mode == UnitsMode::Display {
            let entries = DEFAULTS
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .chain(
                    overrides
                        .iter()
                        .map(|(k, v)| (k.clone(), v.trim().to_string())),
                );
            for (k, sym) in entries {
                if let Some(u) = key_dim(&k).and_then(|d| unit_of(&sym, d)) {
                    table.insert(k, (sym, u));
                }
            }
        }
        Units { mode, table }
    }

    /// The units of the project at `root` (its `rocketwright.toml`
    /// `[display_units]`); the defaults when it has none or cannot be read.
    pub fn for_project(mode: UnitsMode, root: Option<&Path>) -> Units {
        let overrides = root
            .and_then(|r| std::fs::read_to_string(r.join("rocketwright.toml")).ok())
            .map(|text| manifest_units(&text))
            .unwrap_or_default();
        Units::new(mode, &overrides)
    }

    pub fn mode(&self) -> UnitsMode {
        self.mode
    }

    /// The symbol and unit a class prints in; `None` for pure numbers.
    pub fn unit(&self, c: Class) -> Option<(String, Unit)> {
        let si = |k: DimKind| {
            (
                k.si_unit().to_string(),
                Unit {
                    scale: 1.0,
                    offset: 0.0,
                    dim: k.dimension(),
                },
            )
        };
        match c {
            Class::Plain | Class::Dim(DimKind::Dimensionless) => None,
            Class::Fixed(s) => Some((s.to_string(), Unit::ONE)),
            Class::Dim(k) => Some(self.table.get(k.name()).cloned().unwrap_or_else(|| si(k))),
            Class::Altitude => Some(
                self.table
                    .get(ALTITUDE)
                    .cloned()
                    .unwrap_or_else(|| si(DimKind::Length)),
            ),
        }
    }

    /// The symbol a class prints in (`""` for pure numbers).
    pub fn symbol(&self, c: Class) -> String {
        self.unit(c).map(|(s, _)| s).unwrap_or_default()
    }

    /// An SI value in the class's unit, without the symbol.
    pub fn value(&self, si: f64, c: Class) -> f64 {
        match self.unit(c) {
            Some((_, u)) => u.from_si(si),
            None => si,
        }
    }

    /// `357.92 mm`: an SI value in its display unit, 5 significant figures.
    pub fn fmt(&self, si: f64, c: Class) -> String {
        // Integrator noise (`-2.3e-13 m` at landing) prints as 0.
        let si = if si.abs() < 1e-12 { 0.0 } else { si };
        let n = crate::cmd::fmt_f(self.value(si, c));
        match self.unit(c) {
            Some((s, _)) if !s.is_empty() => format!("{n} {s}"),
            _ => n,
        }
    }

    /// [`Units::fmt`] of a JSON number; `-` when it is not one.
    pub fn num(&self, v: &Value, c: Class) -> String {
        v.as_f64().map_or_else(|| "-".into(), |x| self.fmt(x, c))
    }

    /// The signed change `b - a` in the display unit: `+4.736 g`.
    pub fn delta(&self, a: f64, b: f64, c: Class) -> String {
        let d = self.value(b, c) - self.value(a, c);
        let sign = if d < 0.0 { "-" } else { "+" };
        let n = crate::cmd::fmt_f(d.abs());
        match self.unit(c) {
            Some((s, _)) if !s.is_empty() => format!("{sign}{n} {s}"),
            _ => format!("{sign}{n}"),
        }
    }

    /// [`Units::delta`] of two JSON numbers; `None` unless both are numbers.
    pub fn delta_json(&self, a: &Value, b: &Value, c: Class) -> Option<String> {
        Some(self.delta(a.as_f64()?, b.as_f64()?, c))
    }
}

/// The SI unit map `--json` output carries (`"units"`): dimension → SI symbol.
pub fn si_units_map() -> Value {
    let mut m = Map::new();
    for (k, _) in DEFAULTS {
        let d = key_dim(k).unwrap_or(DimKind::Length);
        m.insert((*k).to_string(), json!(d.si_unit()));
    }
    for (k, v) in [("impulse", "N*s"), ("force", "N"), ("stability", "cal")] {
        m.insert(k.into(), json!(v));
    }
    Value::Object(m)
}

/// Adds the SI `units` map to a JSON object output (other values pass through).
pub fn with_units(mut v: Value) -> Value {
    if let Value::Object(m) = &mut v
        && !m.contains_key("units")
    {
        m.insert("units".into(), si_units_map());
    }
    v
}

/// `[display_units]` of a `rocketwright.toml` text.
pub fn manifest_units(text: &str) -> BTreeMap<String, String> {
    #[derive(serde::Deserialize, Default)]
    struct M {
        #[serde(default)]
        display_units: BTreeMap<String, String>,
    }
    toml::from_str::<M>(text)
        .map(|m| m.display_units)
        .unwrap_or_default()
}

// ---- classifying values ----------------------------------------------------------

/// Class of a run-summary key from its unit suffix (`apogee_m` is a flight
/// distance, `max_velocity_ms` a velocity, `min_stability_cal` calibers).
pub fn summary_class(key: &str) -> Class {
    if key.ends_with("_ms2") {
        Class::Dim(DimKind::Acceleration)
    } else if key.ends_with("_ms") {
        Class::Dim(DimKind::Velocity)
    } else if key.ends_with("_cal") {
        Class::Fixed("cal")
    } else if key.ends_with("_m") {
        Class::Altitude
    } else if key.ends_with("_s") {
        Class::Dim(DimKind::Time)
    } else {
        Class::Plain
    }
}

/// Class of a metric path (`docs/dev/metric-paths.md`) or a bare run-summary
/// key. Clearance rows carry their own dimension: pass the report's
/// [`rw_check::metrics::metric_map`] as `report` to resolve them.
pub fn metric_class(
    key: &str,
    report: Option<&BTreeMap<String, rw_check::metrics::Metric>>,
) -> Class {
    use DimKind::{Angle, Impulse, Inertia, Length, Mass, Time};
    if let Some(k) = key.strip_prefix("sim.") {
        return summary_class(k);
    }
    if !key.contains('.') {
        return match key {
            "cg" | "cp" | "length" | "diameter" => Class::Dim(Length),
            _ => summary_class(key),
        };
    }
    let last = key.rsplit('.').next().unwrap_or("");
    let head = key.split('.').next().unwrap_or("");
    match head {
        "dims" => match last {
            "length_cal" => Class::Fixed("cal"),
            "fineness" => Class::Plain,
            _ => Class::Dim(Length),
        },
        "mass" => match last {
            "cg" | "cg_burnout" => Class::Dim(Length),
            "ixx" | "iyy" => Class::Dim(Inertia),
            _ => Class::Dim(Mass),
        },
        "aero" => match last {
            "cp" => Class::Dim(Length),
            "alpha" => Class::Dim(Angle),
            _ => Class::Plain,
        },
        "stability" => match last {
            "liftoff_pct_length" => Class::Fixed("%"),
            "ref_diameter" => Class::Dim(Length),
            _ => Class::Fixed("cal"),
        },
        "motor" => match last {
            "total_impulse" => Class::Dim(Impulse),
            "burn_time" => Class::Dim(Time),
            _ => Class::Plain,
        },
        "clearance" => report
            .and_then(|r| r.get(key))
            .map_or(Class::Plain, |m| Class::Dim(m.dim)),
        _ => Class::Plain,
    }
}

/// True for a run-summary key (`apogee_m`, `max_mach`, `sim.drift_m`).
pub fn is_summary_key(key: &str) -> bool {
    let k = key.strip_prefix("sim.").unwrap_or(key);
    !k.contains(['.', '/'])
        && (k == "max_mach"
            || ["_m", "_ms", "_ms2", "_s", "_cal"]
                .iter()
                .any(|s| k.ends_with(s)))
}

/// Class of a row that names its SI unit (`history compare` metrics and
/// component fields, `diff run` rows): a run-summary key is a flight
/// quantity, `cal` and `%` print as is, any other unit by its dimension; no
/// unit falls back to the metric path.
pub fn unit_class(key: &str, si_unit: Option<&str>) -> Class {
    if is_summary_key(key) {
        return summary_class(key.strip_prefix("sim.").unwrap_or(key));
    }
    match si_unit {
        Some("cal") => Class::Fixed("cal"),
        Some("%") => Class::Fixed("%"),
        Some(u) if !u.is_empty() => rw_units::unit_dimension(u)
            .ok()
            .and_then(DimKind::from_dimension)
            .map_or(Class::Plain, Class::Dim),
        _ => metric_class(key, None),
    }
}

/// Class of an evaluated-model field by name (`span`, `x_fore`, `od`), from
/// the schema's `x-unit-dimension`.
pub fn field_class(name: &str) -> Class {
    match rw_check::field_dim(name) {
        Some(DimKind::Dimensionless) | None => Class::Plain,
        Some(k) => Class::Dim(k),
    }
}

/// An evaluated-model value with every dimensioned number written as a
/// display string (`"110 mm"`), keyed by its field name; other values
/// unchanged. Numbers in an array take the array's field.
pub fn display_tree(units: &Units, v: &Value, field: Option<&str>) -> Value {
    match v {
        Value::Number(n) => match field.map(field_class) {
            Some(c @ Class::Dim(_)) => n.as_f64().map_or(v.clone(), |x| json!(units.fmt(x, c))),
            _ => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(|x| display_tree(units, x, field)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), display_tree(units, x, Some(k))))
                .collect(),
        ),
        _ => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> Units {
        Units::default()
    }

    #[test]
    fn defaults_are_mm_g_and_flight_metres() {
        let u = display();
        assert_eq!(u.fmt(0.35792, Class::Dim(DimKind::Length)), "357.92 mm");
        assert_eq!(u.fmt(0.057405, Class::Dim(DimKind::Mass)), "57.405 g");
        assert_eq!(u.fmt(356.98, Class::Altitude), "356.98 m");
        assert_eq!(u.fmt(123.18, Class::Dim(DimKind::Velocity)), "123.18 m/s");
        assert_eq!(u.fmt(5.2069, Class::Fixed("cal")), "5.2069 cal");
        assert_eq!(u.fmt(26.415, Class::Plain), "26.415");
        assert_eq!(
            u.fmt(std::f64::consts::FRAC_PI_2, Class::Dim(DimKind::Angle)),
            "90 deg"
        );
        assert_eq!(u.fmt(1.2773e-4, Class::Dim(DimKind::Volume)), "127.73 cm^3");
    }

    #[test]
    fn si_mode_and_overrides() {
        let si = Units::new(UnitsMode::Si, &BTreeMap::new());
        assert_eq!(si.fmt(0.35792, Class::Dim(DimKind::Length)), "0.35792 m");
        assert_eq!(si.fmt(0.057405, Class::Dim(DimKind::Mass)), "0.057405 kg");
        let o: BTreeMap<String, String> = [
            ("length".to_string(), "in".to_string()),
            ("altitude".to_string(), "ft".to_string()),
            ("mass".to_string(), "furlong".to_string()),
            ("time".to_string(), "kg".to_string()),
        ]
        .into();
        let u = Units::new(UnitsMode::Display, &o);
        assert_eq!(u.fmt(0.0254, Class::Dim(DimKind::Length)), "1 in");
        assert_eq!(u.fmt(0.3048, Class::Altitude), "1 ft");
        // Bad entries keep the default.
        assert_eq!(u.fmt(0.001, Class::Dim(DimKind::Mass)), "1 g");
        assert_eq!(u.fmt(2.0, Class::Dim(DimKind::Time)), "2 s");
    }

    #[test]
    fn deltas_are_in_display_units() {
        let u = display();
        assert_eq!(
            u.delta(0.057405, 0.059139, Class::Dim(DimKind::Mass)),
            "+1.734 g"
        );
        assert_eq!(u.delta(5.2069, 3.603, Class::Fixed("cal")), "-1.6039 cal");
        assert_eq!(u.delta(26.415, 38.993, Class::Plain), "+12.578");
    }

    #[test]
    fn metric_classes() {
        use DimKind::*;
        let c = |k| metric_class(k, None);
        assert_eq!(c("mass.liftoff"), Class::Dim(Mass));
        assert_eq!(c("mass.cg"), Class::Dim(Length));
        assert_eq!(c("mass.components.nose.cg"), Class::Dim(Length));
        assert_eq!(c("mass.components.nose.mass"), Class::Dim(Mass));
        assert_eq!(c("mass.ixx"), Class::Dim(Inertia));
        assert_eq!(c("aero.cp"), Class::Dim(Length));
        assert_eq!(c("aero.terms.fins.cp"), Class::Dim(Length));
        assert_eq!(c("aero.terms.fins.cna"), Class::Plain);
        assert_eq!(c("stability.liftoff"), Class::Fixed("cal"));
        assert_eq!(c("dims.length_cal"), Class::Fixed("cal"));
        assert_eq!(c("length_cal"), Class::Fixed("cal"));
        assert_eq!(c("dims.fineness"), Class::Plain);
        assert_eq!(c("dims.length"), Class::Dim(Length));
        assert_eq!(c("stability.liftoff_pct_length"), Class::Fixed("%"));
        assert_eq!(c("motor.mount.burn_time"), Class::Dim(Time));
        assert_eq!(c("motor.mount.total_impulse"), Class::Dim(Impulse));
        assert_eq!(c("apogee_m"), Class::Altitude);
        assert_eq!(c("sim.apogee_m"), Class::Altitude);
        assert_eq!(c("max_mach"), Class::Plain);
        assert_eq!(
            c("clearance.recovery_volume.chute.body.actual"),
            Class::Plain
        );
        assert_eq!(unit_class("mass.cg", Some("m")), Class::Dim(Length));
        assert_eq!(unit_class("apogee_m", Some("m")), Class::Altitude);
        assert_eq!(
            unit_class("stability.min", Some("cal")),
            Class::Fixed("cal")
        );
        assert_eq!(unit_class("mass.ixx", Some("kg*m^2")), Class::Dim(Inertia));
        assert_eq!(unit_class("/shape/span", Some("m")), Class::Dim(Length));
        assert_eq!(unit_class("/length", Some("m")), Class::Dim(Length));
        assert_eq!(unit_class("max_mach", None), Class::Plain);
        assert_eq!(unit_class("drift_m", Some("m")), Class::Altitude);
    }

    #[test]
    fn manifest_units_and_trees() {
        let m = manifest_units("format = 1\nname = \"x\"\n[display_units]\nlength = \"cm\"\n");
        assert_eq!(m.get("length").map(String::as_str), Some("cm"));
        assert!(manifest_units("not toml [").is_empty());
        let t = display_tree(
            &display(),
            &json!({"x_fore": 0.335, "count": 3, "type": "x"}),
            None,
        );
        assert_eq!(t, json!({"x_fore": "335 mm", "count": 3, "type": "x"}));
    }
}
