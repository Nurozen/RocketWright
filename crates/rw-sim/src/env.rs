//! The launch environment a flight runs in, built from `Conditions`:
//! atmosphere, gravity, constant wind, launch site, and launch rail; or a
//! tabulated atmosphere and wind profile ([`Environment::with_profile`]).
//!
//! Frame: launch-site ENU (x east, y north, z up), origin at the rail foot,
//! flat ground at z = 0. Atmosphere and gravity are evaluated at the
//! geometric altitude above mean sea level `site_altitude + z`.

use rw_atmos::{Atmosphere, AtmosphereState, ConstantWind, GravityModel, Profile};
use rw_model::{AtmosphereModel, Conditions, Geodetic};

/// Environment of one flight.
#[derive(Debug, Clone, PartialEq)]
pub struct Environment {
    pub atmosphere: Atmosphere,
    pub gravity: GravityModel,
    pub wind: ConstantWind,
    /// Launch-site altitude above mean sea level (m).
    pub site_altitude: f64,
    /// Rail length (m): distance travelled along the rail until rail exit.
    pub rail_length: f64,
    /// Unit vector along the rail, pointing up the rail (ENU).
    pub rail_axis: [f64; 3],
    /// A tabulated atmosphere and wind. When set it replaces `atmosphere`
    /// and `wind`.
    pub profile: Option<Profile>,
}

impl Environment {
    /// The environment `conditions` describe. Gravity follows
    /// `conditions.gravity` when set (`constant` → that g, `wgs84` →
    /// Somigliana at the site latitude). Absent, it is the engine default
    /// (`wgs84`, per `Conditions.gravity`), except that `geodetic = spherical`
    /// selects the inverse-square law on r_0.
    /// `ussa1976` ignores the base temperature and pressure; `isa_custom`
    /// passes the standard layer structure through them at the site altitude.
    ///
    /// cite: n/a configuration mapping, no physics
    pub fn from_conditions(c: &Conditions) -> Self {
        let atmosphere = match c.atmosphere {
            AtmosphereModel::Ussa1976 => Atmosphere::standard(),
            AtmosphereModel::IsaCustom => {
                Atmosphere::custom_base(c.site_altitude_m, c.base_temperature_k, c.base_pressure_pa)
            }
        };
        let wgs84 = GravityModel::Somigliana {
            latitude_deg: c.latitude_deg,
        };
        let gravity = match (c.gravity, c.geodetic) {
            (Some(rw_model::GravityModel::Constant { g_ms2 }), _) => {
                GravityModel::Uniform { g_ms2 }
            }
            (Some(rw_model::GravityModel::Wgs84), _) => wgs84,
            (None, Geodetic::Spherical) => GravityModel::InverseSquare,
            (None, Geodetic::Flat | Geodetic::Wgs84) => wgs84,
        };
        Self {
            atmosphere,
            gravity,
            wind: ConstantWind {
                speed: c.wind_speed_ms,
                from_deg: c.wind_direction_deg,
            },
            site_altitude: c.site_altitude_m,
            rail_length: c.rail_length_m,
            rail_axis: rail_axis(c.rod_angle_deg, c.rod_direction_deg),
            profile: None,
        }
    }

    /// This environment with a tabulated atmosphere and wind (heights above
    /// mean sea level) in place of the standard atmosphere and constant wind.
    ///
    /// cite: n/a configuration mapping, no physics
    pub fn with_profile(mut self, profile: Profile) -> Self {
        self.profile = Some(profile);
        self
    }

    /// Atmosphere at height `z` above the launch site.
    ///
    /// cite: n/a frame offset, no physics
    pub fn air(&self, z: f64) -> AtmosphereState {
        match &self.profile {
            Some(p) => p.at(self.site_altitude + z),
            None => self.atmosphere.at(self.site_altitude + z),
        }
    }

    /// Gravity magnitude (m/s², acting along -z) at height `z` above the site.
    ///
    /// cite: n/a frame offset, no physics
    pub fn g(&self, z: f64) -> f64 {
        self.gravity.at(self.site_altitude + z)
    }

    /// Wind velocity (ENU, m/s) at height `z` above the site.
    ///
    /// cite: n/a frame offset, no physics
    pub fn wind_at(&self, z: f64) -> [f64; 3] {
        match &self.profile {
            Some(p) => p.wind_enu(self.site_altitude + z),
            None => self.wind.velocity_enu(self.site_altitude + z),
        }
    }
}

/// Unit vector up a rail tilted `angle_deg` from vertical toward azimuth
/// `direction_deg` (clockwise from north), in ENU.
///
/// cite: n/a spherical-angle frame transform
pub fn rail_axis(angle_deg: f64, direction_deg: f64) -> [f64; 3] {
    let (th, psi) = (angle_deg.to_radians(), direction_deg.to_radians());
    [th.sin() * psi.sin(), th.sin() * psi.cos(), th.cos()]
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rw_model::IntegratorKind;

    pub(crate) fn conditions() -> Conditions {
        Conditions {
            rail_length_m: 1.0,
            rod_angle_deg: 0.0,
            rod_direction_deg: 90.0,
            site_altitude_m: 0.0,
            latitude_deg: 45.0,
            longitude_deg: 0.0,
            base_temperature_k: 288.15,
            base_pressure_pa: 101_325.0,
            atmosphere: AtmosphereModel::Ussa1976,
            geodetic: Geodetic::Flat,
            wind_speed_ms: 0.0,
            wind_direction_deg: 90.0,
            wind_turbulence: 0.0,
            time_step_s: 0.05,
            integrator: IntegratorKind::Rk4,
            gravity: Some(rw_model::GravityModel::Constant {
                g_ms2: rw_atmos::ussa1976::G0,
            }),
            launch_into_wind: None,
        }
    }

    #[test]
    fn maps_conditions() {
        let mut c = conditions();
        let e = Environment::from_conditions(&c);
        assert_eq!(e.g(5_000.0), rw_atmos::ussa1976::G0);
        // Absent gravity: the engine default, WGS84 at the site latitude
        // (also under `geodetic = flat`).
        c.gravity = None;
        assert_eq!(
            Environment::from_conditions(&c).g(0.0),
            rw_atmos::gravity::somigliana(45.0, 0.0)
        );
        c.gravity = Some(rw_model::GravityModel::Wgs84);
        assert!((e.rail_axis[2] - 1.0).abs() < 1e-15);
        c.geodetic = Geodetic::Wgs84;
        c.site_altitude_m = 1_000.0;
        c.rod_angle_deg = 30.0;
        c.rod_direction_deg = 90.0;
        c.wind_speed_ms = 4.0;
        c.wind_direction_deg = 270.0;
        let e = Environment::from_conditions(&c);
        assert_eq!(e.g(0.0), rw_atmos::gravity::somigliana(45.0, 1_000.0));
        assert_eq!(e.air(500.0), rw_atmos::ussa1976(1_500.0));
        // Rail tilted 30 deg toward east.
        assert!((e.rail_axis[0] - 0.5).abs() < 1e-12 && e.rail_axis[1].abs() < 1e-12);
        // Wind from the west blows east.
        assert!((e.wind_at(0.0)[0] - 4.0).abs() < 1e-12);
        c.geodetic = Geodetic::Spherical;
        c.gravity = None;
        assert_eq!(
            Environment::from_conditions(&c).g(0.0),
            rw_atmos::gravity::inverse_square(1_000.0)
        );
    }
}
