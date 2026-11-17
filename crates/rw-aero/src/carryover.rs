//! Supersonic lift carried from a fin onto the body, K_B(T), and its center
//! of pressure (NACA TR 1307, Pitts, Nielsen and Kaattari 1957, pdf pp 10-14
//! and 21-22; literature-map BW-1307-08..15).
//!
//! TR 1307 collapses the body to a plane strip of width d = 2 r_t beside the
//! fin root (figure 4b) and integrates the pressure field of the half-wing
//! over the part of that strip between the Mach lines from the root leading
//! and trailing edges: eq (23) for a supersonic leading edge (β m > 1) and
//! eq (25) for a subsonic one, m = cot Γ_L. With no body behind the trailing
//! edge the strip stops at the trailing-edge station (eqs 30/31 text, pdf
//! p 14), so the streamwise upper limit is c_r + min(β η, l_aft) for a body
//! that runs l_aft behind the root trailing edge. The first moment of the
//! same integrand (eqs 66 and 69) gives the CP.
//!
//! The report prints closed forms for the two end cases (24)/(26) and
//! (30)/(31) and charts them (chart 4; barrowman-1967 Fig 3-9 is chart 4b).
//! This module integrates (23)/(25) numerically, which covers a partial
//! afterbody and β d > c_r as well; the closed forms are the tests.
//!
//! The method holds once the tip Mach line passes behind the carry-over
//! region, eq (22). Below that Mach number the slender-body K_B(T) is kept
//! (TR 1307 pdf p 12 selection rule; barrowman-1967 (3-98), (3-99)), and
//! [`Carryover`] joins the two with a C¹ cubic.

use std::f64::consts::PI;

use crate::fins::{FinPlanform, kt_b};
use crate::mach::{SUPERSONIC_LIMIT, beta, hermite, table_hermite};

/// Gauss-Legendre order of each one-dimensional rule.
const QUAD_N: usize = 20;
/// Mach width of the cubic from the slender-body K_B(T) to the supersonic one.
const BLEND_WIDTH: f64 = 0.25;
/// Upper end and spacing of the Mach grid; above it the last value is held.
const GRID_MACH_MAX: f64 = 6.0;
const GRID_STEP: f64 = 0.05;

/// The fin-root geometry the planar carry-over model needs (all m): root
/// chord c_r, leading-edge sweep as tan Γ_L (= 1/m, 0 for an unswept edge),
/// body diameter d at the root, and the length l_aft of constant-radius body
/// behind the root trailing edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CarryGeometry {
    pub root_chord: f64,
    pub tan_le: f64,
    pub body_diameter: f64,
    pub afterbody: f64,
}

/// Gauss-Legendre nodes and weights on [−1, 1] (Newton iteration on P_n).
fn gauss_legendre(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let mut x = (PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
            let mut dp = 1.0;
            for _ in 0..100 {
                let (mut p0, mut p1) = (1.0, x);
                for k in 2..=n {
                    let kf = k as f64;
                    let p2 = ((2.0 * kf - 1.0) * x * p1 - (kf - 1.0) * p0) / kf;
                    p0 = p1;
                    p1 = p2;
                }
                dp = n as f64 * (x * p1 - p0) / (x * x - 1.0);
                let dx = p1 / dp;
                x -= dx;
                if dx.abs() < 1e-15 {
                    break;
                }
            }
            (x, 2.0 / ((1.0 - x * x) * dp * dp))
        })
        .collect()
}

/// Lifting pressure of the half-wing on the body strip per unit q α, at the
/// point ξ behind the root leading edge and η into the strip.
fn pressure(beta: f64, tan_le: f64, xi: f64, eta: f64) -> f64 {
    if beta > tan_le {
        // (23): (4/(β π)) (β m/√(β² m² − 1)) cos⁻¹((ξ/β + β m η)/(η + m ξ)),
        // written in tan Γ_L = 1/m so an unswept edge needs no limit.
        let arg = (xi * tan_le / beta + beta * eta) / (eta * tan_le + xi);
        4.0 / (PI * (beta * beta - tan_le * tan_le).sqrt()) * arg.clamp(-1.0, 1.0).acos()
    } else {
        // (25): (8 (β m)^{3/2}/(π β (β m + 1))) √((ξ/β − η)/(m ξ + η)).
        let bm = beta / tan_le;
        8.0 * bm.powf(1.5) / (PI * beta * (bm + 1.0))
            * ((xi / beta - eta).max(0.0) / (xi / tan_le + eta)).sqrt()
    }
}

