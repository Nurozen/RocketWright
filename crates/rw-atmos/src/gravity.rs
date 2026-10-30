//! Gravitational acceleration for the launch-site frame.
//!
//! Three models, selected by the simulation's `Conditions.geodetic`:
//! - [`GravityModel::Constant`]: g = g_0 everywhere (flat Earth).
//! - [`GravityModel::Uniform`]: a user-given constant g (`Conditions.gravity`).
//! - [`GravityModel::InverseSquare`]: g(z) = g_0 (r_0 / (r_0 + z))² (USSA (17)).
//! - [`GravityModel::Somigliana`]: WGS84 normal gravity at the site latitude
//!   with a second-order height correction, ported from RocketPy.

use crate::ussa1976::{G0, R0};

/// Gravity model plus the site latitude it needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GravityModel {
    /// Uniform g_0.
    Constant,
    /// Uniform, user-given magnitude (m/s², positive down).
    Uniform { g_ms2: f64 },
    /// Inverse-square law on the USSA effective radius.
    InverseSquare,
    /// WGS84 Somigliana normal gravity at `latitude_deg`.
    Somigliana { latitude_deg: f64 },
}

impl GravityModel {
    /// Magnitude of gravity (m/s², positive down) at geometric altitude `z`
    /// above mean sea level.
    ///
    /// cite: ussa-1976 eq 17 p 24
    pub fn at(&self, z: f64) -> f64 {
        match *self {
            Self::Constant => G0,
            Self::Uniform { g_ms2 } => g_ms2,
            Self::InverseSquare => inverse_square(z),
            Self::Somigliana { latitude_deg } => somigliana(latitude_deg, z),
        }
    }
}

/// g(z) = g_0 (r_0 / (r_0 + z))².
///
/// cite: ussa-1976 eq 17 p 24
pub fn inverse_square(z: f64) -> f64 {
    let r = R0 / (R0 + z);
    G0 * r * r
}

/// WGS84 Somigliana normal gravity at `latitude_deg` and ellipsoidal height
/// `height` (m), with the second-order free-air height correction.
///
// Ported from RocketPy (MIT) rocketpy/environment/environment.py:Environment.somigliana_gravity
pub fn somigliana(latitude_deg: f64, height: f64) -> f64 {
    let a = 6_378_137.0; // semi-major axis
    let f = 1.0 / 298.257_223_563; // flattening
    let m_rot = 3.449_786_506_841e-3; // rotation factor
    let g_e = 9.780_325_335_9; // normal gravity at the equator
    let k_somgl = 1.931_852_652_458e-3;
    let e2 = 6.694_379_990_141e-3; // first eccentricity squared
    let s2 = latitude_deg.to_radians().sin().powi(2);
    let g0 = g_e * (1.0 + k_somgl * s2) / (1.0 - e2 * s2).sqrt();
    let corr =
        1.0 - height * 2.0 / a * (1.0 + f + m_rot - 2.0 * f * s2) + 3.0 * height * height / (a * a);
    corr * g0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_and_inverse_square() {
        assert_eq!(GravityModel::Constant.at(10_000.0), G0);
        assert_eq!(GravityModel::Uniform { g_ms2: 9.8 }.at(10_000.0), 9.8);
        assert_eq!(inverse_square(0.0), G0);
        // 1% of r_0 up: g drops by 1/(1.01)^2.
        let z = 0.01 * R0;
        assert!((inverse_square(z) - G0 / 1.0201).abs() < 1e-12);
    }

    #[test]
    fn somigliana_reference_values() {
        // WGS84 normal gravity: 9.7803253359 at the equator, 9.8321849379 at
        // the poles (RocketPy constants), about 9.80620 at 45 deg.
        assert!((somigliana(0.0, 0.0) - 9.780_325_335_9).abs() < 1e-10);
        assert!((somigliana(90.0, 0.0) - 9.832_184_937_9).abs() < 1e-8);
        assert!((somigliana(45.0, 0.0) - 9.806_199).abs() < 1e-5);
        // Free-air gradient about -3.086e-6 s^-2.
        let grad = (somigliana(45.0, 1_000.0) - somigliana(45.0, 0.0)) / 1_000.0;
        assert!((grad + 3.086e-6).abs() < 1e-8, "{grad}");
    }
}
