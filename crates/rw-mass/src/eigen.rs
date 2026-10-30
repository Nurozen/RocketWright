//! Principal moments of inertia: a hand-rolled cyclic Jacobi eigen-solver for
//! a symmetric 3×3 matrix (plan: "hand-rolled 3×3 Jacobi").

// Matrix rotations read most clearly with explicit row/column indices.
#![allow(clippy::needless_range_loop)]

use crate::body::{IDENTITY, Mat3, RigidBody};

/// Principal moments (ascending) and the matching unit axes (`axes[k]` is the
/// body-frame direction of `moments[k]`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Principal {
    pub moments: [f64; 3],
    pub axes: [[f64; 3]; 3],
}

/// Eigenvalues and eigenvectors of a symmetric 3×3 matrix by cyclic Jacobi
/// rotations. Returns `(values, vectors)` sorted ascending; `vectors[k]` is the
/// unit eigenvector of `values[k]`. Only the upper triangle is read.
/// cite: n/a numerical method (cyclic Jacobi eigenvalue rotations, symmetric 3x3)
pub fn jacobi_eigen(a: &Mat3) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut m = *a;
    for i in 0..3 {
        for j in 0..i {
            m[i][j] = m[j][i];
        }
    }
    // Columns of v are the eigenvectors.
    let mut v = IDENTITY;
    let scale = m
        .iter()
        .flatten()
        .fold(0.0_f64, |s, x| s.max(x.abs()))
        .max(f64::MIN_POSITIVE);
    for _sweep in 0..64 {
        let off = m[0][1].abs() + m[0][2].abs() + m[1][2].abs();
        if off <= 1e-18 * scale {
            break;
        }
        for (p, q) in [(0usize, 1usize), (0, 2), (1, 2)] {
            let apq = m[p][q];
            if apq == 0.0 {
                continue;
            }
            // Rotation angle that zeroes m[p][q] (stable tangent form).
            let theta = (m[q][q] - m[p][p]) / (2.0 * apq);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            // m ← Jᵀ m J with J the (p, q) Givens rotation.
            for k in 0..3 {
                let (mkp, mkq) = (m[k][p], m[k][q]);
                m[k][p] = c * mkp - s * mkq;
                m[k][q] = s * mkp + c * mkq;
            }
            for k in 0..3 {
                let (mpk, mqk) = (m[p][k], m[q][k]);
                m[p][k] = c * mpk - s * mqk;
                m[q][k] = s * mpk + c * mqk;
            }
            m[p][q] = 0.0;
            m[q][p] = 0.0;
            for row in v.iter_mut() {
                let (vp, vq) = (row[p], row[q]);
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| m[i][i].total_cmp(&m[j][j]));
    let values = idx.map(|i| m[i][i]);
    let vectors = idx.map(|i| [v[0][i], v[1][i], v[2][i]]);
    (values, vectors)
}

/// Principal moments of inertia of a body about its CG.
/// cite: n/a numerical method (eigen-decomposition of the inertia tensor, MI-08 definitions)
pub fn principal(body: &RigidBody) -> Principal {
    let (moments, axes) = jacobi_eigen(&body.inertia);
    Principal { moments, axes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::{rot_x, rot_y};

    fn check_decomposition(a: &Mat3, tol: f64) {
        let (vals, vecs) = jacobi_eigen(a);
        for k in 0..3 {
            let v = vecs[k];
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!((n - 1.0).abs() < 1e-12);
            for i in 0..3 {
                let av: f64 = (0..3).map(|j| a[i][j] * v[j]).sum();
                assert!((av - vals[k] * v[i]).abs() < tol, "A v = λ v failed");
            }
            for l in 0..k {
                let d: f64 = (0..3).map(|i| v[i] * vecs[l][i]).sum();
                assert!(d.abs() < 1e-12, "not orthogonal");
            }
        }
        assert!(vals[0] <= vals[1] && vals[1] <= vals[2]);
    }

    #[test]
    fn diagonal_is_identity_decomposition() {
        let a = [[3.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 2.0]];
        let (vals, _) = jacobi_eigen(&a);
        assert_eq!(vals, [1.0, 2.0, 3.0]);
    }

    #[test]
    fn known_matrix() {
        // Eigenvalues of [[2,1,0],[1,2,1],[0,1,2]] are 2 − √2, 2, 2 + √2.
        let a = [[2.0, 1.0, 0.0], [1.0, 2.0, 1.0], [0.0, 1.0, 2.0]];
        let (vals, _) = jacobi_eigen(&a);
        let s = 2f64.sqrt();
        for (v, e) in vals.iter().zip([2.0 - s, 2.0, 2.0 + s]) {
            assert!((v - e).abs() < 1e-14);
        }
        check_decomposition(&a, 1e-13);
    }

    #[test]
    fn rotated_tensor_recovers_principal_values() {
        let body = RigidBody::axisymmetric(1.0, [0.0; 3], 0.5, 4.0);
        let q = {
            let (a, b) = (rot_x(0.7), rot_y(-0.4));
            let mut c = [[0.0; 3]; 3];
            for i in 0..3 {
                for j in 0..3 {
                    c[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
                }
            }
            c
        };
        let r = body.rotated(&q);
        let p = principal(&r);
        assert!((p.moments[0] - 0.5).abs() < 1e-13);
        assert!((p.moments[1] - 4.0).abs() < 1e-13);
        assert!((p.moments[2] - 4.0).abs() < 1e-13);
        // The roll axis is the rotated +X.
        let x = [q[0][0], q[1][0], q[2][0]];
        let d: f64 = (0..3).map(|i| x[i] * p.axes[0][i]).sum();
        assert!((d.abs() - 1.0).abs() < 1e-12);
        check_decomposition(&r.inertia, 1e-13);
    }

    #[test]
    fn degenerate_and_zero() {
        check_decomposition(&[[0.0; 3]; 3], 1e-15);
        check_decomposition(&[[1.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0]], 1e-13);
    }
}