fn body_lift_with(nodes: &[(f64, f64)], beta: f64, g: &CarryGeometry) -> (f64, f64) {
    let (c_r, t, d, l_aft) = (
        g.root_chord,
        g.tan_le.max(0.0),
        g.body_diameter,
        g.afterbody.max(0.0),
    );
    if !(beta > 0.0 && c_r > 0.0 && d > 0.0) {
        return (0.0, 0.0);
    }
    // The strip is empty where the leading-edge Mach line has passed the end
    // of the region, β η ≥ c_r + l_aft.
    let eta_max = d.min((c_r + l_aft) / beta);
    let knee = l_aft / beta;
    let mut panels = vec![0.0];
    if knee > 0.0 && knee < eta_max {
        panels.push(knee);
    }
    panels.push(eta_max);
    let (mut lift, mut moment) = (0.0, 0.0);
    for w in panels.windows(2) {
        let (a, b) = (w[0], w[1]);
        for &(x, wt) in nodes {
            // η = a + (b − a) s²(3 − 2s): the η-integrand has weak endpoint
            // singularities (η ln η at 0, a 3/2 power at the cut-off), which
            // this substitution flattens.
            let s = 0.5 * (x + 1.0);
            let eta = a + (b - a) * s * s * (3.0 - 2.0 * s);
            let jac = 0.5 * wt * (b - a) * 6.0 * s * (1.0 - s);
            let lo = beta * eta;
            let hi = c_r + lo.min(l_aft);
            if hi <= lo {
                continue;
            }
            // ξ = lo + u²: the pressure starts as √(ξ − β η) on the Mach line.
            let u_max = (hi - lo).sqrt();
            let (mut i0, mut i1) = (0.0, 0.0);
            for &(y, wu) in nodes {
                let u = 0.5 * u_max * (y + 1.0);
                let xi = lo + u * u;
                let f = 0.5 * u_max * wu * 2.0 * u * pressure(beta, t, xi, eta);
                i0 += f;
                i1 += f * xi;
            }
            lift += jac * i0;
            moment += jac * i1;
        }
    }
    (lift, moment)
}

/// Lift carried onto the body by one half-wing per unit q α, L_B(W)/(q α)
/// (an area), and its first moment about the root leading edge (area ×
/// length), by quadrature of eq (23) (β > tan Γ_L, supersonic leading edge)
/// or eq (25) (subsonic leading edge) over 0 ≤ η ≤ d,
/// β η ≤ ξ ≤ c_r + min(β η, l_aft). The moment integrands are eqs (66) and
/// (69). Body upwash is left out, as in the report (pdf p 11).
/// cite: naca-tr-1307 eq 23 p 11
/// cite: naca-tr-1307 eq 25 p 11
/// cite: naca-tr-1307 eq 30 p 14
/// cite: naca-tr-1307 eq 66 p 21
/// cite: naca-tr-1307 eq 69 p 22
pub fn half_wing_body_lift(beta: f64, g: &CarryGeometry) -> (f64, f64) {
    body_lift_with(&gauss_legendre(QUAD_N), beta, g)
}

/// β at which the tip Mach line first passes behind the carry-over region:
/// β A (1 + λ)(1/(β m) + 1) = 4, i.e. β = 4/(A (1 + λ)) − tan Γ_L, floored at
/// 0 when the condition holds at every supersonic Mach number. A is the
/// aspect ratio of the two exposed panels joined and λ the taper ratio.
/// cite: naca-tr-1307 eq 22 p 11
/// cite: barrowman-1967 eq 3-99 p 41
pub fn criterion_beta(aspect_ratio: f64, taper: f64, tan_le: f64) -> f64 {
    let a = aspect_ratio * (1.0 + taper);
    if a <= 0.0 {
        return f64::INFINITY;
    }
    (4.0 / a - tan_le.max(0.0)).max(0.0)
}

