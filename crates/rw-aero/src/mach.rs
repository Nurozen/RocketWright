//! Compressibility helpers and the Niskanen (2009) Mach extension: β, the
//! Prandtl factor, stagnation pressure, the Busemann coefficients, and the
//! transonic blends. Notation follows `docs/dev/literature-map.md`.

/// Ratio of specific heats of air (AT-08).
pub const GAMMA: f64 = 1.4;

/// Upper Mach bound of the subsonic fin formulas used by the transonic blend.
pub const SUBSONIC_LIMIT: f64 = 0.9;
/// Lower Mach bound of the supersonic (Busemann strip) fin formulas.
pub const SUPERSONIC_LIMIT: f64 = 1.5;

/// Compressibility parameter β = sqrt(|M² − 1|).
/// cite: niskanen-2009 eq 3.13 p 40
pub fn beta(mach: f64) -> f64 {
    (mach * mach - 1.0).abs().sqrt()
}

/// Prandtl factor P_G = 1/sqrt(1 − M²) (M < 1).
/// cite: niskanen-2009 eq 3.14 p 40
pub fn prandtl(mach: f64) -> f64 {
    1.0 / beta(mach.min(0.999_999))
}

/// Stagnation-to-dynamic pressure ratio q_stag/q.
/// cite: niskanen-2009 eq B.1 p 116
pub fn stagnation_pressure_ratio(mach: f64) -> f64 {
    let m = mach.abs();
    if m < 1.0 {
        1.0 + m * m / 4.0 + m.powi(4) / 40.0
    } else {
        1.84 - 0.76 / m.powi(2) + 0.166 / m.powi(4) + 0.035 / m.powi(6)
    }
}

/// Blunt-cylinder (stagnation) pressure drag C_D•,stag = 0.85 q_stag/q, on
/// the cylinder's frontal area.
/// cite: niskanen-2009 eq B.2 p 117
pub fn stagnation_cd(mach: f64) -> f64 {
    0.85 * stagnation_pressure_ratio(mach)
}

/// Busemann third-order coefficients `[K_1, K_2, K_3]` for M > 1. K_3 keeps
/// the −12 M² term that niskanen-2009 eq 3.44 drops (literature-map Errata).
/// cite: barrowman-1967 eq 3-7 p 13-14
pub fn busemann(mach: f64) -> [f64; 3] {
    let m = mach.max(1.0 + 1e-9);
    let b = beta(m);
    let g = GAMMA;
    let (m2, m4) = (m * m, m.powi(4));
    let k1 = 2.0 / b;
    let k2 = ((g + 1.0) * m4 - 4.0 * b * b) / (4.0 * b.powi(4));
    let k3 =
        ((g + 1.0) * m.powi(8) + (2.0 * g * g - 7.0 * g - 5.0) * m.powi(6) + 10.0 * (g + 1.0) * m4
            - 12.0 * m2
            + 8.0)
            / (6.0 * b.powi(7));
    [k1, k2, k3]
}

/// Busemann strip pressure coefficient C_P = K_1 η + K_2 η² + K_3 η³ for a
/// surface inclination η (odd-extended: C_P(−η) = −C_P(η)).
/// cite: niskanen-2009 eq 3.41 p 40
pub fn busemann_cp(mach: f64, eta: f64) -> f64 {
    let [k1, k2, k3] = busemann(mach);
    let e = eta.abs();
    eta.signum() * (k1 * e + k2 * e * e + k3 * e * e * e)
}

/// Cubic Hermite interpolant on `[x0, x1]` through `(x0, y0)` with slope `d0`
/// and `(x1, y1)` with slope `d1`. Used for the transonic blends, whose end
/// conditions the sources state as value and slope constraints.
/// cite: n/a numerical interpolation (cubic Hermite basis)
pub fn hermite(x: f64, x0: f64, x1: f64, y0: f64, d0: f64, y1: f64, d1: f64) -> f64 {
    let h = x1 - x0;
    let t = ((x - x0) / h).clamp(0.0, 1.0);
    let (t2, t3) = (t * t, t * t * t);
    (2.0 * t3 - 3.0 * t2 + 1.0) * y0
        + (t3 - 2.0 * t2 + t) * h * d0
        + (-2.0 * t3 + 3.0 * t2) * y1
        + (t3 - t2) * h * d1
}

