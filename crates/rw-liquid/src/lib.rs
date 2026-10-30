//! Liquid propulsion (R4.7, M4.5): chamber and nozzle sizing from the
//! thermochemistry tables (`rw-thermo`), injector sizing from the pressure
//! drop, the feed pressure budget, tank geometry and mass, a polytropic
//! pressurant blowdown with a Brent chamber-pressure solve, the resulting
//! thrust curve as a [`rw_motor::ThrustCurve`] (`MotorSource::Liquid`), and
//! the design rules (`RW-E220`..`RW-E229`).
//!
//! Equations follow NASA SP-125 (Huzel and Huang 1967, `sp-125`); every
//! physics `pub fn` cites its equation and PDF page, and
//! `docs/dev/literature-map.md` (prefix `LQ`) lists them in our notation.
//!
//! Module map:
//! - [`thermo`]: the [`Thermo`] trait (tables or native CEA behind it);
//! - [`sizing`]: throat, exit, chamber, and nozzle geometry;
//! - [`injector`]: orifice area, velocity, and pressure drop;
//! - [`feed`]: line and orifice resistances, the pressure budget;
//! - [`tank`]: geometry, liquid level, CG, shell mass, hoop stress;
//! - [`blowdown`]: ullage gas law and the time integration;
//! - [`curve`]: the generated thrust curve;
//! - [`rules`] and [`diag`]: design rules and their codes;
//! - [`design`]: the whole engine from an [`rw_model::EvalEngine`].
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod blowdown;
pub mod curve;
pub mod design;
pub mod diag;
pub mod feed;
pub mod injector;
pub mod props;
pub mod rules;
pub mod sizing;
pub mod solve;
pub mod tank;
pub mod thermo;

pub use design::{Design, DesignOptions, design, design_engine};
pub use thermo::{TableThermo, Thermo, ThermoPoint};

/// Standard gravity (m/s²).
pub const G0: f64 = 9.806_65;
/// Sea-level standard pressure (Pa), the design ambient by default.
pub const P_SEA_LEVEL: f64 = 101_325.0;
