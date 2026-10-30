//! `threedof::` tests: vertical analytic burn/coast, rail-exit kinematics,
//! burnout break, drag and wind terms, gravity per `Conditions`.

use super::*;
use crate::doubles::ConstantCd;
use crate::env::Environment;
use crate::env::tests::conditions;
use crate::integrator::Dp54Options;
use crate::models::tests::{constant_motor, mounted};
use crate::models::{PointMass, Propulsion};
use rw_atmos::ussa1976::G0;
use rw_model::Geodetic;

/// Constant-thrust test vehicle: 10 N for 1.23 s, 12 g propellant, 12 g
/// casing, 100 g airframe.
const F: f64 = 10.0;
const TB: f64 = 1.23;
const PROP: f64 = 0.012;
const CASE: f64 = 0.012;
const DRY: f64 = 0.100;
const M0: f64 = DRY + CASE + PROP;

struct Rig {
    env: Environment,
    prop: Propulsion,
    mass: PointMass,
    aero: ConstantCd,
}

impl Rig {
    fn new(env: Environment, motor: rw_motor::ThrustCurve, cd: f64) -> Self {
        let prop = Propulsion::new(&[mounted(motor, 0.0, 1)]);
        Self {
            env,
            mass: PointMass {
                dry_mass: DRY,
                propulsion: prop.clone(),
            },
            prop,
            aero: ConstantCd {
                cd,
                ref_area: 4.9e-4,
            },
        }
    }
    fn vehicle(&self) -> Vehicle<'_> {
        Vehicle {
            env: &self.env,
            aero: &self.aero,
            mass: &self.mass,
            propulsion: &self.prop,
        }
    }
}

fn vacuum_rig(rail: f64, angle_deg: f64) -> Rig {
    let mut c = conditions();
    c.rail_length_m = rail;
    c.rod_angle_deg = angle_deg;
    Rig::new(
        Environment::from_conditions(&c),
        constant_motor(F, TB, PROP, CASE),
        0.0,
    )
}

fn opts(integrator: IntegratorChoice) -> Options3Dof {
    Options3Dof {
        integrator,
        max_time: 60.0,
        sample_dt: 0.01,
        stop_at_apogee: false,
    }
}

fn dp54_tight() -> IntegratorChoice {
    IntegratorChoice::Dp54(Dp54Options {
        rtol: 1e-10,
        atol: 1e-10,
        ..Dp54Options::default()
    })
}

/// Analytic constant-thrust, linear-mass, drag-free motion along an axis with
/// gravity component `g_ax` (Tsiolkovsky with gravity loss):
/// v = v_e ln(m0/m) - g_ax t, s = v_e (t + (m/ṁ) ln(m/m0)) - g_ax t²/2.
fn burn(t: f64, g_ax: f64) -> (f64, f64) {
    let mdot = PROP / TB;
    let ve = F / mdot;
    let m = M0 - mdot * t;
    let v = ve * (M0 / m).ln() - g_ax * t;
    let s = ve * (t + (m / mdot) * (m / M0).ln()) - 0.5 * g_ax * t * t;
    (s, v)
}

fn bisect(mut lo: f64, mut hi: f64, f: impl Fn(f64) -> f64) -> f64 {
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if f(mid) > 0.0 { hi = mid } else { lo = mid }
    }
    0.5 * (lo + hi)
}

fn event_t(fl: &Flight3Dof, kind: EventKind) -> f64 {
    fl.events.iter().find(|e| e.kind == kind).expect("event").t
}

fn rel(a: f64, b: f64) -> f64 {
    ((a - b) / b).abs()
}

