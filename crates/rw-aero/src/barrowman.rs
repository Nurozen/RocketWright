//! Barrowman body normal force and CP (nose, body tube, transitions) with the
//! Galejs body-lift term, and the CP combination (Niskanen 2009 §3.2,
//! Barrowman 1967 §3). Notation follows `docs/dev/literature-map.md`.
//!
//! The hand cases at the bottom check the whole Barrowman chain (bodies, fins,
//! interference, combination) against closed forms from the sources.

use std::f64::consts::PI;

use rw_geom::nose::{shape_radius, transition_radius};
use rw_model::{EvalShape, NoseShape};

/// Body-lift constant K ≈ 1.1 (Galejs).
pub const K_LIFT: f64 = 1.1;

/// Simpson panels used for the profile integrals.
const PANELS: usize = 2000;

/// Kind of an axisymmetric body component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Nose,
    Tube,
    Transition,
}

/// One body component of the external axial chain, with the profile
/// integrals the Barrowman terms need.
#[derive(Debug, Clone, PartialEq)]
pub struct BodySegment {
    pub id: String,
    pub kind: BodyKind,
    /// Profile shape (nose and transition); `None` for a tube.
    pub shape: Option<(NoseShape, f64)>,
    pub x_fore: f64,
    pub length: f64,
    /// Fore and aft radii r_0, r_1.
    pub r0: f64,
    pub r1: f64,
    /// Enclosed volume of the shaped length V_c = π∫r² dx.
    pub volume: f64,
    /// Side-projected planform area A_plan = ∫2r dx.
    pub planform: f64,
    /// Planform centroid from the component front, X_lift.
    pub planform_x: f64,
}

impl BodySegment {
    /// Builds the body component of an evaluated shape (shoulders are inside
    /// the neighbouring tube and take no part in the external flow).
    /// `None` for shapes that are not part of the axial body.
    /// cite: niskanen-2009 eq 3.27 p 34
    pub fn from_shape(id: &str, x_fore: f64, shape: &EvalShape) -> Option<Self> {
        let (kind, sh, length, r0, r1) = match shape {
            EvalShape::NoseCone {
                shape,
                shape_param,
                length,
                od,
                ..
            } => (
                BodyKind::Nose,
                Some((*shape, *shape_param)),
                *length,
                0.0,
                0.5 * od,
            ),
            EvalShape::BodyTube { length, od, .. } => {
                (BodyKind::Tube, None, *length, 0.5 * od, 0.5 * od)
            }
            EvalShape::Transition {
                shape,
                shape_param,
                length,
                fore_od,
                aft_od,
                ..
            } => (
                BodyKind::Transition,
                Some((*shape, *shape_param)),
                *length,
                0.5 * fore_od,
                0.5 * aft_od,
            ),
            _ => return None,
        };
        let mut c = Self {
            id: id.to_string(),
            kind,
            shape: sh,
            x_fore,
            length: length.max(0.0),
            r0,
            r1,
            volume: 0.0,
            planform: 0.0,
            planform_x: 0.0,
        };
        let (v, a, m) = profile_integrals(|x| c.radius(x), c.length);
        c.volume = v;
        c.planform = a;
        c.planform_x = if a > 0.0 { m / a } else { 0.5 * c.length };
        Some(c)
    }

    /// Outer radius at distance `x` from the component front.
    /// cite: niskanen-2009 sec A.1 p 110-113
    pub fn radius(&self, x: f64) -> f64 {
        match (self.kind, self.shape) {
            (BodyKind::Nose, Some((s, p))) => shape_radius(s, p, self.length, self.r1, x),
            (BodyKind::Transition, Some((s, p))) => {
                transition_radius(s, p, self.length, self.r0, self.r1, x)
            }
            _ => self.r0,
        }
    }

    /// Fore and aft cross-section areas A_0, A_1.
    /// cite: n/a circle area
    pub fn areas(&self) -> (f64, f64) {
        (PI * self.r0 * self.r0, PI * self.r1 * self.r1)
    }

