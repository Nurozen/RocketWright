//! U.S. Standard Atmosphere 1976, 0 to 86 km geometric (R4.4).
//!
//! Every number and equation here is from `ussa-1976` Part 1, as recorded in
//! `docs/dev/literature-map.md` rows AT-01..AT-30 (with the AT Errata: R* =
//! 8314.32, r_0 = 6 356 766 m, S = 110.4 K). Notation: `z` geometric altitude
//! (m), `h` geopotential altitude (m'), `tm` molecular-scale temperature
//! T_M (K), `t` kinetic temperature T (K).
//!
//! The pressure profile is computed from the layer table by chaining (33a) and
//! (33b) from the sea-level values, so a custom base (`IsaCustom`) reuses the
//! same code (see [`Layers::with_base`]). Above 84.852 km' (z = 86 km) the
//! last layer is held isothermal; that region is outside USSA Part 1's 0-86 km
//! tables and is only a continuation for out-of-range queries.

/// Standard gravity g_0 (m/s²); also g_0' in m²/(s² m') (AT-01, AT-02).
pub const G0: f64 = 9.806_65;
/// Universal gas constant R* (J/(kmol K)) (AT-04, errata value).
pub const R_STAR: f64 = 8_314.32;
/// Sea-level mean molar mass M_0 (kg/kmol) (AT-05).
pub const M0: f64 = 28.964_4;
/// Effective Earth radius r_0 (m) for the H <-> z transformation (AT-03).
pub const R0: f64 = 6_356_766.0;
/// Sea-level pressure P_0 (Pa) (AT-06).
pub const P0: f64 = 101_325.0;
/// Sea-level temperature T_0 = T_M,0 (K) (AT-07).
pub const T0: f64 = 288.15;
/// Ratio of specific heats γ (AT-08).
pub const GAMMA: f64 = 1.4;
/// Sutherland β_S (kg/(s m K^½)) (AT-09).
pub const BETA_S: f64 = 1.458e-6;
/// Sutherland constant S (K) (AT-09, errata value 110.4).
pub const SUTHERLAND_S: f64 = 110.4;

/// Layer base geopotential altitudes H_b (m'), b = 0..7 (AT-11).
pub const H_B: [f64; 8] = [
    0.0, 11_000.0, 20_000.0, 32_000.0, 47_000.0, 51_000.0, 71_000.0, 84_852.0,
];
/// Molecular-scale temperature gradients L_M,b (K/m'), b = 0..6 (AT-11).
pub const L_MB: [f64; 7] = [-6.5e-3, 0.0, 1.0e-3, 2.8e-3, 0.0, -2.8e-3, -2.0e-3];

/// Lowest geopotential altitude the b = 0 law is defined for (AT-20: -5 km').
pub const H_MIN: f64 = -5_000.0;

/// M/M_0 at z = 80.0, 80.5, ..., 86.0 km (AT-19, Table 8).
const MM0_TABLE: [f64; 13] = [
    1.000_000, 0.999_996, 0.999_989, 0.999_971, 0.999_941, 0.999_909, 0.999_870, 0.999_829,
    0.999_786, 0.999_741, 0.999_694, 0.999_641, 0.999_579,
];

/// Geometric altitude z (m) to geopotential altitude H (m'), Γ = 1 m'/m.
///
/// cite: ussa-1976 eq 18 p 24
pub fn geopotential_altitude(z: f64) -> f64 {
    R0 * z / (R0 + z)
}

/// Geopotential altitude H (m') to geometric altitude z (m), Γ = 1 m'/m.
///
/// cite: ussa-1976 eq 19 p 24
pub fn geometric_altitude(h: f64) -> f64 {
    R0 * h / (R0 - h)
}

/// The ratio g_0' M_0 / R* (K/m') that appears in (33a) and (33b).
fn hydrostatic_constant() -> f64 {
    G0 * M0 / R_STAR
}

