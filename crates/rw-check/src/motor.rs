//! Motor rows: impulse, burn time, thrust-to-weight, fit in the mount, and
//! retention; plus placing resolved curves in their mounts.

use rw_model::{Diagnostic, EvalShape, EvaluatedModel, IgnitionEvent};
use rw_motor::{MotorSource, MountedMotor, ThrustCurve};
use rw_units::DimKind;

use crate::diag::{self, diag};
use crate::{Clearance, ClearanceRule, MotorReport};

/// Standard gravity (m/s²) for weight in the thrust-to-weight ratio.
pub const G0: f64 = 9.806_65;
/// Liftoff thrust-to-weight below which `RW-W102` warns.
pub const MIN_THRUST_TO_WEIGHT: f64 = 5.0;
/// Fit tolerance on diameters and stations (m).
pub(crate) const FIT_TOL: f64 = 1e-6;

/// Liftoff thrust-to-weight: average thrust of `count` motors over the
/// vehicle's liftoff weight.
/// cite: n/a ratio of average thrust to standard weight (definition)
pub fn thrust_to_weight(average_thrust: f64, count: u32, liftoff_mass: f64) -> f64 {
    let w = liftoff_mass * G0;
    if w > 0.0 {
        f64::from(count.max(1)) * average_thrust / w
    } else {
        0.0
    }
}

/// The motor ref of a mount in the active configuration (`motor` or
/// `engine:<id>`), falling back to the curve's source.
fn motor_ref(model: &EvaluatedModel, m: &MountedMotor) -> String {
    let configured = model
        .config
        .as_deref()
        .and_then(|c| model.configs.get(c))
        .and_then(|c| c.motors.iter().find(|mm| mm.mount == m.mount))
        .and_then(|mm| {
            mm.motor
                .clone()
                .or_else(|| mm.engine.as_ref().map(|e| format!("engine:{e}")))
        });
    configured.unwrap_or_else(|| match &m.curve.source {
        MotorSource::Generic { id } => format!("generic:{id}"),
        MotorSource::Library { path } => path.clone(),
        MotorSource::Embedded { origin } => origin.clone(),
        MotorSource::Thrustcurve { motor_id } => format!("thrustcurve:{motor_id}"),
        MotorSource::Liquid { engine } => format!("engine:{engine}"),
    })
}

/// Places resolved curves in the mounts of the active configuration
/// (`rw_sim::stages::mounted_motors`): clusters, stage membership, and
/// ignition times from the configuration's ignition and separation events.
/// `resolve` maps a motor ref to its curve.
/// cite: n/a placement of resolved curves in their mounts, no physics
pub fn mounted_from_config(
    model: &EvaluatedModel,
    resolve: &dyn Fn(&str) -> Option<ThrustCurve>,
) -> Vec<MountedMotor> {
    rw_sim::stages::mounted_motors(model, resolve)
}