    /// Normal-force slope at α → 0 on `a_ref`.
    /// cite: niskanen-2009 eq 3.19 p 32
    pub fn cna0(&self, a_ref: f64) -> f64 {
        let (a0, a1) = self.areas();
        body_cna(a0, a1, a_ref)
    }

    /// Potential-flow CP station (from the nose tip).
    /// cite: niskanen-2009 eq 3.28 p 34
    pub fn cp(&self) -> f64 {
        let (a0, a1) = self.areas();
        self.x_fore + body_cp(self.length, a0, a1, self.volume)
    }

    /// Normal force at α: potential term (2/A_ref)(A_1 − A_0) sin α plus the
    /// body-lift term, with its CP. Returns (C_N, X_cp from the nose tip).
    /// cite: niskanen-2009 eq 3.26 p 34
    pub fn cn_at(&self, a_ref: f64, alpha: f64) -> (f64, f64) {
        let (a0, a1) = self.areas();
        let pot = body_cn(a0, a1, a_ref, alpha);
        let lift = body_lift_cn(self.planform, a_ref, alpha);
        let x_lift = self.x_fore + self.planform_x;
        combine(&[(pot, self.cp()), (lift, x_lift)]).map_or((0.0, self.cp()), |x| (pot + lift, x))
    }
}

/// Volume π∫r² dx, planform ∫2r dx, and planform moment ∫2r x dx over `[0, len]`
/// (composite Simpson).
/// cite: niskanen-2009 eq 3.27 p 34
pub fn profile_integrals(r: impl Fn(f64) -> f64, len: f64) -> (f64, f64, f64) {
    if len <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let h = len / PANELS as f64;
    let (mut v, mut a, mut m) = (0.0, 0.0, 0.0);
    for k in 0..=PANELS {
        let x = k as f64 * h;
        let w = if k == 0 || k == PANELS {
            1.0
        } else if k % 2 == 1 {
            4.0
        } else {
            2.0
        };
        let rr = r(x).max(0.0);
        v += w * PI * rr * rr;
        a += w * 2.0 * rr;
        m += w * 2.0 * rr * x;
    }
    (v * h / 3.0, a * h / 3.0, m * h / 3.0)
}

/// Body component normal-force slope at α → 0: (C_Nα)_c = (2/A_ref)(A_1 − A_0).
/// cite: niskanen-2009 eq 3.19 p 32
pub fn body_cna(a0: f64, a1: f64, a_ref: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    2.0 / a_ref * (a1 - a0)
}

/// Body component potential normal force C_N = (2/A_ref)(A_1 − A_0) sin α.
/// cite: niskanen-2009 eq 3.19 p 32
pub fn body_cn(a0: f64, a1: f64, a_ref: f64, alpha: f64) -> f64 {
    body_cna(a0, a1, a_ref) * alpha.sin()
}

/// Body component CP from its front, X_c = (l_c A_1 − V_c)/(A_1 − A_0); the
/// mid-length when A_1 = A_0 (no potential normal force).
/// cite: niskanen-2009 eq 3.28 p 34
pub fn body_cp(length: f64, a0: f64, a1: f64, volume: f64) -> f64 {
    let da = a1 - a0;
    if da.abs() < 1e-15 {
        return 0.5 * length;
    }
    (length * a1 - volume) / da
}

/// Body-lift normal force C_N,lift = K (A_plan/A_ref) sin²α, K = 1.1.
/// cite: niskanen-2009 eq 3.26 p 34
pub fn body_lift_cn(a_plan: f64, a_ref: f64, alpha: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    K_LIFT * a_plan / a_ref * alpha.sin().powi(2)
}

/// CP of a set of normal-force terms `(C_N or C_Nα, X)`: X_cp = Σ X_i C_i / Σ C_i.
/// `None` when the terms sum to zero.
/// cite: niskanen-2009 eq 3.29 p 35
pub fn combine(terms: &[(f64, f64)]) -> Option<f64> {
    let total: f64 = terms.iter().map(|t| t.0).sum();
    if total.abs() < 1e-15 {
        return None;
    }
    Some(terms.iter().map(|t| t.0 * t.1).sum::<f64>() / total)
}

