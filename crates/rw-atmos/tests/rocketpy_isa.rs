// Ported from RocketPy (MIT) rocketpy/environment/environment.py:Environment.pressure_ISA
// (with temperature_ISA, calculate_density_profile, calculate_speed_of_sound_profile,
// calculate_dynamic_viscosity; constants from Environment.__init__), as a test oracle.
//
//! Cross-check of our USSA 1976 against RocketPy's ISA (ISO 2533), which is
//! numerically the same model below 80 km but uses a different Earth radius
//! (6 378 100 m vs r_0 = 6 356 766 m), R = 287.05287 J/(kg K), rounded layer
//! base pressures, and temperature interpolated linearly in geometric (not
//! geopotential) altitude. Agreement is therefore approximate: the
//! tolerances below cover those differences, nothing more.
//!
//! RocketPy's docstring values `density(0) = 1.225000018124288` and
//! `density(1000) = 1.1115112430077818` (its 100-point discretisation) are
//! checked too.

use rw_atmos::ussa1976;

const EARTH_RADIUS: f64 = 6.3781e6;
const R_AIR: f64 = 287.052_87;
const G: f64 = 9.806_65;
const LAYER_H: [f64; 9] = [-2e3, 0.0, 11e3, 20e3, 32e3, 47e3, 51e3, 71e3, 80e3];
const LAYER_T: [f64; 9] = [
    301.15, 288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 196.65,
];
const LAYER_BETA: [f64; 9] = [
    -6.5e-3, -6.5e-3, 0.0, 1e-3, 2.8e-3, 0.0, -2.8e-3, -2e-3, 0.0,
];
const LAYER_P: [f64; 9] = [
    1.27774e5, 1.01325e5, 2.26320e4, 5.47487e3, 8.680164e2, 1.10906e2, 6.69384e1, 3.95639e0,
    8.86272e-2,
];

fn layer(h: f64) -> usize {
    LAYER_H.iter().rposition(|&b| h >= b).unwrap_or(0)
}

/// `pressure_function(h)` inside `Environment.pressure_ISA`.
fn rocketpy_pressure(z: f64) -> f64 {
    let h = EARTH_RADIUS * z / (EARTH_RADIUS + z);
    let i = layer(h);
    let (hb, tb, pb, b) = (LAYER_H[i], LAYER_T[i], LAYER_P[i], LAYER_BETA[i]);
    if b != 0.0 {
        pb * (1.0 + (b / tb) * (h - hb)).powf(-G / (b * R_AIR))
    } else {
        pb * (-(h - hb) * (G / (R_AIR * tb))).exp()
    }
}

/// `temperature_ISA`: linear interpolation over the layer temperatures at the
/// geometric heights of the layer bases.
fn rocketpy_temperature(z: f64) -> f64 {
    let zs: Vec<f64> = LAYER_H
        .iter()
        .map(|&h| EARTH_RADIUS * h / (EARTH_RADIUS - h))
        .collect();
    let i = zs
        .iter()
        .rposition(|&b| z >= b)
        .unwrap_or(0)
        .min(zs.len() - 2);
    let f = (z - zs[i]) / (zs[i + 1] - zs[i]);
    LAYER_T[i] + f * (LAYER_T[i + 1] - LAYER_T[i])
}

fn rel(a: f64, b: f64) -> f64 {
    ((a - b) / b).abs()
}

#[test]
fn ussa_matches_rocketpy_isa_to_80_km() {
    let altitudes = [
        0.0, 1_000.0, 5_000.0, 11_000.0, 15_000.0, 25_000.0, 35_000.0, 50_000.0, 60_000.0, 75_000.0,
    ];
    for z in altitudes {
        let ours = ussa1976(z);
        let p = rocketpy_pressure(z);
        let t = rocketpy_temperature(z);
        let rho = p / (R_AIR * t);
        let a = (1.4 * R_AIR * t).sqrt();
        let mu = 1.458e-6 * t.powf(1.5) / (t + 110.4);
        assert!(
            rel(ours.pressure, p) < 1e-3,
            "P at {z}: {} vs {p}",
            ours.pressure
        );
        assert!(
            rel(ours.temperature, t) < 1e-3,
            "T at {z}: {} vs {t}",
            ours.temperature
        );
        assert!(
            rel(ours.density, rho) < 2e-3,
            "rho at {z}: {} vs {rho}",
            ours.density
        );
        assert!(rel(ours.speed_of_sound, a) < 5e-4, "a at {z}");
        assert!(rel(ours.dynamic_viscosity, mu) < 1e-3, "mu at {z}");
    }
}

#[test]
fn rocketpy_docstring_densities() {
    assert!(rel(ussa1976(0.0).density, 1.225_000_018_124_288) < 1e-6);
    // RocketPy interpolates a 100-point table, so allow 2e-4.
    assert!(rel(ussa1976(1_000.0).density, 1.111_511_243_007_781_8) < 2e-4);
}