/// Pressure at `h` inside a layer with base `(h_b, tm_b, p_b)` and gradient
/// `l_b`: (33a) when L_M,b ≠ 0, (33b) when L_M,b = 0.
///
/// cite: ussa-1976 eq 33a p 28
pub fn layer_pressure(h: f64, h_b: f64, tm_b: f64, p_b: f64, l_b: f64) -> f64 {
    let k = hydrostatic_constant();
    if l_b == 0.0 {
        // (33b)
        p_b * (-k * (h - h_b) / tm_b).exp()
    } else {
        p_b * (tm_b / (tm_b + l_b * (h - h_b))).powf(k / l_b)
    }
}

/// Mass density from pressure and molecular-scale temperature,
/// ρ = P M_0 / (R* T_M).
///
/// cite: ussa-1976 eq 42 p 31
pub fn density(p: f64, tm: f64) -> f64 {
    p * M0 / (R_STAR * tm)
}

/// Speed of sound, a = sqrt(γ R* T_M / M_0).
///
/// cite: ussa-1976 eq 50 p 34
pub fn speed_of_sound(tm: f64) -> f64 {
    (GAMMA * R_STAR * tm / M0).sqrt()
}

/// Dynamic viscosity (Sutherland), μ = β_S T^(3/2) / (T + S), kinetic T.
///
/// cite: ussa-1976 eq 51 p 35
pub fn dynamic_viscosity(t: f64) -> f64 {
    BETA_S * t.powf(1.5) / (t + SUTHERLAND_S)
}

/// Kinematic viscosity, ν = μ / ρ.
///
/// cite: ussa-1976 eq 52 p 35
pub fn kinematic_viscosity(mu: f64, rho: f64) -> f64 {
    mu / rho
}

/// Mean molar mass ratio M/M_0 at geometric altitude `z`: 1 below 80 km,
/// linear in Table 8 from 80 to 86 km, held at the 86 km value above.
///
/// cite: ussa-1976 tab 8 p 25
pub fn molar_mass_ratio(z: f64) -> f64 {
    let km = z / 1000.0;
    if km <= 80.0 {
        return 1.0;
    }
    let pos = (km - 80.0) / 0.5;
    let last = MM0_TABLE.len() - 1;
    if pos >= last as f64 {
        return MM0_TABLE[last];
    }
    let i = pos.floor() as usize;
    let f = pos - i as f64;
    MM0_TABLE[i] + f * (MM0_TABLE[i + 1] - MM0_TABLE[i])
}

/// Atmospheric properties at one altitude. SI units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AtmosphereState {
    /// Geometric altitude above mean sea level (m).
    pub z: f64,
    /// Geopotential altitude (m').
    pub h: f64,
    /// Kinetic temperature T (K) (= T_M (M/M_0)).
    pub temperature: f64,
    /// Molecular-scale temperature T_M (K) (the USSA main tables print T = T_M).
    pub molecular_temperature: f64,
    /// Pressure (Pa).
    pub pressure: f64,
    /// Mass density (kg/m³).
    pub density: f64,
    /// Speed of sound (m/s).
    pub speed_of_sound: f64,
    /// Dynamic viscosity (Pa s).
    pub dynamic_viscosity: f64,
    /// Kinematic viscosity (m²/s).
    pub kinematic_viscosity: f64,
}

/// The layer table with base temperatures T_M,b and pressures P_b chained from
/// a sea-level `(T_M,0, P_0)` (AT-11 for the standard values; Gap 9).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layers {
    /// T_M,b (K), b = 0..7.
    pub tm_b: [f64; 8],
    /// P_b (Pa), b = 0..7.
    pub p_b: [f64; 8],
}

impl Layers {
    /// The standard layer table (T_M,0 = 288.15 K, P_0 = 101 325 Pa).
    ///
    /// cite: ussa-1976 eq 23 p 26
    pub fn standard() -> Self {
        Self::with_base(T0, P0)
    }

