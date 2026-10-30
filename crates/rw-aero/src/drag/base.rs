//! Base drag of the body and of rapid diameter reductions (Niskanen 2009 §3.4.5).

/// Base drag on the base area: 0.12 + 0.13 M² (M < 1), 0.25/M (M ≥ 1).
/// cite: niskanen-2009 eq 3.94 p 60
pub fn base_cd(mach: f64) -> f64 {
    let m = mach.max(0.0);
    if m < 1.0 {
        0.12 + 0.13 * m * m
    } else {
        0.25 / m
    }
}

/// Base area with the exhaust of thrusting motors removed,
/// max(A_base − A_motor, 0) while thrusting.
/// cite: niskanen-2009 sec 3.4.5 p 61
pub fn effective_base_area(base_area: f64, motor_area: f64, thrusting: bool) -> f64 {
    if thrusting {
        (base_area - motor_area).max(0.0)
    } else {
        base_area.max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_drag_worked_values() {
        assert!((base_cd(0.0) - 0.12).abs() < 1e-15);
        assert!((base_cd(0.5) - 0.1525).abs() < 1e-15);
        // Continuous at M = 1 (0.25 on both branches).
        assert!((base_cd(1.0 - 1e-12) - 0.25).abs() < 1e-9);
        assert!((base_cd(2.0) - 0.125).abs() < 1e-15);
        assert_eq!(effective_base_area(1.0, 0.4, true), 0.6);
        assert_eq!(effective_base_area(1.0, 2.0, true), 0.0);
        assert_eq!(effective_base_area(1.0, 0.4, false), 1.0);
    }
}
