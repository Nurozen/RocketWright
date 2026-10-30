//! 2D drawings (R3.1): deterministic SVG of the side profile, fin
//! planforms, station diagram, and anchor map, with CG (filled circle) and
//! CP (crossed circle) markers and dimension lines. `rw-cli`'s `render2d`
//! rasterizes these strings through resvg with the vendored Inter font.
//!
//! Output is a pure function of its inputs: fixed two-decimal coordinates,
//! components in model order, no ids, clocks, or randomness (I8).
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

mod compare;
mod fin;
mod profile;
mod svg;

pub use compare::{Mark, Side, draw_compare, mark_ink};

use rw_check::CheckReport;
use rw_geom::Geometry;
use rw_model::EvaluatedModel;

/// The 2D views (`rw render --view profile|fin|stations|anchors`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// Side profile with internals, fins, CG/CP markers, and overall dims.
    Profile,
    /// Each fin set's planform with chord, span, and sweep dims.
    Fin,
    /// Profile outline with every component station ticked and labelled.
    Stations,
    /// Profile outline with every named anchor marked.
    Anchors,
}

impl View {
    /// Every view, in CLI order.
    pub const ALL: [View; 4] = [View::Profile, View::Fin, View::Stations, View::Anchors];

    /// The CLI spelling.
    /// cite: n/a naming, no physics
    pub const fn name(self) -> &'static str {
        match self {
            View::Profile => "profile",
            View::Fin => "fin",
            View::Stations => "stations",
            View::Anchors => "anchors",
        }
    }
}

/// CG/CP stations (m from the nose tip) and the liftoff margin to annotate.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Markers {
    pub cg: Option<f64>,
    pub cp: Option<f64>,
    /// Liftoff margin in calibers.
    pub stability: Option<f64>,
}

impl Markers {
    /// Liftoff CG, static CP, and liftoff margin from a check report.
    /// cite: n/a copies computed report values
    pub fn from_report(r: &CheckReport) -> Self {
        Markers {
            cg: Some(r.mass.cg),
            cp: Some(r.aero.cp),
            stability: Some(r.stability.liftoff),
        }
    }
}

/// Drawing options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawOptions {
    /// Canvas width in CSS px (the height follows the model).
    pub width: f64,
    /// Draw inner components (dashed) in the profile.
    pub internals: bool,
}

impl Default for DrawOptions {
    fn default() -> Self {
        DrawOptions {
            width: 1200.0,
            internals: true,
        }
    }
}

/// Draws `view` as an SVG document.
/// cite: n/a 2D drawing of computed geometry, no physics
pub fn draw(
    view: View,
    model: &EvaluatedModel,
    geometry: &Geometry,
    markers: &Markers,
    opts: &DrawOptions,
) -> String {
    match view {
        View::Profile => profile::profile(model, geometry, markers, opts),
        View::Fin => fin::fins(model, geometry, opts),
        View::Stations => profile::stations(model, geometry, opts),
        View::Anchors => profile::anchors(model, geometry, opts),
    }
}
