//! The check stage of the mutation pipeline. [`Checker`] is the seam: the
//! session runs whatever checker it was opened with.
//!
//! - [`StaticChecker`] (the default): geometry, motors, mass, and aero built
//!   from the evaluated model, then `rw_check::check_static`, with library
//!   and parse diagnostics merged in; deltas are `CheckDelta::between`.
//! - [`StaticCheckDouble`]: a physics-free stand-in (the model's diagnostics
//!   and dimensions, zero mass, aero, and stability) for tests that only
//!   exercise the write path. [`delta_between`] compares its reports.

use std::collections::{BTreeMap, BTreeSet};

use rw_aero::{AeroModel, AeroOptions};
use rw_api::StepMetrics;
use rw_check::{
    AeroReport, CheckDelta, CheckInput, CheckReport, CheckStatus, CheckTier, ComponentDims, Dims,
    MassReport, StabilityReport, check_static, mounted_from_config,
};
use rw_mass::MassModel;
use rw_model::{Diagnostic, EvaluatedModel, SchemaTag, Severity};
use rw_motor::ThrustCurve;
use serde_json::Value;

/// Resolves a motor ref (`generic:RW_C6G`, `lib:<path>`, a designation) to
/// its thrust curve; the session answers from its library.
pub type ResolveMotor<'a> = dyn Fn(&str) -> Option<ThrustCurve> + 'a;

/// Metric paths compared by [`delta_between`] (`docs/dev/metric-paths.md`).
pub const DELTA_METRICS: &[&str] = &[
    "dims.length",
    "dims.max_diameter",
    "dims.fin_span",
    "mass.dry",
    "mass.liftoff",
    "mass.burnout",
    "mass.propellant",
    "mass.cg",
    "mass.cg_burnout",
    "aero.cp",
    "aero.cna",
    "aero.cd",
    "stability.liftoff",
    "stability.burnout",
    "stability.min",
];

/// Produces the check report of an evaluated model.
pub trait Checker: Send + Sync {
    /// The static report. `extra` diagnostics (library, parse) are merged in;
    /// `motors` resolves the configured motor refs.
    fn check(
        &self,
        model: &EvaluatedModel,
        extra: &[Diagnostic],
        inputs: &BTreeMap<String, String>,
        motors: &ResolveMotor<'_>,
    ) -> CheckReport;

    /// The delta a mutating tool returns (I6).
    fn delta(&self, before: &CheckReport, after: &CheckReport, step: Option<String>) -> CheckDelta {
        delta_between(before, after, step)
    }

    /// Sparkline metrics stored with a history step.
    fn metrics(&self, report: &CheckReport) -> StepMetrics;
}

/// Status from diagnostics: errors, else warnings, else clean.
pub fn status_of(diags: &[Diagnostic]) -> CheckStatus {
    if diags.iter().any(|d| d.severity == Severity::Error) {
        CheckStatus::Errors
    } else if diags.iter().any(|d| d.severity == Severity::Warning) {
        CheckStatus::Warnings
    } else {
        CheckStatus::Clean
    }
}

/// Stable order for diagnostics: file, path, code, message.
pub fn sort_diagnostics(d: &mut [Diagnostic]) {
    d.sort_by(|a, b| {
        (
            a.file.as_deref(),
            a.path.as_deref(),
            &a.code,
            &a.message,
            a.line,
        )
            .cmp(&(
                b.file.as_deref(),
                b.path.as_deref(),
                &b.code,
                &b.message,
                b.line,
            ))
    });
}

fn merge_extra(mut diagnostics: Vec<Diagnostic>, extra: &[Diagnostic]) -> Vec<Diagnostic> {
    for d in extra {
        if !diagnostics.contains(d) {
            diagnostics.push(d.clone());
        }
    }
    sort_diagnostics(&mut diagnostics);
    diagnostics
}

/// The real static tier: `rw_check::check_static` over the evaluated model.
#[derive(Debug, Clone, Copy, Default)]
pub struct StaticChecker;

impl Checker for StaticChecker {
    fn check(
        &self,
        model: &EvaluatedModel,
        extra: &[Diagnostic],
        inputs: &BTreeMap<String, String>,
        motors: &ResolveMotor<'_>,
    ) -> CheckReport {
        let geometry = rw_geom::build(model);
        let mounted = mounted_from_config(model, motors);
        let mass = MassModel::new(model, &geometry, &mounted);
        let aero = AeroModel::new(model, &geometry, &AeroOptions::default());
        let mut report = check_static(&CheckInput {
            model,
            geometry: &geometry,
            mass: &mass,
            aero: &aero,
            motors: &mounted,
            inputs,
        });
        if !extra.is_empty() {
            report.diagnostics = merge_extra(std::mem::take(&mut report.diagnostics), extra);
            if status_of(&report.diagnostics) == CheckStatus::Errors {
                report.status = CheckStatus::Errors;
            } else if report.status == CheckStatus::Clean {
                report.status = status_of(&report.diagnostics);
            }
        }
        report
    }

    fn delta(&self, before: &CheckReport, after: &CheckReport, step: Option<String>) -> CheckDelta {
        CheckDelta::between(before, after, step)
    }

    fn metrics(&self, report: &CheckReport) -> StepMetrics {
        let has_mass = report.mass.liftoff > 0.0;
        StepMetrics {
            stability_liftoff: (has_mass && report.stability.ref_diameter > 0.0)
                .then_some(report.stability.liftoff),
            mass_liftoff: has_mass.then_some(report.mass.liftoff),
            apogee_m: report.sim.as_ref().map(|s| s.apogee_m),
        }
    }
}

