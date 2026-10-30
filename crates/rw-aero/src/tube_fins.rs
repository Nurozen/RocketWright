//! Tube fins: each tube is an annular (ring) wing (M2-parity).
//!
//! Normal force. NACA TN 4117 (Fletcher 1957) measured annular airfoils of
//! aspect ratio A = d/c from 1/3 to 3 (d the ring diameter, c the chord,
//! projected area S = d c) and found the lift-curve slope about twice that of
//! a plane rectangular wing of the same aspect ratio (summary pdf 3,
//! conclusion 3 pdf 8, curve D of Fig 11 pdf 21); its low-A theory curve B,
//! C_Lα = π A, agrees for A < 1. MIL-HDBK-762 §5-3.2 gives the
//! same factor of about two for ringtails against planar fins, subsonic and
//! supersonic (pdf 252). So one tube's slope is 2 × the rectangular-wing slope of
//! niskanen-2009 (3.40)/(3.49) at AR = A on S (literature-map TF-01..TF-03).
//! A ring is axisymmetric about its own axis, so its normal force does not
//! depend on its roll position: N tubes sum N slopes, where N planar fins sum
//! N/2 (3.53) (literature-map Gaps 11). The niskanen-2013 (3.54) fin–fin factor and the
//! Barrowman fin–body factors K_T(B) + K_B(T) of the equivalent planar panel
//! (span d at r_t) are kept as for planar fins; MIL-HDBK-762 Fig 5-61's
//! ring/planar ratio includes the fin–body interference (TF-06). No source
//! gives the mutual interference of tubes that touch each other (Gaps).
//!
//! CP. TN 4117 conclusion 1: aspect ratio moves an annular airfoil's
//! aerodynamic centre as it does a plane unswept wing's, so the planar CP
//! rule (3.36) is used at AR = A (TF-05). TN 4117 Fig 8 (isolated rings: AC at
//! −0.11 c for A = 1/3) and AMCP 706-280 §8-2.3 (body-mounted ring tails: mid
//! chord, TF-07) bracket it; neither is used.
//!
//! Drag (PARITY-tubes). Each tube is split into three flow paths:
//!
//! - **Bore**: the air through the tube is pipe flow, so its loss is the
//!   Darcy–Weisbach pressure drop Δp = f (L/d) ρ V²/2 (SP-125 eq 7-7) over the
//!   bore area, at the flight speed, with f from the Moody chart (SP-125
//!   eq 7-8 laminar, fig 7-20 turbulent, ε the tube roughness). It replaces
//!   flat-plate friction on the bore (TF-10).
//! - **Corner channels**: where a tube meets the body, the region between
//!   the tube, the body, and the two rays from the body axis tangent to the
//!   tube is a cusped channel (with tubes that touch, it is closed by the
//!   neighbour). Its hydraulic diameter is a small fraction of the tube
//!   radius, so its Darcy loss f L/D_h is above the drag of a closed blunt
//!   face (case 4 at M 0.3: D_h ≈ 2.5 mm, f L/D_h ≈ 1.6 against
//!   C_D•,stag + C_D,base ≈ 1.0): it passes little air and is taken as a
//!   blunt face, stagnation drag (B.2) in front and base drag (3.94) behind,
//!   on its frontal area (TF-11).
//! - **Outside**: flat-plate friction (3.81)-(3.85) on the outer surface that
//!   is not inside a corner channel, with no thickness factor (MIL-HDBK-762
//!   (5-40), TF-09), less the body surface the channels cover (the body
//!   term counts its whole surface).
//!
//! The tube wall's edges keep stagnation (B.2) and base (3.94) drag on the
//! rolled-out edge area π(r_o² − r_i²) (AMCP 706-280 eq 8-24, TF-08).
//! Damping and roll terms reuse the equivalent planar panel (chord L, span
//! d). See `docs/dev/parity-log.md` (M2-parity, PARITY-tubes).

use std::f64::consts::PI;

use rw_geom::ComponentGeometry;
use rw_model::{EvalComponent, FinCrossSection};

