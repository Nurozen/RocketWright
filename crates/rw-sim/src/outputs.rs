//! Run outputs (R4.8): the IF6 `RunSummary` and `Series` of a flight, and the
//! map from OpenRocket's summary and event names (the oracle golden keys,
//! spec B2 key map, `tests/oracle/keymap.json`) to ours.

use rw_model::SchemaTag;

use crate::flight::{Flight, Mode, Sample};
use crate::models::norm;
use crate::{
    DeploymentTiming, EjectionTiming, EventKind, FlightEvent, RunSummary, SERIES_COLUMNS, Series,
    SeriesColumn,
};

/// Oracle summary key → `RunSummary` key (spec B2 key map, S:177).
pub const OR_SUMMARY_KEYS: &[(&str, &str)] = &[
    ("max_altitude_m", "apogee_m"),
    ("max_velocity_ms", "max_velocity_ms"),
    ("max_accel_ms2", "max_accel_ms2"),
    ("max_mach", "max_mach"),
    ("time_to_apogee_s", "time_to_apogee_s"),
    ("flight_time_s", "flight_time_s"),
    ("ground_hit_velocity_ms", "landing_velocity_ms"),
    ("rod_clear_velocity_ms", "rail_exit_velocity_ms"),
    ("deployment_velocity_ms", "deployment_velocity_ms"),
    ("optimum_delay_s", "optimum_delay_s"),
];

/// The oracle golden's event name for one of our event kinds (as the oracle
/// exports them), or `None` for kinds the case-1 golden does not carry.
///
/// cite: n/a name mapping, no physics
pub fn or_event_name(kind: EventKind) -> Option<&'static str> {
    Some(match kind {
        EventKind::Ignition => "ignition",
        EventKind::Liftoff => "liftoff",
        EventKind::RailExit => "launch_rod_clearance",
        EventKind::Burnout => "burnout",
        EventKind::Apogee => "apogee",
        EventKind::Ejection => "ejection_charge",
        EventKind::Deployment => "recovery_device_deployment",
        EventKind::Landing => "ground_hit",
        EventKind::StageSeparation | EventKind::Tumble => return None,
    })
}

/// A `RunSummary` value by its key (`None` for an absent optional value or
/// an unknown key).
///
/// cite: n/a field lookup, no physics
pub fn summary_value(s: &RunSummary, key: &str) -> Option<f64> {
    Some(match key {
        "apogee_m" => s.apogee_m,
        "max_velocity_ms" => s.max_velocity_ms,
        "max_accel_ms2" => s.max_accel_ms2,
        "max_mach" => s.max_mach,
        "time_to_apogee_s" => s.time_to_apogee_s,
        "flight_time_s" => s.flight_time_s,
        "landing_velocity_ms" => s.landing_velocity_ms,
        "rail_exit_velocity_ms" => s.rail_exit_velocity_ms,
        "deployment_velocity_ms" => return s.deployment_velocity_ms,
        "optimum_delay_s" => return s.optimum_delay_s,
        "min_stability_cal" => s.min_stability_cal,
        "burnout_time_s" => s.burnout_time_s,
        "burnout_altitude_m" => s.burnout_altitude_m,
        "landing_x_m" => s.landing_x_m,
        "landing_y_m" => s.landing_y_m,
        "drift_m" => s.drift_m,
        "coast_time_s" => return s.coast_time_s,
        _ => return None,
    })
}

fn first(events: &[FlightEvent], kind: EventKind) -> Option<&FlightEvent> {
    events.iter().find(|e| e.kind == kind)
}

