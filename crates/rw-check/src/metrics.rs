//! Metric paths: the dotted field paths of a [`CheckReport`] with their SI
//! values and dimensions (`docs/dev/metric-paths.md`). `CheckDelta.changed`,
//! `[[assert]]`, and `[report]` all read this map. Rows of a list are keyed
//! by their component, mount, or rule rather than their index, so a path
//! survives reordering: `mass.components.<id>.mass`, `aero.terms.<id>.cna`,
//! `motor.<mount>.thrust_to_weight`, `clearance.<rule>.<a>.<b>.actual`.

use std::collections::BTreeMap;

use rw_units::DimKind;
use serde_json::Value;

use crate::CheckReport;

/// One metric: SI value plus dimension.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metric {
    pub value: f64,
    pub dim: DimKind,
}

fn put(out: &mut BTreeMap<String, Metric>, path: String, value: f64, dim: DimKind) {
    out.insert(path, Metric { value, dim });
}

/// Dimension of a run-summary key from its unit suffix (`apogee_m`,
/// `max_velocity_ms`, `max_accel_ms2`, `time_to_apogee_s`, ...).
fn sim_dim(key: &str) -> DimKind {
    if key.ends_with("_ms2") {
        DimKind::Acceleration
    } else if key.ends_with("_ms") {
        DimKind::Velocity
    } else if key.ends_with("_m") {
        DimKind::Length
    } else if key.ends_with("_s") {
        DimKind::Time
    } else {
        DimKind::Dimensionless
    }
}

/// Every metric path of `report` (no aliases).
/// cite: n/a flattening of computed report values
pub fn metric_map(report: &CheckReport) -> BTreeMap<String, Metric> {
    use DimKind::{Angle, Dimensionless, Impulse, Inertia, Length, Mass, Time};
    let mut m = BTreeMap::new();
    let d = &report.dims;
    put(&mut m, "dims.length".into(), d.length, Length);
    put(&mut m, "dims.max_diameter".into(), d.max_diameter, Length);
    if let Some(s) = d.fin_span {
        put(&mut m, "dims.fin_span".into(), s, Length);
    }
    if let Some(v) = d.length_cal {
        put(&mut m, "dims.length_cal".into(), v, Dimensionless);
    }
    if let Some(v) = d.fineness {
        put(&mut m, "dims.fineness".into(), v, Dimensionless);
    }
    for c in &d.components {
        let p = format!("dims.components.{}", c.component);
        put(&mut m, format!("{p}.x_fore"), c.x_fore, Length);
        put(&mut m, format!("{p}.x_aft"), c.x_aft, Length);
        put(&mut m, format!("{p}.length"), c.length, Length);
        if let Some(v) = c.od {
            put(&mut m, format!("{p}.od"), v, Length);
        }
        if let Some(v) = c.id {
            put(&mut m, format!("{p}.id"), v, Length);
        }
    }
    let ms = &report.mass;
    for (k, v, dim) in [
        ("dry", ms.dry, Mass),
        ("liftoff", ms.liftoff, Mass),
        ("burnout", ms.burnout, Mass),
        ("propellant", ms.propellant, Mass),
        ("cg", ms.cg, Length),
        ("cg_burnout", ms.cg_burnout, Length),
        ("ixx", ms.ixx, Inertia),
        ("iyy", ms.iyy, Inertia),
    ] {
        put(&mut m, format!("mass.{k}"), v, dim);
    }
    for c in &ms.components {
        put(
            &mut m,
            format!("mass.components.{}.mass", c.component),
            c.mass,
            Mass,
        );
        put(
            &mut m,
            format!("mass.components.{}.cg", c.component),
            c.cg,
            Length,
        );
    }
    let a = &report.aero;
    put(&mut m, "aero.cp".into(), a.cp, Length);
    put(&mut m, "aero.cna".into(), a.cna, Dimensionless);
    put(&mut m, "aero.mach".into(), a.mach, Dimensionless);
    put(&mut m, "aero.alpha".into(), a.alpha, Angle);
    put(&mut m, "aero.cd".into(), a.cd, Dimensionless);
    for t in &a.terms {
        put(
            &mut m,
            format!("aero.terms.{}.cna", t.component),
            t.cna,
            Dimensionless,
        );
        put(
            &mut m,
            format!("aero.terms.{}.cp", t.component),
            t.cp,
            Length,
        );
    }
    let s = &report.stability;
    for (k, v) in [
        ("liftoff", s.liftoff),
        ("burnout", s.burnout),
        ("min", s.min),
        ("liftoff_pct_length", s.liftoff_pct_length),
    ] {
        put(&mut m, format!("stability.{k}"), v, Dimensionless);
    }
    put(
        &mut m,
        "stability.ref_diameter".into(),
        s.ref_diameter,
        Length,
    );
    for r in &report.motor {
        let p = format!("motor.{}", r.mount);
        put(
            &mut m,
            format!("{p}.total_impulse"),
            r.total_impulse,
            Impulse,
        );
        put(&mut m, format!("{p}.burn_time"), r.burn_time, Time);
        put(
            &mut m,
            format!("{p}.thrust_to_weight"),
            r.thrust_to_weight,
            Dimensionless,
        );
    }
    for c in &report.clearance {
        let rule = serde_json::to_value(c.rule)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let mut p = format!("clearance.{rule}.{}", c.a);
        if let Some(b) = &c.b {
            p = format!("{p}.{b}");
        }
        put(&mut m, format!("{p}.required"), c.required, c.dim);
        put(&mut m, format!("{p}.actual"), c.actual, c.dim);
    }
    if let Some(sim) = &report.sim
        && let Ok(Value::Object(o)) = serde_json::to_value(sim)
    {
        for (k, v) in o {
            if let Some(x) = v.as_f64() {
                put(&mut m, format!("sim.{k}"), x, sim_dim(&k));
            }
        }
    }
    m
}

/// [`metric_map`] plus the short names `[[assert]]` accepts: `cg`, `cp`,
/// `length`, `diameter`, `motor.thrust_to_weight` (the smallest over the
/// motors), `motor_fit` (1 when every motor fits), and the bare run-summary
/// keys (`apogee_m`) when a quick sim ran.
/// cite: n/a aliases of computed report values
pub fn assert_scope(report: &CheckReport) -> BTreeMap<String, Metric> {
    let mut m = metric_map(report);
    let alias = |m: &mut BTreeMap<String, Metric>, short: &str, long: &str| {
        if let Some(v) = m.get(long).copied() {
            m.insert(short.to_string(), v);
        }
    };
    alias(&mut m, "cg", "mass.cg");
    alias(&mut m, "cp", "aero.cp");
    alias(&mut m, "length", "dims.length");
    alias(&mut m, "diameter", "dims.max_diameter");
    alias(&mut m, "length_cal", "dims.length_cal");
    alias(&mut m, "fineness", "dims.fineness");
    if let Some(tw) = report
        .motor
        .iter()
        .map(|r| r.thrust_to_weight)
        .reduce(f64::min)
    {
        put(
            &mut m,
            "motor.thrust_to_weight".into(),
            tw,
            DimKind::Dimensionless,
        );
    }
    let fit = report.motor.iter().all(|r| r.fits_mount);
    put(
        &mut m,
        "motor_fit".into(),
        if fit { 1.0 } else { 0.0 },
        DimKind::Dimensionless,
    );
    let sims: Vec<(String, Metric)> = m
        .iter()
        .filter_map(|(k, v)| k.strip_prefix("sim.").map(|s| (s.to_string(), *v)))
        .collect();
    m.extend(sims);
    m
}
