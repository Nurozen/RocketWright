//! Parallel-axis composition (MI-24, MI-27..MI-29), off-axis parts and the
//! principal-axis solver.

mod common;

use std::f64::consts::PI;

use common::{assert_close, build, comp, model};
use rw_mass::{RigidBody, eigen};
use serde_json::json;

fn tube(id: &str, parent: Option<&str>, x0: f64, l: f64) -> serde_json::Value {
    comp(
        id,
        parent,
        x0,
        x0 + l,
        json!({"type": "body_tube", "length": l, "od": 0.05, "id": 0.046}),
    )
}

/// Two tubes end to end compose to one tube of twice the length.
#[test]
fn two_tubes_equal_one() {
    let rho = 1200.0;
    let (_, two) = build(&model(
        vec![tube("a", None, 0.0, 0.3), tube("b", Some("a"), 0.3, 0.3)],
        rho,
    ));
    let (_, one) = build(&model(vec![tube("a", None, 0.0, 0.6)], rho));
    let (a, b) = (two.dry(), one.dry());
    assert_close("m", a.mass, b.mass, 1e-12);
    assert_close("cg", a.cg, b.cg, 1e-12);
    assert_close("Ixx", a.ixx, b.ixx, 1e-12);
    assert_close("Iyy", a.iyy, b.iyy, 1e-12);
}

/// MI-29 by hand: conical nose (MI-11) + tube (MI-19).
#[test]
fn nose_plus_tube_by_hand() {
    let rho = 1000.0;
    let (od, ln, lt) = (0.05, 0.15, 0.5);
    let nose = comp(
        "nose",
        None,
        0.0,
        ln,
        json!({"type": "nose_cone", "shape": "conical",
        "shape_param": 0.0, "length": ln, "od": od, "thickness": 0.0}),
    );
    let body = comp(
        "tube",
        Some("nose"),
        ln,
        ln + lt,
        json!({"type": "body_tube", "length": lt, "od": od, "id": 0.046}),
    );
    let (_, mm) = build(&model(vec![nose, body], rho));
    let r = od / 2.0;
    let m1 = rho * PI * r * r * ln / 3.0;
    let (x1, i1) = (0.75 * ln, 0.15 * m1 * (r * r + ln * ln / 4.0));
    let ri = 0.023;
    let m2 = rho * PI * (r * r - ri * ri) * lt;
    let (x2, i2) = (
        ln + lt / 2.0,
        m2 * (3.0 * r * r + 3.0 * ri * ri + lt * lt) / 12.0,
    );
    let m = m1 + m2;
    let x = (m1 * x1 + m2 * x2) / m;
    // MI-29: I = Σ (m_i x_i² + I_i) − x_cg² Σ m_i.
    let iyy = m1 * x1 * x1 + i1 + m2 * x2 * x2 + i2 - x * x * m;
    let ixx = 0.3 * m1 * r * r + m2 * (r * r + ri * ri) / 2.0;
    let d = mm.dry();
    assert_close("m", d.mass, m, 1e-9);
    assert_close("cg", d.cg, x, 1e-9);
    assert_close("Ixx", d.ixx, ixx, 1e-9);
    assert_close("Iyy", d.iyy, iyy, 1e-9);
    // The breakdown recombines to the totals.
    let parts: Vec<RigidBody> = mm
        .breakdown()
        .iter()
        .map(|c| RigidBody::axisymmetric(c.mass, [c.cg, 0.0, 0.0], c.ixx, c.iyy))
        .collect();
    let s = RigidBody::combine(&parts).props();
    assert_close("Σ breakdown Iyy", s.iyy, d.iyy, 1e-12);
}

/// A launch lug on +Y makes the tensor non-diagonal; the Jacobi principal
/// moments are its eigenvalues and keep the trace.
#[test]
fn off_axis_lug_principal_axes() {
    let rho = 1000.0;
    let mut lug = comp(
        "lug",
        Some("a"),
        0.5,
        0.55,
        json!({"type": "launch_lug", "length": 0.05, "od": 0.01, "id": 0.008}),
    );
    lug["containment"] = json!("surface");
    let (g, mm) = build(&model(vec![tube("a", None, 0.0, 0.6), lug], rho));
    let lug_g = g.components.iter().find(|c| c.id == "lug").unwrap();
    assert!(
        lug_g.instances[0].offset[1] > 0.02,
        "lug sits on the tube surface"
    );
    let b = mm.dry_body();
    assert!(b.cg[1] > 0.0);
    assert!(b.inertia[0][1].abs() > 0.0 && b.inertia[0][1] == b.inertia[1][0]);
    let p = mm.principal_at(0.0);
    let tr = b.inertia[0][0] + b.inertia[1][1] + b.inertia[2][2];
    assert_close("trace", p.moments.iter().sum::<f64>(), tr, 1e-12);
    for k in 0..3 {
        let v = p.axes[k];
        for i in 0..3 {
            let av: f64 = (0..3).map(|j| b.inertia[i][j] * v[j]).sum();
            assert!((av - p.moments[k] * v[i]).abs() < 1e-12 * tr);
        }
    }
    // Same as calling the solver directly.
    let (vals, _) = eigen::jacobi_eigen(&b.inertia);
    assert_eq!(vals, p.moments);
}

/// Three fins 120° apart: I_yy = I_zz and no products of inertia.
#[test]
fn symmetric_fins_are_axisymmetric() {
    let mut fins = comp(
        "fins",
        Some("a"),
        0.45,
        0.55,
        json!({"type": "trapezoidal_fin_set",
        "count": 3, "thickness": 0.003, "cross_section": "square", "cant": 0.0,
        "fillet_radius": 0.004, "root_chord": 0.1, "tip_chord": 0.04, "span": 0.06,
        "sweep": 0.05, "tab": {"height": 0.002, "length": 0.06, "offset": 0.02}}),
    );
    fins["instances"] = json!([]);
    let (_, mm) = build(&model(vec![tube("a", None, 0.0, 0.6), fins], 1500.0));
    let b = mm.dry_body();
    let s = b.inertia[1][1].abs();
    assert!((b.inertia[1][1] - b.inertia[2][2]).abs() < 1e-12 * s);
    for (i, j) in [(0, 1), (0, 2), (1, 2)] {
        assert!(
            b.inertia[i][j].abs() < 1e-12 * s,
            "I[{i}][{j}] = {}",
            b.inertia[i][j]
        );
    }
    assert!(b.cg[1].abs() < 1e-15 && b.cg[2].abs() < 1e-15);
}

/// Cut components remove their volume of the parent's material (MI-25).
#[test]
fn cut_removes_parent_material() {
    let rho = 1000.0;
    let mut cut = comp(
        "hole",
        Some("a"),
        0.2,
        0.3,
        json!({"type": "bulkhead", "length": 0.1, "od": 0.04}),
    );
    cut["cut"] = json!(true);
    cut.as_object_mut().unwrap().remove("material");
    let (_, with) = build(&model(
        vec![
            comp(
                "a",
                None,
                0.0,
                0.5,
                json!({"type": "bulkhead", "length": 0.5, "od": 0.05}),
            ),
            cut,
        ],
        rho,
    ));
    let want = rho * PI * (0.025f64.powi(2) * 0.5 - 0.02f64.powi(2) * 0.1);
    assert_close("m", with.dry().mass, want, 1e-12);
    let hole = with
        .breakdown()
        .into_iter()
        .find(|c| c.id == "hole")
        .unwrap();
    assert!(hole.mass < 0.0);
}
