//! The `rocketwright` command line (also installed as `rw`): argument parsing,
//! the stdio MCP server, the sidecar socket, and 2D rendering. Every front end
//! becomes an `rw_api::Command` run through `Session::execute` (invariant I2).
//!
//! Native crate: filesystem, clock, and threads are allowed here.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod cmd;
pub mod display;
pub mod forward;
pub mod legend;
pub mod mcp;
pub mod render;
pub mod render2d;
pub mod render3d;

/// Build provenance: the features this binary was compiled with, as one
/// literal per feature set (`concat!` takes literals only).
macro_rules! with_features {
    ($m:ident) => {{
        #[cfg(all(feature = "doubles", feature = "cea"))]
        let v = $m!("cea,doubles");
        #[cfg(all(feature = "doubles", not(feature = "cea")))]
        let v = $m!("doubles");
        #[cfg(all(not(feature = "doubles"), feature = "cea"))]
        let v = $m!("cea");
        #[cfg(not(any(feature = "doubles", feature = "cea")))]
        let v = $m!("");
        v
    }};
}

macro_rules! provenance_literal {
    ($f:literal) => {
        concat!("RW-BUILD-PROVENANCE:v1;features=", $f, ";")
    };
}

macro_rules! version_literal {
    ("") => {
        env!("CARGO_PKG_VERSION")
    };
    ($f:literal) => {
        concat!(env!("CARGO_PKG_VERSION"), " (features: ", $f, ")")
    };
}

/// Marker embedded in the `rocketwright` binary (`main.rs` keeps it with
/// `#[used]`). `cargo xtask audit` reads it from the file bytes of release and
/// dev-app binaries and fails on `doubles` (it never runs the binary).
pub const BUILD_PROVENANCE: &str = with_features!(provenance_literal);

/// The prefix of [`BUILD_PROVENANCE`]; the feature list follows, up to `;`.
pub const BUILD_PROVENANCE_PREFIX: &str = "RW-BUILD-PROVENANCE:v1;features=";

/// `rocketwright --version` text after the name: the crate version, plus
/// `(features: ...)` when the build enables `cea` or `doubles`.
pub const VERSION: &str = with_features!(version_literal);

/// Compile-time features of this build (`cea`, `doubles`), sorted.
pub fn build_features() -> Vec<&'static str> {
    BUILD_PROVENANCE[BUILD_PROVENANCE_PREFIX.len()..]
        .trim_end_matches(';')
        .split(',')
        .filter(|f| !f.is_empty())
        .collect()
}

/// [`BUILD_PROVENANCE`] as a fixed-size array, for the `#[used]` static.
pub const fn provenance_bytes<const N: usize>() -> [u8; N] {
    let b = BUILD_PROVENANCE.as_bytes();
    let mut a = [0u8; N];
    let mut i = 0;
    while i < N && i < b.len() {
        a[i] = b[i];
        i += 1;
    }
    a
}

/// Version string printed by `rocketwright --version`.
pub fn version_line() -> String {
    format!("rocketwright {VERSION}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_line_names_binary() {
        assert!(super::version_line().starts_with("rocketwright "));
    }

    #[test]
    fn provenance_names_this_build() {
        let f = super::build_features();
        assert_eq!(f.contains(&"doubles"), cfg!(feature = "doubles"));
        assert_eq!(f.contains(&"cea"), cfg!(feature = "cea"));
        assert!(super::BUILD_PROVENANCE.starts_with(super::BUILD_PROVENANCE_PREFIX));
        assert_eq!(
            super::version_line().contains("doubles"),
            cfg!(feature = "doubles")
        );
    }
}