/// Blends a subsonic law (valid to [`SUBSONIC_LIMIT`]) and a supersonic law
/// (valid from [`SUPERSONIC_LIMIT`]) with a C¹ cubic in M, matching value and
/// slope at both ends. The thesis prints no transonic rule for fin C_Nα or
/// roll damping; this mirrors its fin-CP blend (eq 3.36), which is likewise a
/// polynomial fixed by value and slope constraints.
/// cite: niskanen-2009 eq 3.36 p 37
pub fn transonic_blend(mach: f64, sub: impl Fn(f64) -> f64, sup: impl Fn(f64) -> f64) -> f64 {
    let (a, b) = (SUBSONIC_LIMIT, SUPERSONIC_LIMIT);
    if mach <= a {
        return sub(mach);
    }
    if mach >= b {
        return sup(mach);
    }
    let h = 1e-5;
    let da = (sub(a) - sub(a - h)) / h;
    let db = (sup(b + h) - sup(b)) / h;
    hermite(mach, a, b, sub(a), da, sup(b), db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beta_and_prandtl() {
        assert!((beta(0.6) - 0.8).abs() < 1e-12);
        assert!((beta(1.25) - 0.75).abs() < 1e-12);
        assert!((prandtl(0.6) - 1.25).abs() < 1e-12);
    }

    #[test]
    fn stagnation_ratio_is_continuous_at_mach_one() {
        // B.1 both branches at M = 1: 1 + 1/4 + 1/40 = 1.275; 1.84 − 0.76 + 0.166 + 0.035 = 1.281.
        assert!((stagnation_pressure_ratio(1.0 - 1e-12) - 1.275).abs() < 1e-9);
        assert!((stagnation_pressure_ratio(1.0) - 1.281).abs() < 1e-12);
        assert!((stagnation_cd(0.0) - 0.85).abs() < 1e-12);
    }

    #[test]
    fn busemann_first_order_is_ackeret_half() {
        let [k1, k2, k3] = busemann(2.0);
        let b = 3.0_f64.sqrt();
        assert!((k1 - 2.0 / b).abs() < 1e-12);
        // K2 at M = 2: ((2.4)(16) − 4·3)/(4·9) = 26.4/36.
        assert!((k2 - 26.4 / 36.0).abs() < 1e-12);
        // K3 at M = 2 with the −12M² term: (2.4·256 + (3.92 − 9.8 − 5)·64 + 24·16 − 48 + 8)/(6 b⁷).
        let num = 2.4 * 256.0 + (2.0 * 1.96 - 9.8 - 5.0) * 64.0 + 24.0 * 16.0 - 48.0 + 8.0;
        assert!((k3 - num / (6.0 * b.powi(7))).abs() < 1e-12);
        assert!((busemann_cp(2.0, -0.1) + busemann_cp(2.0, 0.1)).abs() < 1e-15);
    }

    #[test]
    fn hermite_matches_end_conditions() {
        let f = |x: f64| hermite(x, 1.0, 2.0, 3.0, -1.0, 5.0, 2.0);
        assert!((f(1.0) - 3.0).abs() < 1e-12 && (f(2.0) - 5.0).abs() < 1e-12);
        let h = 1e-6;
        assert!(((f(1.0 + h) - f(1.0)) / h + 1.0).abs() < 1e-4);
        assert!(((f(2.0) - f(2.0 - h)) / h - 2.0).abs() < 1e-4);
    }

    #[test]
    fn blend_is_continuous() {
        let sub = |m: f64| 1.0 / beta(m);
        let sup = |m: f64| 2.0 / beta(m);
        for m in [SUBSONIC_LIMIT, SUPERSONIC_LIMIT] {
            let lo = transonic_blend(m - 1e-9, sub, sup);
            let hi = transonic_blend(m + 1e-9, sub, sup);
            assert!((lo - hi).abs() < 1e-6, "{m}: {lo} vs {hi}");
        }
    }
}
