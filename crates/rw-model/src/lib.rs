//! Project data model: source types (IF1), the evaluated model (IF2), refs,
//! patches, and diagnostics.
//!
//! - [`source`]: parse one file into a typed document (M1.21).
//! - [`expr`], [`params`]: `=` expressions, `[params.*]`, `[variants.*]` (M1.21).
//! - [`anchors`], [`attach`], [`containment`], [`shape`], [`eval`]: the tree,
//!   placement, and [`eval()`] → [`EvaluatedModel`] (M1.22).
//! - [`components`]: per-kind rules, materials, finishes, appearance,
//!   joints, configurations, and simulations (M1.24).
//! - [`refs`], [`patch`]: the `rw:` ref grammar and `PatchOp` on the
//!   id-keyed model value (M1.23).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod anchors;
pub mod attach;
pub mod components;
pub mod containment;
pub mod diag;
pub mod eval;
pub mod expr;
pub mod fluids;
pub mod params;
pub mod patch;
pub mod refs;
pub mod shape;
pub mod source;
pub mod types;

pub use diag::{Diagnostic, Severity};
pub use eval::{eval, model_hash};
pub use patch::{ModelValue, apply_value};
pub use source::{parse_source, parse_source_with_warnings};
pub use types::*;