#[cfg(test)]
mod tests {
    //! Barrowman 1967 hand cases: closed forms from the sources, computed
    //! independently of the integrals above.
    use super::*;
    use crate::fins::{
        fin_count_factor, kt_b, kt_b_slender_body, single_fin_cna_subsonic,
        trapezoid_cp_from_root_le,
    };
    use crate::testutil::{case_model, close};
    use crate::{AeroModel, AeroOptions, AeroState};
    use serde_json::json;

    fn nose(shape: &str, param: f64, l: f64, d: f64) -> BodySegment {
        let s: EvalShape = serde_json::from_value(json!({
            "type": "nose_cone", "shape": shape, "shape_param": param,
            "length": l, "od": d, "thickness": 0.0
        }))
        .unwrap();
        BodySegment::from_shape("n", 0.0, &s).unwrap()
    }

    #[test]
    fn nose_cna_is_two_on_its_base_area() {
        // barrowman-1967 eq 3-66: (C_Nα)_B = 2 A_1/A_ref = 2 for any pointed nose.
        let a = PI * 0.025 * 0.025;
        for (s, p) in [
            ("conical", 0.0),
            ("ogive", 1.0),
            ("ogive", 0.5),
            ("ellipsoid", 0.0),
            ("power", 0.5),
            ("parabolic", 0.75),
            ("haack", 0.0),
            ("haack", 1.0 / 3.0),
        ] {
            let n = nose(s, p, 0.2, 0.05);
            assert!(close(n.cna0(a), 2.0, 1e-12), "{s} {p}");
        }
    }

    #[test]
    fn cone_cp_is_two_thirds_length() {
        // V = A l/3 in eq 3-89: X_B = l − V/A = 2l/3.
        let n = nose("conical", 0.0, 0.3, 0.06);
        assert!(close(n.cp(), 0.2, 1e-9), "{}", n.cp());
    }

    #[test]
    fn tangent_ogive_cp_from_barrowman_volume() {
        // barrowman-1967 eq 3-90 (corrected per Errata: V = π d³·RHS), eq 3-89.
        for f in [2.0_f64, 3.0, 5.0] {
            let (d, l) = (0.04_f64, 0.04 * f);
            let q = f * f + 0.25;
            let rhs = f * q * q - f.powi(3) / 3.0 - (f * f - 0.25) * q * q * (f / q).asin();
            let v = PI * d.powi(3) * rhs;
            let x = l - v / (PI * d * d / 4.0);
            let n = nose("ogive", 1.0, l, d);
            assert!(close(n.cp(), x, 1e-7), "f={f}: {} vs {x}", n.cp());
            assert!(close(n.volume, v, 1e-7));
        }
    }

    #[test]
    fn other_noses_cp_closed_forms() {
        let (l, d) = (0.2_f64, 0.05_f64);
        let a = PI * d * d / 4.0;
        // Ellipsoid: V = (2/3) A l → X = l/3. Paraboloid-like power 1/2: V = A l/2 → X = l/2.
        assert!(close(nose("ellipsoid", 0.0, l, d).cp(), l / 3.0, 1e-7));
        assert!(close(nose("power", 0.5, l, d).cp(), l / 2.0, 1e-7));
        // Full parabola κ = 1: r = r1 u(2 − u) → V = A l·8/15 → X = 7l/15.
        assert!(close(
            nose("parabolic", 1.0, l, d).cp(),
            7.0 * l / 15.0,
            1e-7
        ));
        // Von Kármán: V = A l/2 (∫(θ − sin2θ/2)/π du = 1/2) → X = l/2.
        assert!(close(nose("haack", 0.0, l, d).cp(), l / 2.0, 1e-6));
        let _ = a;
    }

