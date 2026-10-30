//! Recovery (R4.5): deployment triggers, parachute and streamer drag,
//! tumbling descent, and the point-mass descent equations.
//!
//! Once a recovery device deploys, the flight switches to three degrees of
//! freedom and the whole drag comes from the deployed devices
//! (niskanen-2013 sec 4.2.5, pdf 78-79): parachute C_D (default 0.8) on the
//! canopy area, streamer C_D from the empirical fit (C.6) when the model gives
//! none. A vehicle that ejects without deploying anything tumbles, with the
//! average tumbling drag (3.98)/(3.99) and the fin efficiency of Table 3.4
//! (niskanen-2013 sec 3.5, pdf 62-64).

use rw_geom::{ComponentGeometry, Geometry};
use rw_model::{ComponentType, DeployEvent, EvalConfig, EvalShape, EvaluatedModel};

use crate::env::Environment;
use crate::models::norm;

/// Default parachute drag coefficient on the canopy area.
pub const PARACHUTE_CD_DEFAULT: f64 = 0.8;
/// Tumbling drag coefficient of fins on their (effective) profile area.
pub const TUMBLE_CD_FINS: f64 = 1.42;
/// Tumbling drag coefficient of body tubes on their profile area.
pub const TUMBLE_CD_BODY: f64 = 0.56;
/// Streamer surface density the (C.4) fit was measured at (kg/m²).
pub const STREAMER_REF_DENSITY: f64 = 0.080;

/// One deployable recovery device of a configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryDevice {
    /// Component id.
    pub id: String,
    /// Drag area C_D·A (m²).
    pub cd_area: f64,
    pub event: DeployEvent,
    /// Delay after the event (s); for `timer`, the time after launch.
    pub delay: f64,
    /// Deployment altitude above the launch site (m), for `altitude`.
    pub altitude: Option<f64>,
}

/// The recovery setup of one flight.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Recovery {
    pub devices: Vec<RecoveryDevice>,
    /// Drag area C_D·A (m²) of the vehicle tumbling (no device deployed after
    /// ejection).
    pub tumble_cd_area: f64,
}

/// Parachute drag area C_D π (d² - d_s²)/4 on the canopy minus the spill hole.
///
/// cite: niskanen-2013 sec 4.2.5 p 78-79
pub fn parachute_cd_area(cd: f64, diameter: f64, spill_hole: f64) -> f64 {
    let cd = if cd > 0.0 { cd } else { PARACHUTE_CD_DEFAULT };
    let a = core::f64::consts::PI * 0.25 * (diameter * diameter - spill_hole * spill_hole);
    cd * a.max(0.0)
}

/// Streamer drag coefficient on its strip area w·l from the empirical fit
/// C_D = 0.034 ((ρ_m + 0.025)/0.105) (l + 1)/l, with ρ_m the material surface
/// density in kg/m² and l in m.
///
/// cite: niskanen-2013 eq C.6 p 126
pub fn streamer_cd(length: f64, surface_density: f64) -> f64 {
    if length <= 0.0 {
        return 0.0;
    }
    0.034 * ((surface_density + 0.025) / 0.105) * (length + 1.0) / length
}

/// Streamer drag area C_D w l; a non-positive `cd` uses [`streamer_cd`] with
/// the material surface density (80 g/m² when unknown).
///
/// cite: niskanen-2013 eq C.3 p 125
pub fn streamer_cd_area(cd: f64, length: f64, width: f64, surface_density: Option<f64>) -> f64 {
    let cd = if cd > 0.0 {
        cd
    } else {
        streamer_cd(length, surface_density.unwrap_or(STREAMER_REF_DENSITY))
    };
    cd * length * width
}

/// Fin efficiency factor of a tumbling stage with `count` fins (multiplies
/// the area of one fin).
///
/// cite: niskanen-2013 tab 3.4 p 64
pub fn tumble_fin_efficiency(count: u32) -> f64 {
    const TABLE: [f64; 8] = [0.50, 1.00, 1.50, 1.41, 1.81, 1.73, 1.90, 1.85];
    match count {
        0 => 0.0,
        n => TABLE[(n.min(8) - 1) as usize],
    }
}

