//! Rigid-body mass properties with the full 3×3 inertia tensor, and their
//! composition by the parallel-axis theorem (MI-24, MI-27..MI-29).
//!
//! Frame: body axes (+X aft along the station axis, +Z up, +Y = Z × X). The
//! inertia tensor is about the body's own CG, with the products of inertia
//! carrying the usual minus sign (`I = ∫(|r|² E − r rᵀ) dm`, MI-08).

use crate::types::MassProps;

/// A 3×3 matrix, row-major.
pub type Mat3 = [[f64; 3]; 3];

/// The 3×3 identity.
pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

const ZERO3: Mat3 = [[0.0; 3]; 3];

/// Mass, CG, and the inertia tensor about the CG.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigidBody {
    pub mass: f64,
    /// CG in the body frame; `cg[0]` is the station.
    pub cg: [f64; 3],
    /// Inertia tensor about the CG, body axes.
    pub inertia: Mat3,
}

impl Default for RigidBody {
    fn default() -> Self {
        Self::ZERO
    }
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut c = ZERO3;
    for (i, row) in c.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    c
}

fn transpose(a: &Mat3) -> Mat3 {
    let mut t = ZERO3;
    for (i, row) in a.iter().enumerate() {
        for (j, v) in row.iter().enumerate() {
            t[j][i] = *v;
        }
    }
    t
}

fn mat_vec(a: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}

/// Steiner term `m (|d|² E − d dᵀ)`: the inertia of a point mass `m` at `d`.
/// cite: amcp-706-280 eq 6-1 p 103
/// cite: mil-hdbk-762 eq 7-21 p 564
pub fn steiner(m: f64, d: [f64; 3]) -> Mat3 {
    let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let mut s = ZERO3;
    for (i, row) in s.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            let e = if i == j { d2 } else { 0.0 };
            *v = m * (e - d[i] * d[j]);
        }
    }
    s
}

fn add(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut c = *a;
    for (i, row) in c.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v += b[i][j];
        }
    }
    c
}