use crate::drag::base::base_cd;
use crate::fins::{FinPlanform, STRIPS, Strip, fin_count_factor, kb_t, kt_b, single_fin_cna};
use crate::mach::stagnation_cd;

/// Ring diameter of a tube for the annular-wing terms: NACA TN 4117 defines
/// A = d/c and S = d c with d the inner diameter (symbols, pdf 4); a tube with
/// no bore falls back to its outer diameter.
/// cite: naca-tn-4117 sec symbols p 4
pub fn ring_diameter(od: f64, id: f64) -> f64 {
    if id > 0.0 { id.min(od) } else { od.max(0.0) }
}

/// Annular-wing aspect ratio A = d/c (d ring diameter, c chord = tube length).
/// cite: naca-tn-4117 sec symbols p 4
pub fn ring_aspect_ratio(d: f64, length: f64) -> f64 {
    if length > 0.0 { d / length } else { 0.0 }
}

/// Normal-force slope of one tube on A_ref: twice the slope of a plane
/// rectangular wing of the same aspect ratio A = d/L on the projected area
/// S = d L. The rectangular wing is (3.40)/(3.49) with AR = A, i.e. the
/// single-fin form with s = d/√2 (2s²/A_fin = A). Tends to curve B,
/// C_Lα = π A on S, as A → 0.
/// cite: naca-tn-4117 sec conclusions p 8
/// cite: naca-tn-4117 fig 11 p 21
/// cite: niskanen-2009 eq 3.40 p 39
pub fn ring_cna(mach: f64, alpha: f64, d: f64, length: f64, a_ref: f64) -> f64 {
    if d <= 0.0 || length <= 0.0 {
        return 0.0;
    }
    2.0 * single_fin_cna(
        mach,
        alpha,
        d / std::f64::consts::SQRT_2,
        d * length,
        a_ref,
        0.0,
    )
}

/// Count factor of N tubes: each ring's normal force is independent of its
/// roll position, so the set sums N slopes (Σ 1 rather than the planar Σ sin²
/// = N/2, eq 3.53), times the (3.54) fin–fin factor.
/// cite: naca-tn-4117 sec summary p 3
/// cite: niskanen-2013 eq 3.54 p 43
pub fn tube_count_factor(count: u32) -> f64 {
    2.0 * fin_count_factor(count)
}

/// Normal-force slope of the tube set on A_ref:
/// N' (C_Nα)_ring (K_T(B) + K_B(T)), the interference factors of the
/// equivalent planar panel of span d (outer diameter) at the body radius r_t.
/// cite: naca-tn-4117 sec conclusions p 8
/// cite: mil-hdbk-762 fig 5-61 p 367
/// cite: barrowman-1967 eq 3-98 p 41
#[allow(clippy::too_many_arguments)]
pub fn tube_set_cna(
    mach: f64,
    alpha: f64,
    count: u32,
    od: f64,
    id: f64,
    length: f64,
    r_t: f64,
    a_ref: f64,
) -> f64 {
    let d = ring_diameter(od, id);
    ring_cna(mach, alpha, d, length, a_ref)
        * tube_count_factor(count)
        * (kt_b(r_t, od) + kb_t(mach, r_t, od))
}

/// Frontal (annulus) area of one tube, π (r_o² − r_i²).
/// cite: n/a pure geometry (annulus area)
pub fn annulus_area(od: f64, id: f64) -> f64 {
    let ro = 0.5 * od.max(0.0);
    let ri = 0.5 * id.clamp(0.0, od.max(0.0));
    PI * (ro * ro - ri * ri)
}

