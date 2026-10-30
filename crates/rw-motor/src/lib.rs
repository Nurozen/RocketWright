//! Solid motors (IF4): thrust curves, RASP `.eng` and RockSim `.rse` parsing,
//! and interpolation (R4.6). M1.5 freezes the types and signatures.
//!
//! - [`parse_eng`] / [`parse_rse`]: file readers (one or more motors per file).
//! - [`ThrustCurve::thrust_at`], [`ThrustCurve::mass_at`], [`ThrustCurve::cg_at`]:
//!   linear interpolation over the samples (module `curve`).
//! - [`class`]: NAR impulse classes and designations.
//! - [`generic`]: the built-in offline library (`lib/motors/generic/`).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod class;
mod curve;
mod eng;
pub mod generic;
mod rse;
pub mod types;

pub use types::*;

/// Parses a RASP `.eng` file (one or more motors).
///
/// Header: `name diameter_mm length_mm delays prop_kg total_kg manufacturer`;
/// then `t F` rows (s, N). The curve starts implicitly at (0, 0). RASP carries
/// no per-sample mass or CG, so `mass_at` derives depletion from cumulative
/// impulse and `cg_at` returns the casing midpoint.
///
/// cite: n/a file-format reader (RASP .eng), no physics
pub fn parse_eng(text: &str, source: MotorSource) -> Result<Vec<ThrustCurve>, MotorError> {
    eng::parse(text, source)
}

/// Parses a RockSim `.rse` file (one or more motors).
///
/// Units: `dia`/`len` mm, `initWt`/`propWt` g, `t` s, `f` N, `m` g (the
/// **total** motor mass, M1.36a), `cg` mm from the motor's fore end.
///
/// cite: n/a file-format reader (RockSim .rse XML), no physics
pub fn parse_rse(text: &str, source: MotorSource) -> Result<Vec<ThrustCurve>, MotorError> {
    rse::parse(text, source)
}

/// Header data of a generated curve (SI), for [`curve_from_samples`].
#[derive(Debug, Clone, PartialEq)]
pub struct CurveHeader {
    pub designation: String,
    pub manufacturer: Option<String>,
    pub diameter: f64,
    pub length: f64,
    pub prop_mass: f64,
    pub total_mass: f64,
}

/// Builds a validated curve from generated samples (a liquid engine's
/// blowdown): same checks and derived fields as the file readers.
///
/// cite: n/a curve assembly and validation, no physics
pub fn curve_from_samples(
    h: CurveHeader,
    points: Vec<ThrustPoint>,
    sha256: &str,
    source: MotorSource,
) -> Result<ThrustCurve, MotorError> {
    curve::build(
        curve::Header {
            designation: h.designation,
            manufacturer: h.manufacturer,
            diameter: h.diameter,
            length: h.length,
            delays: Vec::new(),
            prop_mass: h.prop_mass,
            total_mass: h.total_mass,
        },
        points,
        0,
        sha256,
        &source,
    )
}
