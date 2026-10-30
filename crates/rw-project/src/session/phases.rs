//! Phase rows of `run_diff` (B3 round 11, T5): the time, altitude, and speed
//! of each flight phase of the main flight (rail exit, burnout, apogee, the
//! last deployment, landing) on both sides, in time order, so where the gap
//! between two flights opens is a tool answer rather than an agent's
//! inference. Pure functions of the stored events or a golden's events.

use rw_api::{MetricDiffRow, OracleEvent, OracleEventKind};
use rw_sim::{EventKind, FlightEvent};

/// Phases in flight order.
pub const PHASES: &[&str] = &["rail_exit", "burnout", "apogee", "deployment", "landing"];

/// One phase's event: time after ignition, altitude, speed (SI).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhasePoint {
    pub t: f64,
    pub altitude: Option<f64>,
    pub velocity: Option<f64>,
}

/// Which event of a kind a phase takes: the first rail exit and apogee, the
/// last burnout at or before apogee (the summary's `burnout_time_s`), the
/// last deployment (the summary's `deployment_velocity_ms`), and the last
/// landing.
fn pick(
    points: &[(&'static str, PhasePoint)],
    phase: &str,
    apogee_t: Option<f64>,
) -> Option<PhasePoint> {
    let mut of = points.iter().filter(|(k, _)| *k == phase).map(|(_, p)| *p);
    match phase {
        "rail_exit" | "apogee" => of.next(),
        "burnout" => of.rfind(|p| apogee_t.is_none_or(|ta| p.t <= ta + 1e-9)),
        _ => of.next_back(),
    }
}

fn phases_of(points: &[(&'static str, PhasePoint)]) -> Vec<Option<PhasePoint>> {
    let apogee_t = points
        .iter()
        .find(|(k, _)| *k == "apogee")
        .map(|(_, p)| p.t);
    PHASES.iter().map(|ph| pick(points, ph, apogee_t)).collect()
}

/// The phases of our main flight's events.
pub fn run_phases(events: &[FlightEvent]) -> Vec<Option<PhasePoint>> {
    let points: Vec<(&'static str, PhasePoint)> = events
        .iter()
        .filter(|e| e.branch.is_none())
        .filter_map(|e| {
            let phase = match e.kind {
                EventKind::RailExit => "rail_exit",
                EventKind::Burnout => "burnout",
                EventKind::Apogee => "apogee",
                EventKind::Deployment => "deployment",
                EventKind::Landing => "landing",
                _ => return None,
            };
            Some((
                phase,
                PhasePoint {
                    t: e.t,
                    altitude: Some(e.altitude),
                    velocity: Some(e.velocity),
                },
            ))
        })
        .collect();
    phases_of(&points)
}

/// The phases of a golden's main-branch events.
pub fn golden_phases(events: &[OracleEvent]) -> Vec<Option<PhasePoint>> {
    let points: Vec<(&'static str, PhasePoint)> = events
        .iter()
        .filter(|e| e.branch.is_none())
        .filter_map(|e| {
            let phase = match e.kind {
                OracleEventKind::LaunchRodClearance => "rail_exit",
                OracleEventKind::Burnout => "burnout",
                OracleEventKind::Apogee => "apogee",
                OracleEventKind::RecoveryDeviceDeployment => "deployment",
                OracleEventKind::GroundHit => "landing",
                _ => return None,
            };
            Some((
                phase,
                PhasePoint {
                    t: e.t_s,
                    altitude: e.altitude_m,
                    velocity: e.velocity_ms,
                },
            ))
        })
        .collect();
    phases_of(&points)
}

/// Reads one value of a phase.
type PhaseField = fn(&PhasePoint) -> Option<f64>;

fn phase_row(key: String, a: Option<f64>, b: Option<f64>, unit: &str) -> MetricDiffRow {
    let delta = a.zip(b).map(|(a, b)| a - b);
    let delta_pct = b
        .zip(delta)
        .and_then(|(b, d)| (b != 0.0).then_some(100.0 * d / b));
    MetricDiffRow {
        key,
        a,
        b,
        delta,
        delta_pct,
        tol: None,
        pass: None,
        unit: Some(unit.to_string()),
    }
}

/// Rows `<phase>.t_s`, `<phase>.altitude_m`, `<phase>.velocity_ms` for each
/// phase either side has (in [`PHASES`] order; no landing altitude and no
/// apogee speed),
/// `a - b` and its percent of `b` like the summary rows, never gated. A value
/// neither side has is skipped.
pub fn phase_rows(a: &[Option<PhasePoint>], b: &[Option<PhasePoint>]) -> Vec<MetricDiffRow> {
    let mut rows = Vec::new();
    for (i, phase) in PHASES.iter().enumerate() {
        let (x, y) = (a.get(i).copied().flatten(), b.get(i).copied().flatten());
        if x.is_none() && y.is_none() {
            continue;
        }
        let fields: [(&str, &str, PhaseField); 3] = [
            ("t_s", "s", |p| Some(p.t)),
            ("altitude_m", "m", |p| p.altitude),
            ("velocity_ms", "m/s", |p| p.velocity),
        ];
        for (field, unit, get) in fields {
            // Landing is at ground level and apogee is where the climb
            // stops: those values are integration noise around 0.
            if (*phase == "landing" && field == "altitude_m")
                || (*phase == "apogee" && field == "velocity_ms")
            {
                continue;
            }
            let (va, vb) = (x.as_ref().and_then(get), y.as_ref().and_then(get));
            if va.is_some() || vb.is_some() {
                rows.push(phase_row(format!("{phase}.{field}"), va, vb, unit));
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(t: f64, kind: EventKind, alt: f64, v: f64, branch: Option<&str>) -> FlightEvent {
        FlightEvent {
            t,
            kind,
            altitude: alt,
            velocity: v,
            source: None,
            branch: branch.map(String::from),
        }
    }

    #[test]
    fn phases_pick_the_main_flight_events_in_time_order() {
        let ours = vec![
            ev(0.0, EventKind::Ignition, 0.0, 0.0, None),
            ev(0.17, EventKind::RailExit, 1.0, 18.3, None),
            ev(1.0, EventKind::Burnout, 50.0, 90.0, Some("booster")),
            ev(1.6, EventKind::Burnout, 110.0, 100.0, None),
            ev(7.7, EventKind::Apogee, 343.7, 2.0, None),
            ev(8.6, EventKind::Deployment, 340.0, 8.4, None),
            ev(90.1, EventKind::Landing, 0.0, 4.6, None),
        ];
        let golden: Vec<OracleEvent> = serde_json::from_value(serde_json::json!([
            {"kind": "launch_rod_clearance", "t_s": 0.172, "altitude_m": 1.01, "velocity_ms": 18.6},
            {"kind": "burnout", "t_s": 1.6, "altitude_m": 111.0, "velocity_ms": 101.0},
            {"kind": "apogee", "t_s": 7.74, "altitude_m": 345.8, "velocity_ms": null},
            {"kind": "recovery_device_deployment", "t_s": 8.6, "altitude_m": 342.0, "velocity_ms": 8.3},
            {"kind": "ground_hit", "t_s": 90.7, "altitude_m": 0.0, "velocity_ms": 4.1}
        ]))
        .unwrap();
        let rows = phase_rows(&run_phases(&ours), &golden_phases(&golden));
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "rail_exit.t_s",
                "rail_exit.altitude_m",
                "rail_exit.velocity_ms",
                "burnout.t_s",
                "burnout.altitude_m",
                "burnout.velocity_ms",
                "apogee.t_s",
                "apogee.altitude_m",
                "deployment.t_s",
                "deployment.altitude_m",
                "deployment.velocity_ms",
                "landing.t_s",
                "landing.velocity_ms",
            ]
        );
        let bo = rows.iter().find(|r| r.key == "burnout.altitude_m").unwrap();
        // The main flight's burnout, not the booster branch's.
        assert_eq!((bo.a, bo.b), (Some(110.0), Some(111.0)));
        assert_eq!(bo.delta, Some(-1.0));
        assert!((bo.delta_pct.unwrap() + 100.0 / 111.0).abs() < 1e-12);
        assert_eq!(bo.unit.as_deref(), Some("m"));
        assert!(rows.iter().all(|r| r.tol.is_none() && r.pass.is_none()));
        // A side without a value: ours only, no delta.
        let golden_partial: Vec<OracleEvent> = serde_json::from_value(serde_json::json!([
            {"kind": "burnout", "t_s": 1.6, "altitude_m": null, "velocity_ms": 101.0}
        ]))
        .unwrap();
        let rows = phase_rows(&run_phases(&ours), &golden_phases(&golden_partial));
        let ba = rows.iter().find(|r| r.key == "burnout.altitude_m").unwrap();
        assert_eq!((ba.a, ba.b, ba.delta), (Some(110.0), None, None));
    }

    #[test]
    fn a_phase_neither_side_has_is_skipped() {
        let a = run_phases(&[ev(7.0, EventKind::Apogee, 100.0, 0.0, None)]);
        let rows = phase_rows(&a, &a);
        assert!(
            rows.iter().all(|r| r.key.starts_with("apogee.")),
            "{rows:?}"
        );
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.delta == Some(0.0)));
    }
}
