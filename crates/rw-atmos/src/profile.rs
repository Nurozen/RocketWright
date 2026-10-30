//! A tabulated atmosphere and wind profile (pressure, temperature, and
//! horizontal wind against geometric height), e.g. a reanalysis sounding at
//! a launch site (R4.4; the Bella Lui validation, plan M2.12).
//!
//! Between samples, temperature and wind are linear in height and pressure
//! is exponential in height (log-linear, the isothermal-layer form of the
//! hydrostatic law). Outside the samples, temperature and wind hold their end
//! values and pressure continues the end segment's exponential.
//!
//! Ported from RocketPy (MIT) rocketpy/environment/environment.py:Environment.process_forecast_reanalysis
//! (pressure, temperature, wind-u, and wind-v as functions of geometric
//! height, interpolated between pressure levels).

use crate::ussa1976::{
    AtmosphereState, density, dynamic_viscosity, geopotential_altitude, kinematic_viscosity,
    speed_of_sound,
};

/// One sample of a [`Profile`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProfileSample {
    /// Geometric height above mean sea level (m).
    pub height: f64,
    /// Pressure (Pa).
    pub pressure: f64,
    /// Temperature (K).
    pub temperature: f64,
    /// Wind toward east (m/s).
    pub wind_u: f64,
    /// Wind toward north (m/s).
    pub wind_v: f64,
}

/// A tabulated atmosphere, samples strictly ascending in height.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    samples: Vec<ProfileSample>,
}

impl Profile {
    /// A profile from samples in any order. Fails with fewer than two
    /// samples, repeated heights, or a non-positive pressure or temperature.
    pub fn new(mut samples: Vec<ProfileSample>) -> Result<Self, String> {
        if samples.len() < 2 {
            return Err("an atmosphere profile needs at least two samples".into());
        }
        if let Some(s) = samples.iter().find(|s| {
            !(s.pressure > 0.0
                && s.temperature > 0.0
                && s.height.is_finite()
                && s.wind_u.is_finite()
                && s.wind_v.is_finite())
        }) {
            return Err(format!(
                "invalid profile sample at {} m: pressure and temperature must be positive and all values finite",
                s.height
            ));
        }
        samples.sort_by(|a, b| a.height.total_cmp(&b.height));
        if samples.windows(2).any(|w| w[1].height <= w[0].height) {
            return Err("atmosphere profile heights must be distinct".into());
        }
        Ok(Self { samples })
    }

    /// The samples, ascending in height.
    pub fn samples(&self) -> &[ProfileSample] {
        &self.samples
    }

    /// Bracketing segment `(lo, hi)` and the fraction of `z` along it
    /// (below 0 or above 1 outside the samples).
    fn segment(&self, z: f64) -> (&ProfileSample, &ProfileSample, f64) {
        let s = &self.samples;
        let i = s.partition_point(|p| p.height <= z).clamp(1, s.len() - 1);
        let (a, b) = (&s[i - 1], &s[i]);
        (a, b, (z - a.height) / (b.height - a.height))
    }

    /// Pressure (Pa) at geometric height `z` (m above mean sea level).
    pub fn pressure(&self, z: f64) -> f64 {
        let (a, b, f) = self.segment(z);
        a.pressure * (b.pressure / a.pressure).powf(f)
    }

    /// Temperature (K) at `z`, held at the end values outside the samples.
    pub fn temperature(&self, z: f64) -> f64 {
        let (a, b, f) = self.segment(z);
        let f = f.clamp(0.0, 1.0);
        a.temperature + f * (b.temperature - a.temperature)
    }

    /// Wind velocity in ENU (m/s) at `z`, held at the end values outside the
    /// samples.
    pub fn wind_enu(&self, z: f64) -> [f64; 3] {
        let (a, b, f) = self.segment(z);
        let f = f.clamp(0.0, 1.0);
        [
            a.wind_u + f * (b.wind_u - a.wind_u),
            a.wind_v + f * (b.wind_v - a.wind_v),
            0.0,
        ]
    }

    /// Air properties at geometric height `z` (m above mean sea level):
    /// density from the ideal-gas law, speed of sound, and Sutherland
    /// viscosity, all on the profile's temperature (M/M_0 = 1 below 80 km).
    pub fn at(&self, z: f64) -> AtmosphereState {
        let t = self.temperature(z);
        let p = self.pressure(z);
        let rho = density(p, t);
        let mu = dynamic_viscosity(t);
        AtmosphereState {
            z,
            h: geopotential_altitude(z),
            temperature: t,
            molecular_temperature: t,
            pressure: p,
            density: rho,
            speed_of_sound: speed_of_sound(t),
            dynamic_viscosity: mu,
            kinematic_viscosity: kinematic_viscosity(mu, rho),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ussa1976;

    fn sample(height: f64) -> ProfileSample {
        let s = ussa1976(height);
        ProfileSample {
            height,
            pressure: s.pressure,
            temperature: s.temperature,
            wind_u: height / 100.0,
            wind_v: -1.0,
        }
    }

    #[test]
    fn rejects_bad_tables() {
        assert!(Profile::new(vec![sample(0.0)]).is_err());
        assert!(Profile::new(vec![sample(0.0), sample(0.0)]).is_err());
        let mut bad = sample(100.0);
        bad.pressure = 0.0;
        assert!(Profile::new(vec![sample(0.0), bad]).is_err());
    }

    #[test]
    fn interpolates_and_extrapolates() {
        // Unsorted input is sorted.
        let p = Profile::new(vec![sample(1_000.0), sample(0.0), sample(2_000.0)]).unwrap();
        assert_eq!(p.samples()[0].height, 0.0);
        // Samples reproduce exactly.
        for z in [0.0, 1_000.0, 2_000.0] {
            let (a, b) = (p.at(z), ussa1976(z));
            assert!((a.pressure - b.pressure).abs() < 1e-9 * b.pressure);
            assert!((a.density - b.density).abs() < 1e-9);
            assert!((a.speed_of_sound - b.speed_of_sound).abs() < 1e-9);
        }
        // Between samples the standard atmosphere is close to log-linear:
        // over a 1 km gap the midpoint error is about h^2/8 * n (L/T)^2
        // (n = g/(R L) = 5.256), 3.3e-4.
        let (a, b) = (p.at(500.0), ussa1976(500.0));
        let rel = ((a.pressure - b.pressure) / b.pressure).abs();
        assert!(rel < 5e-4, "{rel}");
        // Standard temperature is linear in geopotential, ours in geometric
        // height: they differ by micro-kelvins here.
        assert!((a.temperature - b.temperature).abs() < 1e-3);
        assert_eq!(p.wind_enu(500.0), [5.0, -1.0, 0.0]);
        // Outside: wind and temperature held, pressure continues.
        assert_eq!(p.wind_enu(-100.0), [0.0, -1.0, 0.0]);
        assert_eq!(p.wind_enu(9_000.0), [20.0, -1.0, 0.0]);
        assert_eq!(p.temperature(9_000.0), p.temperature(2_000.0));
        assert!(p.pressure(2_500.0) < p.pressure(2_000.0));
        assert!(p.pressure(-200.0) > p.pressure(0.0));
    }
}
