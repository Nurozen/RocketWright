//! Command surface (IF8): the Command enum, tool inputs/outputs, and shared API types for every front end.
//!
//! Every front end (CLI args, MCP, socket, watcher, UI) becomes a
//! [`Command`] run through `rw_project::Session::execute` (invariant I2).
//! [`schema_registry`] lists every published JSON Schema (`schema/`), so
//! Rust types → `schema/` → TS types and MCP schemas (invariant I3).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod command;
pub mod error;
pub mod fixture;
pub mod history;
pub mod oracle;
pub mod registry;
pub mod render;
pub mod run;
pub mod tools;

pub use command::*;
pub use error::*;
pub use fixture::*;
pub use history::*;
pub use oracle::*;
pub use registry::*;
pub use render::*;
pub use run::*;
pub use tools::*;

/// Re-exports of the frozen IF types, so consumers depend on `rw-api` only.
pub mod contracts {
    pub use rw_check::{CheckDelta, CheckReport};
    pub use rw_geom::Geometry;
    pub use rw_model::{EvaluatedModel, SCHEMA_VERSION};
    pub use rw_motor::{MotorSource, ThrustCurve};
    pub use rw_sim::{RunEvents, RunSummary, SimInput, SimResult};
}
