//! Design checks (IF7): the `rw check` report and the `CheckDelta` every
//! mutating tool returns (R3.2, R3.4). M1.5 freezes the types and signatures.
//!
//! - [`check_static`]: dims, mass breakdown, static aero with cited model
//!   ids, stability over the burn, motor fit and thrust-to-weight,
//!   clearance rules and interference, `[[assert]]`, `[report]`, input
//!   hashes. Output floats are rounded to [`canon::SIG_FIGS`]; serialize with
//!   [`canonical_json`] for the byte-stable, key-sorted form (I8).
//! - [`CheckDelta::between`]: changed metric paths ([`metrics`]), new and
//!   resolved diagnostics.
//! - [`mounted_from_config`]: places resolved motor curves in their mounts.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod canon;
pub mod diag;
pub mod metrics;
pub mod types;

mod asserts;
mod clearance;
mod dims;
mod motor;
mod recovery;
mod statics;

pub use asserts::field_dim;
pub use canon::canonical_json;
pub use motor::{G0, MIN_THRUST_TO_WEIGHT, mounted_from_config, thrust_to_weight};
pub use statics::{burnout_time, margin_cal};
pub use types::*;

use std::collections::{BTreeMap, BTreeSet};

use rw_aero::AeroModel;
use rw_geom::Geometry;
use rw_mass::MassModel;
use rw_model::{Diagnostic, SchemaTag, Severity};
use rw_motor::MountedMotor;

/// Inputs of the static check tier (no simulation; < 200 ms on the fixture).
pub struct CheckInput<'a> {
    pub model: &'a rw_model::EvaluatedModel,
    pub geometry: &'a Geometry,
    pub mass: &'a MassModel,
    pub aero: &'a AeroModel,
    pub motors: &'a [MountedMotor],
    /// project-relative path → hash, for `inputs`.
    pub inputs: &'a std::collections::BTreeMap<String, String>,
}

fn status_of(diags: &[Diagnostic], asserts: &[AssertionResult]) -> CheckStatus {
    let failed = |s: Severity| asserts.iter().any(|a| !a.pass && a.severity == s);
    if diags.iter().any(|d| d.severity == Severity::Error) || failed(Severity::Error) {
        CheckStatus::Errors
    } else if diags.iter().any(|d| d.severity == Severity::Warning) || failed(Severity::Warning) {
        CheckStatus::Warnings
    } else {
        CheckStatus::Clean
    }
}

/// The static check: diagnostics, dims, mass, aero, stability, motor fit,
/// interference, clearance, assertions, and report values.
/// cite: n/a assembly of the cited mass, aero, and stability terms
pub fn check_static(input: &CheckInput<'_>) -> CheckReport {
    let model = input.model;
    let mut diags: Vec<Diagnostic> = model.diagnostics.clone();

    let mut dims = dims::dims(model, input.geometry);
    let mass = statics::mass_report(input.mass, input.motors);
    let coeffs = input.aero.static_coeffs();
    let aero = statics::aero_report(input.aero, &coeffs);
    let d_ref = if model.reference.diameter > 0.0 {
        model.reference.diameter
    } else {
        input.geometry.ref_diameter
    };
    dims.length_cal = dims::ratio(dims.length, d_ref);
    if d_ref <= 0.0 {
        diags.push(diag::diag(
            diag::E_NO_REFERENCE,
            None,
            "The model has no reference diameter".into(),
            "Add a body tube or nose cone with an `od`, or set the reference diameter.".into(),
        ));
    }
    let stability =
        statics::stability_report(input.mass, input.motors, aero.cp, d_ref, dims.length);
    if d_ref > 0.0 && stability.min < 0.0 {
        let fins = model.components.iter().find(|c| dims::is_fin_set(c));
        diags.push(diag::diag(
            diag::E_UNSTABLE,
            fins.map(|f| format!("/c/{}/span", f.id)),
            format!(
                "Unstable: the stability margin is {:.2} cal at liftoff and {:.2} cal at its \
                 minimum during the burn (CP is forward of the CG)",
                stability.liftoff, stability.min
            ),
            match fins {
                Some(f) => format!(
                    "Move the CP aft: increase c.{}.span or the root chord, or add nose weight.",
                    f.id
                ),
                None => "Add a fin set aft of the CG, or add nose weight.".into(),
            },
        ));
    }

    let found = clearance::check(model, input.geometry);
    let mut clearance = found.clearance;
    let motor = motor::motor_reports(
        model,
        input.motors,
        mass.liftoff,
        &mut clearance,
        &mut diags,
    );
    diags.extend(found.diagnostics);
    diags.extend(recovery::deployment_diags(model));

    let mut inputs = input.inputs.clone();
    for m in &motor {
        inputs
            .entry(format!("motor:{}", m.motor))
            .or_insert_with(|| m.sha256.clone());
    }

    let mut report = CheckReport {
        schema: SchemaTag,
        status: CheckStatus::Clean,
        tier: CheckTier::Static,
        model_hash: model.model_hash.clone(),
        config: model.config.clone(),
        diagnostics: Vec::new(),
        dims,
        mass,
        aero,
        stability,
        motor,
        interference: found.interference,
        clearance,
        assertions: Vec::new(),
        report: BTreeMap::new(),
        inputs,
        sim: None,
    };
    report = canon::rounded(report);
    let scope = metrics::assert_scope(&report);
    let have_sim = report.sim.is_some();
    report.assertions = model
        .asserts
        .iter()
        .map(|a| asserts::assertion(a, model, &scope, have_sim))
        .collect();
    report.report = asserts::report_values(model, &scope, &mut diags);
    report.diagnostics = diags;
    report.status = status_of(&report.diagnostics, &report.assertions);
    canon::rounded(report)
}

