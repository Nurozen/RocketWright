//! Per-kind component rules (M1.24, R2.5-R2.6).
//!
//! [`crate::shape`] turns source fields into SI [`EvalShape`]s; this module
//! holds what each kind adds on top: range and consistency checks
//! ([`validate`]), materials and the density kind each kind needs
//! ([`material`]), finish roughness ([`finish`]), appearance presets
//! ([`appearance`]), joint metadata ([`joint`]), and the evaluation of
//! configurations ([`config`]) and simulations ([`sim`]), and liquid engines
//! with their feed graphs and tanks ([`engine`], [`tank`]).
//!
//! Every finding is a [`Diagnostic`] at the source field's JSON pointer, so
//! an agent can patch exactly that field. Checks never abort evaluation.

pub mod appearance;
pub mod config;
pub mod engine;
pub mod finish;
pub mod fins;
pub mod joint;
pub mod mass_component;
pub mod material;
pub mod nose;
pub mod rail_button;
pub mod recovery;
pub mod ring;
pub mod sim;
pub mod tank;
pub mod tube;

#[cfg(test)]
mod case1;
#[cfg(test)]
pub(crate) mod testutil;

use std::collections::BTreeMap;

use rw_units::{DimKind, format_sig_number};

use crate::diag::{self, Diagnostic};
use crate::types::{Component, EvalComponent, EvalMaterial, EvalShape};

/// `0.054` → `"0.054 m"` (SI, six significant figures).
pub(crate) fn show(v: f64, k: DimKind) -> String {
    match k {
        DimKind::Dimensionless => format_sig_number(v, 6),
        k => format!("{} {}", format_sig_number(v, 6), k.si_unit()),
    }
}

/// Collects the findings for one component (pointers under `/c/<id>/`, or
/// under another base such as an engine's feed node).
pub(crate) struct Check<'a> {
    pub id: &'a str,
    pub out: Vec<Diagnostic>,
    base: String,
}

impl<'a> Check<'a> {
    pub fn new(id: &'a str) -> Self {
        Check {
            id,
            out: Vec::new(),
            base: format!("/c/{id}"),
        }
    }

    /// Findings for `id` with pointers under `base` (no trailing `/`).
    pub fn at(id: &'a str, base: String) -> Self {
        Check {
            id,
            out: Vec::new(),
            base,
        }
    }

    /// `<base>/<field>` (`/c/<id>/<field>` for components); `field` may
    /// contain `/` (`shoulder/od`).
    pub fn ptr(&self, field: &str) -> String {
        format!("{}/{field}", self.base)
    }

    pub fn push(&mut self, code: &str, field: &str, msg: String, hint: impl Into<String>) {
        let p = self.ptr(field);
        self.out.push(Diagnostic::new(code, p, msg).with_hint(hint));
    }

    /// `v > 0`.
    pub fn positive(&mut self, field: &str, v: f64, k: DimKind) -> bool {
        if v > 0.0 {
            return true;
        }
        self.push(
            diag::E_GEOMETRY,
            field,
            format!(
                "`{}.{}` must be greater than 0 (is {})",
                self.id,
                field.replace('/', "."),
                show(v, k)
            ),
            format!("set `{}` to a positive value", field.replace('/', ".")),
        );
        false
    }

    /// `v >= 0`.
    pub fn non_negative(&mut self, field: &str, v: f64, k: DimKind) -> bool {
        if v >= 0.0 {
            return true;
        }
        self.push(
            diag::E_GEOMETRY,
            field,
            format!(
                "`{}.{}` must not be negative (is {})",
                self.id,
                field.replace('/', "."),
                show(v, k)
            ),
            format!("set `{}` to 0 or more", field.replace('/', ".")),
        );
        false
    }

    /// `v < limit` (`what` names the limit, e.g. "the outer diameter").
    pub fn below(&mut self, field: &str, v: f64, limit: f64, what: &str, k: DimKind) -> bool {
        if v < limit {
            return true;
        }
        self.push(
            diag::E_GEOMETRY,
            field,
            format!(
                "`{}.{}` ({}) must be smaller than {what} ({})",
                self.id,
                field.replace('/', "."),
                show(v, k),
                show(limit, k)
            ),
            format!("reduce `{}` or enlarge {what}", field.replace('/', ".")),
        );
        false
    }

    /// `v <= limit`.
    pub fn at_most(&mut self, field: &str, v: f64, limit: f64, what: &str, k: DimKind) -> bool {
        if v <= limit {
            return true;
        }
        self.push(
            diag::E_GEOMETRY,
            field,
            format!(
                "`{}.{}` ({}) must not exceed {what} ({})",
                self.id,
                field.replace('/', "."),
                show(v, k),
                show(limit, k)
            ),
            format!("reduce `{}` or enlarge {what}", field.replace('/', ".")),
        );
        false
    }

    /// `count` within `lo..=hi`.
    pub fn count(&mut self, field: &str, n: u32, lo: u32, hi: u32) -> bool {
        if (lo..=hi).contains(&n) {
            return true;
        }
        self.push(
            diag::E_GEOMETRY,
            field,
            format!(
                "`{}.{field}` is {n}; it must be between {lo} and {hi}",
                self.id
            ),
            format!("set `{field}` to {lo}..{hi}"),
        );
        false
    }
}

/// Checks one evaluated component against its kind's rules, its material,
/// finish, appearance, and joint. `src` is the source table it came from.
pub fn validate(
    src: &Component,
    e: &EvalComponent,
    materials: &BTreeMap<String, EvalMaterial>,
) -> Vec<Diagnostic> {
    let mut chk = Check::new(&e.id);
    match &e.shape {
        EvalShape::NoseCone { .. } | EvalShape::Transition { .. } => nose::check(&mut chk, e),
        EvalShape::BodyTube { .. }
        | EvalShape::InnerTube { .. }
        | EvalShape::Coupler { .. }
        | EvalShape::LaunchLug { .. }
        | EvalShape::TubeFinSet { .. } => tube::check(&mut chk, src, e),
        EvalShape::CenteringRing { .. }
        | EvalShape::Bulkhead { .. }
        | EvalShape::EngineBlock { .. } => ring::check(&mut chk, e),
        EvalShape::TrapezoidalFinSet { .. }
        | EvalShape::EllipticalFinSet { .. }
        | EvalShape::FreeformFinSet { .. } => fins::check(&mut chk, e),
        EvalShape::RailButton { .. } => rail_button::check(&mut chk, e),
        EvalShape::Parachute { .. } | EvalShape::Streamer { .. } | EvalShape::ShockCord { .. } => {
            recovery::check(&mut chk, e)
        }
        EvalShape::MassComponent { .. } => mass_component::check(&mut chk, e),
        EvalShape::Tank { .. } => tank::check(&mut chk, src, e),
    }
    material::check(&mut chk, src, e, materials);
    finish::check(&mut chk, e);
    appearance::check(&mut chk, e.appearance.as_ref());
    joint::check(&mut chk, e);
    chk.out
}