    /// Layer table with sea-level molecular temperature `tm0` and pressure
    /// `p0`, keeping the standard gradients L_M,b: T_M,b by (23), P_b by
    /// chaining (33a)/(33b) at each H_b+1.
    ///
    /// cite: ussa-1976 eq 23 p 26
    pub fn with_base(tm0: f64, p0: f64) -> Self {
        let mut tm_b = [0.0; 8];
        let mut p_b = [0.0; 8];
        tm_b[0] = tm0;
        p_b[0] = p0;
        for b in 0..7 {
            let dh = H_B[b + 1] - H_B[b];
            tm_b[b + 1] = tm_b[b] + L_MB[b] * dh;
            p_b[b + 1] = layer_pressure(H_B[b + 1], H_B[b], tm_b[b], p_b[b], L_MB[b]);
        }
        Self { tm_b, p_b }
    }

    /// Index b of the layer containing geopotential altitude `h`
    /// (H_b ≤ H < H_b+1; below 0 → 0; at or above 84.852 km' → 7).
    ///
    /// cite: ussa-1976 eq 23 p 26
    pub fn layer_index(h: f64) -> usize {
        H_B.iter().rposition(|&hb| h >= hb).unwrap_or(0)
    }

    /// Molecular-scale temperature T_M at `h` (23). Layer 7 (above
    /// 84.852 km') is held isothermal at T_M,7.
    ///
    /// cite: ussa-1976 eq 23 p 26
    pub fn molecular_temperature(&self, h: f64) -> f64 {
        let b = Self::layer_index(h);
        let l = if b < 7 { L_MB[b] } else { 0.0 };
        self.tm_b[b] + l * (h - H_B[b])
    }

    /// Pressure at `h` from the containing layer (33a)/(33b).
    ///
    /// cite: ussa-1976 eq 33a p 28
    pub fn pressure(&self, h: f64) -> f64 {
        let b = Self::layer_index(h);
        let l = if b < 7 { L_MB[b] } else { 0.0 };
        layer_pressure(h, H_B[b], self.tm_b[b], self.p_b[b], l)
    }

    /// All properties at geometric altitude `z` above mean sea level.
    /// Altitudes below -5 km' are clamped to -5 km' (the b = 0 law's range).
    ///
    /// cite: ussa-1976 eq 42 p 31
    pub fn at(&self, z: f64) -> AtmosphereState {
        let h = geopotential_altitude(z).max(H_MIN);
        let tm = self.molecular_temperature(h);
        let p = self.pressure(h);
        let t = tm * molar_mass_ratio(z);
        let rho = density(p, tm);
        let mu = dynamic_viscosity(t);
        AtmosphereState {
            z,
            h,
            temperature: t,
            molecular_temperature: tm,
            pressure: p,
            density: rho,
            speed_of_sound: speed_of_sound(tm),
            dynamic_viscosity: mu,
            kinematic_viscosity: kinematic_viscosity(mu, rho),
        }
    }
}

