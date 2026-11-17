//! Supersonic methods that replace the slender-body terms above the
//! transonic range. They switch on by Mach number; there is no option.
//!
//! [`cone`]: flow on a circular cone, at zero incidence by integrating the
//! conical-flow equation (NASA SP-3004) and its normal-force slope from the
//! tabulated small-incidence solution (NASA SP-3007 Table 2).
//! [`body`]: second-order shock-expansion for pointed bodies of revolution
//! (NACA TR 1328): surface pressure at zero lift, and the normal-force
//! loading, slope and CP near zero lift.

pub mod body;
pub mod cone;