fn check_vertical(fl: &Flight3Dof, tol: f64) {
    let (zb, vb) = burn(TB, G0);
    let z_apo = zb + vb * vb / (2.0 * G0);
    let t_apo = TB + vb / G0;
    let t_land = t_apo + (2.0 * z_apo / G0).sqrt();
    let v_land = (2.0 * G0 * z_apo).sqrt();
    let s = &fl.summary;
    assert!(
        rel(s.burnout_altitude_m, zb) < tol,
        "z_b {} vs {zb}",
        s.burnout_altitude_m
    );
    assert_eq!(s.burnout_time_s, TB);
    let b = fl
        .events
        .iter()
        .find(|e| e.kind == EventKind::Burnout)
        .unwrap();
    assert!(rel(b.velocity, vb) < tol, "v_b {} vs {vb}", b.velocity);
    // In vacuum the fastest point is the landing.
    assert!(
        rel(s.max_velocity_ms, v_land) < tol,
        "v_max {}",
        s.max_velocity_ms
    );
    assert!(
        rel(s.apogee_m, z_apo) < tol,
        "apogee {} vs {z_apo}",
        s.apogee_m
    );
    assert!((s.time_to_apogee_s - t_apo).abs() < tol * t_apo, "t_apo");
    assert!((s.flight_time_s - t_land).abs() < tol * t_land, "t_land");
    assert!(rel(s.landing_velocity_ms, v_land) < tol, "v_land");
    assert!(s.landing_x_m.abs() < 1e-9 && s.landing_y_m.abs() < 1e-9);
    // Rail exit at s = 1 m.
    let t_exit = bisect(0.0, TB, |t| burn(t, G0).0 - 1.0);
    assert!(
        (s.rail_exit_time_s - t_exit).abs() < 1e-6,
        "{} vs {t_exit}",
        s.rail_exit_time_s
    );
    assert!(rel(s.rail_exit_velocity_ms, burn(t_exit, G0).1) < tol);
    // Grid samples follow the analytic burn.
    for smp in fl.samples.iter().filter(|x| x.t > 0.0 && x.t < TB) {
        let (z, v) = burn(smp.t, G0);
        assert!((smp.pos[2] - z).abs() < tol * zb + 1e-9, "z({})", smp.t);
        assert!((smp.vel[2] - v).abs() < tol * vb, "v({})", smp.t);
        assert!((smp.mass - (M0 - PROP * smp.t / TB)).abs() < 1e-12);
    }
}

#[test]
fn vertical_burn_coast_matches_analytic_dp54() {
    let rig = vacuum_rig(1.0, 0.0);
    let fl = simulate_3dof(&rig.vehicle(), &opts(dp54_tight()), &mut |_| true).unwrap();
    assert!(fl.completed);
    check_vertical(&fl, 1e-8);
    // Default R4.5 tolerance (rtol 1e-6).
    let d = IntegratorChoice::Dp54(Dp54Options::default());
    let fl = simulate_3dof(&rig.vehicle(), &opts(d), &mut |_| true).unwrap();
    check_vertical(&fl, 1e-5);
}

#[test]
fn vertical_burn_coast_matches_analytic_rk4() {
    // h = 0.05 does not divide the burn time; the explicit burnout break keeps
    // the step from straddling the thrust cut-off.
    let rig = vacuum_rig(1.0, 0.0);
    let fl = simulate_3dof(
        &rig.vehicle(),
        &opts(IntegratorChoice::Rk4 { h: 0.05 }),
        &mut |_| true,
    )
    .unwrap();
    check_vertical(&fl, 1e-7);
}

#[test]
fn event_sequence_and_samples() {
    let rig = vacuum_rig(1.0, 0.0);
    let fl = simulate_3dof(&rig.vehicle(), &opts(dp54_tight()), &mut |_| true).unwrap();
    let kinds: Vec<EventKind> = fl.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        [
            EventKind::Ignition,
            EventKind::Liftoff,
            EventKind::RailExit,
            EventKind::Burnout,
            EventKind::Apogee,
            EventKind::Landing
        ]
    );
    assert!(fl.events.windows(2).all(|w| w[0].t <= w[1].t));
    assert!(fl.samples.windows(2).all(|w| w[0].t < w[1].t));
    // Every event time is an exact row.
    for e in &fl.events {
        assert!(fl.samples.iter().any(|s| s.t == e.t), "{:?}", e.kind);
    }
    let apo = fl
        .events
        .iter()
        .find(|e| e.kind == EventKind::Apogee)
        .unwrap();
    assert!(apo.velocity.abs() < 1e-6);
    assert!(
        fl.samples
            .iter()
            .filter(|s| s.t < event_t(&fl, EventKind::RailExit))
            .all(|s| s.phase == Phase::Rail)
    );
    assert!(fl.samples.last().unwrap().pos[2].abs() < 1e-9);
}