/// Tumbling drag area C_D A_ref = C_D,f A_f + C_D,bt A_bt, with A_bt the body
/// profile area and A_f the area of one fin times the efficiency factor.
///
/// cite: niskanen-2013 eq 3.99 p 64
pub fn tumble_cd_area(body_profile_area: f64, fin_sets: &[(f64, u32)]) -> f64 {
    let fins: f64 = fin_sets
        .iter()
        .map(|&(a, n)| a * tumble_fin_efficiency(n))
        .sum();
    TUMBLE_CD_FINS * fins + TUMBLE_CD_BODY * body_profile_area
}

/// Area of a closed planform polygon (shoelace).
fn polygon_area(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    if n < 3 {
        return 0.0;
    }
    let s: f64 = (0..n)
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % n]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum();
    0.5 * s.abs()
}

fn is_body(g: &ComponentGeometry) -> bool {
    matches!(
        g.kind,
        ComponentType::NoseCone | ComponentType::BodyTube | ComponentType::Transition
    )
}

impl Recovery {
    /// The devices `config.deployments` names (parachutes and streamers of
    /// `model`) and the tumbling drag area from `geometry` (aerodynamic body
    /// profiles and fin sets).
    ///
    /// cite: n/a configuration mapping onto the cited drag areas
    pub fn from_model(model: &EvaluatedModel, config: &EvalConfig, geometry: &Geometry) -> Self {
        let devices = config
            .deployments
            .iter()
            .filter(|d| d.event != DeployEvent::Never)
            .filter_map(|d| {
                let c = model.components.iter().find(|c| c.id == d.component)?;
                let cd_area = match c.shape {
                    EvalShape::Parachute {
                        diameter,
                        cd,
                        spill_hole,
                        ..
                    } => parachute_cd_area(cd, diameter, spill_hole),
                    EvalShape::Streamer {
                        length, width, cd, ..
                    } => {
                        let rho = c
                            .material
                            .as_deref()
                            .and_then(|m| model.materials.get(m))
                            .and_then(|m| m.surface_density);
                        streamer_cd_area(cd, length, width, rho)
                    }
                    _ => return None,
                };
                Some(RecoveryDevice {
                    id: d.component.clone(),
                    cd_area,
                    event: d.event,
                    delay: d.delay,
                    altitude: d.altitude,
                })
            })
            .collect();
        let aero: Vec<&ComponentGeometry> = geometry.components.iter().filter(|g| g.aero).collect();
        let body: f64 = aero
            .iter()
            .filter(|g| is_body(g))
            .map(|g| g.planform_area)
            .sum();
        let fins: Vec<(f64, u32)> = aero
            .iter()
            .filter_map(|g| g.fins.as_ref())
            .map(|f| (polygon_area(&f.planform), f.count))
            .collect();
        Self {
            devices,
            tumble_cd_area: tumble_cd_area(body, &fins),
        }
    }
}

/// Point-mass descent acceleration (ENU, m/s²) at height `z`, ground velocity
/// `v`, with drag area `cd_area` and mass `mass`:
/// a = -½ ρ |v_rel| v_rel C_D A / m - g ẑ.
///
/// cite: niskanen-2013 sec 4.2.5 p 78
pub fn descent_accel(env: &Environment, z: f64, v: [f64; 3], cd_area: f64, mass: f64) -> [f64; 3] {
    let air = env.air(z);
    let w = env.wind_at(z);
    let vr = [v[0] - w[0], v[1] - w[1], v[2] - w[2]];
    let s = norm(vr);
    let k = if mass > 0.0 {
        -0.5 * air.density * s * cd_area / mass
    } else {
        0.0
    };
    [k * vr[0], k * vr[1], k * vr[2] - env.g(z)]
}