/// Equivalent planar fin set of `count` tubes of length `length`, outer and
/// inner diameters `od`/`id`, fore end at station `x_fore`, root on the body at
/// radius `r_t`: chord L, span d, thickness (od − id)/2, square section, no
/// sweep or cant. A rectangle has c̄ = L and y_mac = s/2.
/// cite: barrowman-1967 eq 3-24 p 20
pub fn equivalent_planform(
    count: u32,
    length: f64,
    od: f64,
    id: f64,
    x_fore: f64,
    r_t: f64,
) -> FinPlanform {
    let span = od.max(0.0);
    let chord = length.max(0.0);
    let width = span / STRIPS as f64;
    let strips = (0..STRIPS)
        .map(|k| Strip {
            xi: r_t + (k as f64 + 0.5) * width,
            chord,
            width,
        })
        .collect();
    FinPlanform {
        count,
        area: chord * span,
        span,
        root_chord: chord,
        tip_chord: chord,
        mac: chord,
        y_mac: 0.5 * span,
        x_mac_le: x_fore,
        x_root_le: x_fore,
        gamma_c: 0.0,
        gamma_le: 0.0,
        thickness: 0.5 * (od - id).max(0.0),
        cross_section: FinCrossSection::Square,
        cant: 0.0,
        r_t,
        strips,
    }
}

/// Body radius under the tubes: the placed instance's radial offset (tube
/// axis) minus od/2, else the component's `fore` anchor radius minus od/2.
/// cite: n/a placement geometry
pub fn root_radius(c: &EvalComponent, g: &ComponentGeometry, od: f64) -> f64 {
    let axis = g
        .instances
        .first()
        .map(|i| i.offset[1].hypot(i.offset[2]))
        .filter(|r| *r > 0.0)
        .or_else(|| c.anchors.iter().find(|a| a.name == "fore").map(|a| a.r));
    axis.map_or(0.0, |r| (r - 0.5 * od).max(0.0))
}

/// Half-angles of the corner channels beside a tube of outer radius `r_tube`
/// lying on a body of radius `r_body`, cut off by the two rays from the body
/// axis tangent to the tube. Returns (ψ_t, ψ_b): ψ_t at the tube axis between
/// the line of centres and the tangent point, cos ψ_t = r_tube/(r_body +
/// r_tube); ψ_b = π/2 − ψ_t at the body axis (right angle at the tangent
/// point). With no body (r_body = 0), ψ_t = 0 and the channel area is zero.
/// cite: n/a pure geometry (tangents from the body axis to the tube circle)
pub fn corner_half_angles(r_body: f64, r_tube: f64) -> (f64, f64) {
    let (rb, rt) = (r_body.max(0.0), r_tube.max(0.0));
    if rt <= 0.0 {
        return (0.0, 0.0);
    }
    let psi_t = (rt / (rb + rt)).clamp(-1.0, 1.0).acos();
    (psi_t, 0.5 * PI - psi_t)
}

/// Frontal area of the two corner channels beside one tube: the kite formed
/// by the body axis, the two tangent points, and the tube axis (two right
/// triangles of legs r_t and √((r_b + r_t)² − r_t²)), less the tube sector
/// of angle 2ψ_t and the body sector of angle 2ψ_b inside it.
/// cite: n/a pure geometry (kite minus two circular sectors)
pub fn corner_area(r_body: f64, r_tube: f64) -> f64 {
    let (rb, rt) = (r_body.max(0.0), r_tube.max(0.0));
    let (psi_t, psi_b) = corner_half_angles(rb, rt);
    let leg = ((rb + rt).powi(2) - rt * rt).max(0.0).sqrt();
    (leg * rt - rt * rt * psi_t - rb * rb * psi_b).max(0.0)
}

/// Wetted area of one tube's outside that takes flat-plate friction: the
/// outer surface outside the corner channels, 2(π − ψ_t) r_t L, less the body
/// surface the channels cover, 2ψ_b r_b L (with ψ_b at most π/N, so `count`
/// tubes never cover more than the body's circumference).
/// cite: n/a pure geometry (exposed arcs times length)
pub fn exposed_wetted_area(count: u32, length: f64, r_body: f64, r_tube: f64) -> f64 {
    let (rb, rt, l) = (r_body.max(0.0), r_tube.max(0.0), length.max(0.0));
    let (psi_t, psi_b) = corner_half_angles(rb, rt);
    let psi_b = psi_b.min(PI / f64::from(count.max(1)));
    (2.0 * (PI - psi_t) * rt * l - 2.0 * psi_b * rb * l).max(0.0)
}