#[test]
fn inclined_rail_exit_kinematics() {
    // 30 deg from vertical toward east, 2 m rail: a = F/m - g cos 30.
    let rig = vacuum_rig(2.0, 30.0);
    let o = Options3Dof {
        stop_at_apogee: true,
        ..opts(dp54_tight())
    };
    let fl = simulate_3dof(&rig.vehicle(), &o, &mut |_| true).unwrap();
    let g_ax = G0 * 30f64.to_radians().cos();
    let t_exit = bisect(0.0, TB, |t| burn(t, g_ax).0 - 2.0);
    let v_exit = burn(t_exit, g_ax).1;
    let s = &fl.summary;
    assert!(
        (s.rail_exit_time_s - t_exit).abs() < 1e-9,
        "{} vs {t_exit}",
        s.rail_exit_time_s
    );
    assert!(rel(s.rail_exit_velocity_ms, v_exit) < 1e-9);
    let exit = fl
        .samples
        .iter()
        .find(|x| x.t == s.rail_exit_time_s)
        .unwrap();
    assert!((exit.pos[0] - 1.0).abs() < 1e-9 && exit.pos[1].abs() < 1e-12);
    assert!((exit.pos[2] - 3f64.sqrt()).abs() < 1e-9);
    // On the rail the motion stays on the rail axis.
    for x in fl.samples.iter().filter(|x| x.phase == Phase::Rail) {
        assert!((x.pos[2] - x.pos[0] * 3f64.sqrt()).abs() < 1e-12);
    }
    // After the rail, gravity turns the trajectory over: apogee lies east.
    assert!(fl.completed && s.landing_x_m > 1.0);
    let rail = rail::to_enu(&rig.vehicle(), &[2.0, v_exit]);
    assert!((rail.1[0] - 0.5 * v_exit).abs() < 1e-12);
}

#[test]
fn liftoff_waits_for_thrust_to_exceed_weight() {
    // Thrust ramps 0 -> F over 0.1 s; the vehicle sits on the launcher until
    // F(t) = m(t) g.
    let mut motor = constant_motor(F, TB, PROP, CASE);
    motor.points.insert(
        0,
        rw_motor::ThrustPoint {
            t: 0.0,
            thrust: 0.0,
            mass: None,
            cg: None,
        },
    );
    motor.points[1].t = 0.1;
    motor.total_impulse = F * (TB - 0.05);
    let rig = Rig::new(Environment::from_conditions(&conditions()), motor, 0.0);
    let veh = rig.vehicle();
    let fl = simulate_3dof(&veh, &opts(dp54_tight()), &mut |_| true).unwrap();
    let expect = bisect(0.0, 0.1, |t| {
        rig.prop.thrust(t) - (DRY + rig.prop.mass(t)) * G0
    });
    let lift = event_t(&fl, EventKind::Liftoff);
    assert!((lift - expect).abs() < 1e-9, "{lift} vs {expect}");
    for s in fl.samples.iter().filter(|s| s.t <= expect) {
        assert_eq!(s.pos, [0.0; 3]);
        assert_eq!(s.vel, [0.0; 3]);
    }
}

#[test]
fn explicit_burnout_break_beats_straddling() {
    // Integrate the vertical flight from rest with RK4 h = 0.05 to t = 2 s,
    // with and without the burnout break.
    let rig = vacuum_rig(0.0, 0.0);
    let veh = rig.vehicle();
    let (zb, vb) = burn(TB, G0);
    let dt = 2.0 - TB;
    let z_exact = zb + vb * dt - 0.5 * G0 * dt * dt;
    let run = |breaks: &[f64]| {
        let end = run_phase(
            IntegratorChoice::Rk4 { h: 0.05 },
            0.0,
            [0.0; 6],
            2.0,
            breaks,
            &mut |seg, t, y: &State3, dy: &mut State3| rhs(&veh, t, Some(seg), y, dy),
            &mut [],
            PhaseHooks {
                on_step: &mut |_| true,
                on_break: &mut |_, _| {},
            },
        )
        .unwrap();
        (end.y[2] - z_exact).abs()
    };
    let with_break = run(&rig.prop.breaks());
    let straddle = run(&[]);
    assert!(with_break < 1e-8 * z_exact, "with break: {with_break}");
    assert!(
        straddle > 1e3 * with_break,
        "straddle {straddle} vs {with_break}"
    );
}

