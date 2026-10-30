//! Mass properties of analytic shapes against the closed forms of the
//! literature map (MI rows), within 1e-9 relative (Acc 2).

mod common;

use std::f64::consts::PI;

use common::{assert_close, build, comp, model};
use rw_geom::ProfilePoint;
use rw_mass::revolve::{shell_moments, solid_moments};
use serde_json::json;

const TOL: f64 = 1e-9;

fn p(x: f64, r: f64) -> ProfilePoint {
    ProfilePoint { x, r }
}

/// MI-09..MI-11: solid cone, apex at x = 0.
#[test]
fn solid_cone() {
    let (r, l, x0) = (0.04, 0.3, 0.1);
    let m = solid_moments(&[p(x0, 0.0), p(x0 + l, r)]);
    let mass = PI * r * r * l / 3.0;
    assert_close("V", m.m, mass, TOL);
    assert_close("cg", m.cg(), x0 + 0.75 * l, TOL);
    assert_close("Ixx", m.ixx(), 0.3 * mass * r * r, TOL);
    assert_close("Iyy", m.iyy(), 0.15 * mass * (r * r + l * l / 4.0), TOL);
}

/// MI-12..MI-14: solid frustum; I_yy as the difference of two cones.
#[test]
fn solid_frustum() {
    let (r0, r1, l) = (0.05, 0.02, 0.12);
    let m = solid_moments(&[p(0.0, r0), p(l, r1)]);
    let v = PI * l / 3.0 * (r0 * r0 + r1 * r1 + r0 * r1);
    assert_close("V", m.m, v, TOL);
    let xcg = l * (r0 * r0 + 2.0 * r0 * r1 + 3.0 * r1 * r1) / (4.0 * (r0 * r0 + r0 * r1 + r1 * r1));
    assert_close("cg", m.cg(), xcg, TOL);
    let ixx = 0.3 * v * (r0.powi(5) - r1.powi(5)) / (r0.powi(3) - r1.powi(3));
    assert_close("Ixx", m.ixx(), ixx, TOL);
    // Big cone (apex at x = H) minus the small cone beyond x = l.
    let h = l * r0 / (r0 - r1);
    let cone = |r: f64, len: f64, x_base: f64| {
        let mass = PI * r * r * len / 3.0;
        let cg = x_base + 0.25 * len; // apex aft of the base
        (mass, cg, 0.15 * mass * (r * r + len * len / 4.0))
    };
    let (mb, cb, ib) = cone(r0, h, 0.0);
    let (ms, cs, is) = cone(r1, h - l, l);
    let iyy = ib + mb * (cb - xcg).powi(2) - (is + ms * (cs - xcg).powi(2));
    assert_close("Iyy", m.iyy(), iyy, TOL);
}

/// Thin conical shell (derived from MI-08 with dm = σ dA): CG 2L/3 from the
/// apex, I_xx = m r²/2, I_yy = m (r²/4 + L²/18).
#[test]
fn thin_cone_shell() {
    let (r, l) = (0.03, 0.2);
    let m = shell_moments(&[p(0.0, 0.0), p(l, r)]);
    let mass = PI * r * (r * r + l * l).sqrt();
    assert_close("A", m.m, mass, TOL);
    assert_close("cg", m.cg(), 2.0 * l / 3.0, TOL);
    assert_close("Ixx", m.ixx(), mass * r * r / 2.0, TOL);
    assert_close("Iyy", m.iyy(), mass * (r * r / 4.0 + l * l / 18.0), TOL);
}

fn single(shape: serde_json::Value, len: f64, rho: f64) -> rw_mass::ComponentMass {
    let mdl = model(vec![comp("a", None, 0.0, len, shape)], rho);
    let (_, mm) = build(&mdl);
    mm.breakdown().remove(0)
}

/// MI-18/MI-19: annular tube through the full pipeline (rw-geom → rw-mass).
#[test]
fn body_tube_end_to_end() {
    let (od, id, l, rho) = (0.066, 0.062, 0.6, 1850.0);
    let c = single(
        json!({"type": "body_tube", "length": l, "od": od, "id": id}),
        l,
        rho,
    );
    let (ro, ri) = (od / 2.0, id / 2.0);
    let mass = rho * PI * (ro * ro - ri * ri) * l;
    assert_close("m", c.mass, mass, TOL);
    assert_close("cg", c.cg, l / 2.0, TOL);
    assert_close("Ixx", c.ixx, mass * (ro * ro + ri * ri) / 2.0, TOL);
    assert_close(
        "Iyy",
        c.iyy,
        mass * (3.0 * ro * ro + 3.0 * ri * ri + l * l) / 12.0,
        TOL,
    );
    assert!(!c.overridden);
}

