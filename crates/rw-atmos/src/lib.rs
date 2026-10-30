//! Standard atmosphere (USSA 1976) and launch-site wind models (R4.4).
//!
//! - [`ussa1976`]: the 1976 U.S. Standard Atmosphere, 0-86 km geometric:
//!   geopotential layers, temperature, pressure, density, speed of sound,
//!   Sutherland viscosity (`docs/dev/literature-map.md` rows AT-01..AT-30).
//! - [`Atmosphere`]: the profile a simulation uses (standard, or the standard
//!   layer structure through a custom base temperature and pressure).
//! - [`gravity`]: constant, inverse-square, and WGS84 Somigliana gravity.
//! - [`wind`]: constant wind.
//! - [`profile`]: a tabulated atmosphere and wind (e.g. a reanalysis sounding).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod gravity;
pub mod profile;
pub mod ussa1976;
pub mod wind;

pub use gravity::GravityModel;
pub use profile::{Profile, ProfileSample};
pub use ussa1976::{AtmosphereState, Layers, ussa1976};
pub use wind::ConstantWind;

/// An atmosphere profile: the USSA 1976 layer structure through a base.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Atmosphere {
    layers: Layers,
}

impl Default for Atmosphere {
    fn default() -> Self {
        Self::standard()
    }
}

impl Atmosphere {
    /// The 1976 U.S. Standard Atmosphere.
    ///
    /// cite: ussa-1976 eq 23 p 26
    pub fn standard() -> Self {
        Self {
            layers: Layers::standard(),
        }
    }

    /// The standard layer structure (USSA gradients L_M,b) passing through
    /// `temperature` (K, molecular-scale) and `pressure` (Pa) at geometric
    /// altitude `site_z` (m above mean sea level). Temperatures shift by a
    /// constant offset; pressures scale by a constant factor (pressure is
    /// linear in P_0 for a fixed temperature profile, (33a)/(33b)).
    /// With the standard values at the site this equals [`Atmosphere::standard`].
    ///
    /// cite: ussa-1976 eq 33a p 28
    pub fn custom_base(site_z: f64, temperature: f64, pressure: f64) -> Self {
        let std = Layers::standard();
        let h = ussa1976::geopotential_altitude(site_z).max(ussa1976::H_MIN);
        let dt = temperature - std.molecular_temperature(h);
        let unit = Layers::with_base(ussa1976::T0 + dt, 1.0);
        let p0 = pressure / unit.pressure(h);
        Self {
            layers: Layers::with_base(ussa1976::T0 + dt, p0),
        }
    }

    /// Properties at geometric altitude `z` above mean sea level.
    ///
    /// cite: ussa-1976 eq 42 p 31
    pub fn at(&self, z: f64) -> AtmosphereState {
        self.layers.at(z)
    }

    /// The layer table in use.
    ///
    /// cite: n/a accessor, no physics
    pub fn layers(&self) -> &Layers {
        &self.layers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_api() {
        let a = Atmosphere::standard();
        assert_eq!(a.at(1_234.0), ussa1976(1_234.0));
        // Standard values at the site reproduce the standard profile.
        let s = ussa1976(1_500.0);
        let c = Atmosphere::custom_base(1_500.0, s.molecular_temperature, s.pressure);
        for z in [0.0, 1_500.0, 9_000.0, 30_000.0] {
            let (x, y) = (c.at(z), ussa1976(z));
            assert!(((x.pressure - y.pressure) / y.pressure).abs() < 1e-12);
            assert!((x.temperature - y.temperature).abs() < 1e-9);
        }
        // A custom base holds at the site.
        let c = Atmosphere::custom_base(1_500.0, 300.0, 85_000.0);
        let x = c.at(1_500.0);
        assert!((x.molecular_temperature - 300.0).abs() < 1e-9);
        assert!((x.pressure - 85_000.0).abs() < 1e-6);
    }
}
