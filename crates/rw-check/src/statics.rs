//! Mass breakdown, static aerodynamics, and stability margins over the burn.

use rw_aero::{AeroCoeffs, AeroModel};
use rw_mass::MassModel;
use rw_motor::MountedMotor;

use crate::{AeroReport, AeroTerm, ComponentMassRow, MassReport, StabilityReport};

/// Uniform samples over the burn for the minimum margin (plus every motor
/// sample time, so thrust-curve corners are never skipped).
const BURN_SAMPLES: usize = 200;

/// Time after launch at which the last motor burns out (0 without motors).
/// cite: n/a last thrust sample of each mounted motor
pub fn burnout_time(motors: &[MountedMotor]) -> f64 {
    motors
        .iter()
        .map(|m| m.ignition_time + m.curve.points.last().map_or(m.curve.burn_time, |p| p.t))
        .fold(0.0, f64::max)
}

/// Sample times over `[0, t_burnout]`, sorted and deduplicated.
pub(crate) fn burn_times(motors: &[MountedMotor]) -> Vec<f64> {
    let t_bo = burnout_time(motors);
    let mut ts: Vec<f64> = (0..=BURN_SAMPLES)
        .map(|i| t_bo * i as f64 / BURN_SAMPLES as f64)
        .collect();
    for m in motors {
        ts.extend(
            m.curve
                .points
                .iter()
                .map(|p| m.ignition_time + p.t)
                .filter(|t| (0.0..=t_bo).contains(t)),
        );
    }
    ts.sort_by(f64::total_cmp);
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
    ts
}

/// The `mass` block: dry, liftoff, and burnout mass and CG, and the dry
/// per-component breakdown in tree order.
pub(crate) fn mass_report(mass: &MassModel, motors: &[MountedMotor]) -> MassReport {
    let dry = mass.dry();
    let lift = mass.at(0.0);
    let bo = mass.at(burnout_time(motors));
    MassReport {
        dry: dry.mass,
        liftoff: lift.mass,
        burnout: bo.mass,
        propellant: (lift.mass - bo.mass).max(0.0),
        cg: lift.cg,
        cg_burnout: bo.cg,
        ixx: lift.ixx,
        iyy: lift.iyy,
        components: mass
            .breakdown()
            .into_iter()
            .map(|c| ComponentMassRow {
                component: c.id,
                mass: c.mass,
                cg: c.cg,
                overridden: c.overridden,
            })
            .collect(),
    }
}

/// The `aero` block from the static coefficients (AoA 0 at `static_mach`).
pub(crate) fn aero_report(aero: &AeroModel, c: &AeroCoeffs) -> AeroReport {
    AeroReport {
        cp: c.cp,
        cna: c.cn_alpha,
        mach: aero.options().static_mach,
        alpha: 0.0,
        cd: c.cd,
        terms: c
            .components
            .iter()
            .map(|t| AeroTerm {
                component: t.id.clone(),
                cna: t.cn_alpha,
                cp: t.cp,
                model: t.model.clone(),
            })
            .collect(),
    }
}

/// Static margin in calibers: (x_CP − x_CG) / d_ref, positive when the CP
/// is aft of the CG.
/// cite: niskanen-2009 sec 2.4 p 22
pub fn margin_cal(x_cp: f64, x_cg: f64, d_ref: f64) -> f64 {
    if d_ref > 0.0 {
        (x_cp - x_cg) / d_ref
    } else {
        0.0
    }
}

/// The `stability` block: margins at liftoff, burnout, and the minimum over
/// the burn (CP held at its static value; the CG moves as propellant burns).
pub(crate) fn stability_report(
    mass: &MassModel,
    motors: &[MountedMotor],
    x_cp: f64,
    d_ref: f64,
    length: f64,
) -> StabilityReport {
    let at = |t: f64| margin_cal(x_cp, mass.at(t).cg, d_ref);
    let liftoff = at(0.0);
    let burnout = at(burnout_time(motors));
    let min = burn_times(motors)
        .into_iter()
        .map(at)
        .fold(liftoff.min(burnout), f64::min);
    let x_cg = mass.at(0.0).cg;
    StabilityReport {
        liftoff,
        burnout,
        min,
        liftoff_pct_length: if length > 0.0 {
            100.0 * (x_cp - x_cg) / length
        } else {
            0.0
        },
        ref_diameter: d_ref,
    }
}