/// MI-09..MI-11 through the pipeline: a solid conical nose.
#[test]
fn conical_nose_end_to_end() {
    let (od, l, rho) = (0.05, 0.15, 1050.0);
    let shape = json!({"type": "nose_cone", "shape": "conical", "shape_param": 0.0,
        "length": l, "od": od, "thickness": 0.0});
    let c = single(shape, l, rho);
    let r = od / 2.0;
    let mass = rho * PI * r * r * l / 3.0;
    assert_close("m", c.mass, mass, TOL);
    assert_close("cg", c.cg, 0.75 * l, TOL);
    assert_close("Ixx", c.ixx, 0.3 * mass * r * r, TOL);
    assert_close("Iyy", c.iyy, 0.15 * mass * (r * r + l * l / 4.0), TOL);
}

/// MI-15/MI-16: solid paraboloid (power series n = 1/2) through the pipeline.
#[test]
fn paraboloid_nose_end_to_end() {
    let (od, l, rho) = (0.04, 0.12, 1000.0);
    let shape = json!({"type": "nose_cone", "shape": "power", "shape_param": 0.5,
        "length": l, "od": od, "thickness": 0.0});
    let c = single(shape, l, rho);
    let r = od / 2.0;
    let mass = rho * PI * l * r * r / 2.0;
    assert_close("m", c.mass, mass, TOL);
    assert_close("cg", c.cg, l - l / 3.0, TOL);
    assert_close("Ixx", c.ixx, mass * r * r / 3.0, TOL);
    assert_close("Iyy", c.iyy, mass * (3.0 * r * r + l * l) / 18.0, TOL);
}

/// MI-06 (corrected per Errata): solid tangent-ogive volume
/// V = π d³ [f (f² + 1/4)² − f³/3 − (f² − 1/4)(f² + 1/4)² asin(f/(f² + 1/4))].
#[test]
fn tangent_ogive_volume() {
    let (od, l, rho) = (0.025, 0.1, 1.0);
    let shape = json!({"type": "nose_cone", "shape": "ogive", "shape_param": 1.0,
        "length": l, "od": od, "thickness": 0.0});
    let c = single(shape, l, rho);
    let f = l / od;
    let q = f * f + 0.25;
    let rhs = f * q * q - f.powi(3) / 3.0 - (f * f - 0.25) * q * q * (f / q).asin();
    assert_close("V", c.mass / rho, PI * od.powi(3) * rhs, TOL);
}

/// MI-05/MI-25: a solid cylinder (bulkhead) and a hollow-minus-cavity ring.
#[test]
fn bulkhead_and_ring() {
    let (od, l, rho) = (0.05, 0.006, 630.0);
    let c = single(json!({"type": "bulkhead", "length": l, "od": od}), l, rho);
    let r = od / 2.0;
    let mass = rho * PI * r * r * l;
    assert_close("m", c.mass, mass, TOL);
    assert_close("Ixx", c.ixx, mass * r * r / 2.0, TOL);
    assert_close("Iyy", c.iyy, mass * (3.0 * r * r + l * l) / 12.0, TOL);
}

// ---- fins -------------------------------------------------------------------

struct Trap {
    cr: f64,
    ct: f64,
    s: f64,
    sweep: f64,
    t: f64,
    x_le: f64,
}

impl Trap {
    fn area(&self) -> f64 {
        0.5 * (self.cr + self.ct) * self.s
    }
    /// Gaps item 2: x̄ from the root LE = [x_t (c_r + 2c_t) + c_r² + c_r c_t + c_t²] / (3 (c_r + c_t)).
    fn x_cg(&self) -> f64 {
        let (cr, ct, xt) = (self.cr, self.ct, self.sweep);
        self.x_le + (xt * (cr + 2.0 * ct) + cr * cr + cr * ct + ct * ct) / (3.0 * (cr + ct))
    }
    /// ∫ (x − x̄)² dA by Simpson in y (exact: the integrand is cubic in y).
    fn var_x_area(&self) -> f64 {
        let xc = self.x_cg();
        let strip = |y: f64| {
            let le = self.x_le + self.sweep * y / self.s;
            let te = self.x_le + self.cr + (self.sweep + self.ct - self.cr) * y / self.s;
            ((te - xc).powi(3) - (le - xc).powi(3)) / 3.0
        };
        self.s / 6.0 * (strip(0.0) + 4.0 * strip(self.s / 2.0) + strip(self.s))
    }
}