/// Friction (3.81)-(3.85) of the tubes' outsides on the reference area,
/// N C_f S_exposed / A_ref, with the flat-plate C_f and no thickness factor
/// (TF-09).
/// cite: mil-hdbk-762 eq 5-40 p 288
pub fn outside_friction_cd(
    cf: f64,
    count: u32,
    length: f64,
    r_body: f64,
    od: f64,
    a_ref: f64,
) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    f64::from(count) * cf * exposed_wetted_area(count, length, r_body, 0.5 * od) / a_ref
}

/// Darcy friction factor of pipe flow at Reynolds number `re` (on the bore
/// diameter) and relative roughness ε/d. Laminar (Re < 1200): Poiseuille's
/// f = 64/Re (SP-125 eq 7-8). Turbulent: the Moody chart (SP-125 fig 7-20),
/// whose curves are the Colebrook interpolation between the smooth- and
/// rough-pipe laws, 1/√f = −2 log₁₀(ε/(3.7 d) + 2.51/(Re √f)), solved here by
/// fixed-point iteration in 1/√f. Infinite at Re ≤ 0.
/// cite: sp-125 eq 7-8 p 292
/// cite: sp-125 fig 7-20 p 293
pub fn pipe_friction_factor(re: f64, rel_roughness: f64) -> f64 {
    if re <= 0.0 {
        return f64::INFINITY;
    }
    if re < 1200.0 {
        return 64.0 / re;
    }
    let rough = rel_roughness.max(0.0) / 3.7;
    // Start from the fully rough asymptote (or a smooth-pipe guess) and iterate.
    let mut x: f64 = if rough > 0.0 {
        -2.0 * rough.log10()
    } else {
        8.0
    };
    for _ in 0..50 {
        let next = -2.0 * (rough + 2.51 * x / re).log10();
        if (next - x).abs() < 1e-12 * next.abs() {
            x = next;
            break;
        }
        x = next;
    }
    1.0 / (x * x)
}

/// Pipe-flow loss of the tubes' bores on the reference area,
/// N f (L/d) (π d²/4) / A_ref: the Darcy–Weisbach drop Δp = f (L/d) ρ V²/2
/// (SP-125 eq 7-7) acting over the bore at the flight speed V, with f from
/// [`pipe_friction_factor`] at Re = V d/ν and ε/d. Zero without a bore or flow.
/// cite: sp-125 eq 7-7 p 292
pub fn bore_cd(
    count: u32,
    id: f64,
    length: f64,
    roughness: f64,
    speed: f64,
    nu: f64,
    a_ref: f64,
) -> f64 {
    if a_ref <= 0.0 || id <= 0.0 || length <= 0.0 || speed <= 0.0 || nu <= 0.0 {
        return 0.0;
    }
    let f = pipe_friction_factor(speed * id / nu, roughness / id);
    f64::from(count) * f * (length / id) * 0.25 * PI * id * id / a_ref
}

/// Blunt frontal area of one tube: the wall's edge annulus π(r_o² − r_i²)
/// (rolled-out edge, AMCP 706-280 eq 8-24) plus its two corner channels on a
/// body of radius `r_body` ([`corner_area`]).
/// cite: amcp-706-280 eq 8-24 p 267
pub fn blunt_area(od: f64, id: f64, r_body: f64) -> f64 {
    annulus_area(od, id) + corner_area(r_body, 0.5 * od)
}

/// Stagnation pressure drag of the tubes' blunt fronts on the reference
/// area, N A_blunt C_D•,stag / A_ref ([`blunt_area`]: wall edges and corner
/// channels).
/// cite: niskanen-2009 eq B.2 p 117
pub fn pressure_cd(count: u32, od: f64, id: f64, r_body: f64, a_ref: f64, mach: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    f64::from(count) * blunt_area(od, id, r_body) / a_ref * stagnation_cd(mach)
}

