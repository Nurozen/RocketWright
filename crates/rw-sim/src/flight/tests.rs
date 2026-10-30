//! `flight::` tests: errors, cancellation, runs that end before landing.

use super::*;
use crate::doubles::ConstantCd;
use crate::env::Environment;
use crate::env::tests::conditions;
use crate::integrator::Dp54Options;
use crate::models::tests::{constant_motor, mounted};
use crate::models::{PointMass, Propulsion};

fn opts(max_time: f64) -> FlightOptions {
    FlightOptions {
        integrator: IntegratorChoice::Dp54(Dp54Options::default()),
        max_time,
        sample_dt: 0.01,
    }
}

fn with_vehicle<R>(motors: &[rw_motor::MountedMotor], f: impl FnOnce(&Vehicle<'_>) -> R) -> R {
    let env = Environment::from_conditions(&conditions());
    let prop = Propulsion::new(motors);
    let mass = PointMass {
        dry_mass: 0.1,
        propulsion: prop.clone(),
    };
    let aero = ConstantCd {
        cd: 0.5,
        ref_area: 4.9e-4,
    };
    f(&Vehicle {
        env: &env,
        aero: &aero,
        mass: &mass,
        propulsion: &prop,
    })
}

#[test]
fn errors_cancellation_and_timeouts() {
    let rec = Recovery::default();
    with_vehicle(&[], |veh| {
        assert_eq!(
            simulate_flight(veh, &rec, &opts(10.0), &mut |_| true),
            Err(SimError::NoMotor)
        );
    });
    let motor = mounted(constant_motor(10.0, 1.23, 0.012, 0.012), 0.0, 1);
    with_vehicle(std::slice::from_ref(&motor), |veh| {
        assert!(matches!(
            simulate_flight(veh, &rec, &opts(0.0), &mut |_| true),
            Err(SimError::Input { .. })
        ));
        // Cancelled on the rail and in free flight.
        assert_eq!(
            simulate_flight(veh, &rec, &opts(10.0), &mut |_| false),
            Err(SimError::Cancelled)
        );
        let mut n = 0;
        assert_eq!(
            simulate_flight(veh, &rec, &opts(10.0), &mut |_| {
                n += 1;
                n < 5
            }),
            Err(SimError::Cancelled)
        );
        // Stops at max_time before landing: not landed, no landing event.
        let f = simulate_flight(veh, &rec, &opts(3.0), &mut |_| true).unwrap();
        assert!(!f.landed);
        assert!(!f.events.iter().any(|e| e.kind == EventKind::Landing));
        assert!((f.samples.last().unwrap().t - 3.0).abs() < 1e-12);
        // A full run lands, with the progress fraction reaching ~1 at most.
        let mut last = 0.0;
        let f = simulate_flight(veh, &rec, &opts(100.0), &mut |p| {
            last = p;
            true
        })
        .unwrap();
        assert!(f.landed && last <= 1.0 + 1e-12);
    });
    // Too weak to lift off: the rail phase reaches max_time.
    let weak = mounted(constant_motor(0.5, 1.0, 0.001, 0.001), 0.0, 1);
    with_vehicle(&[weak], |veh| {
        assert!(matches!(
            simulate_flight(veh, &rec, &opts(5.0), &mut |_| true),
            Err(SimError::Integration { .. })
        ));
    });
}