#[test]
fn drag_and_wind_terms() {
    // Hand check of the free-flight RHS after burnout at z = 1000 m.
    let mut c = conditions();
    c.wind_speed_ms = 10.0;
    c.wind_direction_deg = 270.0; // from the west: blows toward +x
    let rig = Rig::new(
        Environment::from_conditions(&c),
        constant_motor(F, TB, PROP, CASE),
        0.5,
    );
    let veh = rig.vehicle();
    let y: State3 = [0.0, 0.0, 1_000.0, 0.0, 0.0, 100.0];
    let a = accel(&veh, 5.0, None, &y);
    let rho = rw_atmos::ussa1976(1_000.0).density;
    let m = DRY + CASE;
    let v_rel = [-10.0, 0.0, 100.0];
    let vmag = (100.0f64 * 100.0 + 100.0).sqrt();
    let k = 0.5 * rho * vmag * 0.5 * 4.9e-4 / m;
    assert!((a[0] - (-k * v_rel[0])).abs() < 1e-12, "{a:?}");
    assert!(a[1].abs() < 1e-15);
    assert!((a[2] - (-k * v_rel[2] - G0)).abs() < 1e-12);
    // Thrust follows the air-relative velocity during the burn.
    let a_burn = accel(&veh, 0.5, None, &y);
    let m_b = DRY + rig.prop.mass(0.5);
    let thrust_x = (a_burn[0] - (-0.5 * rho * vmag * 0.5 * 4.9e-4 / m_b * v_rel[0])) * m_b;
    assert!((thrust_x - F * v_rel[0] / vmag).abs() < 1e-9, "{thrust_x}");
    // Rail: drag projected on the rail axis; at rest with wind there is still
    // a drag load from the crosswind (reacted by the launcher until liftoff).
    let a_rail = rail::free_accel(&veh, 5.0, None, &[0.0, 0.0]);
    assert!((a_rail + G0).abs() < 1e-12, "crosswind gives no axial load");
}

#[test]
fn drag_lowers_apogee_and_integrators_agree() {
    let c = conditions();
    let motor = rw_motor::generic::generic_motor("RW_C6G").unwrap();
    let rig = Rig::new(Environment::from_conditions(&c), motor.clone(), 0.5);
    let veh = rig.vehicle();
    let dp = simulate_3dof(
        &veh,
        &opts(IntegratorChoice::Dp54(Dp54Options::default())),
        &mut |_| true,
    )
    .unwrap();
    let rk = simulate_3dof(&veh, &opts(IntegratorChoice::Rk4 { h: 0.01 }), &mut |_| {
        true
    })
    .unwrap();
    // RK4 steps across the curve's interior kinks (not breaks): O(h²) there.
    assert!(
        rel(rk.summary.apogee_m, dp.summary.apogee_m) < 2e-5,
        "{:?}\n{:?}",
        rk.summary,
        dp.summary
    );
    assert!(rel(rk.summary.flight_time_s, dp.summary.flight_time_s) < 2e-5);
    let vac = Rig::new(Environment::from_conditions(&c), motor, 0.0);
    let vac = simulate_3dof(
        &vac.vehicle(),
        &opts(IntegratorChoice::Dp54(Dp54Options::default())),
        &mut |_| true,
    )
    .unwrap();
    assert!(dp.summary.apogee_m < 0.9 * vac.summary.apogee_m);
    // Burnout mass is the dry vehicle plus the empty casing.
    let after = dp
        .samples
        .iter()
        .find(|s| s.t > dp.summary.burnout_time_s)
        .unwrap();
    assert!((after.mass - (DRY + rig.prop.mass(1e3))).abs() < 1e-12);
    assert_eq!(after.thrust, 0.0);
    assert!(dp.summary.max_mach > 0.0 && dp.summary.max_accel_ms2 > G0);
    // Coming down under drag, the landing speed is below the vacuum value.
    assert!(dp.summary.landing_velocity_ms < vac.summary.landing_velocity_ms);
}