/// K_B(T) and the CP of the carried load for one fin set over Mach:
/// the slender-body value up to the eq (22) Mach number M_c, the TR 1307
/// integral from M_c + 0.25 (and not below M 1.5, where the fin slope itself
/// is still a transonic blend), and a C¹ cubic between. The integral is
/// tabulated on a Mach grid when the model is built and interpolated with
/// cubic Hermite segments, so `eval` does no quadrature.
#[derive(Debug, Clone, PartialEq)]
pub struct Carryover {
    /// Slender-body K_B(T) = K_T(B)² − K_T(B).
    slender: f64,
    /// Blend window [M_c, M_hi].
    m_lo: f64,
    m_hi: f64,
    /// Grid origin and spacing; `k` and `x_cp` are node values.
    m0: f64,
    dm: f64,
    k: Vec<f64>,
    x_cp: Vec<f64>,
}

impl Carryover {
    /// Tabulates the supersonic K_B(T) and its CP for a planform with
    /// `afterbody` m of constant-radius body behind the root trailing edge.
    /// K_B(T) is the carried lift of eq (23)/(25) over the wing-alone lift of
    /// linear theory with its tip effects, (A_fin/A_ref)(4/β) F, F the
    /// panel's tip-relief factor ([`crate::fins::TipCone::panel_factor`]):
    /// K_B(T) = β L_B(W)/(4 q α A_fin F). For a rectangular fin
    /// (4/β) F = (4 − 2/(β A))/β, the wing-alone slope of eq (27). The
    /// flat-plate fin-set row (C_Nα)_N (K_T(B) + K_B(T)) then carries exactly
    /// the integrated lift; a wedge section's thickness lift is carried in
    /// the same ratio.
    /// cite: naca-tr-1307 eq 23 p 11
    /// cite: naca-tr-1307 eq 22 p 11
    /// cite: barrowman-1967 eq 3-98 p 41
    pub fn new(p: &FinPlanform, afterbody: f64) -> Self {
        let kt = kt_b(p.r_t, p.span);
        let slender = if p.r_t + p.span <= 0.0 {
            0.0
        } else {
            kt * kt - kt
        };
        let tan_le = p.gamma_le.tan().max(0.0);
        let taper = if p.root_chord > 0.0 {
            p.tip_chord / p.root_chord
        } else {
            0.0
        };
        let beta_c = criterion_beta(p.aspect_ratio(), taper, tan_le);
        let m_lo = (1.0 + beta_c * beta_c).sqrt().min(GRID_MACH_MAX);
        let m_hi = (m_lo + BLEND_WIDTH).max(SUPERSONIC_LIMIT);
        let g = CarryGeometry {
            root_chord: p.root_chord,
            tan_le,
            body_diameter: 2.0 * p.r_t,
            afterbody,
        };
        let n = (((GRID_MACH_MAX - m_hi) / GRID_STEP).ceil() as usize).max(1) + 1;
        let dm = (GRID_MACH_MAX - m_hi).max(GRID_STEP) / (n - 1) as f64;
        let nodes = gauss_legendre(QUAD_N);
        let (mut k, mut x_cp) = (Vec::with_capacity(n), Vec::with_capacity(n));
        let tip = p.tip_cone();
        for i in 0..n {
            let mach = m_hi + dm * i as f64;
            let b = beta(mach);
            let (lift, moment) = body_lift_with(&nodes, b, &g);
            let relief = tip.panel_factor(mach, &p.strips);
            k.push(if p.area > 0.0 && relief > 0.0 {
                b * lift / (4.0 * p.area * relief)
            } else {
                0.0
            });
            x_cp.push(if lift > 0.0 { moment / lift } else { 0.0 });
        }
        Self {
            slender,
            m_lo,
            m_hi,
            m0: m_hi,
            dm,
            k,
            x_cp,
        }
    }

    /// Mach numbers between which K_B(T) and the carried-load CP go from the
    /// slender-body to the supersonic form.
    /// cite: naca-tr-1307 eq 22 p 11
    pub fn window(&self) -> (f64, f64) {
        (self.m_lo, self.m_hi)
    }

