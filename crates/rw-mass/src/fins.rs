//! Fin plates: planform + tab polygons extruded by the thickness, root
//! fillets, cant, and roll placement.
//!
//! The plate is integrated exactly from its polygon (Green's theorem area
//! moments), so the roll inertia keeps the cross term 2 r_t η̄ m that the
//! handbook table drops (literature-map Errata, amcp-706-280 Table 6-1).

use rw_geom::{FinGeometry, InstanceGeometry};

use crate::body::{Mat3, RigidBody, rot_x, rot_y};

/// Area moments of a simple polygon in (x, y).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PolyMoments {
    /// ∫ dA.
    pub a: f64,
    /// ∫ x dA.
    pub ax: f64,
    /// ∫ y dA.
    pub ay: f64,
    /// ∫ x² dA.
    pub axx: f64,
    /// ∫ y² dA.
    pub ayy: f64,
    /// ∫ x y dA.
    pub axy: f64,
}

impl PolyMoments {
    fn plus(self, o: PolyMoments) -> PolyMoments {
        PolyMoments {
            a: self.a + o.a,
            ax: self.ax + o.ax,
            ay: self.ay + o.ay,
            axx: self.axx + o.axx,
            ayy: self.ayy + o.ayy,
            axy: self.axy + o.axy,
        }
    }
}

/// Area, first, and second moments of a simple polygon (either orientation;
/// the result is for the enclosed region), by Green's theorem edge sums.
/// cite: n/a pure geometry (polygon area moments by Green's theorem; MI-08 integrands)
pub fn polygon_moments(poly: &[[f64; 2]]) -> PolyMoments {
    let n = poly.len();
    if n < 3 {
        return PolyMoments::default();
    }
    let mut m = PolyMoments::default();
    for i in 0..n {
        let [x0, y0] = poly[i];
        let [x1, y1] = poly[(i + 1) % n];
        let c = x0 * y1 - x1 * y0;
        m.a += c / 2.0;
        m.ax += (x0 + x1) * c / 6.0;
        m.ay += (y0 + y1) * c / 6.0;
        m.axx += (x0 * x0 + x0 * x1 + x1 * x1) * c / 12.0;
        m.ayy += (y0 * y0 + y0 * y1 + y1 * y1) * c / 12.0;
        m.axy += (x0 * y1 + 2.0 * x0 * y0 + 2.0 * x1 * y1 + x1 * y0) * c / 24.0;
    }
    if m.a < 0.0 {
        m = PolyMoments {
            a: -m.a,
            ax: -m.ax,
            ay: -m.ay,
            axx: -m.axx,
            ayy: -m.ayy,
            axy: -m.axy,
        };
    }
    m
}

/// Fraction of r² in one root-fillet cross-section: the region between two
/// perpendicular walls and a quarter circle of radius r, A = r²(1 − π/4).
/// cite: n/a derived (square minus quarter disc; literature-map Gaps 2, no printed fillet equation)
pub fn fillet_area(r: f64) -> f64 {
    r * r * (1.0 - std::f64::consts::FRAC_PI_4)
}

/// Distance of the fillet cross-section centroid from each wall,
/// d = r (10 − 3π)/(12 − 3π) ≈ 0.2234 r.
/// cite: n/a derived (first moment of square minus quarter disc; literature-map Gaps 2)
pub fn fillet_centroid_offset(r: f64) -> f64 {
    let pi = std::f64::consts::PI;
    r * (10.0 - 3.0 * pi) / (12.0 - 3.0 * pi)
}

/// Root leading and trailing edge stations of a planform (vertices on y = 0).
fn root_edge(poly: &[[f64; 2]]) -> Option<(f64, f64)> {
    let (lo, hi) = poly
        .iter()
        .filter(|p| p[1].abs() < 1e-12)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), p| {
            (a.min(p[0]), b.max(p[0]))
        });
    (lo.is_finite() && hi > lo).then_some((lo, hi))
}

/// Raw moments (mass, first moment, second-moment matrix) in the plate frame
/// (u = x − x_pivot along the chord, v up the span from the root, w normal).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Raw {
    m: f64,
    first: [f64; 3],
    second: Mat3,
}

impl Raw {
    fn add_point_line(&mut self, mass: f64, c: [f64; 3], chord_len: f64) {
        // A uniform line mass along u through c (length chord_len).
        self.m += mass;
        for i in 0..3 {
            self.first[i] += mass * c[i];
            for j in 0..3 {
                self.second[i][j] += mass * c[i] * c[j];
            }
        }
        self.second[0][0] += mass * chord_len * chord_len / 12.0;
    }
}