fn fin_model(tr: &Trap, rho: f64, extra: serde_json::Value) -> rw_model::EvaluatedModel {
    let (od, len) = (0.05, 0.4);
    let mut fins = json!({"type": "trapezoidal_fin_set", "count": 3, "thickness": tr.t,
        "cross_section": "square", "cant": 0.0, "fillet_radius": 0.0,
        "root_chord": tr.cr, "tip_chord": tr.ct, "span": tr.s, "sweep": tr.sweep});
    for (k, v) in extra.as_object().unwrap() {
        fins[k] = v.clone();
    }
    let mut f = comp("fins", Some("tube"), tr.x_le, tr.x_le + tr.cr, fins);
    f["containment"] = json!("surface");
    f["instances"] = json!([]);
    model(
        vec![
            comp(
                "tube",
                None,
                0.0,
                len,
                json!({"type": "body_tube", "length": len, "od": od, "id": 0.048}),
            ),
            f,
        ],
        rho,
    )
}

const TRAP: Trap = Trap {
    cr: 0.08,
    ct: 0.03,
    s: 0.06,
    sweep: 0.04,
    t: 0.003,
    x_le: 0.3,
};

fn fin_entry(mdl: &rw_model::EvaluatedModel) -> rw_mass::ComponentMass {
    let (_, mm) = build(mdl);
    mm.breakdown().into_iter().find(|c| c.id == "fins").unwrap()
}

/// MI-20..MI-22 with the Errata cross term: a 3-fin trapezoidal set.
#[test]
fn trapezoidal_fin_set() {
    let rho = 1800.0;
    let c = fin_entry(&fin_model(&TRAP, rho, json!({})));
    let rt = 0.025;
    let m1 = rho * TRAP.t * TRAP.area();
    assert_close("m", c.mass, 3.0 * m1, TOL);
    assert_close("x_cg", c.cg, TRAP.x_cg(), TOL);
    let lambda = TRAP.ct / TRAP.cr;
    // Corrected roll inertia per fin, plus the plate thickness term m t²/12.
    let exact = rw_mass::fins::trapezoid_fin_roll_inertia(m1, TRAP.s, lambda, rt);
    let ixx = 3.0 * (exact + m1 * TRAP.t * TRAP.t / 12.0);
    assert_close("Ixx", c.ixx, ixx, TOL);
    // The printed table value drops 2 r_t η̄ m; the integral keeps it.
    let printed = m1 * (TRAP.s * TRAP.s / 6.0 * (1.0 + 3.0 * lambda) / (1.0 + lambda) + rt * rt);
    let eta = rw_mass::fins::trapezoid_span_cg(TRAP.s, lambda);
    assert_close(
        "Errata cross term",
        exact - printed,
        2.0 * rt * eta * m1,
        TOL,
    );
    // Three fins 120° apart: I_yy = Σ m σ_x² + I_xx/2.
    let iyy = 3.0 * rho * TRAP.t * TRAP.var_x_area() + 0.5 * ixx;
    assert_close("Iyy", c.iyy, iyy, TOL);
}

/// Tabs add a rectangle below the root (y ∈ [−h, 0]).
#[test]
fn fin_tab_mass_and_cg() {
    let rho = 1800.0;
    let (h, len, off) = (0.002, 0.05, 0.01);
    let plain = fin_entry(&fin_model(&TRAP, rho, json!({})));
    let tabbed = fin_entry(&fin_model(
        &TRAP,
        rho,
        json!({"tab": {"height": h, "length": len, "offset": off}}),
    ));
    let mt = 3.0 * rho * TRAP.t * h * len;
    assert_close("m", tabbed.mass, plain.mass + mt, TOL);
    let x_tab = TRAP.x_le + off + len / 2.0;
    let cg = (plain.mass * plain.cg + mt * x_tab) / (plain.mass + mt);
    assert_close("cg", tabbed.cg, cg, TOL);
}

