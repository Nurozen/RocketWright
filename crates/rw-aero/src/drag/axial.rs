//! Axial drag versus angle of attack (Niskanen 2009 §3.4.7).

use crate::mach::hermite;

const PEAK_DEG: f64 = 17.0;

/// Scaling of the zero-α drag to the axial coefficient, C_A = C_D,0 f_A(α).
/// The source fixes only the constraints f_A(0°) = 1, f_A(17°) = 1.3,
/// f_A(90°) = 0 with zero slope at all three (literature-map Gaps 4); the two
/// parts are the cubics those constraints define. Past 90° the body flies
/// tail first and the axial force reverses: f_A(α) = −f_A(180° − α).
/// cite: niskanen-2009 sec 3.4.7 p 63
pub fn axial_factor(alpha: f64) -> f64 {
    let a = alpha.abs().to_degrees() % 360.0;
    let a = if a > 180.0 { 360.0 - a } else { a };
    if a > 90.0 {
        return -axial_factor((180.0 - a).to_radians());
    }
    if a <= PEAK_DEG {
        hermite(a, 0.0, PEAK_DEG, 1.0, 0.0, 1.3, 0.0)
    } else {
        hermite(a, PEAK_DEG, 90.0, 1.3, 0.0, 0.0, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constraints_hold() {
        let f = |d: f64| axial_factor(d.to_radians());
        assert!((f(0.0) - 1.0).abs() < 1e-12);
        assert!((f(17.0) - 1.3).abs() < 1e-12);
        assert!(f(90.0).abs() < 1e-12);
        let h = 1e-4;
        for d in [0.0, 17.0, 90.0] {
            let s = (f(d + h) - f(d - h)) / (2.0 * h);
            assert!(s.abs() < 1e-6, "{d}: {s}");
        }
        assert!((f(180.0) + 1.0).abs() < 1e-12);
    }
}