    #[test]
    fn conical_transition_cna_and_cp() {
        // Frustum r0 → r1 over l: C_Nα = (2/A_ref)(A_1 − A_0) (eq 3-65);
        // X = (l A_1 − V)/(A_1 − A_0), V = π l (r0² + r0 r1 + r1²)/3.
        let s: EvalShape = serde_json::from_value(json!({
            "type": "transition", "shape": "conical", "shape_param": 0.0,
            "length": 0.05, "fore_od": 0.04, "aft_od": 0.06, "thickness": 0.0
        }))
        .unwrap();
        let t = BodySegment::from_shape("t", 0.3, &s).unwrap();
        let a_ref = PI * 0.03 * 0.03;
        let (r0, r1, l) = (0.02_f64, 0.03_f64, 0.05_f64);
        let cna = 2.0 / a_ref * PI * (r1 * r1 - r0 * r0);
        assert!(close(t.cna0(a_ref), cna, 1e-12));
        let v = PI * l * (r0 * r0 + r0 * r1 + r1 * r1) / 3.0;
        let x = 0.3 + (l * PI * r1 * r1 - v) / (PI * (r1 * r1 - r0 * r0));
        assert!(close(t.cp(), x, 1e-8));
        // A boattail (shrinking) has negative C_Nα.
        let s2: EvalShape = serde_json::from_value(json!({
            "type": "transition", "shape": "conical", "shape_param": 0.0,
            "length": 0.05, "fore_od": 0.06, "aft_od": 0.04, "thickness": 0.0
        }))
        .unwrap();
        let b = BodySegment::from_shape("b", 0.3, &s2).unwrap();
        assert!(close(b.cna0(a_ref), -cna, 1e-12));
        assert!(close(b.cp(), 0.3 + l - (x - 0.3), 1e-8));
    }

    #[test]
    fn body_lift_at_alpha() {
        let s: EvalShape = serde_json::from_value(json!({
            "type": "body_tube", "length": 0.3, "od": 0.05, "id": 0.048
        }))
        .unwrap();
        let t = BodySegment::from_shape("t", 0.2, &s).unwrap();
        let a_ref = PI * 0.025 * 0.025;
        assert_eq!(t.cna0(a_ref), 0.0);
        let alpha = 0.1_f64;
        let (cn, x) = t.cn_at(a_ref, alpha);
        assert!(close(cn, 1.1 * 0.015 / a_ref * alpha.sin().powi(2), 1e-9));
        assert!(close(x, 0.35, 1e-9));
    }

    #[test]
    fn interference_exact_vs_simplified() {
        // Slender-body K_T(B) with the +π/4 correction vs eq 3.56, within 5%.
        for (r, s) in [(0.0125_f64, 0.03_f64), (0.027, 0.09), (0.05, 0.05)] {
            let exact = kt_b_slender_body((s + r) / r);
            assert!((exact / kt_b(r, s) - 1.0).abs() < 0.05, "{r} {s}: {exact}");
        }
        // τ = 2 hand value: 2/(π/4)·{1.0625(½ atan 0.75 + π/4) − ¼(1.5 + 2 atan 0.5)}.
        let hand = 8.0 / PI
            * (1.0625 * (0.5 * 0.75_f64.atan() + PI / 4.0) - 0.25 * (1.5 + 2.0 * 0.5_f64.atan()));
        assert!(close(kt_b_slender_body(2.0), hand, 1e-12));
    }

    #[test]
    fn four_fin_set_closed_form() {
        // barrowman-1967 eq 3-6 / 3-12 (N/2 sum) vs niskanen eq 3.40; trapezoid CP eq 3-30.
        let (cr, ct, s, xt) = (0.14_f64, 0.06_f64, 0.09_f64, 0.045_f64);
        let a_fin = 0.5 * (cr + ct) * s;
        let ar = 2.0 * s * s / a_fin;
        let gc = ((xt + ct / 2.0 - cr / 2.0) / s).atan();
        let a_ref = PI * 0.027 * 0.027;
        for m in [0.0_f64, 0.3, 0.8] {
            let b = (1.0 - m * m).sqrt();
            let b67 = 2.0 * PI * ar * (a_fin / a_ref)
                / (2.0 + (4.0 + (b * ar / gc.cos()).powi(2)).sqrt());
            assert!(close(
                single_fin_cna_subsonic(m, s, a_fin, a_ref, gc),
                b67,
                1e-12
            ));
        }
        let x_cp = trapezoid_cp_from_root_le(cr, ct, xt);
        let b67 = xt / 3.0 * (cr + 2.0 * ct) / (cr + ct) + (cr + ct - cr * ct / (cr + ct)) / 6.0;
        assert!(close(x_cp, b67, 1e-12));
    }

