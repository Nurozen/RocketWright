//! NASA CEA (vendored in `third_party/cea`, v3.3.4, Apache-2.0) for
//! RocketWright: hand-written FFI ([`ffi`]) and a safe layer ([`Cea`]),
//! compiled only with the `cea` feature, which builds CEA from source and links
//! it statically (the binary depends on nothing but the system C library).
//!
//! Native only, never a dependency of a pure crate. Used for thermochemistry
//! table generation and as a live oracle in tests. Without the feature this
//! crate exports only the plain request/result types and unit enums.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod data;
pub mod problem;
pub mod propellants;
pub mod units;

#[cfg(feature = "cea")]
mod cea;
#[cfg(feature = "cea")]
pub mod ffi;

#[cfg(feature = "cea")]
pub use cea::{BUILD_DATA_DIR, Cea};
pub use problem::{
    Basis, CeaError, Combustor, Component, EqState, Exit, Products, Ratio, Reactant, RocketProblem,
    Role, Stations, TpProblem,
};
pub use units::{EnthalpyUnit, TempUnit, UnknownUnit};

/// Whether this build links CEA.
pub const CEA_LINKED: bool = cfg!(feature = "cea");

#[cfg(test)]
mod tests {
    #[test]
    fn cea_feature_flag_reported() {
        assert_eq!(super::CEA_LINKED, cfg!(feature = "cea"));
    }
}