/// One fin (no roll, no instance offset) as a rigid body in the
/// component-local frame: plate (planform + tab) of thickness t with areal
/// mass `rho_t` = ρ t, plus two root fillets of bulk density `rho_fillet`,
/// with the cant rotation about the root mid-chord at radius `root_radius`.
/// cite: amcp-706-280 tab 6-1 p 104
/// cite: mil-hdbk-762 eq 7-20 p 564
pub fn fin_local_body(fin: &FinGeometry, rho_t: f64, rho_fillet: f64) -> RigidBody {
    let pm = fin
        .tab
        .as_deref()
        .map(polygon_moments)
        .unwrap_or_default()
        .plus(polygon_moments(&fin.planform));
    let xp = rw_geom::frames::fin_pivot_x(fin);
    let t = fin.thickness;
    // Plate: shift x to u = x − xp; the thickness adds ∫w² = t²/12 per mass.
    let mut raw = Raw {
        m: rho_t * pm.a,
        first: [rho_t * (pm.ax - xp * pm.a), rho_t * pm.ay, 0.0],
        second: [[0.0; 3]; 3],
    };
    raw.second[0][0] = rho_t * (pm.axx - 2.0 * xp * pm.ax + xp * xp * pm.a);
    raw.second[1][1] = rho_t * pm.ayy;
    raw.second[2][2] = rho_t * pm.a * t * t / 12.0;
    raw.second[0][1] = rho_t * (pm.axy - xp * pm.ay);
    raw.second[1][0] = raw.second[0][1];
    // Fillets: two line masses along the root, one on each face.
    if fin.fillet_radius > 0.0
        && rho_fillet > 0.0
        && let Some((le, te)) = root_edge(&fin.planform)
    {
        let len = te - le;
        let mf = rho_fillet * fillet_area(fin.fillet_radius) * len;
        let d = fillet_centroid_offset(fin.fillet_radius);
        let u = 0.5 * (le + te) - xp;
        for side in [-1.0, 1.0] {
            raw.add_point_line(mf, [u, d, side * (0.5 * t + d)], len);
        }
    }
    let plate = RigidBody::from_moments(raw.m, raw.first, raw.second);
    // Cant about the span axis through the pivot, then lift to the pivot point.
    plate
        .rotated(&rot_y(fin.cant))
        .translated([xp, fin.root_radius, 0.0])
}

/// A whole fin set: each instance places the local fin by
/// `p = Rx(roll) p_local + offset` (rw-geom frames).
/// cite: mil-hdbk-762 eq 7-22 p 564
pub fn fin_set_body(
    fin: &FinGeometry,
    instances: &[InstanceGeometry],
    rho_t: f64,
    rho_fillet: f64,
) -> RigidBody {
    let one = fin_local_body(fin, rho_t, rho_fillet);
    let placed: Vec<RigidBody> = instances
        .iter()
        .map(|i| one.rotated(&rot_x(i.roll)).translated(i.offset))
        .collect();
    RigidBody::combine(&placed)
}

/// Spanwise CG of a trapezoidal fin from the root, η̄ = (s/3)(1 + 2λ)/(1 + λ),
/// λ = c_t/c_r.
/// cite: amcp-706-280 tab 6-1 p 104
pub fn trapezoid_span_cg(span: f64, taper: f64) -> f64 {
    span / 3.0 * (1.0 + 2.0 * taper) / (1.0 + taper)
}

/// Roll inertia of one thin trapezoidal fin about the body axis, **with** the
/// cross term the handbook table omits (Errata):
/// I_xx = m [r_t² + 2 r_t η̄ + (s²/6)(1 + 3λ)/(1 + λ)].
/// cite: amcp-706-280 tab 6-1 p 104
pub fn trapezoid_fin_roll_inertia(mass: f64, span: f64, taper: f64, root_radius: f64) -> f64 {
    let eta = trapezoid_span_cg(span, taper);
    mass * (root_radius * root_radius
        + 2.0 * root_radius * eta
        + span * span / 6.0 * (1.0 + 3.0 * taper) / (1.0 + taper))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_square_moments() {
        let sq = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let m = polygon_moments(&sq);
        assert!((m.a - 1.0).abs() < 1e-15);
        assert!((m.ax - 0.5).abs() < 1e-15 && (m.ay - 0.5).abs() < 1e-15);
        assert!((m.axx - 1.0 / 3.0).abs() < 1e-15);
        assert!((m.ayy - 1.0 / 3.0).abs() < 1e-15);
        assert!((m.axy - 0.25).abs() < 1e-15);
        let rev: Vec<[f64; 2]> = sq.iter().rev().copied().collect();
        assert_eq!(polygon_moments(&rev), m);
    }

    #[test]
    fn fillet_constants() {
        // The spandrel centroid: (r²·r/2 − (π r²/4)(r − 4r/(3π))) / A.
        let r = 0.01;
        let a = fillet_area(r);
        let pi = std::f64::consts::PI;
        let num = r * r * r / 2.0 - pi * r * r / 4.0 * (r - 4.0 * r / (3.0 * pi));
        assert!((fillet_centroid_offset(r) - num / a).abs() < 1e-15);
    }
}