    /// C¹ interpolant of a node table at `mach` (clamped to the grid).
    /// Returns (value, slope in Mach).
    fn table(&self, v: &[f64], mach: f64) -> (f64, f64) {
        table_hermite(v, self.m0, self.dm, mach)
    }

    /// Supersonic K_B(T) from the tabulated integral, valid from the upper end
    /// of [`Self::window`].
    /// cite: naca-tr-1307 eq 23 p 11
    pub fn kb_t_supersonic(&self, mach: f64) -> f64 {
        self.table(&self.k, mach).0
    }

    /// CP of the carried load behind the root leading edge (m), the first
    /// moment of the lift integral over the lift (eq 68), valid from the upper
    /// end of [`Self::window`]. barrowman-1967 (3-102)/(3-103) is the same
    /// ratio for the no-afterbody case.
    /// cite: naca-tr-1307 eq 68 p 22
    /// cite: barrowman-1967 eq 3-102 p 42
    pub fn cp_supersonic(&self, mach: f64) -> f64 {
        self.table(&self.x_cp, mach).0
    }

    /// K_B(T) at any Mach number: slender-body K_T(B)² − K_T(B) up to the
    /// eq (22) Mach number, the tabulated integral above the window, and the
    /// cubic matching value and slope at both ends between.
    /// cite: barrowman-1967 eq 3-98 p 41
    /// cite: naca-tr-1307 eq 22 p 11
    pub fn kb_t(&self, mach: f64) -> f64 {
        if mach <= self.m_lo {
            return self.slender;
        }
        if mach >= self.m_hi {
            return self.kb_t_supersonic(mach);
        }
        let (k1, d1) = self.table(&self.k, self.m_hi);
        hermite(mach, self.m_lo, self.m_hi, self.slender, 0.0, k1, d1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TR 1307's chart quantity K_B(W) (β C_Lα)_W (1 + λ)(s/r − 1) from the
    /// quadrature. With S_W = c_r (1 + λ)(s − r) and d = 2r it is
    /// 4 β L_B(W)/(q α c_r d), a function of β m and β d/c_r only.
    fn chart_q(bm: f64, bd: f64, afterbody: bool) -> f64 {
        let (beta, c_r) = (1.3, 0.8);
        let d = bd * c_r / beta;
        let g = CarryGeometry {
            root_chord: c_r,
            tan_le: if bm.is_finite() { beta / bm } else { 0.0 },
            body_diameter: d,
            afterbody: if afterbody { 1e3 } else { 0.0 },
        };
        4.0 * beta * half_wing_body_lift(beta, &g).0 / (c_r * d)
    }

    /// Eq (24): afterbody, β m > 1.
    fn eq24(bm: f64, bd: f64) -> f64 {
        let s = (bm * bm - 1.0).sqrt();
        8.0 * bm / (PI * s * bd)
            * (bm / (1.0 + bm)
                * (((bm + 1.0) * bd + bm) / bm).powi(2)
                * ((1.0 + (1.0 + bm) * bd) / (bm + (bm + 1.0) * bd)).acos()
                + s / (bm + 1.0) * ((1.0 + 2.0 * bd).sqrt() - 1.0)
                - s / bm * bd * bd * (1.0 + 1.0 / bd).acosh()
                - bm / (1.0 + bm) * (1.0 / bm).acos())
    }

    /// Eq (26): afterbody, β m < 1.
    fn eq26(bm: f64, bd: f64) -> f64 {
        let r = (bm + (1.0 + bm) * bd) / bm;
        16.0 * (bm / (1.0 + bm)).powi(2) / (PI * bd)
            * (r.powf(1.5) + r.sqrt()
                - 2.0
                - ((1.0 + bm) * bd / bm).powi(2) * (1.0 / r).sqrt().atanh())
    }

    /// Eq (30): no afterbody, β m > 1, β d < c_r.
    fn eq30(bm: f64, bd: f64) -> f64 {
        let s = (bm * bm - 1.0).sqrt();
        let k = bm / bd; // m c_r/d
        8.0 / (PI * s)
            * bd
            * ((1.0 + k).powi(2) * ((bm + 1.0 / bd) / (1.0 + k)).acos()
                - (bm / bd).powi(2) * (1.0 / bm).acos()
                + bm / (bd * bd) * s * bd.asin()
                - s * (1.0 / bd).acosh())
    }

    /// Eq (31): no afterbody, β m < 1, β d < c_r.
    fn eq31(bm: f64, bd: f64) -> f64 {
        let k = bm / bd;
        let root = ((1.0 / bd - 1.0) / (k + 1.0)).sqrt();
        16.0 * bm.sqrt() / (PI * (bm + 1.0))
            * bd
            * ((1.0 + k) * ((1.0 / bd - 1.0) * (k + 1.0)).sqrt() - bm.powf(1.5) / (bd * bd)
                + bm / (bd * bd) * (bm + 1.0) * ((1.0 / bm).sqrt().atan() - root.atan())
                - (bm + 1.0) / bm.sqrt() * (bm.sqrt() * root).atanh())
    }

    #[test]
    fn gauss_legendre_integrates_polynomials() {
        let nodes = gauss_legendre(QUAD_N);
        let sum: f64 = nodes.iter().map(|n| n.1).sum();
        assert!((sum - 2.0).abs() < 1e-13);
        // ∫ x^38 dx on [−1, 1] = 2/39 (exact to degree 2n − 1 = 39).
        let i: f64 = nodes.iter().map(|&(x, w)| w * x.powi(38)).sum();
        assert!((i - 2.0 / 39.0).abs() < 1e-13);
    }

    #[test]
    fn quadrature_matches_the_afterbody_closed_forms() {
        for bd in [0.1, 0.4, 0.9, 2.0, 4.0] {
            for bm in [1.05, 1.2, 2.0, 4.0, 50.0] {
                let (q, c) = (chart_q(bm, bd, true), eq24(bm, bd));
                assert!(
                    (q / c - 1.0).abs() < 2e-5,
                    "(24) βm={bm} βd/c={bd}: {q} {c}"
                );
            }
            for bm in [0.2, 0.5, 0.8, 0.95] {
                let (q, c) = (chart_q(bm, bd, true), eq26(bm, bd));
                assert!(
                    (q / c - 1.0).abs() < 2e-5,
                    "(26) βm={bm} βd/c={bd}: {q} {c}"
                );
            }
        }
    }

    #[test]
    fn quadrature_matches_the_no_afterbody_closed_forms() {
        for bd in [0.1, 0.2, 0.4, 0.7, 0.95] {
            for bm in [1.05, 1.2, 2.0, 4.0, 50.0] {
                let (q, c) = (chart_q(bm, bd, false), eq30(bm, bd));
                assert!(
                    (q / c - 1.0).abs() < 2e-5,
                    "(30) βm={bm} βd/c={bd}: {q} {c}"
                );
            }
            for bm in [0.2, 0.5, 0.8, 0.95] {
                let (q, c) = (chart_q(bm, bd, false), eq31(bm, bd));
                assert!(
                    (q / c - 1.0).abs() < 2e-5,
                    "(31) βm={bm} βd/c={bd}: {q} {c}"
                );
            }
        }
    }

    #[test]
    fn rectangular_wing_closed_form() {
        // Eq (27): rectangular fins with an afterbody. βA r/s/(1 − r/s) is
        // β d/c_r, and the wing-alone slope is β C_Lα = 4 − 2/(βA).
        let (beta, c_r, r, span) = (1.6, 0.5, 0.2, 0.7);
        let s = r + span;
        let ba = beta * 2.0 * span / c_r;
        let x = ba * (r / s) / (1.0 - r / s);
        let k27 = 2.0 / (PI * (ba - 0.5))
            * (0.5 * (1.0 + x).powi(2) * (ba / (ba + s / r - 1.0)).acos()
                - 0.5 * x * x * (1.0 + 1.0 / x).acosh()
                - 0.5
                - PI / 4.0
                + 0.5 * (1.0 + 2.0 * x).sqrt());
        let g = CarryGeometry {
            root_chord: c_r,
            tan_le: 0.0,
            body_diameter: 2.0 * r,
            afterbody: 1e3,
        };
        let lift = half_wing_body_lift(beta, &g).0;
        // K = 2 L/(q α S_W C_Lα), S_W = 2 c_r (s − r).
        let k = 2.0 * lift / (2.0 * c_r * span * (4.0 - 2.0 / ba) / beta);
        assert!((k / k27 - 1.0).abs() < 2e-5, "{k} {k27}");
    }

    #[test]
    fn matches_barrowman_fig_3_9() {
        // Fig 3-9 (TR 1307 chart 4b, no afterbody) at 2 β r/c_r = 0.2.
        for (bm, v) in [(f64::INFINITY, 6.06), (4.0, 5.16), (2.0, 4.51)] {
            let q = chart_q(bm, 0.2, false);
            assert!((q - v).abs() < 0.01, "βm={bm}: {q} vs {v}");
        }
        // The unswept edge is the β m → ∞ limit of (30).
        assert!((chart_q(f64::INFINITY, 0.2, false) / eq30(1e6, 0.2) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn leading_edge_forms_meet_at_the_sonic_edge() {
        for after in [true, false] {
            let (lo, hi) = (
                chart_q(1.0 - 1e-7, 0.5, after),
                chart_q(1.0 + 1e-7, 0.5, after),
            );
            assert!((lo / hi - 1.0).abs() < 1e-5, "{lo} {hi}");
        }
    }

    #[test]
    fn no_afterbody_lift_is_constant_past_the_trailing_edge_mach_line() {
        // For β d > c_r the strip beyond η = c_r/β is behind the trailing
        // edge (pdf p 14), so the lift is that of β d = c_r: Q · βd/c_r is
        // constant.
        let at_edge = chart_q(2.0, 1.0, false);
        for bd in [1.5, 3.0] {
            assert!((chart_q(2.0, bd, false) * bd / at_edge - 1.0).abs() < 1e-9);
        }
        // A partial afterbody lies between the two end cases.
        let g = |l_aft: f64| CarryGeometry {
            root_chord: 1.0,
            tan_le: 0.3,
            body_diameter: 0.8,
            afterbody: l_aft,
        };
        let l = |l_aft: f64| half_wing_body_lift(1.5, &g(l_aft)).0;
        assert!(l(0.0) < l(0.4) && l(0.4) < l(5.0));
        assert!(
            (l(1.2) / l(5.0) - 1.0).abs() < 1e-12,
            "β d = 1.2 covers the strip"
        );
    }

    #[test]
    fn cp_of_the_carried_load() {
        // Unswept edge, no afterbody, β d ≥ c_r: with u = β η the lift is
        // (4/(π β²)) ∫_0^c dξ ∫_0^ξ cos⁻¹(u/ξ) du = 2 c²/(π β²) and the
        // moment (4/(π β²)) ∫ ξ² dξ = 4 c³/(3 π β²), so the CP is at 2c/3.
        let (beta, c) = (2.0, 0.6);
        let g = CarryGeometry {
            root_chord: c,
            tan_le: 0.0,
            body_diameter: 1.0,
            afterbody: 0.0,
        };
        let (lift, moment) = half_wing_body_lift(beta, &g);
        assert!((lift / (2.0 * c * c / (PI * beta * beta)) - 1.0).abs() < 1e-6);
        assert!((moment / lift / (2.0 * c / 3.0) - 1.0).abs() < 1e-6);
        // An afterbody moves the CP aft, past the trailing edge at high β d.
        let aft = CarryGeometry {
            afterbody: 1e3,
            ..g
        };
        let (la, ma) = half_wing_body_lift(beta, &aft);
        assert!(ma / la > moment / lift && ma / la > c);
    }

    fn planform(c_r: f64, c_t: f64, span: f64, sweep: f64, r_t: f64) -> FinPlanform {
        FinPlanform {
            count: 4,
            area: 0.5 * (c_r + c_t) * span,
            span,
            root_chord: c_r,
            tip_chord: c_t,
            mac: 0.0,
            y_mac: 0.0,
            x_mac_le: 0.0,
            x_root_le: 0.0,
            gamma_c: 0.0,
            gamma_le: (sweep / span).atan(),
            thickness: 0.0,
            cross_section: rw_model::FinCrossSection::Square,
            cant: 0.0,
            r_t,
            strips: Vec::new(),
        }
    }

    #[test]
    fn table_reproduces_the_integral_and_the_rectangular_value() {
        // 1 × 1 cal rectangular fins on a 1 cal body, flush with the base
        // (the Basic Finner): past β d = c_r the lift is 2 c²/(π β²), so
        // K_B(T) = β L/(4 A_fin) = 1/(2 π β).
        let p = planform(0.03, 0.03, 0.03, 0.0, 0.015);
        let c = Carryover::new(&p, 0.0);
        assert!((c.window().0 - 2f64.sqrt()).abs() < 1e-12);
        assert!((c.window().1 - (2f64.sqrt() + 0.25)).abs() < 1e-12);
        for m in [1.7, 1.832, 2.375, 3.03, 4.3, 5.9] {
            let exact = 1.0 / (2.0 * PI * beta(m));
            assert!(
                (c.kb_t(m) / exact - 1.0).abs() < 2e-4,
                "M={m}: {}",
                c.kb_t(m)
            );
            assert!((c.cp_supersonic(m) / 0.02 - 1.0).abs() < 1e-5, "M={m}");
        }
        // Swept, tapered fins with a partial afterbody, off the grid nodes.
        let p = planform(0.12, 0.05, 0.07, 0.06, 0.025);
        let c = Carryover::new(&p, 0.04);
        let g = CarryGeometry {
            root_chord: 0.12,
            tan_le: 0.06 / 0.07,
            body_diameter: 0.05,
            afterbody: 0.04,
        };
        for m in [c.window().1 + 0.03, 2.111, 3.456, 5.5] {
            let (lift, moment) = half_wing_body_lift(beta(m), &g);
            let k = beta(m) * lift / (4.0 * p.area);
            assert!(
                (c.kb_t(m) / k - 1.0).abs() < 2e-3,
                "M={m}: {} {k}",
                c.kb_t(m)
            );
            assert!(
                (c.cp_supersonic(m) / (moment / lift) - 1.0).abs() < 2e-3,
                "M={m}"
            );
        }
        // Held past the grid.
        assert_eq!(c.kb_t(7.0), c.kb_t(GRID_MACH_MAX));
    }

    #[test]
    fn kb_t_is_slender_below_the_criterion_and_c1_across_the_window() {
        let p = planform(0.03, 0.03, 0.03, 0.0, 0.015);
        let c = Carryover::new(&p, 0.0);
        let kt = kt_b(p.r_t, p.span);
        for m in [0.0, 0.3, 0.9, 1.2, c.window().0] {
            assert_eq!(c.kb_t(m), kt * kt - kt, "M={m}");
        }
        let h = 1e-6;
        for m in [c.window().0, c.window().1, c.window().1 + 0.1, 2.0] {
            let (lo, mid, hi) = (c.kb_t(m - h), c.kb_t(m), c.kb_t(m + h));
            assert!((hi - lo).abs() < 1e-5, "M={m}: value jump");
            let kink = ((hi - mid) - (mid - lo)).abs() / h;
            assert!(kink < 1e-4, "M={m}: slope jump {kink}");
        }
        // No lift is carried without a body.
        let bare = Carryover::new(&planform(0.03, 0.03, 0.03, 0.0, 0.0), 0.0);
        assert_eq!(bare.kb_t(0.5), 0.0);
        assert_eq!(bare.kb_t(2.5), 0.0);
        // A wide fin meets eq (22) from M 1, so the window ends at M 1.5.
        let wide = Carryover::new(&planform(0.03, 0.03, 0.09, 0.0, 0.015), 0.0);
        assert_eq!(
            wide.window(),
            ((1.0f64 + 1.0 / 9.0).sqrt(), SUPERSONIC_LIMIT)
        );
    }

    #[test]
    fn criterion() {
        // Rectangular 1 × 1 panels: A = 2, λ = 1, so β_c = 1 (M = √2).
        assert!((criterion_beta(2.0, 1.0, 0.0) - 1.0).abs() < 1e-15);
        // Sweep lowers it; a wide span meets it at every supersonic Mach.
        assert!((criterion_beta(2.0, 1.0, 0.4) - 0.6).abs() < 1e-15);
        assert_eq!(criterion_beta(6.0, 1.0, 0.0), 1.0 / 3.0);
        assert_eq!(criterion_beta(2.0, 1.0, 1.5), 0.0);
    }
}