    #[test]
    fn whole_vehicle_barrowman_hand_case() {
        // The M1.5 fixture (tangent ogive l = 0.22, d = 0.054; 4 trapezoid fins
        // c_r 0.14, c_t 0.06, s 0.09, sweep 0.045 at x 0.70) at M 0.3, α → 0.
        let m = case_model("fixture");
        let g = rw_geom::build(&m);
        let am = AeroModel::new(&m, &g, &AeroOptions::default());
        let st = AeroState {
            mach: 0.3,
            speed: 102.0,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: 1.4607e-5,
            thrusting: false,
        };
        let c = am.eval(&st);
        let a_ref = m.reference.area;
        let (cr, ct, s, xt, r_t) = (0.14_f64, 0.06_f64, 0.09_f64, 0.045_f64, 0.027_f64);
        let a_fin = 0.5 * (cr + ct) * s;
        let gc = ((xt + ct / 2.0 - cr / 2.0) / s).atan();
        let fin1 = single_fin_cna_subsonic(0.3, s, a_fin, a_ref, gc);
        // barrowman-1967 (3-106): (C_Nα)_T(B) + (C_Nα)_B(T), K_T(B) + K_B(T) = (1 + r/(s + r))².
        let fins = fin1 * 2.0 * (1.0 + r_t / (s + r_t)).powi(2);
        assert!(close(
            fin_count_factor(4) * kt_b(r_t, s).powi(2),
            fins / fin1,
            1e-12
        ));
        // Nose C_Nα on the fixture's reference area (A_1 = A_ref → 2 up to rounding).
        let nose_cna = 2.0 * PI * 0.027 * 0.027 / a_ref;
        assert!(
            close(c.cn_alpha, nose_cna + fins, 1e-6),
            "{} vs {}",
            c.cn_alpha,
            nose_cna + fins
        );
        // CP: nose (eq 3-89 with the eq 3-90 volume) and fins: the fin load
        // K_F(B) at the wing-alone CP (eq 3-30) and the body-carried rest at
        // the NACA TR 1307 chart 16 CP (the planform has a forward-swept
        // trailing edge, so the chart covers it).
        let f = 0.22_f64 / 0.054;
        let q = f * f + 0.25;
        let rhs = f * q * q - f.powi(3) / 3.0 - (f * f - 0.25) * q * q * (f / q).asin();
        let x_nose = 0.22 - PI * 0.054_f64.powi(3) * rhs / (PI * 0.027 * 0.027);
        let x_wing = 0.7 + trapezoid_cp_from_root_le(cr, ct, xt);
        let trap = crate::body_load::TrapezoidFin {
            root_chord: cr,
            tip_chord: ct,
            sweep: xt,
            span: s,
            r_t,
        };
        assert!(crate::body_load::chart16_applies(&trap));
        let tau = r_t / (r_t + s);
        let k_f = crate::body_load::k_fin_body(tau);
        let k_b = (1.0 + tau).powi(2) - k_f;
        let x_body = 0.7 + crate::body_load::body_load_cp(&trap, (1.0 - 0.09_f64).sqrt());
        let x_fin = (k_f * x_wing + k_b * x_body) / (k_f + k_b);
        assert!(x_body < x_wing && x_fin < x_wing);
        let x = (nose_cna * x_nose + fins * x_fin) / (nose_cna + fins);
        assert!(close(c.cp, x, 1e-5), "{} vs {x}", c.cp);
        let comp = |id: &str| c.components.iter().find(|t| t.id == id).unwrap();
        assert!(close(comp("fins").cp, x_fin, 1e-6));
        assert!(comp("nose").model.starts_with("niskanen-2009:"));
        assert!(comp("fins").model.contains("3.56"));
        assert!(comp("fins").model.contains("naca-tr-1307"));
    }
}