/// Base drag of the tubes' blunt backs on the reference area,
/// N A_blunt C_D,base / A_ref ([`blunt_area`]).
/// cite: niskanen-2009 eq 3.94 p 60
pub fn base_drag_cd(count: u32, od: f64, id: f64, r_body: f64, a_ref: f64, mach: f64) -> f64 {
    if a_ref <= 0.0 {
        return 0.0;
    }
    f64::from(count) * blunt_area(od, id, r_body) / a_ref * base_cd(mach)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fins::cp_fraction;
    use crate::testutil::{close, comp, model};
    use crate::{AeroModel, AeroOptions, AeroState, DragKind};
    use serde_json::json;

    // 6 tubes, L 50 mm, od 12 mm, id 11 mm, on a 25 mm body (r 12.5 mm).
    const L: f64 = 0.05;
    const OD: f64 = 0.012;
    const ID: f64 = 0.011;
    const R_BODY: f64 = 0.0125;

    fn a_ref() -> f64 {
        PI * R_BODY * R_BODY
    }

    fn state(mach: f64) -> AeroState {
        AeroState {
            mach,
            speed: mach * 340.294,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: 1.4607e-5,
            thrusting: false,
        }
    }

    /// Ogive nose, 300 mm tube of 25 mm, and optionally `count` tube fins at the aft end.
    fn rocket(count: Option<u32>) -> rw_model::EvaluatedModel {
        let mut v = vec![
            comp(
                "nose",
                None,
                "axial",
                [0.0, 0.1],
                None,
                json!({
                    "type": "nose_cone", "shape": "ogive", "shape_param": 1.0,
                    "length": 0.1, "od": 0.025, "thickness": 0.002
                }),
            ),
            comp(
                "body",
                Some("nose"),
                "axial",
                [0.1, 0.4],
                None,
                json!({ "type": "body_tube", "length": 0.3, "od": 0.025, "id": 0.023 }),
            ),
        ];
        if let Some(n) = count {
            v.push(comp(
                "tf",
                Some("body"),
                "surface",
                [0.35, 0.4],
                None,
                json!({ "type": "tube_fin_set", "count": n, "length": L, "od": OD, "id": ID }),
            ));
        }
        model(v, 0.025)
    }

    fn aero(m: &rw_model::EvaluatedModel) -> AeroModel {
        AeroModel::new(m, &rw_geom::build(m), &AeroOptions::default())
    }

    fn row(c: crate::AeroCoeffs) -> crate::ComponentAero {
        c.components.into_iter().find(|r| r.id == "tf").unwrap()
    }

    #[test]
    fn equivalent_planform_values() {
        let p = equivalent_planform(6, L, OD, ID, 0.35, R_BODY);
        assert_eq!(p.count, 6);
        assert!(close(p.area, L * OD, 1e-12));
        assert_eq!((p.span, p.root_chord, p.tip_chord, p.mac), (OD, L, L, L));
        assert!(close(p.y_mac, 0.006, 1e-12));
        assert!(close(p.thickness, 0.0005, 1e-9));
        assert_eq!((p.gamma_c, p.gamma_le, p.cant), (0.0, 0.0, 0.0));
        assert_eq!(p.cross_section, FinCrossSection::Square);
        assert!(close(p.aspect_ratio(), 2.0 * OD / L, 1e-12));
        // Strips tile the span from the body surface out to r_t + d.
        let strip_area: f64 = p.strips.iter().map(|s| s.chord * s.width).sum();
        assert!(close(strip_area, p.area, 1e-12));
        assert!(p.strips[0].xi > R_BODY && p.strips.last().unwrap().xi < R_BODY + OD);
        assert!(close(
            annulus_area(OD, ID),
            PI * (0.006f64.powi(2) - 0.0055f64.powi(2)),
            1e-12
        ));
    }

    #[test]
    fn root_radius_from_placed_tubes() {
        let m = rocket(Some(6));
        let g = rw_geom::build(&m);
        let c = m.components.iter().find(|c| c.id == "tf").unwrap();
        let cg = g.components.iter().find(|c| c.id == "tf").unwrap();
        assert_eq!(cg.instances.len(), 6);
        assert!(close(root_radius(c, cg, OD), R_BODY, 1e-9));
    }

    #[test]
    fn ring_slope_is_twice_the_rectangular_wing() {
        // NACA TN 4117 curve D: 2 × the rectangular wing of A = d/c on S = d c,
        // here the (3.40) Diederich form 2πA/(2 + sqrt(4 + (βA)²)).
        let (d, c, mach) = (0.024, 0.076, 0.3);
        let a = d / c;
        let b = (1.0f64 - mach * mach).sqrt();
        let rect = 2.0 * PI * a / (2.0 + (4.0 + (b * a).powi(2)).sqrt());
        let s = d * c;
        assert!(close(
            ring_cna(mach, 0.0, d, c, a_ref()),
            2.0 * rect * s / a_ref(),
            1e-12
        ));
        // Curve B (low A): C_Lα = π A on S. Within 1 % at A = 1/3 (M 0),
        // where TN 4117 measured about 0.018 per degree (Fig 11).
        let ring = ring_cna(0.0, 0.0, 0.025, 0.075, 1.0) / (0.025 * 0.075);
        assert!(close(ring, PI / 3.0, 0.01), "{ring}");
        assert!(close(ring / 57.3, 0.018, 0.02), "{}", ring / 57.3);
        assert!(close(
            ring_cna(0.0, 0.0, 1e-3, 1.0, 1.0) / 1e-3,
            PI * 1e-3,
            1e-6
        ));
        assert_eq!(ring_cna(0.3, 0.0, 0.0, c, a_ref()), 0.0);
        // Ring diameter: the bore (TN 4117 symbols), else the outer diameter.
        assert_eq!(ring_diameter(OD, ID), ID);
        assert_eq!(ring_diameter(OD, 0.0), OD);
        assert!(close(ring_aspect_ratio(ID, L), 0.22, 1e-12));
    }

    #[test]
    fn tubes_count_without_roll_weighting() {
        // Planar fins sum N/2 slopes (3.53); rings are axisymmetric: N.
        for n in 1..=4 {
            assert!(close(tube_count_factor(n), f64::from(n), 1e-12));
        }
        assert!(close(tube_count_factor(6), 6.0 * 0.913, 1e-12));
        assert!(close(
            tube_count_factor(6),
            2.0 * fin_count_factor(6),
            1e-12
        ));
    }

    #[test]
    fn set_slope_through_the_model() {
        let mach = 0.3;
        let set = |n: u32| tube_set_cna(mach, 0.0, n, OD, ID, L, R_BODY, a_ref());
        let by_hand = ring_cna(mach, 0.0, ID, L, a_ref())
            * tube_count_factor(6)
            * (kt_b(R_BODY, OD) + kb_t(mach, R_BODY, OD));
        assert!(close(set(6), by_hand, 1e-12));
        let r6 = row(aero(&rocket(Some(6))).eval(&state(mach)));
        assert!(
            close(r6.cn_alpha, set(6), 1e-12),
            "{} vs {}",
            r6.cn_alpha,
            set(6)
        );
        assert!(r6.model.contains("tube-fins"));
        let r3 = row(aero(&rocket(Some(3))).eval(&state(mach)));
        assert!(close(
            r6.cn_alpha / r3.cn_alpha,
            tube_count_factor(6) / tube_count_factor(3),
            1e-9
        ));
        // About twice the old equivalent-planar-fin set (N/2 roll weighting,
        // AR = 2d/L): the roll factor 2 times ring/panel ≈ (ID/OD)².
        let p = equivalent_planform(6, L, OD, ID, 0.35, R_BODY);
        let planar = single_fin_cna(mach, 0.0, p.span, p.area, a_ref(), 0.0)
            * fin_count_factor(6)
            * (kt_b(R_BODY, OD) + kb_t(mach, R_BODY, OD));
        let ratio = r6.cn_alpha / planar;
        assert!(ratio > 1.6 && ratio < 2.2, "{ratio}");
    }

    #[test]
    fn cp_between_tube_ends() {
        let am = aero(&rocket(Some(6)));
        for mach in [0.3, 0.8, 1.2, 2.5] {
            let r = row(am.eval(&state(mach)));
            assert!(r.cp > 0.35 && r.cp < 0.40, "M {mach}: {}", r.cp);
        }
        let r = row(am.static_coeffs());
        assert!(close(
            r.cp,
            0.35 + L * cp_fraction(0.3, ring_aspect_ratio(ID, L)),
            1e-12
        ));
        // Supersonic: the (3.35) fit at the annular-wing A = d/L.
        let r = row(am.eval(&state(2.5)));
        assert!(close(
            r.cp,
            0.35 + L * cp_fraction(2.5, ring_aspect_ratio(ID, L)),
            1e-12
        ));
        assert!(close(r.cp, 0.35 + 0.25 * L, 1e-12));
    }

    #[test]
    fn corner_geometry() {
        // Tubes of the body radius: ψ_t = 60°, ψ_b = 30°, and the two corner
        // channels make one curvilinear triangle of three touching circles,
        // √3 r² − 3 (π/6) r² = (√3 − π/2) r².
        let r = 0.0124;
        let (pt, pb) = corner_half_angles(r, r);
        assert!(close(pt, PI / 3.0, 1e-12) && close(pb, PI / 6.0, 1e-12));
        assert!(close(
            corner_area(r, r),
            (3f64.sqrt() - 0.5 * PI) * r * r,
            1e-12
        ));
        // Six of them close the ring: half of each outside is exposed, and
        // the body under the tubes is all covered (2 ψ_b r per tube, N = 6).
        assert!(close(exposed_wetted_area(6, L, r, r), PI * r * L, 1e-12));
        // More tubes than fit cannot cover more than the body.
        assert!(close(
            exposed_wetted_area(12, L, r, r),
            2.0 * (PI - PI / 3.0) * r * L - 2.0 * (PI / 12.0) * r * L,
            1e-12
        ));
        // Test tubes (r_t 6 mm on r_b 12.5 mm): leg √(18.5² − 6²) = 17.5 mm.
        let (pt, pb) = corner_half_angles(R_BODY, 0.006);
        assert!(close(pt.cos(), 0.006 / 0.0185, 1e-12) && close(pt + pb, 0.5 * PI, 1e-12));
        let hand = 0.0175 * 0.006 - 0.006f64.powi(2) * pt - R_BODY * R_BODY * pb;
        assert!(close(corner_area(R_BODY, 0.006), hand, 1e-12));
        // No body: no channel, the whole outside is wetted.
        assert_eq!(corner_area(0.0, 0.006), 0.0);
        assert!(close(
            exposed_wetted_area(6, L, 0.0, 0.006),
            2.0 * PI * 0.006 * L,
            1e-12
        ));
    }

    #[test]
    fn pipe_friction_on_the_moody_chart() {
        // SP-125 eq 7-8 below Re 1200; fig 7-20 readings above (Colebrook).
        assert!(close(pipe_friction_factor(1000.0, 0.0), 0.064, 1e-12));
        assert!(close(pipe_friction_factor(1e5, 0.0), 0.0180, 0.01));
        assert!(close(pipe_friction_factor(1e5, 0.001), 0.0222, 0.01));
        assert!(close(pipe_friction_factor(1e8, 0.01), 0.0380, 0.01));
        assert!(close(pipe_friction_factor(1e6, 0.0), 0.0116, 0.01));
        // The iterate satisfies the Colebrook relation.
        let (re, e) = (1.7e5, 2.5e-3);
        let f = pipe_friction_factor(re, e);
        let rhs = -2.0 * (e / 3.7 + 2.51 / (re * f.sqrt())).log10();
        assert!(close(1.0 / f.sqrt(), rhs, 1e-10));
        // Rougher and slower pipes lose more.
        assert!(pipe_friction_factor(1e5, 0.01) > pipe_friction_factor(1e5, 0.001));
        assert!(pipe_friction_factor(2e4, 0.001) > pipe_friction_factor(2e5, 0.001));
        assert!(pipe_friction_factor(0.0, 0.0).is_infinite());
    }

    #[test]
    fn drag_terms_from_flow_paths() {
        let mach = 0.3;
        let (speed, nu) = (mach * 340.294, 1.4607e-5);
        // Blunt fronts and backs: N (annulus + corners) on A_ref, with
        // C_D•,stag(0.3) = 0.85 (1 + 0.3²/4 + 0.3⁴/40) = 0.869297125 and
        // C_D,base(0.3) = 0.12 + 0.13 · 0.09 = 0.1317.
        let blunt = annulus_area(OD, ID) + corner_area(R_BODY, 0.5 * OD);
        assert!(close(blunt_area(OD, ID, R_BODY), blunt, 1e-15));
        let p = pressure_cd(6, OD, ID, R_BODY, a_ref(), mach);
        assert!(close(p, 6.0 * blunt / a_ref() * 0.869_297_125, 1e-9), "{p}");
        let b = base_drag_cd(6, OD, ID, R_BODY, a_ref(), mach);
        assert!(close(b, 6.0 * blunt / a_ref() * 0.1317, 1e-9), "{b}");
        assert_eq!(pressure_cd(6, OD, ID, R_BODY, 0.0, mach), 0.0);
        // Bore: N f (L/d) (π d²/4)/A_ref at Re = V d/ν, ε/d.
        let eps = crate::drag::friction::DEFAULT_ROUGHNESS;
        let f = pipe_friction_factor(speed * ID / nu, eps / ID);
        let bore = bore_cd(6, ID, L, eps, speed, nu, a_ref());
        assert!(close(
            bore,
            6.0 * f * L / ID * 0.25 * PI * ID * ID / a_ref(),
            1e-12
        ));
        assert_eq!(bore_cd(6, 0.0, L, eps, speed, nu, a_ref()), 0.0);
        assert_eq!(bore_cd(6, ID, L, eps, 0.0, nu, a_ref()), 0.0);
        // Outside friction: the flat-plate C_f on the exposed outsides only.
        let cf = 0.005;
        assert!(close(
            outside_friction_cd(cf, 6, L, R_BODY, OD, a_ref()),
            6.0 * cf * exposed_wetted_area(6, L, R_BODY, 0.5 * OD) / a_ref(),
            1e-12
        ));

        let m = rocket(Some(6));
        let am = aero(&m);
        let terms = am.drag_terms(&state(mach));
        let get = |k: DragKind| {
            terms
                .iter()
                .filter(|t| t.id == "tf" && t.kind == k)
                .map(|t| t.cd)
                .sum::<f64>()
        };
        assert!(close(get(DragKind::Pressure), p, 1e-12));
        assert!(close(get(DragKind::Base), b, 1e-12));
        let bore_term: f64 = terms
            .iter()
            .filter(|t| t.id == "tf" && t.model.starts_with("sp-125"))
            .map(|t| t.cd)
            .sum();
        assert!(close(
            bore_term,
            bore_cd(6, ID, L, eps, speed, nu, a_ref()),
            1e-12
        ));
        assert!(get(DragKind::Friction) > bore_term);
        // No roll forcing without cant; roll damping from the strips.
        let mut s = state(mach);
        s.roll_rate = 5.0;
        let c = am.eval(&s);
        assert_eq!(c.cl_forcing, 0.0);
        assert!(c.cl_damping > 0.0);
    }

    #[test]
    fn tube_fins_move_cp_aft() {
        let body = aero(&rocket(None)).static_coeffs();
        let with = aero(&rocket(Some(6))).static_coeffs();
        assert!(with.cn_alpha > body.cn_alpha);
        assert!(with.cp > body.cp + 0.05, "{} vs {}", with.cp, body.cp);
        assert!(with.drag.total > body.drag.total);
    }
}