#[test]
fn spherical_gravity_conserves_energy_in_coast() {
    let mut c = conditions();
    c.geodetic = Geodetic::Spherical;
    c.gravity = None;
    c.site_altitude_m = 1_000.0;
    let rig = Rig::new(
        Environment::from_conditions(&c),
        constant_motor(F, TB, PROP, CASE),
        0.0,
    );
    let fl = simulate_3dof(&rig.vehicle(), &opts(dp54_tight()), &mut |_| true).unwrap();
    let b = fl
        .events
        .iter()
        .find(|e| e.kind == EventKind::Burnout)
        .unwrap();
    // v_b²/2 = g0 r0² (1/r_b - 1/r_a) with r = r0 + site + z.
    let r0 = rw_atmos::ussa1976::R0;
    let r_b = r0 + 1_000.0 + b.altitude;
    let r_a = 1.0 / (1.0 / r_b - b.velocity * b.velocity / (2.0 * G0 * r0 * r0));
    let z_a = r_a - r0 - 1_000.0;
    assert!(
        rel(fl.summary.apogee_m, z_a) < 1e-9,
        "{} vs {z_a}",
        fl.summary.apogee_m
    );
    // Flat (constant g0) gives a lower apogee than the weaker spherical gravity.
    c.geodetic = Geodetic::Flat;
    c.gravity = conditions().gravity;
    let flat = Rig::new(
        Environment::from_conditions(&c),
        constant_motor(F, TB, PROP, CASE),
        0.0,
    );
    let ff = simulate_3dof(&flat.vehicle(), &opts(dp54_tight()), &mut |_| true).unwrap();
    assert!(ff.summary.apogee_m < fl.summary.apogee_m);
}

#[test]
fn errors_and_cancellation() {
    let env = Environment::from_conditions(&conditions());
    let prop = Propulsion::new(&[]);
    let mass = PointMass {
        dry_mass: DRY,
        propulsion: prop.clone(),
    };
    let aero = ConstantCd {
        cd: 0.5,
        ref_area: 1e-3,
    };
    let veh = Vehicle {
        env: &env,
        aero: &aero,
        mass: &mass,
        propulsion: &prop,
    };
    let o = opts(IntegratorChoice::Rk4 { h: 0.05 });
    assert_eq!(
        simulate_3dof(&veh, &o, &mut |_| true),
        Err(SimError::NoMotor)
    );
    let rig = vacuum_rig(1.0, 0.0);
    let mut calls = 0;
    let r = simulate_3dof(&rig.vehicle(), &o, &mut |_| {
        calls += 1;
        calls < 30
    });
    assert_eq!(r, Err(SimError::Cancelled));
    // Too heavy to lift off: never leaves the rail.
    let mut heavy = vacuum_rig(1.0, 0.0);
    heavy.mass.dry_mass = 5.0;
    let r = simulate_3dof(
        &heavy.vehicle(),
        &Options3Dof { max_time: 3.0, ..o },
        &mut |_| true,
    );
    assert!(matches!(r, Err(SimError::Integration { .. })), "{r:?}");
}

#[test]
fn options_from_sim() {
    let mut c = conditions();
    c.integrator = rw_model::IntegratorKind::Dp54;
    c.time_step_s = 0.02;
    let sim = rw_model::EvalSim {
        id: "s".into(),
        name: "s".into(),
        kind: rw_model::SimKind::Flight,
        config: "c".into(),
        conditions: c,
        series_dt: 0.01,
        max_time: 120.0,
        rtol: 1e-7,
        atol: 1e-9,
        seed: 0,
        visual_flow: None,
    };
    let o = Options3Dof::from_sim(&sim);
    assert_eq!(o.max_time, 120.0);
    assert_eq!(o.sample_dt, 0.01);
    match o.integrator {
        IntegratorChoice::Dp54(d) => {
            assert_eq!((d.rtol, d.atol, d.h_max), (1e-7, 1e-9, 0.02));
        }
        IntegratorChoice::Rk4 { .. } => panic!("expected dp54"),
    }
}