/// Terminal descent speed in still air, sqrt(2 m g / (ρ C_D A)).
///
/// cite: niskanen-2013 eq 3.98 p 63
pub fn terminal_velocity(mass: f64, g: f64, density: f64, cd_area: f64) -> f64 {
    if density <= 0.0 || cd_area <= 0.0 {
        return f64::INFINITY;
    }
    (2.0 * mass * g / (density * cd_area)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::tests::conditions;

    #[test]
    fn parachute_and_streamer_areas() {
        let a = parachute_cd_area(0.8, 0.3, 0.0);
        assert!((a - 0.8 * core::f64::consts::PI * 0.0225).abs() < 1e-15);
        assert_eq!(parachute_cd_area(0.0, 0.3, 0.0), a);
        assert!(parachute_cd_area(0.8, 0.3, 0.05) < a);
        // (C.4) at 80 g/m²: C_D = 0.034 (l + 1)/l; (C.3) C_D A = 0.034 (l + 1) w.
        let cd = streamer_cd(0.4, 0.080);
        assert!((cd - 0.034 * 1.4 / 0.4).abs() < 1e-12);
        assert!((streamer_cd_area(0.0, 0.4, 0.04, None) - 0.034 * 1.4 * 0.04).abs() < 1e-12);
        assert_eq!(streamer_cd_area(0.5, 0.4, 0.04, None), 0.5 * 0.016);
    }

    #[test]
    fn tumble_drag_area() {
        // (3.99) for a 44 mm × 108 mm tube with three 70/40/60 mm fins
        // (Table 3.3 model #1): 1.42 · 1.5 A_fin + 0.56 A_bt.
        let a_fin = 0.5 * (0.070 + 0.040) * 0.060;
        let cda = tumble_cd_area(0.044 * 0.108, &[(a_fin, 3)]);
        assert!((cda - (1.42 * 1.5 * a_fin + 0.56 * 0.044 * 0.108)).abs() < 1e-15);
        // (3.98): terminal speed of that 18 g stage at ρ = 1.31 is of the
        // measured 5.6 m/s order.
        let v = terminal_velocity(0.018, 9.81, 1.31, cda);
        assert!(v > 4.0 && v < 7.0, "{v}");
        assert_eq!(tumble_fin_efficiency(3), 1.5);
        assert_eq!(tumble_fin_efficiency(12), 1.85);
        assert_eq!(tumble_fin_efficiency(0), 0.0);
        // Four fins shield each other: 1.41 < 1.50 (Table 3.4).
        assert!((tumble_cd_area(0.0, &[(1e-3, 4)]) - 1.42 * 1.41e-3).abs() < 1e-15);
    }

    #[test]
    fn descent_accel_balances_at_terminal_speed() {
        let env = Environment::from_conditions(&conditions());
        let air = env.air(100.0);
        let vt = terminal_velocity(0.06, env.g(100.0), air.density, 0.0565);
        let a = descent_accel(&env, 100.0, [0.0, 0.0, -vt], 0.0565, 0.06);
        assert!(a[2].abs() < 1e-12, "{a:?}");
        assert!(descent_accel(&env, 100.0, [0.0, 0.0, -2.0 * vt], 0.0565, 0.06)[2] > 0.0);
    }

    // ---- flight-level recovery tests (rail → 6DOF → descent) -------------------

    use crate::doubles::ConstantCd;
    use crate::flight::{Flight, FlightOptions, simulate_flight};
    use crate::integrator::Dp54Options;
    use crate::models::tests::{constant_motor, mounted};
    use crate::models::{MassEval, PointMass, Propulsion, Vehicle};
    use crate::outputs;
    use crate::phase::IntegratorChoice;
    use crate::{EventKind, FlightEvent};

    /// 10 N × 1.23 s motor with ejection `delay`, 100 g airframe, C_D 0.5.
    fn fly(delay: Option<f64>, recovery: &Recovery) -> (Flight, f64) {
        let env = Environment::from_conditions(&conditions());
        let mut m = mounted(constant_motor(10.0, 1.23, 0.012, 0.012), 0.0, 1);
        m.delay = delay;
        let prop = Propulsion::new(&[m]);
        let mass = PointMass {
            dry_mass: 0.1,
            propulsion: prop.clone(),
        };
        let aero = ConstantCd {
            cd: 0.5,
            ref_area: 4.9e-4,
        };
        let veh = Vehicle {
            env: &env,
            aero: &aero,
            mass: &mass,
            propulsion: &prop,
        };
        let f = simulate_flight(
            &veh,
            recovery,
            &FlightOptions {
                integrator: IntegratorChoice::Dp54(Dp54Options {
                    rtol: 1e-9,
                    atol: 1e-9,
                    ..Dp54Options::default()
                }),
                max_time: 400.0,
                sample_dt: 0.01,
            },
            &mut |_| true,
        )
        .unwrap();
        (f, mass.at(100.0).mass)
    }

    fn device(
        id: &str,
        cd_area: f64,
        event: DeployEvent,
        delay: f64,
        alt: Option<f64>,
    ) -> RecoveryDevice {
        RecoveryDevice {
            id: id.into(),
            cd_area,
            event,
            delay,
            altitude: alt,
        }
    }

    fn kinds(evs: &[FlightEvent]) -> Vec<EventKind> {
        evs.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn terminal_velocity_at_landing() {
        let cda = parachute_cd_area(0.8, 0.3, 0.0);
        let rec = Recovery {
            devices: vec![device("chute", cda, DeployEvent::Apogee, 0.0, None)],
            tumble_cd_area: 0.0,
        };
        let (f, m) = fly(None, &rec);
        assert!(f.landed);
        let env = Environment::from_conditions(&conditions());
        let vt = terminal_velocity(m, env.g(0.0), env.air(0.0).density, cda);
        let s = outputs::summary(&f);
        assert!(
            (s.landing_velocity_ms / vt - 1.0).abs() < 1e-3,
            "{} vs {vt}",
            s.landing_velocity_ms
        );
        // Deployed at apogee: deployment speed is the apogee speed (0 in
        // still air, vertical flight).
        let ap = f
            .events
            .iter()
            .find(|e| e.kind == EventKind::Apogee)
            .unwrap();
        let dep = f
            .events
            .iter()
            .find(|e| e.kind == EventKind::Deployment)
            .unwrap();
        assert_eq!(ap.t, dep.t);
        assert!(s.deployment_velocity_ms.unwrap() < 1e-6);
    }

    #[test]
    fn event_ordering_and_r48_keys() {
        // Drogue at apogee + 1 s, main at 60 m on descent, and an ejection
        // charge at burnout + 4 s that no device is tied to.
        let drogue = parachute_cd_area(0.8, 0.1, 0.0);
        let main = parachute_cd_area(0.8, 0.4, 0.0);
        let rec = Recovery {
            devices: vec![
                device("drogue", drogue, DeployEvent::Apogee, 1.0, None),
                device("main", main, DeployEvent::Altitude, 0.0, Some(60.0)),
            ],
            tumble_cd_area: 1e-3,
        };
        let (f, _) = fly(Some(4.0), &rec);
        let k = kinds(&f.events);
        let pos = |kind: EventKind, nth: usize| {
            k.iter()
                .enumerate()
                .filter(|(_, x)| **x == kind)
                .nth(nth)
                .map(|(i, _)| i)
                .unwrap_or_else(|| panic!("no {kind:?} #{nth} in {k:?}"))
        };
        let order = [
            pos(EventKind::Ignition, 0),
            pos(EventKind::Liftoff, 0),
            pos(EventKind::RailExit, 0),
            pos(EventKind::Burnout, 0),
            pos(EventKind::Apogee, 0),
            pos(EventKind::Deployment, 0),
            pos(EventKind::Deployment, 1),
            pos(EventKind::Landing, 0),
        ];
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{k:?}");
        let ev = |kind: EventKind, nth: usize| f.events[pos(kind, nth)].clone();
        let (apo, d1, d2) = (
            ev(EventKind::Apogee, 0),
            ev(EventKind::Deployment, 0),
            ev(EventKind::Deployment, 1),
        );
        assert!((d1.t - apo.t - 1.0).abs() < 1e-9, "drogue at apogee + 1 s");
        assert!(
            (d2.altitude - 60.0).abs() < 1e-6,
            "main at 60 m: {}",
            d2.altitude
        );
        assert_eq!(d1.source.as_ref().unwrap().0, "rw:c/drogue");
        assert_eq!(d2.source.as_ref().unwrap().0, "rw:c/main");
        // Ejection at burnout + 4 s comes before the drogue: tumble until then.
        let ej = ev(EventKind::Ejection, 0);
        let b = ev(EventKind::Burnout, 0);
        assert!((ej.t - b.t - 4.0).abs() < 1e-9);
        if ej.t < d1.t {
            assert!(k.contains(&EventKind::Tumble));
        }
        // Every R4.8 key is emitted, finite, and the optional ones present.
        let s = outputs::summary(&f);
        let json = serde_json::to_value(&s).unwrap();
        for (_, ours) in outputs::OR_SUMMARY_KEYS {
            let v = json[*ours]
                .as_f64()
                .unwrap_or_else(|| panic!("{ours} missing"));
            assert!(v.is_finite(), "{ours}");
            assert_eq!(outputs::summary_value(&s, ours), Some(v));
        }
        assert!((s.optimum_delay_s.unwrap() - (apo.t - b.t)).abs() < 1e-12);
        assert_eq!(s.time_to_apogee_s, apo.t);
        assert_eq!(s.apogee_m, apo.altitude);
        assert!(s.flight_time_s > d2.t && s.landing_velocity_ms > 0.0);
        let series = outputs::series(&f, 0.01);
        assert_eq!(series.columns.len(), crate::SERIES_COLUMNS.len());
        assert!(series.rows.iter().all(|r| r.len() == series.columns.len()));
        assert!(series.rows.windows(2).all(|w| w[0][0] <= w[1][0]));
    }

    /// B3 round 8: derived timing so agents never subtract event times.
    #[test]
    fn derived_timing_fields() {
        let drogue = parachute_cd_area(0.8, 0.1, 0.0);
        let main = parachute_cd_area(0.8, 0.4, 0.0);
        let rec = Recovery {
            devices: vec![
                device("drogue", drogue, DeployEvent::Ejection, 0.0, None),
                device("main", main, DeployEvent::Altitude, 0.0, Some(60.0)),
            ],
            tumble_cd_area: 1e-3,
        };
        let (f, _) = fly(Some(4.0), &rec);
        let s = outputs::summary(&f);
        let at = |k: EventKind| f.events.iter().find(|e| e.kind == k).unwrap().clone();
        let (apo, b, ej) = (
            at(EventKind::Apogee),
            at(EventKind::Burnout),
            at(EventKind::Ejection),
        );
        assert_eq!(ej.source.as_ref().unwrap().0, "rw:c/mmt");
        assert_eq!(s.coast_time_s, Some(apo.t - b.t));
        assert_eq!(s.coast_time_s, s.optimum_delay_s);
        // One row per deployment, in time order, signed against apogee.
        let deps: Vec<&FlightEvent> = f
            .events
            .iter()
            .filter(|e| e.kind == EventKind::Deployment)
            .collect();
        assert_eq!(s.deployments.len(), 2);
        for (d, e) in s.deployments.iter().zip(&deps) {
            assert_eq!(d.source, e.source);
            assert_eq!(d.t_s, e.t);
            assert_eq!(d.deploy_minus_apogee_s, e.t - apo.t);
            assert_eq!(d.deploy_altitude_m, e.altitude);
            assert_eq!(d.deploy_velocity_ms, e.velocity);
        }
        assert_eq!(s.deployments[0].source.as_ref().unwrap().0, "rw:c/drogue");
        assert_eq!(s.deployments[1].source.as_ref().unwrap().0, "rw:c/main");
        assert!(s.deployments[1].deploy_minus_apogee_s > 0.0);
        // The motor's ejection: configured delay minus optimum delay equals
        // ejection time minus apogee time.
        assert_eq!(s.ejections.len(), 1);
        let x = &s.ejections[0];
        assert_eq!(x.source.0, "rw:c/mmt");
        assert_eq!(x.delay_s, 4.0);
        assert!((x.t_s - ej.t).abs() < 1e-12);
        assert!((x.optimum_delay_s - s.optimum_delay_s.unwrap()).abs() < 1e-12);
        assert!((x.delay_minus_optimum_s - (4.0 - s.optimum_delay_s.unwrap())).abs() < 1e-12);
        assert!((x.delay_minus_optimum_s - (ej.t - apo.t)).abs() < 1e-9);
        // No delay (plugged motor): no ejection row.
        let (f, _) = fly(None, &rec);
        assert!(outputs::summary(&f).ejections.is_empty());
    }

    #[test]
    fn ejection_deployment_and_tumble() {
        let cda = parachute_cd_area(0.8, 0.3, 0.0);
        // Chute at ejection + 0.5 s: tumbling from ejection until then.
        let rec = Recovery {
            devices: vec![device("chute", cda, DeployEvent::Ejection, 0.5, None)],
            tumble_cd_area: 2e-3,
        };
        let (f, _) = fly(Some(3.0), &rec);
        let t = |k: EventKind| f.events.iter().find(|e| e.kind == k).map(|e| e.t);
        let ej = t(EventKind::Ejection).unwrap();
        assert!((ej - (1.23 + 3.0)).abs() < 1e-12);
        assert_eq!(t(EventKind::Tumble), Some(ej));
        assert!((t(EventKind::Deployment).unwrap() - ej - 0.5).abs() < 1e-12);
        // Chute at ejection, no delay: no tumble.
        let rec0 = Recovery {
            devices: vec![device("chute", cda, DeployEvent::Ejection, 0.0, None)],
            tumble_cd_area: 2e-3,
        };
        let (f0, _) = fly(Some(3.0), &rec0);
        assert!(!kinds(&f0.events).contains(&EventKind::Tumble));
        // No device at all: tumbles to the ground at the tumbling terminal speed.
        let (ft, m) = fly(
            Some(3.0),
            &Recovery {
                devices: vec![],
                tumble_cd_area: 2e-3,
            },
        );
        let env = Environment::from_conditions(&conditions());
        let vt = terminal_velocity(m, env.g(0.0), env.air(0.0).density, 2e-3);
        let s = outputs::summary(&ft);
        assert!(s.deployment_velocity_ms.is_none());
        assert!(
            (s.landing_velocity_ms / vt - 1.0).abs() < 2e-2,
            "{} vs {vt}",
            s.landing_velocity_ms
        );
        // Timer deployment at 2 s after launch (during the coast).
        let (fr, _) = fly(
            None,
            &Recovery {
                devices: vec![device("chute", cda, DeployEvent::Timer, 2.0, None)],
                tumble_cd_area: 0.0,
            },
        );
        let d = fr
            .events
            .iter()
            .find(|e| e.kind == EventKind::Deployment)
            .unwrap();
        assert_eq!(d.t, 2.0);
    }

    /// Final review (REV-phys): an altitude-only device whose altitude the
    /// flight never reaches (plugged motor, low apogee) deploys at apogee,
    /// the documented fallback, instead of riding ballistic to the ground.
    #[test]
    fn altitude_device_above_apogee_deploys_at_apogee() {
        let cda = parachute_cd_area(0.8, 0.3, 0.0);
        let rec = Recovery {
            devices: vec![device(
                "chute",
                cda,
                DeployEvent::Altitude,
                0.0,
                Some(1.0e4),
            )],
            tumble_cd_area: 0.0,
        };
        let (f, m) = fly(None, &rec);
        assert!(f.landed);
        let at = |k: EventKind| f.events.iter().find(|e| e.kind == k).cloned();
        let apo = at(EventKind::Apogee).expect("apogee");
        assert!(apo.altitude < 1.0e4);
        let dep = at(EventKind::Deployment).expect("the chute never deployed");
        assert_eq!(dep.t, apo.t);
        assert_eq!(dep.source.as_ref().unwrap().0, "rw:c/chute");
        let k = kinds(&f.events);
        let pos = |kind| k.iter().position(|x| *x == kind).unwrap();
        assert!(pos(EventKind::Deployment) < pos(EventKind::Landing));
        // Lands under the chute at its terminal speed.
        let env = Environment::from_conditions(&conditions());
        let vt = terminal_velocity(m, env.g(0.0), env.air(0.0).density, cda);
        let s = outputs::summary(&f);
        assert!((s.landing_velocity_ms / vt - 1.0).abs() < 1e-3);
    }

    #[test]
    fn polygon_area_of_trapezoid() {
        let p = [[0.0, 0.0], [0.0508, 0.0], [0.0762, 0.03], [0.0254, 0.03]];
        assert!((polygon_area(&p) - 0.0508 * 0.03).abs() < 1e-15);
    }
}
