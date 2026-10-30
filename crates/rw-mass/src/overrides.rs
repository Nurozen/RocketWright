//! Mass and CG overrides (`override = { mass, cg, subtree }`), applied to one
//! component or to a component and all its descendants.
//!
//! - Mass override: every member keeps its distribution and is scaled by
//!   k = m'/m, so I' = k I (MI-03).
//! - CG override: every member moves by Δ = x_cg' − x_cg and gains the
//!   transverse parallel-axis term m_i Δ², so the group's
//!   I_yy' = I_yy + m Δ² about the new CG (MI-04).
//!
//! Applying the change member by member keeps the per-component breakdown
//! summing to the vehicle totals.

use crate::body::RigidBody;

/// Applies an override to `parts` (a component, or a subtree). Returns
/// whether anything was overridden. `x_ref` is the station used for a mass
/// override on a massless group with no CG override (the component middle).
/// cite: niskanen-2009 sec 4.2.3 p 74
pub fn apply_override(
    parts: &mut [RigidBody],
    mass: Option<f64>,
    cg: Option<f64>,
    x_ref: f64,
) -> bool {
    if parts.is_empty() || (mass.is_none() && cg.is_none()) {
        return false;
    }
    if let Some(m_new) = mass {
        let m_old = RigidBody::combine(parts.iter()).mass;
        if m_old == 0.0 {
            for p in parts.iter_mut() {
                *p = RigidBody::ZERO;
            }
            parts[0] = RigidBody::point(m_new, [cg.unwrap_or(x_ref), 0.0, 0.0]);
            return true;
        }
        let k = m_new / m_old;
        for p in parts.iter_mut() {
            *p = p.scaled(k);
        }
    }
    if let Some(x_new) = cg {
        let agg = RigidBody::combine(parts.iter());
        let dx = x_new - agg.cg[0];
        for p in parts.iter_mut() {
            let mut q = p.translated([dx, 0.0, 0.0]);
            q.inertia[1][1] += p.mass * dx * dx;
            q.inertia[2][2] += p.mass * dx * dx;
            *p = q;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mass_then_cg() {
        let mut parts = [
            RigidBody::axisymmetric(1.0, [0.0, 0.0, 0.0], 0.1, 0.2),
            RigidBody::axisymmetric(1.0, [2.0, 0.0, 0.0], 0.1, 0.2),
        ];
        let before = RigidBody::combine(parts.iter());
        assert!(apply_override(&mut parts, Some(4.0), Some(1.5), 0.0));
        let after = RigidBody::combine(parts.iter());
        assert!((after.mass - 4.0).abs() < 1e-14);
        assert!((after.cg[0] - 1.5).abs() < 1e-14);
        // I' = k I + m' Δ², k = 2, Δ = 0.5.
        let want = 2.0 * before.inertia[1][1] + 4.0 * 0.25;
        assert!((after.inertia[1][1] - want).abs() < 1e-13);
        assert!((after.inertia[0][0] - 2.0 * before.inertia[0][0]).abs() < 1e-14);
    }

    #[test]
    fn massless_group_becomes_point() {
        let mut parts = [RigidBody::ZERO, RigidBody::ZERO];
        assert!(apply_override(&mut parts, Some(0.5), None, 0.3));
        assert_eq!(parts[0], RigidBody::point(0.5, [0.3, 0.0, 0.0]));
        assert_eq!(parts[1], RigidBody::ZERO);
    }
}