/// Root fillets: two spandrels of area r²(1 − π/4) along each root chord.
#[test]
fn fin_fillet_mass() {
    let rho = 1800.0;
    let r = 0.005;
    let plain = fin_entry(&fin_model(&TRAP, rho, json!({})));
    let filleted = fin_entry(&fin_model(&TRAP, rho, json!({"fillet_radius": r})));
    let mf = 3.0 * 2.0 * rho * r * r * (1.0 - PI / 4.0) * TRAP.cr;
    assert_close("m", filleted.mass, plain.mass + mf, TOL);
    let cg = (plain.mass * plain.cg + mf * (TRAP.x_le + TRAP.cr / 2.0)) / (plain.mass + mf);
    assert_close("cg", filleted.cg, cg, TOL);
}

/// Cant rotates each plate about its span axis through the root mid-chord:
/// the mass is unchanged and ±δ give the same CG and inertias.
#[test]
fn fin_cant_symmetry() {
    let rho = 1800.0;
    let a = fin_entry(&fin_model(&TRAP, rho, json!({"cant": 0.05})));
    let b = fin_entry(&fin_model(&TRAP, rho, json!({"cant": -0.05})));
    let z = fin_entry(&fin_model(&TRAP, rho, json!({})));
    assert_close("m", a.mass, z.mass, 1e-12);
    assert_close("cg ±δ", a.cg, b.cg, 1e-12);
    assert_close("Ixx ±δ", a.ixx, b.ixx, 1e-12);
    assert_close("Iyy ±δ", a.iyy, b.iyy, 1e-12);
    assert!(a.ixx > z.ixx, "cant swings chord mass away from the axis");
}

/// MI-12..MI-14 through the pipeline: a solid conical transition (boattail).
#[test]
fn conical_transition_end_to_end() {
    let (fore, aft, l, rho) = (0.05, 0.03, 0.08, 700.0);
    let shape = json!({"type": "transition", "shape": "conical", "shape_param": 0.0,
        "length": l, "fore_od": fore, "aft_od": aft, "thickness": 0.0});
    let c = single(shape, l, rho);
    let (r0, r1) = (fore / 2.0, aft / 2.0);
    let v = PI * l / 3.0 * (r0 * r0 + r1 * r1 + r0 * r1);
    assert_close("m", c.mass, rho * v, TOL);
    let xcg = l * (r0 * r0 + 2.0 * r0 * r1 + 3.0 * r1 * r1) / (4.0 * (r0 * r0 + r0 * r1 + r1 * r1));
    assert_close("cg", c.cg, xcg, TOL);
    let ixx = 0.3 * rho * v * (r0.powi(5) - r1.powi(5)) / (r0.powi(3) - r1.powi(3));
    assert_close("Ixx", c.ixx, ixx, TOL);
}

/// A hollow ogive weighs ρ × the rw-geom material volume, and a thin wall
/// approaches the thin-shell moments of the outer surface (MI-07).
#[test]
fn hollow_nose_consistent_with_geometry_and_thin_shell() {
    let (od, l, t, rho) = (0.05, 0.2, 0.0005, 1000.0);
    let shape = json!({"type": "nose_cone", "shape": "ogive", "shape_param": 1.0,
        "length": l, "od": od, "thickness": t});
    let mdl = model(vec![comp("a", None, 0.0, l, shape)], rho);
    let (g, mm) = build(&mdl);
    let c = mm.breakdown().remove(0);
    assert_close("m = ρV", c.mass, rho * g.components[0].volume, 1e-12);
    let thin = shell_moments(&g.components[0].outer).scaled(rho * t);
    assert!(
        common::close(c.mass, thin.m, 0.02),
        "{} vs {}",
        c.mass,
        thin.m
    );
    assert!(
        common::close(c.cg, thin.cg(), 0.01),
        "{} vs {}",
        c.cg,
        thin.cg()
    );
    assert!(
        common::close(c.ixx, thin.ixx(), 0.03),
        "{} vs {}",
        c.ixx,
        thin.ixx()
    );
}

/// Parachute: canopy σ·π(d² − d_s²)/4 plus shroud lines
/// `line_count · line_length · λ(line_material)`.
#[test]
fn parachute_canopy_and_shroud_lines() {
    let shape = |lines: u32| {
        json!({"type": "parachute", "diameter": 0.3, "cd": 0.8, "spill_hole": 0.05,
            "packed_length": 0.04, "packed_diameter": 0.02,
            "line_count": lines, "line_length": 0.3, "line_material": "cord"})
    };
    let mass = |lines: u32| {
        let mut mdl = model(vec![comp("a", None, 0.0, 0.04, shape(lines))], 0.0);
        mdl.materials.insert(
            "m".into(),
            serde_json::from_value(json!({ "surface_density": 0.067 })).unwrap(),
        );
        mdl.materials.insert(
            "cord".into(),
            serde_json::from_value(json!({ "line_density": 1.8e-3 })).unwrap(),
        );
        let (_, mm) = build(&mdl);
        mm.breakdown().remove(0).mass
    };
    let canopy = 0.067 * PI * (0.3 * 0.3 - 0.05 * 0.05) / 4.0;
    assert_close("canopy", mass(0), canopy, TOL);
    assert_close("canopy + lines", mass(6), canopy + 6.0 * 0.3 * 1.8e-3, TOL);
}

