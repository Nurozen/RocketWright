//! Simulation definitions (`sims/<id>.rw.toml`): the configuration to fly
//! and the launch and environment [`Conditions`] (rail, site, atmosphere,
//! wind, gravity model, launch into wind, integrator), shared verbatim with
//! `SimInput`, the run manifest, and the oracle golden (M1.44c).

use std::collections::BTreeMap;

use serde_json::Value;

use rw_units::{QAngle, QLength};

use crate::diag::{self, Diagnostic};
use crate::eval::{
    DEFAULT_ATOL, DEFAULT_BASE_PRESSURE, DEFAULT_BASE_TEMPERATURE, DEFAULT_DT, DEFAULT_MAX_TIME,
    DEFAULT_RAIL_LENGTH, DEFAULT_RTOL,
};
use crate::shape::Fields;
use crate::types::{
    AtmosphereModel, AttitudeSource, Conditions, EvalConfig, EvalEngine, EvalSim, EvalVisualFlow,
    FeedNodeKind, Geodetic, GravityModel, GravitySpec, IntegratorKind, SimDoc, SimKind,
};

/// Visual flow study defaults (D10c): a 10 s study rocking about 50 deg
/// from vertical by ±10 deg every 4 s.
pub const VISUAL_DEFAULT_DURATION: f64 = 10.0;
pub const VISUAL_DEFAULT_TILT_DEG: f64 = 50.0;
pub const VISUAL_DEFAULT_SWING_DEG: f64 = 10.0;
pub const VISUAL_DEFAULT_PERIOD: f64 = 4.0;

/// Degrees from radians, rounded to 1e-9 deg so a value written in degrees
/// round-trips exactly (`"28.61 deg"` → 28.61, not 28.610000000000003);
/// the conditions hash compares these values bit for bit with the oracle's.
fn deg(rad: f64) -> f64 {
    let d = rad.to_degrees();
    let r = (d * 1e9).round() / 1e9;
    if r.is_finite() { r } else { d }
}

/// Range checks on the evaluated conditions; `field` paths are under `/sims/<id>/`.
struct Ranges<'a> {
    base: &'a str,
    out: Vec<Diagnostic>,
}

impl Ranges<'_> {
    fn require(&mut self, ok: bool, field: &str, msg: String, hint: &str) {
        if !ok {
            self.out.push(
                Diagnostic::new(
                    diag::E_SIM_CONDITIONS,
                    format!("{}/{field}", self.base),
                    msg,
                )
                .with_hint(hint.to_string()),
            );
        }
    }
}