/// Motor rows, the `motor_fit` clearance rows, and motor diagnostics.
pub(crate) fn motor_reports(
    model: &EvaluatedModel,
    motors: &[MountedMotor],
    liftoff_mass: f64,
    clearance: &mut Vec<Clearance>,
    diags: &mut Vec<Diagnostic>,
) -> Vec<MotorReport> {
    if let Some(cfg) = model.config.as_deref().and_then(|c| model.configs.get(c)) {
        for mm in &cfg.motors {
            if let Some(imp) = mm
                .import
                .as_ref()
                .filter(|i| i.resolution == rw_model::MotorResolution::Substituted)
                .filter(|_| !mm.accept_substitution)
            {
                let named = match &imp.manufacturer {
                    Some(m) => format!("{m} {}", imp.designation),
                    None => imp.designation.clone(),
                };
                diags.push(diag(
                    diag::W_MOTOR_SUBSTITUTED,
                    Some(format!("/configs/{}/motors/{}/motor", cfg.id, mm.mount)),
                    format!(
                        "Motor `{named}` in mount `{}` had no curve offline; `{}` stands in for it",
                        mm.mount,
                        mm.motor.as_deref().unwrap_or("-")
                    ),
                    format!(
                        "Import the real curve into lib/motors/ (`rw call import_file`) and point the configuration at it, or keep the generic curve and accept it: `rw set configs.{}.motors.{}.accept_substitution=true`.",
                        cfg.id, mm.mount
                    ),
                ));
            }
            let wanted = mm.motor.is_some() || mm.engine.is_some();
            if wanted
                && mm.ignition != IgnitionEvent::Never
                && !motors.iter().any(|m| m.mount == mm.mount)
            {
                let r = mm.motor.clone().or(mm.engine.clone()).unwrap_or_default();
                diags.push(diag(
                    diag::W_MOTOR_UNRESOLVED,
                    Some(format!("/c/{}", mm.mount)),
                    format!("Motor `{r}` in mount `{}` was not resolved", mm.mount),
                    "Check the motor ref with `rw motor search`, or import the file into lib/motors/."
                        .into(),
                ));
            }
        }
    }
    let mut out = Vec::new();
    for m in motors {
        let reference = motor_ref(model, m);
        let mount = model.components.iter().find(|c| c.id == m.mount);
        let (bore, x_fore) = match mount.map(|c| (&c.shape, c.x_fore)) {
            Some((EvalShape::InnerTube { id, .. }, x)) => (Some(*id), x),
            _ => (None, f64::NAN),
        };
        let d = m.curve.diameter;
        // A liquid engine's chamber and nozzle are placed by its feed layout
        // (engines/<id>.rw.toml), not slid into the mount: no fit rows.
        let liquid = matches!(m.curve.source, MotorSource::Liquid { .. });
        let diameter_ok = liquid || bore.is_some_and(|id| d <= id + FIT_TOL);
        let length_ok = liquid || (bore.is_some() && m.x_fore >= x_fore - FIT_TOL);
        let fits = diameter_ok && length_ok;
        if let Some(id) = bore.filter(|_| !liquid) {
            clearance.push(Clearance {
                rule: ClearanceRule::MotorFit,
                a: reference.clone(),
                b: Some(m.mount.clone()),
                required: d,
                actual: id,
                dim: DimKind::Length,
                pass: diameter_ok,
            });
        }
        if !fits {
            let (msg, hint) = match bore {
                None => (
                    format!("Motor mount `{}` is not an inner tube", m.mount),
                    "Point the configuration's motor at an inner_tube with motor_mount = true."
                        .to_string(),
                ),
                Some(id) if !diameter_ok => (
                    format!(
                        "Motor `{reference}` is {:.1} mm wide but mount `{}` has a {:.1} mm bore",
                        d * 1e3,
                        m.mount,
                        id * 1e3
                    ),
                    format!(
                        "Pick a motor of at most {:.1} mm, or set c.{}.id to at least {:.1} mm.",
                        id * 1e3,
                        m.mount,
                        d * 1e3
                    ),
                ),
                Some(_) => (
                    format!(
                        "Motor `{reference}` is {:.0} mm longer than mount `{}` allows",
                        (x_fore - m.x_fore) * 1e3,
                        m.mount
                    ),
                    format!(
                        "Lengthen c.{} by at least {:.0} mm, or raise its overhang.",
                        m.mount,
                        (x_fore - m.x_fore) * 1e3
                    ),
                ),
            };
            diags.push(diag(
                diag::E_MOTOR_FIT,
                Some(format!("/c/{}", m.mount)),
                msg,
                hint,
            ));
        }
        let tw = thrust_to_weight(m.curve.average_thrust, m.count, liftoff_mass);
        if m.ignition_time <= 0.0 && tw < MIN_THRUST_TO_WEIGHT {
            diags.push(diag(
                diag::W_LOW_THRUST_TO_WEIGHT,
                Some(format!("/c/{}", m.mount)),
                format!("Liftoff thrust-to-weight with `{reference}` is {tw:.2}, below 5"),
                "Choose a motor with more average thrust, or reduce the liftoff mass.".into(),
            ));
        }
        let retained = model
            .components
            .iter()
            .any(|c| {
                c.parent.as_deref() == Some(m.mount.as_str())
                    && matches!(c.shape, EvalShape::EngineBlock { .. })
            })
            .then_some(true);
        out.push(MotorReport {
            mount: m.mount.clone(),
            designation: m.curve.designation.clone(),
            total_impulse: m.curve.total_impulse * f64::from(m.count.max(1)),
            burn_time: m.curve.burn_time,
            thrust_to_weight: tw,
            fits_mount: fits,
            retained,
            motor: reference,
            sha256: m.curve.sha256.clone(),
        });
    }
    out
}