/// Rotation about +X by `roll` (right-handed, +Y toward +Z).
/// cite: n/a frame rotation matrix (same convention as rw_geom::frames::roll_about_x)
pub fn rot_x(roll: f64) -> Mat3 {
    let (s, c) = roll.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

/// Rotation about +Y by `angle` (right-handed, +Z toward +X).
/// cite: n/a frame rotation matrix (same convention as rw_geom::frames::rotate_about_y)
pub fn rot_y(angle: f64) -> Mat3 {
    let (s, c) = angle.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

impl RigidBody {
    pub const ZERO: RigidBody = RigidBody {
        mass: 0.0,
        cg: [0.0; 3],
        inertia: ZERO3,
    };

    /// A point mass.
    /// cite: n/a constructor, no physics
    pub fn point(mass: f64, at: [f64; 3]) -> Self {
        Self {
            mass,
            cg: at,
            inertia: ZERO3,
        }
    }

    /// A body symmetric about a line parallel to +X through `cg`: roll inertia
    /// `ixx`, transverse `iyy = izz` (MI-02).
    /// cite: niskanen-2009 sec 4.2.3 p 74
    pub fn axisymmetric(mass: f64, cg: [f64; 3], ixx: f64, iyy: f64) -> Self {
        Self {
            mass,
            cg,
            inertia: [[ixx, 0.0, 0.0], [0.0, iyy, 0.0], [0.0, 0.0, iyy]],
        }
    }

    /// From the raw moments about the frame origin: mass `m`, first moment
    /// `first = ∫r dm`, and second-moment matrix `second = ∫r rᵀ dm`. The
    /// inertia about the CG is `tr(S_c) E − S_c` with `S_c = S − m c cᵀ` (MI-08).
    /// A massless input gives [`RigidBody::ZERO`].
    /// cite: mil-hdbk-762 eq 7-20 p 564
    pub fn from_moments(m: f64, first: [f64; 3], second: Mat3) -> Self {
        if m == 0.0 {
            return Self::ZERO;
        }
        let c = first.map(|f| f / m);
        let mut sc = second;
        for (i, row) in sc.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v -= m * c[i] * c[j];
            }
        }
        let tr = sc[0][0] + sc[1][1] + sc[2][2];
        let mut inertia = ZERO3;
        for (i, row) in inertia.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = if i == j { tr } else { 0.0 } - sc[i][j];
            }
        }
        Self {
            mass: m,
            cg: c,
            inertia,
        }
    }

    /// Rotated about the frame origin by `q`: `c' = q c`, `I' = q I qᵀ`.
    /// cite: n/a tensor rotation, no physics
    pub fn rotated(&self, q: &Mat3) -> Self {
        Self {
            mass: self.mass,
            cg: mat_vec(q, self.cg),
            inertia: mat_mul(&mat_mul(q, &self.inertia), &transpose(q)),
        }
    }

    /// Translated by `d` (a rigid move; the inertia about the CG is unchanged).
    /// cite: n/a rigid translation, no physics
    pub fn translated(&self, d: [f64; 3]) -> Self {
        Self {
            cg: [self.cg[0] + d[0], self.cg[1] + d[1], self.cg[2] + d[2]],
            ..*self
        }
    }

    /// Mass and inertia scaled by `k` (same distribution, different density).
    /// cite: niskanen-2009 sec 4.2.3 p 74
    pub fn scaled(&self, k: f64) -> Self {
        Self {
            mass: self.mass * k,
            cg: self.cg,
            inertia: self.inertia.map(|r| r.map(|v| v * k)),
        }
    }

    /// The inertia tensor about the point `p` (parallel-axis theorem, MI-24).
    /// cite: amcp-706-280 eq 6-1 p 103
    pub fn inertia_about(&self, p: [f64; 3]) -> Mat3 {
        let d = [0, 1, 2].map(|i| self.cg[i] - p[i]);
        add(&self.inertia, &steiner(self.mass, d))
    }

    /// Several bodies as one: m = Σ m_i (MI-27), c = Σ m_i c_i / m (MI-28),
    /// I = Σ [I_i + m_i (|d_i|² E − d_i d_iᵀ)], d_i = c_i − c (MI-29, MI-24).
    /// Negative masses (cuts) are allowed. A total mass of 0 puts the CG at the
    /// origin and sums the inertias about it.
    /// cite: mil-hdbk-762 eq 7-27 p 566
    /// cite: mil-hdbk-762 eq 7-28 p 566
    /// cite: mil-hdbk-762 eq 7-22 p 564
    pub fn combine<'a>(parts: impl IntoIterator<Item = &'a RigidBody>) -> Self {
        let parts: Vec<&RigidBody> = parts.into_iter().collect();
        let m: f64 = parts.iter().map(|p| p.mass).sum();
        let cg = if m == 0.0 {
            [0.0; 3]
        } else {
            [0, 1, 2].map(|i| parts.iter().map(|p| p.mass * p.cg[i]).sum::<f64>() / m)
        };
        let inertia = parts
            .iter()
            .fold(ZERO3, |acc, p| add(&acc, &p.inertia_about(cg)));
        Self {
            mass: m,
            cg,
            inertia,
        }
    }

    /// The IF5 summary: station CG, roll inertia `I_xx` about the CG, and the
    /// transverse inertia as the mean of `I_yy` and `I_zz` (equal for an
    /// axisymmetric vehicle, MI-02).
    /// cite: niskanen-2009 sec 4.2.3 p 74
    pub fn props(&self) -> MassProps {
        MassProps {
            mass: self.mass,
            cg: self.cg[0],
            ixx: self.inertia[0][0],
            iyy: 0.5 * (self.inertia[1][1] + self.inertia[2][2]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-12 * b.abs().max(1.0)
    }

    #[test]
    fn two_point_masses() {
        let a = RigidBody::point(1.0, [0.0, 0.0, 0.0]);
        let b = RigidBody::point(3.0, [2.0, 0.0, 0.0]);
        let c = RigidBody::combine([&a, &b]);
        assert!(close(c.mass, 4.0));
        assert!(close(c.cg[0], 1.5));
        // I_yy = 1·1.5² + 3·0.5² = 3.0
        assert!(close(c.inertia[1][1], 3.0));
        assert!(close(c.inertia[2][2], 3.0));
        assert!(close(c.inertia[0][0], 0.0));
    }

    #[test]
    fn rotation_preserves_trace_and_moves_products() {
        let b = RigidBody::axisymmetric(2.0, [0.0, 1.0, 0.0], 1.0, 3.0);
        let r = b.rotated(&rot_x(std::f64::consts::FRAC_PI_2));
        assert!(close(r.cg[2], 1.0) && r.cg[1].abs() < 1e-15);
        let tr = |m: &Mat3| m[0][0] + m[1][1] + m[2][2];
        assert!(close(tr(&r.inertia), tr(&b.inertia)));
        let y = b.rotated(&rot_y(std::f64::consts::FRAC_PI_2));
        // The symmetry axis X maps to −Z: I_zz becomes the roll value.
        assert!(close(y.inertia[2][2], 1.0) && close(y.inertia[0][0], 3.0));
    }

    #[test]
    fn from_moments_matches_combine() {
        let pts = [([1.0, 2.0, 0.5], 0.7), ([-0.3, 0.1, 0.2], 1.3)];
        let mut first = [0.0; 3];
        let mut second = ZERO3;
        let mut m = 0.0;
        for (p, w) in pts {
            m += w;
            for i in 0..3 {
                first[i] += w * p[i];
                for j in 0..3 {
                    second[i][j] += w * p[i] * p[j];
                }
            }
        }
        let a = RigidBody::from_moments(m, first, second);
        let bodies: Vec<RigidBody> = pts.iter().map(|(p, w)| RigidBody::point(*w, *p)).collect();
        let b = RigidBody::combine(&bodies);
        for i in 0..3 {
            assert!(close(a.cg[i], b.cg[i]));
            for j in 0..3 {
                assert!(close(a.inertia[i][j], b.inertia[i][j]), "{i}{j}");
            }
        }
    }
}