fn check_ranges(base: &str, s: &EvalSim) -> Vec<Diagnostic> {
    let c = &s.conditions;
    let mut r = Ranges {
        base,
        out: Vec::new(),
    };
    r.require(
        c.rail_length_m > 0.0,
        "launch/rail_length",
        format!("rail length must be positive (is {} m)", c.rail_length_m),
        "use the launch rail or rod length, e.g. \"1 m\"",
    );
    r.require(
        (0.0..90.0).contains(&c.rod_angle_deg),
        "launch/rod_angle",
        format!(
            "rod angle must be at least 0 deg and below 90 deg (is {} deg)",
            c.rod_angle_deg
        ),
        "give the tilt from vertical, e.g. \"5 deg\"",
    );
    r.require(
        (-90.0..=90.0).contains(&c.latitude_deg),
        "launch/latitude",
        format!(
            "latitude must be within ±90 deg (is {} deg)",
            c.latitude_deg
        ),
        "use a latitude between -90 deg and 90 deg",
    );
    r.require(
        (-180.0..=180.0).contains(&c.longitude_deg),
        "launch/longitude",
        format!(
            "longitude must be within ±180 deg (is {} deg)",
            c.longitude_deg
        ),
        "use a longitude between -180 deg and 180 deg",
    );
    r.require(
        c.base_temperature_k > 0.0,
        "atmosphere/base_temperature",
        format!(
            "base temperature must be above absolute zero (is {} K)",
            c.base_temperature_k
        ),
        "e.g. \"15 degC\"",
    );
    r.require(
        c.base_pressure_pa > 0.0,
        "atmosphere/base_pressure",
        format!(
            "base pressure must be positive (is {} Pa)",
            c.base_pressure_pa
        ),
        "e.g. \"1013.25 hPa\"",
    );
    r.require(
        c.wind_speed_ms >= 0.0,
        "wind/speed",
        format!(
            "wind speed must not be negative (is {} m/s)",
            c.wind_speed_ms
        ),
        "give the speed and set `direction` for where it blows from",
    );
    r.require(
        c.wind_turbulence >= 0.0,
        "wind/turbulence",
        format!(
            "turbulence intensity must not be negative (is {})",
            c.wind_turbulence
        ),
        "use a fraction, e.g. 0.1",
    );
    if let Some(GravityModel::Constant { g_ms2 }) = c.gravity {
        r.require(
            g_ms2 > 0.0,
            "gravity/g",
            format!("constant gravity must be positive, down (is {g_ms2} m/s^2)"),
            "e.g. `g = \"9.80665 m/s^2\"`",
        );
    }
    r.require(
        c.time_step_s > 0.0,
        "integrator/dt",
        format!("the time step must be positive (is {} s)", c.time_step_s),
        "e.g. `dt = \"0.01 s\"`",
    );
    r.require(
        s.max_time > 0.0,
        "integrator/max_time",
        format!("the time limit must be positive (is {} s)", s.max_time),
        "e.g. `max_time = \"600 s\"`",
    );
    r.require(
        s.rtol > 0.0,
        "integrator/rtol",
        format!("rtol must be positive (is {})", s.rtol),
        "e.g. `rtol = 1e-6`",
    );
    r.require(
        s.atol > 0.0,
        "integrator/atol",
        format!("atol must be positive (is {})", s.atol),
        "e.g. `atol = 1e-9`",
    );
    r.require(
        s.series_dt > 0.0,
        "series_dt",
        format!("the series grid must be positive (is {} s)", s.series_dt),
        "e.g. `series_dt = \"0.01 s\"`",
    );
    if let Some(v) = &s.visual_flow {
        visual_ranges(base, v, &mut r.out);
    }
    r.out
}

/// Range checks on an evaluated `[visual_flow]` (RW-E068).
fn visual_ranges(base: &str, v: &EvalVisualFlow, out: &mut Vec<Diagnostic>) {
    let mut bad = |ok: bool, field: &str, msg: String, hint: &str| {
        if !ok {
            out.push(
                Diagnostic::new(
                    diag::E_VISUAL_FLOW,
                    format!("{base}/visual_flow/{field}"),
                    msg,
                )
                .with_hint(hint.to_string()),
            );
        }
    };
    bad(
        v.duration > 0.0,
        "duration",
        format!("the study duration must be positive (is {} s)", v.duration),
        "e.g. `duration = \"10 s\"`",
    );
    bad(
        v.period > 0.0,
        "period",
        format!("the swing period must be positive (is {} s)", v.period),
        "e.g. `period = \"4 s\"`",
    );
    bad(
        (0.0..=90.0).contains(&v.tilt_deg),
        "tilt",
        format!(
            "the mean tilt must be within 0..90 deg (is {} deg)",
            v.tilt_deg
        ),
        "the tilt from vertical, e.g. \"50 deg\"",
    );
    bad(
        v.swing_deg >= 0.0 && v.tilt_deg + v.swing_deg <= 90.0 && v.tilt_deg - v.swing_deg >= -90.0,
        "swing",
        format!(
            "the swing must be non-negative and keep the tilt within ±90 deg (tilt {} deg, swing {} deg)",
            v.tilt_deg, v.swing_deg
        ),
        "e.g. `swing = \"10 deg\"`",
    );
}

/// Evaluates `[visual_flow]` (SI, defaults applied).
fn eval_visual(base: &str, s: &SimDoc, f: &mut Fields) -> Option<EvalVisualFlow> {
    let v = s.visual_flow.as_ref()?;
    let p = |k: &str| format!("{base}/visual_flow/{k}");
    let duration = v
        .duration
        .as_ref()
        .map_or(VISUAL_DEFAULT_DURATION, |q| f.q(q, None, &p("duration")));
    let period = v
        .period
        .as_ref()
        .map_or(VISUAL_DEFAULT_PERIOD, |q| f.q(q, None, &p("period")));
    let tilt = v
        .tilt
        .as_ref()
        .map_or(VISUAL_DEFAULT_TILT_DEG, |q| deg(f.q(q, None, &p("tilt"))));
    let swing = v
        .swing
        .as_ref()
        .map_or(VISUAL_DEFAULT_SWING_DEG, |q| deg(f.q(q, None, &p("swing"))));
    Some(EvalVisualFlow {
        engine: v.engine.clone(),
        tank: v.tank.clone(),
        attitude: v.attitude,
        duration,
        tilt_deg: tilt,
        swing_deg: swing,
        period,
        replay: v.replay.clone(),
    })
}