/// A physics-free double: real diagnostics and dimensions, zero physics.
#[derive(Debug, Clone, Copy, Default)]
pub struct StaticCheckDouble;

impl Checker for StaticCheckDouble {
    fn check(
        &self,
        model: &EvaluatedModel,
        extra: &[Diagnostic],
        inputs: &BTreeMap<String, String>,
        _motors: &ResolveMotor<'_>,
    ) -> CheckReport {
        let diagnostics = merge_extra(model.diagnostics.clone(), extra);
        let components: Vec<ComponentDims> = model
            .components
            .iter()
            .map(|c| ComponentDims {
                component: c.id.clone(),
                x_fore: c.x_fore,
                x_aft: c.x_aft,
                length: c.x_aft - c.x_fore,
                od: None,
                id: None,
            })
            .collect();
        let length = model
            .components
            .iter()
            .map(|c| c.x_aft)
            .fold(0.0_f64, f64::max);
        CheckReport {
            schema: SchemaTag,
            status: status_of(&diagnostics),
            tier: CheckTier::Static,
            model_hash: model.model_hash.clone(),
            config: model.config.clone(),
            diagnostics,
            dims: Dims {
                length,
                max_diameter: model.reference.diameter,
                fin_span: None,
                length_cal: None,
                fineness: None,
                components,
            },
            mass: MassReport {
                dry: 0.0,
                liftoff: 0.0,
                burnout: 0.0,
                propellant: 0.0,
                cg: 0.0,
                cg_burnout: 0.0,
                ixx: 0.0,
                iyy: 0.0,
                components: Vec::new(),
            },
            aero: AeroReport {
                cp: 0.0,
                cna: 0.0,
                mach: 0.3,
                alpha: 0.0,
                cd: 0.0,
                terms: Vec::new(),
            },
            stability: StabilityReport {
                liftoff: 0.0,
                burnout: 0.0,
                min: 0.0,
                liftoff_pct_length: 0.0,
                ref_diameter: model.reference.diameter,
            },
            motor: Vec::new(),
            interference: Vec::new(),
            clearance: Vec::new(),
            assertions: Vec::new(),
            report: BTreeMap::new(),
            inputs: inputs.clone(),
            sim: None,
        }
    }

    /// The double computes no physics, so it stores no sparkline metrics.
    fn metrics(&self, _report: &CheckReport) -> StepMetrics {
        StepMetrics::default()
    }
}

fn metric(v: &Value, path: &str) -> Option<f64> {
    let mut cur = v;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    cur.as_f64()
}

/// The delta between two reports: changed metrics (`[before, after]`), new
/// diagnostics (by `<code>@<path>` key plus message), and resolved keys.
pub fn delta_between(
    before: &CheckReport,
    after: &CheckReport,
    step: Option<String>,
) -> CheckDelta {
    let bv = serde_json::to_value(before).unwrap_or(Value::Null);
    let av = serde_json::to_value(after).unwrap_or(Value::Null);
    let mut changed = BTreeMap::new();
    for path in DELTA_METRICS {
        let (b, a) = (metric(&bv, path), metric(&av, path));
        let same = match (b, a) {
            (Some(x), Some(y)) => (x - y).abs() <= 1e-12 * x.abs().max(y.abs()).max(1.0),
            (None, None) => true,
            _ => false,
        };
        if !same {
            changed.insert((*path).to_string(), [b, a]);
        }
    }
    let ident = |d: &Diagnostic| (d.key(), d.message.clone());
    let before_ids: BTreeSet<_> = before.diagnostics.iter().map(ident).collect();
    let after_keys: BTreeSet<String> = after.diagnostics.iter().map(Diagnostic::key).collect();
    let new_diagnostics: Vec<Diagnostic> = after
        .diagnostics
        .iter()
        .filter(|d| !before_ids.contains(&ident(d)))
        .cloned()
        .collect();
    let resolved: BTreeSet<String> = before
        .diagnostics
        .iter()
        .map(Diagnostic::key)
        .filter(|k| !after_keys.contains(k))
        .collect();
    CheckDelta {
        status: after.status,
        model_hash: after.model_hash.clone(),
        step,
        changed,
        new_diagnostics,
        resolved_diagnostics: resolved.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(diags: Vec<Diagnostic>, cp: f64) -> CheckReport {
        let fx: Value = serde_json::from_str(include_str!(
            "../../../fixtures/contracts/check-report.json"
        ))
        .unwrap();
        let mut r: CheckReport = serde_json::from_value(fx["payload"].clone()).unwrap();
        r.diagnostics = diags;
        r.aero.cp = cp;
        r.status = status_of(&r.diagnostics);
        r
    }

    #[test]
    fn delta_reports_metrics_and_diagnostics() {
        let e = Diagnostic::new("RW-E061", "/c/fins".to_string(), "bad");
        let w = Diagnostic::new("RW-W001", "/c/body/x".to_string(), "unknown");
        let a = report(vec![e.clone()], 0.5);
        let b = report(vec![w.clone()], 0.6);
        let d = delta_between(&a, &b, Some("step:2".into()));
        assert_eq!(d.changed.keys().collect::<Vec<_>>(), ["aero.cp"]);
        assert_eq!(d.changed["aero.cp"], [Some(0.5), Some(0.6)]);
        assert_eq!(d.new_diagnostics, vec![w]);
        assert_eq!(d.resolved_diagnostics, ["RW-E061@/c/fins"]);
        assert_eq!(d.status, CheckStatus::Warnings);
        assert_eq!(d.step.as_deref(), Some("step:2"));
        let same = delta_between(&a, &a, None);
        assert!(same.changed.is_empty() && same.new_diagnostics.is_empty());
        assert!(same.resolved_diagnostics.is_empty());
    }
}
