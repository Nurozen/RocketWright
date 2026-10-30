//! Multi-stage timing (R4.5, M2.3): when each motor ignites and when each
//! stage separates, from the configuration's ignition and separation events.
//!
//! Stages are ordered top (index 0, the stage with the nose) to bottom. A
//! stage separates from the stage above it; everything still attached below
//! it goes with it. Every event here is a fixed time after launch (ignition
//! delays, burn times, ejection delays), so the whole schedule is resolved
//! before the flight, by fixed-point iteration over the dependencies:
//!
//! - motor ignition: `launch` (t = 0), `previous_burnout` (the last burnout of
//!   the nearest lower stage with motors; in the bottom stage, of the
//!   launch-ignited motors of the same stage), `stage_separation` (the
//!   separation of the stage just below), `never`; plus `ignition_delay`.
//! - stage separation: `upper_ignition` (first ignition in the stage above),
//!   `burnout` (last burnout in this stage), `ejection` (first ejection charge
//!   in this stage), `launch`, `never`; plus `separation_delay`.
//!
//! A dependency that never resolves (a cycle, or a stage without the motors
//! its event needs) leaves the motor unlit or the stage attached.

use std::collections::BTreeSet;

use rw_model::{
    EvalConfig, EvalShape, EvalStageConfig, EvaluatedModel, IgnitionEvent, SeparationEvent,
};
use rw_motor::{MountedMotor, ThrustCurve};

/// One motor's inputs to the schedule.
#[derive(Debug, Clone, PartialEq)]
pub struct MotorTiming {
    /// Index of the motor's stage among the active stages (0 = top).
    pub stage: usize,
    pub ignition: IgnitionEvent,
    pub ignition_delay: f64,
    /// Burn duration (time of the last thrust sample).
    pub burn: f64,
    /// Ejection delay after burnout; `None` = plugged.
    pub eject_delay: Option<f64>,
    /// Ignition time when already known (resolved upstream).
    pub fixed: Option<f64>,
}

/// The resolved schedule.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Schedule {
    /// Ignition time per motor (same order as the input); `None` = never lit.
    pub ignition: Vec<Option<f64>>,
    /// Separation time per active stage; `None` = stays attached (always for
    /// the top stage).
    pub separation: Vec<Option<f64>>,
}

/// The active stages of `config` in model order (top first).
///
/// cite: n/a configuration lookup, no physics
pub fn active_stages<'m>(model: &'m EvaluatedModel, config: &EvalConfig) -> Vec<&'m str> {
    model
        .stages
        .iter()
        .filter(|s| {
            config
                .stages
                .iter()
                .find(|c| c.stage == s.id)
                .is_none_or(|c| c.active)
        })
        .map(|s| s.id.as_str())
        .collect()
}

/// Index of component `id`'s stage among `stages`.
///
/// cite: n/a model lookup, no physics
pub fn stage_index(model: &EvaluatedModel, stages: &[&str], id: &str) -> Option<usize> {
    let s = model
        .components
        .iter()
        .find(|c| c.id == id)?
        .stage
        .as_deref()?;
    stages.iter().position(|x| *x == s)
}

fn stage_config<'c>(config: &'c EvalConfig, stage: &str) -> Option<&'c EvalStageConfig> {
    config.stages.iter().find(|c| c.stage == stage)
}