/// Exact moments (m/ρ, ∫x dm/ρ) of the solid inside the inward normal offset
/// by `t` of the ellipsoid r = R sin θ, x = L(1 − cos θ), θ ∈ [0, π/2]
/// (fine frusta on the parametric offset, clipped to r ≥ 0).
fn ellipsoid_offset_solid(l: f64, r: f64, t: f64) -> (f64, f64) {
    let n = 200_000;
    let pts: Vec<(f64, f64)> = (0..=n)
        .map(|i| {
            let th = i as f64 / n as f64 * PI / 2.0;
            let (x, y) = (l * (1.0 - th.cos()), r * th.sin());
            let (tx, ty) = (l * th.sin(), r * th.cos());
            let k = t / tx.hypot(ty);
            (x + k * ty, y - k * tx)
        })
        .filter(|p| p.1 >= 0.0)
        .collect();
    let (mut v, mut vx) = (0.0, 0.0);
    for w in pts.windows(2) {
        let ((x0, r0), (x1, r1)) = (w[0], w[1]);
        let dv = PI * (x1 - x0) / 3.0 * (r0 * r0 + r0 * r1 + r1 * r1);
        v += dv;
        vx += dv * 0.5 * (x0 + x1);
    }
    (v, vx)
}

/// MI-07 + MI-18 + MI-25 on the case-3 nose (ellipsoid 100 mm × 55 mm,
/// 2 mm wall, capped 35 mm × 48 mm shoulder with a 2 mm wall): wall = outer
/// half-spheroid (V = 2πR²L/3) minus its exact inward offset, plus the
/// shoulder annulus and cap disc, with no material at the joint. Thin walls
/// approach ρ A_wet t with the closed-form half-spheroid area.
#[test]
fn ellipsoid_nose_shell_and_shoulder() {
    let (l, od, t, rho) = (0.1, 0.055, 0.002, 1050.0);
    let r = 0.5 * od;
    let (sl, sr, st) = (0.035, 0.024, 0.002);
    let shape = json!({"type": "nose_cone", "shape": "ellipsoid", "shape_param": 0.0,
        "length": l, "od": od, "thickness": t,
        "shoulder": {"length": sl, "od": 2.0 * sr, "thickness": st, "capped": true}});
    let c = single(shape, l, rho);
    let (vc, vcx) = ellipsoid_offset_solid(l, r, t);
    let v_out = 2.0 * PI * r * r * l / 3.0;
    let vx_out = v_out * 5.0 * l / 8.0; // half-spheroid centroid 3L/8 from the base
    let bore = sr - st;
    let v_ann = PI * (sr * sr - bore * bore) * sl;
    let v_cap = PI * bore * bore * st;
    let v = v_out - vc + v_ann + v_cap;
    let vx = vx_out - vcx + v_ann * (l + 0.5 * sl) + v_cap * (l + sl - 0.5 * st);
    // rw-geom integrates the cavity volume on 800 segments (1e-4 relative);
    // the cavity's shape is the 40-segment published polyline (CG 0.05 mm).
    assert_close("mass", c.mass, rho * v, 1e-4);
    assert!((c.cg - vx / v).abs() < 5e-5, "cg {} vs {}", c.cg, vx / v);

    // Thin wall, no shoulder: ρ A_wet t, A_wet = πR²(1 + L asin(e)/(R e)).
    let t = 1e-5;
    let shape = json!({"type": "nose_cone", "shape": "ellipsoid", "shape_param": 0.0,
        "length": l, "od": od, "thickness": t});
    let c = single(shape, l, rho);
    let e = (1.0 - r * r / (l * l)).sqrt();
    let area = PI * r * r * (1.0 + l * e.asin() / (r * e));
    assert_close("thin mass", c.mass, rho * area * t, 2e-3);
}