/// The R4.8 summary of a flight. Apogee is the located apogee event (the
/// highest sample when none was found); maxima run over the samples (grid
/// plus exact event rows); optimum delay = apogee − burnout; the minimum
/// stability runs over rail exit to apogee. Derived timing: coast time =
/// apogee − last burnout; per deployment, its time minus the apogee time;
/// per motor ejection, its configured delay minus its optimum delay (apogee
/// − that motor's burnout).
///
/// cite: n/a reduction of the flight record, no physics
pub fn summary(f: &Flight) -> RunSummary {
    let s = &f.samples;
    let ev = &f.events;
    let (t_apo, z_apo) = match first(ev, EventKind::Apogee) {
        Some(e) => (e.t, e.altitude),
        None => s
            .iter()
            .map(|x| (x.t, x.pos[2]))
            .fold(
                (0.0, f64::NEG_INFINITY),
                |a, b| if b.1 > a.1 { b } else { a },
            ),
    };
    let max_of = |g: &dyn Fn(&Sample) -> f64| s.iter().map(g).fold(0.0, f64::max);
    let t_exit = first(ev, EventKind::RailExit).map_or(0.0, |e| e.t);
    let min_stability = s
        .iter()
        .filter(|x| x.mode != Mode::Descent && x.t >= t_exit && x.t <= t_apo)
        .filter_map(|x| x.stability)
        .fold(f64::INFINITY, f64::min);
    // The last burnout (the top stage's, in a staged flight).
    let burn = ev.iter().rev().find(|e| e.kind == EventKind::Burnout);
    let last = s.last();
    let landing = first(ev, EventKind::Landing);
    let (lx, ly) = last.map_or((0.0, 0.0), |x| (x.pos[0], x.pos[1]));
    RunSummary {
        schema: SchemaTag,
        apogee_m: z_apo,
        max_velocity_ms: max_of(&|x| x.speed),
        max_accel_ms2: max_of(&|x| norm(x.acc)),
        max_mach: max_of(&|x| x.mach),
        time_to_apogee_s: t_apo,
        flight_time_s: landing.map_or(last.map_or(0.0, |x| x.t), |e| e.t),
        landing_velocity_ms: landing.map_or(0.0, |e| e.velocity),
        rail_exit_velocity_ms: first(ev, EventKind::RailExit).map_or(0.0, |e| e.velocity),
        // The last deployment (the main of a dual deploy), as the oracle reports it.
        deployment_velocity_ms: ev
            .iter()
            .rev()
            .find(|e| e.kind == EventKind::Deployment)
            .map(|e| e.velocity),
        optimum_delay_s: burn.filter(|b| b.t <= t_apo).map(|b| t_apo - b.t),
        min_stability_cal: if min_stability.is_finite() {
            min_stability
        } else {
            0.0
        },
        burnout_time_s: burn.map_or(0.0, |e| e.t),
        burnout_altitude_m: burn.map_or(0.0, |e| e.altitude),
        landing_x_m: lx,
        landing_y_m: ly,
        drift_m: lx.hypot(ly),
        coast_time_s: burn.filter(|b| b.t <= t_apo).map(|b| t_apo - b.t),
        deployments: ev
            .iter()
            .filter(|e| e.kind == EventKind::Deployment && e.branch.is_none())
            .map(|e| DeploymentTiming {
                source: e.source.clone(),
                t_s: e.t,
                deploy_minus_apogee_s: e.t - t_apo,
                deploy_altitude_m: e.altitude,
                deploy_velocity_ms: e.velocity,
            })
            .collect(),
        ejections: f
            .ejection_delays
            .iter()
            .map(|d| {
                let optimum = t_apo - d.burnout;
                EjectionTiming {
                    source: rw_model::RwRef(format!("rw:c/{}", d.mount)),
                    t_s: d.burnout + d.delay,
                    delay_s: d.delay,
                    optimum_delay_s: optimum,
                    delay_minus_optimum_s: d.delay - optimum,
                }
            })
            .collect(),
    }
}

/// The output series ([`SERIES_COLUMNS`]): one row per sample. CP and
/// stability are 0 in descent (no attitude is computed there).
///
/// cite: n/a tabulation of the flight record, no physics
pub fn series(f: &Flight, dt: f64) -> Series {
    let rows = f
        .samples
        .iter()
        .map(|x| {
            vec![
                x.t,
                x.pos[2],
                x.pos[0],
                x.pos[1],
                x.vel[2],
                x.speed,
                norm(x.acc),
                x.mach,
                x.aoa,
                x.stability.unwrap_or(0.0),
                x.thrust,
                x.mass,
                x.cg,
                x.cp.unwrap_or(0.0),
                x.cd,
            ]
        })
        .collect();
    Series {
        dt,
        columns: SERIES_COLUMNS
            .iter()
            .map(|&(name, dim)| SeriesColumn {
                name: name.to_string(),
                dim,
            })
            .collect(),
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keymap_matches_tests_oracle_keymap() {
        let v: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/keymap.json"
        )))
        .unwrap();
        let m = v["summary"].as_object().unwrap();
        assert_eq!(m.len(), OR_SUMMARY_KEYS.len());
        for (or, ours) in OR_SUMMARY_KEYS {
            assert_eq!(m[*or], *ours, "{or}");
        }
    }

    #[test]
    fn event_names_cover_the_golden() {
        let v: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/oracle/case1-generic.json"
        )))
        .unwrap();
        let names: Vec<&str> = v["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect();
        for k in [
            EventKind::Ignition,
            EventKind::Liftoff,
            EventKind::RailExit,
            EventKind::Burnout,
            EventKind::Apogee,
            EventKind::Ejection,
            EventKind::Deployment,
            EventKind::Landing,
        ] {
            assert!(names.contains(&or_event_name(k).unwrap()), "{k:?}");
        }
    }
}