/// Resolves ignition and separation times. `stage_cfg[i]` is the separation
/// setting of active stage `i` (`None`: never separates).
///
/// cite: n/a event scheduling by fixed-point iteration, no physics
pub fn resolve(stage_cfg: &[Option<(SeparationEvent, f64)>], motors: &[MotorTiming]) -> Schedule {
    let n = stage_cfg.len();
    let mut ign: Vec<Option<f64>> = motors.iter().map(|m| m.fixed).collect();
    let mut sep: Vec<Option<f64>> = vec![None; n];
    let lit = |m: &MotorTiming| m.ignition != IgnitionEvent::Never || m.fixed.is_some();
    // All motors of stage `s` that can light, once all of them are resolved.
    let burnouts = |ign: &[Option<f64>], s: usize, launch_only: bool| -> Option<Vec<f64>> {
        let mut v = Vec::new();
        for (m, t) in motors.iter().zip(ign) {
            if m.stage != s || !lit(m) {
                continue;
            }
            if launch_only && m.ignition != IgnitionEvent::Launch {
                continue;
            }
            v.push((*t)? + m.burn);
        }
        Some(v)
    };
    for _ in 0..(motors.len() + n + 2) {
        let mut changed = false;
        for (i, m) in motors.iter().enumerate() {
            if ign[i].is_some() {
                continue;
            }
            let base = match m.ignition {
                IgnitionEvent::Launch => Some(0.0),
                IgnitionEvent::Never => None,
                IgnitionEvent::StageSeparation => sep.get(m.stage + 1).copied().flatten(),
                IgnitionEvent::PreviousBurnout => {
                    let lower =
                        (m.stage + 1..n).find(|&k| motors.iter().any(|x| x.stage == k && lit(x)));
                    match lower {
                        Some(k) => burnouts(&ign, k, false)
                            .filter(|v| !v.is_empty())
                            .map(|v| v.into_iter().fold(0.0, f64::max)),
                        None => {
                            burnouts(&ign, m.stage, true).map(|v| v.into_iter().fold(0.0, f64::max))
                        }
                    }
                }
            };
            if let Some(b) = base {
                ign[i] = Some(b + m.ignition_delay);
                changed = true;
            }
        }
        for s in 1..n {
            if sep[s].is_some() {
                continue;
            }
            let Some((event, delay)) = stage_cfg[s] else {
                continue;
            };
            let of_stage = |k: usize| motors.iter().zip(&ign).filter(move |(m, _)| m.stage == k);
            let base = match event {
                SeparationEvent::Never => None,
                SeparationEvent::Launch => Some(0.0),
                SeparationEvent::UpperIgnition => {
                    of_stage(s - 1).filter_map(|(_, t)| *t).reduce(f64::min)
                }
                SeparationEvent::Burnout => burnouts(&ign, s, false)
                    .filter(|v| !v.is_empty())
                    .map(|v| v.into_iter().fold(0.0, f64::max)),
                SeparationEvent::Ejection => of_stage(s)
                    .filter_map(|(m, t)| Some((*t)? + m.burn + m.eject_delay?))
                    .reduce(f64::min),
            };
            if let Some(b) = base {
                sep[s] = Some(b + delay);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Schedule {
        ignition: ign,
        separation: sep,
    }
}

/// Separation settings of the active stages (the top stage never separates).
///
/// cite: n/a configuration lookup, no physics
pub fn stage_settings(config: &EvalConfig, stages: &[&str]) -> Vec<Option<(SeparationEvent, f64)>> {
    stages
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if i == 0 {
                return None;
            }
            stage_config(config, s).map(|c| (c.separation, c.separation_delay))
        })
        .collect()
}

/// A model reduced to the given stages: their member components, with
/// parent and child links to removed components cut.
///
/// cite: n/a model filtering, no physics
pub fn submodel(model: &EvaluatedModel, stages: &[&str]) -> EvaluatedModel {
    let mut m = model.clone();
    m.components
        .retain(|c| c.stage.as_deref().is_some_and(|s| stages.contains(&s)));
    let ids: BTreeSet<String> = m.components.iter().map(|c| c.id.clone()).collect();
    for c in &mut m.components {
        c.children.retain(|x| ids.contains(x));
        if c.parent.as_ref().is_some_and(|p| !ids.contains(p)) {
            c.parent = None;
        }
    }
    m.stages.retain(|s| stages.contains(&s.id.as_str()));
    m
}

/// One stack separating during the flight.
#[derive(Debug, Clone, PartialEq)]
pub struct Drop {
    pub t: f64,
    /// The separating stage (top of the dropped stack).
    pub stage: String,
    /// Its first body component (the event source).
    pub first: String,
    /// Stages of the dropped stack, top first.
    pub stages: Vec<String>,
}

/// The vehicle over a staged flight: leg `i` flies from `legs[i].0` with
/// stages `legs[i].1`; `drops[i]` separates at the start of leg `i + 1`.
#[derive(Debug, Clone, PartialEq)]
pub struct LegPlan {
    pub legs: Vec<(f64, Vec<String>)>,
    pub drops: Vec<Drop>,
    /// True when some stage of the model is inactive in the configuration.
    pub has_inactive: bool,
}

/// The burn duration of a mounted motor (time of its last thrust sample).
///
/// cite: n/a last thrust sample
pub fn burn_duration(m: &MountedMotor) -> f64 {
    m.curve.points.last().map_or(m.curve.burn_time, |p| p.t)
}

/// Places resolved curves in the mounts of the active configuration: the
/// motor's aft end sits at the mount's aft end plus its overhang; the count
/// is the mount's instance count (a cluster flies `count` motors); ignition
/// times follow the configuration's ignition and stage-separation events
/// ([`resolve`]). Motors in inactive stages, never ignited, or waiting on an
/// event that never happens are left out. `resolve_curve` maps a motor ref
/// (or `engine:<id>` for a liquid engine) to its curve.
///
/// cite: n/a placement of resolved curves in their mounts, no physics
pub fn mounted_motors(
    model: &EvaluatedModel,
    resolve_curve: &dyn Fn(&str) -> Option<ThrustCurve>,
) -> Vec<MountedMotor> {
    let Some(cfg) = model.config.as_deref().and_then(|c| model.configs.get(c)) else {
        return Vec::new();
    };
    let active = active_stages(model, cfg);
    let mut placed: Vec<MountedMotor> = Vec::new();
    let mut timings: Vec<MotorTiming> = Vec::new();
    for mm in &cfg.motors {
        if mm.ignition == IgnitionEvent::Never {
            continue;
        }
        // A liquid engine resolves as `engine:<id>` (its generated curve).
        let r = mm
            .motor
            .clone()
            .or_else(|| mm.engine.as_ref().map(|e| format!("engine:{e}")));
        let Some(curve) = r.as_deref().and_then(resolve_curve) else {
            continue;
        };
        let Some(mount) = model.components.iter().find(|c| c.id == mm.mount) else {
            continue;
        };
        // Single-stage models without `[stage]` tables: every mount is in the
        // one implicit stage.
        let stage = match stage_index(model, &active, &mm.mount) {
            Some(s) => s,
            None if mount.stage.is_none() && !active.is_empty() => 0,
            None => continue,
        };
        let overhang = match mount.shape {
            EvalShape::InnerTube { overhang, .. } => overhang,
            _ => 0.0,
        };
        let m = MountedMotor {
            mount: mm.mount.clone(),
            x_fore: mount.x_aft + overhang - curve.length,
            curve,
            ignition_time: 0.0,
            delay: mm.delay,
            count: u32::try_from(mount.instances.len().max(1)).unwrap_or(1),
        };
        timings.push(MotorTiming {
            stage,
            ignition: mm.ignition,
            ignition_delay: mm.ignition_delay,
            burn: burn_duration(&m),
            eject_delay: mm.delay,
            fixed: None,
        });
        placed.push(m);
    }
    let sched = resolve(&stage_settings(cfg, &active), &timings);
    placed
        .into_iter()
        .zip(sched.ignition)
        .filter_map(|(mut m, t)| {
            m.ignition_time = t?;
            Some(m)
        })
        .collect()
}

/// Legs and drops of a flight: separation times from the mounted motors'
/// ignition times and the configuration, processed in time order (lower
/// stages first on ties). A stage that has already left with a lower
/// stack's separation does not separate again.
///
/// cite: n/a event scheduling, no physics
pub fn leg_plan(model: &EvaluatedModel, config: &EvalConfig, motors: &[MountedMotor]) -> LegPlan {
    let stages = active_stages(model, config);
    let timings: Vec<MotorTiming> = motors
        .iter()
        .filter_map(|m| {
            Some(MotorTiming {
                stage: stage_index(model, &stages, &m.mount)?,
                ignition: IgnitionEvent::Launch,
                ignition_delay: 0.0,
                burn: burn_duration(m),
                eject_delay: m.delay,
                fixed: Some(m.ignition_time),
            })
        })
        .collect();
    let sched = resolve(&stage_settings(config, &stages), &timings);
    let mut seps: Vec<(f64, usize)> = sched
        .separation
        .iter()
        .enumerate()
        .filter_map(|(i, t)| t.map(|t| (t.max(0.0), i)))
        .collect();
    seps.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut attached: Vec<usize> = (0..stages.len()).collect();
    let own = |v: &[usize]| v.iter().map(|&i| stages[i].to_string()).collect::<Vec<_>>();
    let mut legs = vec![(0.0, own(&attached))];
    let mut drops = Vec::new();
    for (t, s) in seps {
        if !attached.contains(&s) || s == 0 {
            continue;
        }
        let (keep, gone): (Vec<usize>, Vec<usize>) = attached.iter().partition(|&&i| i < s);
        let first = model
            .stages
            .iter()
            .find(|x| x.id == stages[s])
            .map(|x| x.first.clone())
            .unwrap_or_default();
        drops.push(Drop {
            t,
            stage: stages[s].to_string(),
            first,
            stages: own(&gone),
        });
        attached = keep;
        legs.push((t, own(&attached)));
    }
    LegPlan {
        legs,
        drops,
        has_inactive: stages.len() < model.stages.len(),
    }
}

#[cfg(test)]
mod multistage {
    use super::*;

    fn m(stage: usize, ignition: IgnitionEvent, burn: f64) -> MotorTiming {
        MotorTiming {
            stage,
            ignition,
            ignition_delay: 0.0,
            burn,
            eject_delay: None,
            fixed: None,
        }
    }

    #[test]
    fn two_stage_upper_ignition() {
        // Booster (stage 1) at launch, 2 s burn; sustainer lit at booster
        // burnout + 0.5 s; booster separates at upper ignition.
        let mut sus = m(0, IgnitionEvent::PreviousBurnout, 3.0);
        sus.ignition_delay = 0.5;
        let s = resolve(
            &[None, Some((SeparationEvent::UpperIgnition, 0.0))],
            &[sus, m(1, IgnitionEvent::Launch, 2.0)],
        );
        assert_eq!(s.ignition, vec![Some(2.5), Some(0.0)]);
        assert_eq!(s.separation, vec![None, Some(2.5)]);
    }

    #[test]
    fn separation_then_ignition_and_cycles() {
        // Booster separates at its burnout + 0.2 s; the sustainer lights at
        // separation + 0.1 s.
        let mut sus = m(0, IgnitionEvent::StageSeparation, 3.0);
        sus.ignition_delay = 0.1;
        let s = resolve(
            &[None, Some((SeparationEvent::Burnout, 0.2))],
            &[sus.clone(), m(1, IgnitionEvent::Launch, 2.0)],
        );
        assert!((s.ignition[0].unwrap() - 2.3).abs() < 1e-12);
        assert!((s.separation[1].unwrap() - 2.2).abs() < 1e-12);
        // Cycle: the sustainer waits for separation, which waits for it.
        let s = resolve(
            &[None, Some((SeparationEvent::UpperIgnition, 0.0))],
            &[sus, m(1, IgnitionEvent::Launch, 2.0)],
        );
        assert_eq!(s.ignition[0], None);
        assert_eq!(s.separation[1], None);
    }

    #[test]
    fn ejection_separation_and_single_stage_airstart() {
        let mut b = m(1, IgnitionEvent::Launch, 1.5);
        b.eject_delay = Some(0.0);
        let s = resolve(&[None, Some((SeparationEvent::Ejection, 0.0))], &[b]);
        assert_eq!(s.separation[1], Some(1.5));
        // One stage: previous burnout = the launch motors' burnout.
        let s = resolve(
            &[None],
            &[
                m(0, IgnitionEvent::Launch, 1.0),
                m(0, IgnitionEvent::PreviousBurnout, 1.0),
            ],
        );
        assert_eq!(s.ignition, vec![Some(0.0), Some(1.0)]);
    }
}
