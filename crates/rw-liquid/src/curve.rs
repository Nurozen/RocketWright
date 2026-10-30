//! The blowdown as a [`ThrustCurve`] (`MotorSource::Liquid`) the flight
//! simulation consumes: thrust samples plus the remaining propellant mass
//! and, when the tanks have stations, the propellant CG per sample.

use rw_motor::{CurveHeader, MotorError, MotorSource, ThrustCurve, ThrustPoint};
use sha2::{Digest, Sha256};

use crate::blowdown::{Blowdown, Sample};
use crate::tank::TankGeom;

/// Most samples a generated curve keeps (the blowdown grid is thinned).
pub const MAX_POINTS: usize = 400;
/// Valve-closing ramp after the last burning sample, s.
pub const SHUTDOWN: f64 = 0.02;

/// Where a tank's liquid sits along the vehicle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TankPlacement {
    pub geom: TankGeom,
    /// Station of the tank's aft outer end (+aft from the nose tip).
    pub x_aft: f64,
    pub density: f64,
}

impl TankPlacement {
    /// Station of the centroid of `v` m³ of liquid settled aft.
    ///
    /// cite: sp-125 eq 8-29 p 348
    pub fn liquid_station(&self, v: f64) -> f64 {
        self.x_aft - self.geom.wall - self.geom.liquid_centroid(v)
    }
}

/// What the curve needs besides the blowdown.
#[derive(Debug, Clone, PartialEq)]
pub struct CurveSpec {
    pub engine: String,
    pub designation: String,
    /// Engine envelope: total length and the largest diameter.
    pub length: f64,
    pub diameter: f64,
    /// Mass that stays aboard (pressurant gas, inline tank shells), kg.
    pub dry_mass: f64,
    /// Station of the dry mass's CG.
    pub dry_station: Option<f64>,
    /// Tank placements (oxidizer, fuel), for the CG column.
    pub tanks: Option<(TankPlacement, TankPlacement)>,
    /// Station of the motor's fore end in its mount (CG column origin).
    pub motor_fore: Option<f64>,
}

fn point(s: &Sample, spec: &CurveSpec, ox_rho: f64, fuel_rho: f64) -> ThrustPoint {
    let (mo, mf) = (s.ox_liquid * ox_rho, s.fuel_liquid * fuel_rho);
    let mass = spec.dry_mass + mo + mf;
    let cg = match (&spec.tanks, spec.motor_fore) {
        (Some((a, b)), Some(fore)) => {
            let dry_x = spec.dry_station.unwrap_or(fore + spec.length / 2.0);
            let m = spec.dry_mass * dry_x
                + mo * a.liquid_station(s.ox_liquid)
                + mf * b.liquid_station(s.fuel_liquid);
            (mass > 0.0).then(|| m / mass - fore)
        }
        _ => None,
    };
    ThrustPoint {
        t: s.t,
        thrust: s.thrust.max(0.0),
        mass: Some(mass),
        cg,
    }
}

/// The thrust curve of a blowdown. `ox_rho`/`fuel_rho` are the liquid
/// densities. The digest is sha256 over the canonical JSON of the samples,
/// so it changes exactly when the curve does.
///
/// cite: n/a curve assembly from blowdown samples, no physics
pub fn thrust_curve(
    b: &Blowdown,
    spec: &CurveSpec,
    ox_rho: f64,
    fuel_rho: f64,
) -> Result<ThrustCurve, MotorError> {
    let n = b.samples.len();
    let step = n.div_ceil(MAX_POINTS).max(1);
    let mut pts: Vec<ThrustPoint> = b
        .samples
        .iter()
        .enumerate()
        .filter(|(i, _)| i % step == 0 || *i + 1 == n)
        .map(|(_, s)| point(s, spec, ox_rho, fuel_rho))
        .collect();
    if let Some(last) = pts.last().copied() {
        pts.push(ThrustPoint {
            t: last.t + SHUTDOWN,
            thrust: 0.0,
            ..last
        });
    }
    let prop0 = b
        .samples
        .first()
        .map_or(0.0, |s| s.ox_liquid * ox_rho + s.fuel_liquid * fuel_rho);
    let json = serde_json::to_string(&(&spec.engine, &pts)).unwrap_or_default();
    let sha: String = Sha256::digest(json.as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    rw_motor::curve_from_samples(
        CurveHeader {
            designation: spec.designation.clone(),
            manufacturer: Some("RocketWright liquid".into()),
            diameter: spec.diameter,
            length: spec.length,
            prop_mass: prop0,
            total_mass: prop0 + spec.dry_mass,
        },
        pts,
        &sha,
        MotorSource::Liquid {
            engine: spec.engine.clone(),
        },
    )
}
