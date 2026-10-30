//! Motor mass, CG, and inertia over the burn (MM-05..MM-09) through
//! `MassModel::at`.

mod common;

use common::{assert_close, comp, model};
use rw_mass::MassModel;
use rw_motor::{MountedMotor, generic::generic_motor};
use serde_json::json;

fn setup(count: u32, ignition: f64) -> (MassModel, MountedMotor) {
    let curve = generic_motor("RW_C6G").expect("generic C6");
    let mut mount = comp(
        "mmt",
        Some("tube"),
        0.5,
        0.57,
        json!({"type": "inner_tube", "length": 0.07, "od": 0.019, "id": 0.018,
               "motor_mount": true, "overhang": 0.0}),
    );
    mount["containment"] = json!("inner");
    let mdl = model(
        vec![
            comp(
                "tube",
                None,
                0.0,
                0.6,
                json!({"type": "body_tube", "length": 0.6, "od": 0.025, "id": 0.023}),
            ),
            mount,
        ],
        680.0,
    );
    let g = rw_geom::build(&mdl);
    let m = MountedMotor {
        mount: "mmt".into(),
        curve,
        x_fore: 0.5,
        ignition_time: ignition,
        delay: Some(3.0),
        count,
    };
    (MassModel::new(&mdl, &g, std::slice::from_ref(&m)), m)
}

#[test]
fn loaded_burning_and_burnt_out() {
    let (mm, m) = setup(1, 0.0);
    let c = &m.curve;
    let dry = mm.dry();
    let at0 = mm.at(0.0);
    assert_close("m(0)", at0.mass, dry.mass + c.total_mass, 1e-12);
    let end = mm.at(c.burn_time + 1.0);
    assert_close(
        "m(end)",
        end.mass,
        dry.mass + c.total_mass - c.prop_mass,
        1e-12,
    );
    // Mid-burn: the curve's mass (`.rse` samples, linear) follows
    // m = dry + prop (1 − I(t)/I_tot) (MM-05/MM-06) to the sample spacing.
    let t = 0.5 * c.burn_time;
    let want = c.mass_at(t);
    assert_close("m(t)", mm.at(t).mass - dry.mass, want, 1e-12);
    let law = c.total_mass - c.prop_mass * c.impulse_at(t) / c.total_impulse;
    assert_close("MM-05", want, law, 1e-4);
    // CG (MI-31): (m_dry x_dry + m_mot x_mot) / (m_dry + m_mot).
    let xm = m.x_fore + c.cg_at(t);
    let mt = mm.at(t);
    assert_close(
        "cg(t)",
        mt.cg,
        (dry.mass * dry.cg + want * xm) / mt.mass,
        1e-12,
    );
    // Monotone mass, inertia shrinking with it once the motor burns.
    let mut last = f64::INFINITY;
    for k in 0..=40 {
        let mk = mm.at(c.burn_time * k as f64 / 40.0).mass;
        assert!(mk <= last + 1e-15);
        last = mk;
    }
    assert!(end.ixx < at0.ixx);
}

#[test]
fn before_ignition_holds_loaded_mass() {
    let (mm, m) = setup(1, 2.0);
    assert_close(
        "m",
        mm.at(1.0).mass,
        mm.dry().mass + m.curve.total_mass,
        1e-12,
    );
    assert_close("m", mm.at(2.0).mass, mm.at(0.0).mass, 1e-12);
    assert!(mm.at(2.0 + 0.5 * m.curve.burn_time).mass < mm.at(0.0).mass);
}

/// MM-09: the motor alone is a solid cylinder with its current mass.
#[test]
fn motor_inertia_is_solid_cylinder() {
    let (mm, m) = setup(1, 0.0);
    let b = mm.motors_at(0.0);
    let (r, l, mass) = (m.curve.diameter / 2.0, m.curve.length, m.curve.total_mass);
    assert_close("Ixx", b.inertia[0][0], mass * r * r / 2.0, 1e-12);
    assert_close(
        "Iyy",
        b.inertia[1][1],
        mass * (3.0 * r * r + l * l) / 12.0,
        1e-12,
    );
}

#[test]
fn cluster_count_multiplies() {
    let (one, m) = setup(1, 0.0);
    let (three, _) = setup(3, 0.0);
    let d = three.at(0.0).mass - one.at(0.0).mass;
    assert_close("2 more motors", d, 2.0 * m.curve.total_mass, 1e-12);
}