/// Cross-reference checks on visual flow studies (RW-E068): the kind and
/// the `[visual_flow]` table agree, the engine and tank exist, and a `run`
/// attitude replays a flight sim.
pub(crate) fn check_visual_refs(
    sims: &BTreeMap<String, EvalSim>,
    engines: &BTreeMap<String, EvalEngine>,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (sid, s) in sims {
        let base = format!("/sims/{sid}");
        let d = |field: &str, msg: String, hint: String| {
            Diagnostic::new(diag::E_VISUAL_FLOW, format!("{base}{field}"), msg).with_hint(hint)
        };
        match (s.kind, &s.visual_flow) {
            (SimKind::Flight, None) => {}
            (SimKind::Flight, Some(_)) => out.push(d(
                "/visual_flow",
                format!("sim `{sid}` is a flight but has a `[visual_flow]` table"),
                "set `kind = \"visual_flow\"`, or remove the table".into(),
            )),
            (SimKind::VisualFlow, None) => out.push(d(
                "/kind",
                format!("visual flow study `{sid}` has no `[visual_flow]` table"),
                "add `[visual_flow]` with `engine` and `attitude = \"scripted_tilt\"`".into(),
            )),
            (SimKind::VisualFlow, Some(v)) => {
                let listing = || engines.keys().cloned().collect::<Vec<_>>().join(", ");
                match engines.get(&v.engine) {
                    None => out.push(d(
                        "/visual_flow/engine",
                        format!(
                            "study `{sid}` names engine `{}`, which does not exist",
                            v.engine
                        ),
                        format!("engines: {}", listing()),
                    )),
                    Some(e) => {
                        if let Some(t) = &v.tank
                            && !e.nodes.get(t).is_some_and(|n| n.kind == FeedNodeKind::Tank)
                        {
                            let tanks: Vec<&str> = e
                                .nodes
                                .iter()
                                .filter(|(_, n)| n.kind == FeedNodeKind::Tank)
                                .map(|(k, _)| k.as_str())
                                .collect();
                            out.push(d(
                                "/visual_flow/tank",
                                format!("engine `{}` has no tank node `{t}`", e.id),
                                format!("tanks: {}", tanks.join(", ")),
                            ));
                        }
                    }
                }
                match (v.attitude, &v.replay) {
                    (AttitudeSource::Run, None) => out.push(d(
                        "/visual_flow/replay",
                        format!("study `{sid}` replays a run but names no flight sim"),
                        "set `replay = \"<flight sim id>\"`".into(),
                    )),
                    (AttitudeSource::Run, Some(r))
                        if !sims.get(r).is_some_and(|x| x.kind == SimKind::Flight) =>
                    {
                        out.push(d(
                            "/visual_flow/replay",
                            format!("study `{sid}` replays `{r}`, which is not a flight sim"),
                            format!(
                                "flight sims: {}",
                                sims.values()
                                    .filter(|x| x.kind == SimKind::Flight)
                                    .map(|x| x.id.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Evaluates one simulation definition.
fn eval_sim(sid: &str, s: &SimDoc, f: &mut Fields) -> EvalSim {
    let base = format!("/sims/{sid}");
    let mut q_len = |q: Option<&QLength>, k: &str, d: f64| {
        q.map_or(d, |q| f.q(q, None, &format!("{base}/{k}")))
    };
    let l = s.launch.as_ref();
    let rail = q_len(
        l.map(|l| &l.rail_length),
        "launch/rail_length",
        DEFAULT_RAIL_LENGTH,
    );
    let alt = q_len(l.and_then(|l| l.altitude.as_ref()), "launch/altitude", 0.0);
    let mut q_ang =
        |q: Option<&QAngle>, k: &str| q.map_or(0.0, |q| deg(f.q(q, None, &format!("{base}/{k}"))));
    let rod_angle = q_ang(l.and_then(|l| l.rod_angle.as_ref()), "launch/rod_angle");
    let rod_dir = q_ang(
        l.and_then(|l| l.rod_direction.as_ref()),
        "launch/rod_direction",
    );
    let lat = q_ang(l.and_then(|l| l.latitude.as_ref()), "launch/latitude");
    let lon = q_ang(l.and_then(|l| l.longitude.as_ref()), "launch/longitude");
    let w = s.wind.as_ref();
    let wind_dir = q_ang(w.and_then(|w| w.direction.as_ref()), "wind/direction");
    let a = s.atmosphere.as_ref();
    let base_t = a
        .and_then(|a| a.base_temperature.as_ref())
        .map_or(DEFAULT_BASE_TEMPERATURE, |q| {
            f.q(q, None, &format!("{base}/atmosphere/base_temperature"))
        });
    let base_p = a
        .and_then(|a| a.base_pressure.as_ref())
        .map_or(DEFAULT_BASE_PRESSURE, |q| {
            f.q(q, None, &format!("{base}/atmosphere/base_pressure"))
        });
    let wind_speed = w.map_or(0.0, |w| f.q(&w.speed, None, &format!("{base}/wind/speed")));
    let turb = w
        .and_then(|w| w.turbulence.as_ref())
        .map_or(0.0, |q| f.q(q, None, &format!("{base}/wind/turbulence")));
    let i = s.integrator.as_ref();
    let dt = i.and_then(|i| i.dt.as_ref()).map_or(DEFAULT_DT, |q| {
        f.q(q, None, &format!("{base}/integrator/dt"))
    });
    let max_time = i
        .and_then(|i| i.max_time.as_ref())
        .map_or(DEFAULT_MAX_TIME, |q| {
            f.q(q, None, &format!("{base}/integrator/max_time"))
        });
    let series_dt = s
        .series_dt
        .as_ref()
        .map_or(DEFAULT_DT, |q| f.q(q, None, &format!("{base}/series_dt")));
    // Absent gravity and launch-into-wind stay absent, so a sim that does not
    // set them hashes like the M1.5 contract (engine defaults apply).
    let gravity = s.gravity.as_ref().map(|g| match g {
        GravitySpec::Wgs84 => GravityModel::Wgs84,
        GravitySpec::Constant { g } => GravityModel::Constant {
            g_ms2: f.q(g, None, &format!("{base}/gravity/g")),
        },
    });
    EvalSim {
        id: sid.to_string(),
        name: s.name.clone().unwrap_or_else(|| sid.to_string()),
        kind: s.kind,
        config: s.config.clone(),
        conditions: Conditions {
            rail_length_m: rail,
            rod_angle_deg: rod_angle,
            rod_direction_deg: rod_dir,
            site_altitude_m: alt,
            latitude_deg: lat,
            longitude_deg: lon,
            base_temperature_k: base_t,
            base_pressure_pa: base_p,
            atmosphere: a.map_or(AtmosphereModel::Ussa1976, |a| a.model),
            geodetic: l.and_then(|l| l.geodetic).unwrap_or(Geodetic::Flat),
            wind_speed_ms: wind_speed,
            wind_direction_deg: wind_dir,
            wind_turbulence: turb,
            time_step_s: dt,
            integrator: i.map_or(IntegratorKind::Dp54, |i| i.method),
            gravity,
            launch_into_wind: s.launch_into_wind,
        },
        series_dt,
        max_time,
        rtol: i.and_then(|i| i.rtol).unwrap_or(DEFAULT_RTOL),
        atol: i.and_then(|i| i.atol).unwrap_or(DEFAULT_ATOL),
        seed: s.seed.unwrap_or(0),
        visual_flow: eval_visual(&base, s, f),
    }
}

/// Evaluates every simulation; each must name an existing configuration.
pub(crate) fn eval_sims(
    value: &Value,
    configs: &BTreeMap<String, EvalConfig>,
    f: &mut Fields,
    diags: &mut Vec<Diagnostic>,
) -> BTreeMap<String, EvalSim> {
    let docs: BTreeMap<String, SimDoc> = crate::eval::typed_map(value, "sims", diags);
    let mut sims = BTreeMap::new();
    for (sid, s) in &docs {
        let base = format!("/sims/{sid}");
        if !configs.contains_key(&s.config) {
            f.diags.push(
                Diagnostic::new(
                    diag::E_SIM_CONFIG,
                    format!("{base}/config"),
                    format!(
                        "sim `{sid}` uses config `{}`, which does not exist",
                        s.config
                    ),
                )
                .with_hint(format!(
                    "configs: {}",
                    configs.keys().cloned().collect::<Vec<_>>().join(", ")
                )),
            );
        }
        let before: Vec<String> = f.diags.iter().filter_map(|d| d.path.clone()).collect();
        let sim = eval_sim(sid, s, f);
        // Fields that failed to evaluate already have a diagnostic.
        let failed: Vec<String> = f
            .diags
            .iter()
            .filter_map(|d| d.path.clone())
            .filter(|p| !before.contains(p))
            .collect();
        f.diags.extend(
            check_ranges(&base, &sim)
                .into_iter()
                .filter(|d| d.path.as_ref().is_none_or(|p| !failed.contains(p))),
        );
        sims.insert(sid.clone(), sim);
    }
    sims
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::{AtmosphereModel, Geodetic, GravityModel, IntegratorKind};

    const ROCKET: &str = r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
"#;

    fn sim(text: &str) -> crate::types::EvaluatedModel {
        project(&[
            ("rocket.rw.toml", ROCKET),
            ("configs/base.rw.toml", "name = \"Base\"\n"),
            ("sims/s.rw.toml", text),
        ])
    }

    #[test]
    fn degrees_round_trip_exactly() {
        let m = sim(r#"config = "base"
[launch]
rail_length = "1 m"
latitude = "28.61 deg"
longitude = "-80.6 deg"
rod_angle = "0.5 deg"
"#);
        let c = &m.sims["s"].conditions;
        assert_eq!(c.latitude_deg, 28.61);
        assert_eq!(c.longitude_deg, -80.6);
        assert_eq!(c.rod_angle_deg, 0.5);
    }

    #[test]
    fn case1_conditions_from_the_golden() {
        let m = sim(r#"name = "Simulation 5"
config = "base"
[launch]
rail_length = "1 m"
rod_angle = "0 deg"
rod_direction = "90 deg"
altitude = "0 m"
latitude = "45 deg"
longitude = "0 deg"
geodetic = "flat"
[atmosphere]
model = "ussa1976"
base_temperature = "288.15 K"
base_pressure = "101325 Pa"
[wind]
speed = "0 m/s"
direction = "90 deg"
turbulence = 0
[integrator]
method = "rk4"
dt = "0.05 s"
"#);
        assert_clean(&m);
        let c = &m.sims["s"].conditions;
        let json = serde_json::to_value(c).unwrap();
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../../../tests/oracle/case1.geometry.json"))
                .unwrap();
        let want = &golden["sims"][0]["conditions"];
        for (k, v) in want.as_object().unwrap() {
            let got = &json[k];
            match (got.as_f64(), v.as_f64()) {
                (Some(a), Some(b)) => assert!((a - b).abs() < 1e-9, "{k}: {a} vs {b}"),
                _ => assert_eq!(got, v, "{k}"),
            }
        }
        // No gravity or launch-into-wind given: both absent (hash-compatible).
        assert_eq!(
            json.as_object().unwrap().len(),
            want.as_object().unwrap().len()
        );
        assert_eq!(c.atmosphere, AtmosphereModel::Ussa1976);
        assert_eq!(c.geodetic, Geodetic::Flat);
        assert_eq!(c.integrator, IntegratorKind::Rk4);
    }

    #[test]
    fn gravity_model_and_launch_into_wind() {
        let m = sim(r#"config = "base"
gravity = { model = "constant", g = "9.80665 m/s^2" }
launch_into_wind = true
[wind]
speed = "4 m/s"
direction = "270 deg"
"#);
        assert_clean(&m);
        let c = &m.sims["s"].conditions;
        assert_eq!(c.gravity, Some(GravityModel::Constant { g_ms2: 9.80665 }));
        assert_eq!(c.launch_into_wind, Some(true));
        let json = serde_json::to_value(c).unwrap();
        assert_eq!(
            json["gravity"],
            serde_json::json!({"model": "constant", "g_ms2": 9.80665})
        );

        let m = sim("config = \"base\"\ngravity = { model = \"wgs84\" }\n");
        assert_eq!(m.sims["s"].conditions.gravity, Some(GravityModel::Wgs84));
        assert_eq!(m.sims["s"].conditions.launch_into_wind, None);
        // Defaults: dp54, the default rail.
        let s = &m.sims["s"];
        assert_eq!(s.conditions.integrator, IntegratorKind::Dp54);
        assert_eq!(s.conditions.rail_length_m, 1.0);
    }

    #[test]
    fn condition_ranges() {
        let m = sim(r#"config = "base"
gravity = { model = "constant", g = "0 m/s^2" }
series_dt = "0 s"
[launch]
rail_length = "0 m"
rod_angle = "95 deg"
latitude = "100 deg"
[atmosphere]
model = "isa_custom"
base_pressure = "0 Pa"
[wind]
speed = "-1 m/s"
[integrator]
method = "dp54"
dt = "0 s"
rtol = 0
"#);
        for f in [
            "launch/rail_length",
            "launch/rod_angle",
            "launch/latitude",
            "atmosphere/base_pressure",
            "wind/speed",
            "gravity/g",
            "integrator/dt",
            "integrator/rtol",
            "series_dt",
        ] {
            assert_diag(&m, "RW-E067", &format!("/sims/s/{f}"));
        }
    }

    #[test]
    fn visual_flow_defaults_and_flight_hash_compat() {
        let m = sim(r#"config = "base"
kind = "visual_flow"
[visual_flow]
engine = "nope"
attitude = "scripted_tilt"
"#);
        let v = m.sims["s"].visual_flow.as_ref().expect("evaluated");
        assert_eq!(v.duration, super::VISUAL_DEFAULT_DURATION);
        assert_eq!(v.tilt_deg, super::VISUAL_DEFAULT_TILT_DEG);
        assert_eq!(v.swing_deg, super::VISUAL_DEFAULT_SWING_DEG);
        assert_eq!(v.period, super::VISUAL_DEFAULT_PERIOD);
        assert_diag(&m, "RW-E068", "/sims/s/visual_flow/engine");
        // A flight has no `visual_flow` key in its evaluated JSON (hashes unchanged).
        let m = sim("config = \"base\"\n");
        let json = serde_json::to_value(&m.sims["s"]).unwrap();
        assert!(json.get("visual_flow").is_none());
    }

    #[test]
    fn visual_flow_values_and_rules() {
        let m = sim(r#"config = "base"
kind = "visual_flow"
[visual_flow]
engine = "e"
attitude = "scripted_tilt"
duration = "0 s"
period = "-1 s"
tilt = "95 deg"
swing = "-1 deg"
"#);
        for f in ["duration", "period", "tilt", "swing"] {
            assert_diag(&m, "RW-E068", &format!("/sims/s/visual_flow/{f}"));
        }
        let m = sim("config = \"base\"\nkind = \"visual_flow\"\n");
        assert_diag(&m, "RW-E068", "/sims/s/kind");
        let m =
            sim("config = \"base\"\n[visual_flow]\nengine = \"e\"\nattitude = \"scripted_tilt\"\n");
        assert_diag(&m, "RW-E068", "/sims/s/visual_flow");
        let m = sim(
            "config = \"base\"\nkind = \"visual_flow\"\n[visual_flow]\nengine = \"e\"\nattitude = \"run\"\n",
        );
        assert_diag(&m, "RW-E068", "/sims/s/visual_flow/replay");
        let m = sim(
            "config = \"base\"\nkind = \"visual_flow\"\n[visual_flow]\nengine = \"e\"\nattitude = \"run\"\nreplay = \"s\"\ntilt = \"30 deg\"\n",
        );
        assert_diag(&m, "RW-E068", "/sims/s/visual_flow/replay");
        assert_eq!(m.sims["s"].visual_flow.as_ref().unwrap().tilt_deg, 30.0);
    }
}
