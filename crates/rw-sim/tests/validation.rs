//! Validation against measured flight data (plan M2.12, spec B2).
//!
//! `bella_lui`: the EPFL Rocket Team's Bella Lui (AeroTech K828FJ),
//! Kaltbrunn, 2020-02-22 13:00 UTC, measured apogee 458.97 m above the pad.
//! The vehicle is `tests/validation/bella_lui/` (an rw project evaluated by
//! rw-model), flown with our geometry, aero, and mass models through
//! `rw_sim::simulate_in` in the ERA5 sounding at the site
//! (`era5_profile.csv`, extracted once by `scripts/validation/extract_era5.py`).
//! Gate: apogee within ±10 % of the measurement. Inputs follow RocketPy's
//! acceptance test (RocketPy, MIT); flight data courtesy of the EPFL Rocket
//! Team (see `tests/validation/bella_lui/README.md`).
//!
//! Files are embedded with `include_str!` (no filesystem API, I5).

use rw_aero::{AeroModel, AeroOptions};
use rw_atmos::{Profile, ProfileSample};
use rw_mass::MassModel;
use rw_model::{EvalOptions, EvalShape, Severity, SourceSet, parse_source_with_warnings};
use rw_motor::{MotorSource, MountedMotor};
use rw_sim::env::Environment;
use rw_sim::{EventKind, SimInput, simulate_in};

macro_rules! bella {
    ($p:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/validation/bella_lui/",
            $p
        ))
    };
}

const PROJECT: &[(&str, &str)] = &[
    ("rocketwright.toml", bella!("rocketwright.toml")),
    ("rocket.rw.toml", bella!("rocket.rw.toml")),
    ("configs/k828fj.rw.toml", bella!("configs/k828fj.rw.toml")),
    ("sims/kaltbrunn.rw.toml", bella!("sims/kaltbrunn.rw.toml")),
];
const MOTOR_PATH: &str = "lib/motors/AeroTech_K828FJ.eng";
const MOTOR: &str = bella!("lib/motors/AeroTech_K828FJ.eng");
const ERA5: &str = bella!("era5_profile.csv");
const FLIGHT: &str = bella!("flight_data.csv");

/// RocketPy's motor: 1 kg dry, three BATES grains (density 782.4 kg/m³,
/// outer radius 42.799 mm, inner 33.147 mm, height 152.4 mm).
fn propellant_mass() -> f64 {
    let (ro, ri, h, rho) = (0.085598 / 2.0, 0.033147, 0.1524, 782.4);
    3.0 * rho * core::f64::consts::PI * (ro * ro - ri * ri) * h
}
const MOTOR_DRY_MASS: f64 = 1.0;

/// `(t, z)` of the measured flight (`time aprox (s)`, `z (m)` above the pad).
fn measured() -> Vec<(f64, f64)> {
    FLIGHT
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<f64> = l.split(',').map(|x| x.trim().parse().unwrap()).collect();
            (f[2], f[3])
        })
        .collect()
}

fn era5() -> Profile {
    let samples = ERA5
        .lines()
        .filter(|l| !l.starts_with('#') && !l.starts_with("pressure"))
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<f64> = l.split(',').map(|x| x.trim().parse().unwrap()).collect();
            ProfileSample {
                pressure: f[0],
                height: f[1],
                temperature: f[2],
                wind_u: f[3],
                wind_v: f[4],
            }
        })
        .collect();
    Profile::new(samples).expect("era5 profile")
}

#[test]
fn bella_lui() {
    let mut sources = SourceSet::default();
    for (p, t) in PROJECT {
        let (d, w) = parse_source_with_warnings(p, t).unwrap_or_else(|e| panic!("{p}: {e:?}"));
        assert!(w.is_empty(), "{p}: {w:?}");
        sources.docs.insert((*p).to_string(), d);
    }
    let model = rw_model::eval(&sources, &EvalOptions::default());
    let errors: Vec<_> = model
        .diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .collect();
    assert!(errors.is_empty(), "{errors:#?}");
    let geometry = rw_geom::build(&model);

    // The K828FJ curve as committed, with RocketPy's motor masses.
    let mut curve = rw_motor::parse_eng(
        MOTOR,
        MotorSource::Library {
            path: MOTOR_PATH.into(),
        },
    )
    .expect("eng")
    .remove(0);
    curve.prop_mass = propellant_mass();
    curve.total_mass = MOTOR_DRY_MASS + curve.prop_mass;
    let mmt = model.components.iter().find(|c| c.id == "mmt").unwrap();
    let overhang = match &mmt.shape {
        EvalShape::InnerTube { overhang, .. } => *overhang,
        _ => 0.0,
    };
    let motor = MountedMotor {
        mount: mmt.id.clone(),
        x_fore: mmt.x_aft + overhang - curve.length,
        curve,
        ignition_time: 0.0,
        delay: None,
        count: 1,
    };
    let config = model.configs["k828fj"].clone();
    let sim = model.sims["kaltbrunn"].clone();
    let env = Environment::from_conditions(&sim.conditions).with_profile(era5());

    let aero = AeroModel::new(&model, &geometry, &AeroOptions::default());
    let mass = MassModel::new(&model, &geometry, std::slice::from_ref(&motor));
    let input = SimInput {
        schema: rw_model::SchemaTag,
        sim,
        config,
        model,
        motors: vec![motor],
    };
    let r = simulate_in(&env, &input, &aero, &mass, &mut |_| true).expect("flight");

    let flight = measured();
    let (t_apo, apo) = flight
        .iter()
        .copied()
        .fold((0.0, f64::MIN), |a, b| if b.1 > a.1 { b } else { a });
    let s = &r.summary;
    let err = 100.0 * (s.apogee_m / apo - 1.0);
    println!("Bella Lui, ERA5 2020-02-22 13:00 UTC");
    println!(
        "{:<22} {:>10} {:>10} {:>9}",
        "", "measured", "ours", "delta"
    );
    println!(
        "{:<22} {:>10.2} {:>10.2} {:>+8.2}%",
        "apogee (m AGL)", apo, s.apogee_m, err
    );
    println!(
        "{:<22} {:>10.2} {:>10.2} {:>+8.2} s",
        "time to apogee (s)",
        t_apo,
        s.time_to_apogee_s,
        s.time_to_apogee_s - t_apo
    );
    println!(
        "max velocity {:.2} m/s, max mach {:.3}, rail exit {:.2} m/s, burnout {:.2} s at {:.1} m, min stability {:.2} cal",
        s.max_velocity_ms,
        s.max_mach,
        s.rail_exit_velocity_ms,
        s.burnout_time_s,
        s.burnout_altitude_m,
        s.min_stability_cal
    );
    assert!(
        r.events.iter().any(|e| e.kind == EventKind::Apogee),
        "no apogee event"
    );
    assert!(
        (apo - 458.97).abs() < 0.01,
        "measured apogee {apo} (flight_data.csv changed?)"
    );
    assert!(
        err.abs() <= 10.0,
        "apogee {:.2} m vs measured {apo:.2} m: {err:+.2}% (gate ±10%)",
        s.apogee_m
    );
}