/// The quick-sim tier (`rw check --sim quick`): `report` (from
/// [`check_static`] on `model`) with the flight `summary` attached, the
/// `[[assert]]` rules that need a sim evaluated, and `[report]` values
/// recomputed with the `sim.*` metrics in scope.
/// cite: n/a assembly of a computed report and a computed flight summary
pub fn with_sim(
    model: &rw_model::EvaluatedModel,
    report: CheckReport,
    summary: rw_sim::RunSummary,
) -> CheckReport {
    let mut report = report;
    report.sim = Some(summary);
    report.tier = CheckTier::QuickSim;
    let report = canon::rounded(report);
    let mut report = report;
    let scope = metrics::assert_scope(&report);
    report.assertions = model
        .asserts
        .iter()
        .map(|a| asserts::assertion(a, model, &scope, true))
        .collect();
    let mut extra = Vec::new();
    report.report = asserts::report_values(model, &scope, &mut extra);
    for d in extra {
        if !report.diagnostics.contains(&d) {
            report.diagnostics.push(d);
        }
    }
    report.status = status_of(&report.diagnostics, &report.assertions);
    canon::rounded(report)
}

impl CheckDelta {
    /// The delta between two reports: changed metric paths (`[before, after]`),
    /// new diagnostics, and resolved diagnostic keys (`<code>@<path>`).
    /// cite: n/a difference of two computed reports
    pub fn between(before: &CheckReport, after: &CheckReport, step: Option<String>) -> CheckDelta {
        let (b, a) = (metrics::metric_map(before), metrics::metric_map(after));
        let r = |m: &metrics::Metric| canon::round_sig(m.value, canon::SIG_FIGS);
        let mut changed = BTreeMap::new();
        let keys: BTreeSet<&String> = b.keys().chain(a.keys()).collect();
        for k in keys {
            let (x, y) = (b.get(k).map(r), a.get(k).map(r));
            if x != y {
                changed.insert(k.clone(), [x, y]);
            }
        }
        let before_keys: BTreeSet<String> = before.diagnostics.iter().map(|d| d.key()).collect();
        let after_keys: BTreeSet<String> = after.diagnostics.iter().map(|d| d.key()).collect();
        let mut seen = BTreeSet::new();
        let new_diagnostics = after
            .diagnostics
            .iter()
            .filter(|d| !before_keys.contains(&d.key()) && seen.insert(d.key()))
            .cloned()
            .collect();
        CheckDelta {
            status: after.status,
            model_hash: after.model_hash.clone(),
            step,
            changed,
            new_diagnostics,
            resolved_diagnostics: before_keys.difference(&after_keys).cloned().collect(),
        }
    }
}