/// USSA 1976 properties at geometric altitude `z` (m above mean sea level).
///
/// cite: ussa-1976 eq 33a p 28
pub fn ussa1976(z: f64) -> AtmosphereState {
    Layers::standard().at(z)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(a: f64, b: f64) -> f64 {
        ((a - b) / b).abs()
    }

    /// Table I values print 5 significant figures; half a unit in the last
    /// place is at most 5e-5 relative, plus margin for the table's own rounding
    /// of intermediate quantities.
    const TAB_REL: f64 = 1.2e-4;

    /// (H m', T_M K, P Pa, ρ kg/m³) from Table I, geopotential-altitude half
    /// (`ussa-1976` Table I, pdf pages noted; P converted from mb).
    const TABLE_I_GEOPOTENTIAL: &[(f64, f64, f64, f64, u32)] = &[
        (0.0, 288.150, 101_325.0, 1.2250, 67),
        (1_000.0, 281.650, 89_874.0, 1.1116, 67),
        (11_000.0, 216.650, 22_632.0, 0.363_92, 73),
        (15_000.0, 216.650, 12_044.0, 0.193_67, 73),
        (20_000.0, 216.650, 5_474.8, 0.088_035, 75),
        (25_000.0, 221.650, 2_511.0, 0.039_466, 75),
        (32_000.0, 228.650, 868.01, 0.013_225, 77),
        (40_000.0, 251.050, 277.52, 0.003_851_0, 79),
        (47_000.0, 270.650, 110.90, 0.001_427_5, 79),
        (51_000.0, 270.650, 66.938, 8.616_0e-4, 79),
        (55_000.0, 259.450, 39.969, 5.366_8e-4, 79),
        (71_000.0, 214.650, 3.956_4, 6.421_1e-5, 81),
        (80_000.0, 196.650, 0.886_27, 1.570_1e-5, 81),
    ];

    #[test]
    fn table_i_geopotential_altitudes() {
        let layers = Layers::standard();
        for &(h, tm, p, rho, page) in TABLE_I_GEOPOTENTIAL {
            let s = layers.at(geometric_altitude(h));
            assert!((s.h - h).abs() < 1e-6, "H round trip at {h}");
            assert!(
                (s.molecular_temperature - tm).abs() < 1.5e-3,
                "T_M at H={h} (pdf {page}): {} vs {tm}",
                s.molecular_temperature
            );
            assert!(
                rel(s.pressure, p) < TAB_REL,
                "P at H={h} (pdf {page}): {} vs {p}",
                s.pressure
            );
            assert!(
                rel(s.density, rho) < TAB_REL,
                "rho at H={h} (pdf {page}): {} vs {rho}",
                s.density
            );
        }
    }

    #[test]
    fn table_i_geometric_altitude() {
        // Table I geometric half, pdf 72: Z = 10000 m -> H = 9984 m',
        // T = 223.252 K, P = 2.6499e2 mb, rho = 4.1351e-1.
        let s = ussa1976(10_000.0);
        assert!((s.h - 9_984.3).abs() < 0.1, "H = {}", s.h);
        assert!((s.temperature - 223.252).abs() < 1.5e-3);
        assert!(rel(s.pressure, 26_499.0) < TAB_REL);
        assert!(rel(s.density, 0.413_51) < TAB_REL);
    }

    /// (Z m, a m/s, μ Pa s, ν m²/s) from Table III (geometric altitude),
    /// pdf pages noted.
    const TABLE_III: &[(f64, f64, f64, f64, u32)] = &[
        (0.0, 340.29, 1.789_4e-5, 1.460_7e-5, 116),
        (1_000.0, 336.43, 1.757_9e-5, 1.581_3e-5, 116),
        (11_000.0, 295.15, 1.422_3e-5, 3.898_8e-5, 122),
        (15_000.0, 295.07, 1.421_6e-5, 7.299_5e-5, 122),
        (30_000.0, 301.71, 1.475_3e-5, 8.013_4e-4, 126),
        (50_000.0, 329.80, 1.703_7e-5, 1.659_1e-2, 128),
        (80_000.0, 282.54, 1.320_8e-5, 7.155_7e-1, 130),
        (85_000.0, 275.52, 1.264_7e-5, 1.538_6, 130),
    ];

    #[test]
    fn table_iii_sound_speed_and_viscosity() {
        for &(z, a, mu, nu, page) in TABLE_III {
            let mut s = ussa1976(z);
            if z > 80_000.0 {
                // The main tables omit the Table 8 M/M_0 correction (AT-19):
                // they evaluate (51) with T = T_M. Our kinetic-T value is
                // lower by about 2.7e-4 at 85 km.
                assert!(s.temperature < s.molecular_temperature);
                s.dynamic_viscosity = dynamic_viscosity(s.molecular_temperature);
                s.kinematic_viscosity = kinematic_viscosity(s.dynamic_viscosity, s.density);
            }
            assert!(
                (s.speed_of_sound - a).abs() < 0.006,
                "a at z={z} (pdf {page}): {} vs {a}",
                s.speed_of_sound
            );
            assert!(
                rel(s.dynamic_viscosity, mu) < TAB_REL,
                "mu at z={z} (pdf {page}): {} vs {mu}",
                s.dynamic_viscosity
            );
            assert!(
                rel(s.kinematic_viscosity, nu) < TAB_REL,
                "nu at z={z} (pdf {page}): {} vs {nu}",
                s.kinematic_viscosity
            );
        }
    }

    #[test]
    fn sea_level_constants() {
        // AT-28 (Table 10, pdf 36).
        let s = ussa1976(0.0);
        assert_eq!(s.temperature, 288.15);
        assert_eq!(s.pressure, 101_325.0);
        assert!(rel(s.density, 1.2250) < 5e-5);
        assert!((s.speed_of_sound - 340.294).abs() < 5e-4);
        assert!(rel(s.dynamic_viscosity, 1.7894e-5) < 5e-5);
        assert!(rel(s.kinematic_viscosity, 1.4607e-5) < 5e-5);
    }

    #[test]
    fn layer_bases_match_sheet() {
        // AT-11 derived T_M,b and P_b.
        let l = Layers::standard();
        let tm = [
            288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.946,
        ];
        let p = [
            101_325.0, 22_632.1, 5_474.89, 868.019, 110.906, 66.938_9, 3.956_42, 0.373_384,
        ];
        for b in 0..8 {
            assert!((l.tm_b[b] - tm[b]).abs() < 1e-9, "T_M,{b}");
            assert!(rel(l.p_b[b], p[b]) < 1e-5, "P_{b}: {}", l.p_b[b]);
        }
    }

    #[test]
    fn kinetic_temperature_at_86_km() {
        // AT-21: T_7 = 186.8673 K at z = 86 km (M/M_0 = 0.999579).
        let s = ussa1976(86_000.0);
        assert!((s.h - 84_852.0).abs() < 0.1, "H(86 km) = {}", s.h);
        assert!((s.temperature - 186.8673).abs() < 2e-3, "{}", s.temperature);
        assert_eq!(molar_mass_ratio(79_000.0), 1.0);
        assert!((molar_mass_ratio(80_250.0) - 0.999_998).abs() < 1e-12);
    }

    #[test]
    fn altitude_transform_round_trip_and_continuity() {
        for z in [-4_000.0, 0.0, 1.0, 11_019.0, 50_000.0, 86_000.0] {
            assert!((geometric_altitude(geopotential_altitude(z)) - z).abs() < 1e-7);
        }
        // AT-14 example: z = 11019 m -> H ≈ 11000 m'.
        assert!((geopotential_altitude(11_019.0) - 11_000.0).abs() < 0.1);
        // Pressure and T_M are continuous across every layer boundary.
        let l = Layers::standard();
        for &hb in &H_B[1..] {
            let (lo, hi) = (hb - 1e-6, hb + 1e-6);
            assert!(rel(l.pressure(lo), l.pressure(hi)) < 1e-9, "P jump at {hb}");
            assert!((l.molecular_temperature(lo) - l.molecular_temperature(hi)).abs() < 1e-6);
        }
    }

    #[test]
    fn custom_base_scales_profile() {
        // P is linear in P_0 for a fixed temperature profile.
        let l = Layers::with_base(T0, 2.0 * P0);
        let s = l.at(5_000.0);
        let r = ussa1976(5_000.0);
        assert!(rel(s.pressure, 2.0 * r.pressure) < 1e-12);
        let warm = Layers::with_base(T0 + 10.0, P0);
        assert!((warm.molecular_temperature(r.h) - r.molecular_temperature - 10.0).abs() < 1e-9);
    }
}
