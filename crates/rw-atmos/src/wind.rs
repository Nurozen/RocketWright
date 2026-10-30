//! Constant wind (R4.4). Turbulence (Dryden) is a later step.

/// A horizontal wind, constant with altitude and time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConstantWind {
    /// Speed (m/s).
    pub speed: f64,
    /// Direction the wind blows **from**, degrees clockwise from north.
    pub from_deg: f64,
}

impl ConstantWind {
    /// No wind.
    pub const CALM: Self = Self {
        speed: 0.0,
        from_deg: 0.0,
    };

    /// Wind velocity in the launch-site ENU frame (m/s). A wind from the
    /// north (0 deg) blows toward the south: `(0, -speed, 0)`.
    ///
    /// cite: n/a meteorological direction convention to an ENU vector
    pub fn velocity_enu(&self, _z: f64) -> [f64; 3] {
        let d = self.from_deg.to_radians();
        [-self.speed * d.sin(), -self.speed * d.cos(), 0.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_convention() {
        let w = ConstantWind {
            speed: 5.0,
            from_deg: 0.0,
        };
        let v = w.velocity_enu(100.0);
        assert!(v[0].abs() < 1e-12 && (v[1] + 5.0).abs() < 1e-12 && v[2] == 0.0);
        let w = ConstantWind {
            speed: 3.0,
            from_deg: 90.0,
        };
        let v = w.velocity_enu(0.0);
        assert!((v[0] + 3.0).abs() < 1e-12 && v[1].abs() < 1e-12);
        assert_eq!(ConstantWind::CALM.velocity_enu(0.0), [0.0, -0.0, 0.0]);
    }
}
