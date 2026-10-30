//! Flight configurations (`configs/<id>.rw.toml`, R2.6): a motor (or liquid
//! engine) per mount with its ejection delay and ignition, per-stage
//! separation, and per-recovery-component deployment.

use std::collections::BTreeMap;

use crate::diag::{self, Diagnostic};
use crate::shape::Fields;
use crate::types::{
    ConfigDoc, DeployEvent, EvalComponent, EvalConfig, EvalDeployment, EvalMotorMount, EvalShape,
    EvalStageConfig, IgnitionEvent, SeparationEvent,
};

fn bad(f: &mut Fields, ptr: String, msg: String, hint: &str) {
    f.diags
        .push(Diagnostic::new(diag::E_CONFIG, ptr, msg).with_hint(hint.to_string()));
}

/// A time that must not be negative.
fn time(f: &mut Fields, q: &rw_units::QTime, ptr: String) -> f64 {
    let v = f.q(q, None, &ptr);
    if v < 0.0 {
        bad(
            f,
            ptr,
            format!("the time is negative ({v} s)"),
            "use 0 s or more",
        );
    }
    v
}

/// Evaluates every configuration against the placed components and stages.
pub(crate) fn eval_configs(
    docs: &BTreeMap<String, ConfigDoc>,
    components: &[EvalComponent],
    stage_order: &[String],
    f: &mut Fields,
) -> BTreeMap<String, EvalConfig> {
    let shape_of = |id: &str| components.iter().find(|c| c.id == id).map(|c| &c.shape);
    let recovery: Vec<&EvalComponent> = components
        .iter()
        .filter(|c| {
            matches!(
                c.shape,
                EvalShape::Parachute { .. } | EvalShape::Streamer { .. }
            )
        })
        .collect();
    let mut configs = BTreeMap::new();
    for (cid, doc) in docs {
        let base = format!("/configs/{cid}");
        let mut motors = Vec::new();
        for (mount, a) in &doc.motors {
            let p = format!("{base}/motors/{mount}");
            let is_mount = matches!(
                shape_of(mount),
                Some(EvalShape::InnerTube {
                    motor_mount: true,
                    ..
                })
            );
            if !is_mount {
                bad(
                    f,
                    p.clone(),
                    format!("`{mount}` is not a motor mount"),
                    "assign motors to an inner_tube with `motor_mount = true`",
                );
            }
            match (&a.motor, &a.engine) {
                (Some(_), Some(_)) => bad(
                    f,
                    p.clone(),
                    format!("mount `{mount}` gives both a motor and an engine"),
                    "keep `motor` for a solid motor or `engine` for a liquid engine",
                ),
                (None, None) => bad(
                    f,
                    p.clone(),
                    format!("mount `{mount}` gives neither a motor nor an engine"),
                    "add e.g. `motor = \"generic:RW_C6G\"`, or remove the entry",
                ),
                _ => {}
            }
            motors.push(EvalMotorMount {
                mount: mount.clone(),
                motor: a.motor.clone(),
                engine: a.engine.clone(),
                delay: a.delay.as_ref().map(|q| time(f, q, format!("{p}/delay"))),
                ignition: a.ignition.unwrap_or(IgnitionEvent::Launch),
                ignition_delay: a
                    .ignition_delay
                    .as_ref()
                    .map_or(0.0, |q| time(f, q, format!("{p}/ignition_delay"))),
                import: a.import.clone(),
                accept_substitution: a.accept_substitution,
            });
        }
        for s in doc.stages.keys() {
            if !stage_order.contains(s) {
                f.diags.push(
                    Diagnostic::new(
                        diag::E_CONFIG,
                        format!("{base}/stages/{s}"),
                        format!("`{s}` is not a stage"),
                    )
                    .with_hint(format!("stages: {}", stage_order.join(", "))),
                );
            }
        }
        let stages = stage_order
            .iter()
            .enumerate()
            .map(|(i, sid)| {
                let sc = doc.stages.get(sid);
                EvalStageConfig {
                    stage: sid.clone(),
                    active: sc.is_none_or(|s| s.active),
                    separation: sc.and_then(|s| s.separation).unwrap_or(if i == 0 {
                        SeparationEvent::Never
                    } else {
                        SeparationEvent::UpperIgnition
                    }),
                    separation_delay: sc
                        .and_then(|s| s.separation_delay.as_ref())
                        .map_or(0.0, |q| {
                            time(f, q, format!("{base}/stages/{sid}/separation_delay"))
                        }),
                }
            })
            .collect();
        for k in doc.deploy.keys() {
            if !recovery.iter().any(|r| &r.id == k) {
                bad(
                    f,
                    format!("{base}/deploy/{k}"),
                    format!("`{k}` is not a parachute or streamer"),
                    "deploy settings name a recovery component id",
                );
            }
        }
        let mut deployments = Vec::new();
        for r in &recovery {
            let p = format!("{base}/deploy/{}", r.id);
            let d = doc.deploy.get(&r.id);
            let event = d.map_or(DeployEvent::Ejection, |d| d.event);
            let altitude = d
                .and_then(|d| d.altitude.as_ref())
                .map(|q| f.q(q, None, &format!("{p}/altitude")));
            if event == DeployEvent::Altitude {
                match altitude {
                    None => bad(
                        f,
                        format!("{p}/altitude"),
                        format!("`{}` deploys at an altitude but none is given", r.id),
                        "add e.g. `altitude = \"200 m\"`",
                    ),
                    Some(a) if a <= 0.0 => bad(
                        f,
                        format!("{p}/altitude"),
                        format!("`{}` deploys at a non-positive altitude ({a} m)", r.id),
                        "use an altitude above the launch site, e.g. \"200 m\"",
                    ),
                    _ => {}
                }
            }
            let delay = d.and_then(|d| d.delay.as_ref());
            if event == DeployEvent::Timer && delay.is_none() {
                bad(
                    f,
                    format!("{p}/delay"),
                    format!("`{}` deploys on a timer but no `delay` is given", r.id),
                    "add the time after launch, e.g. `delay = \"6 s\"`",
                );
            }
            deployments.push(EvalDeployment {
                component: r.id.clone(),
                event,
                altitude,
                delay: delay.map_or(0.0, |q| time(f, q, format!("{p}/delay"))),
            });
        }
        configs.insert(
            cid.clone(),
            EvalConfig {
                id: cid.clone(),
                name: doc.name.clone().unwrap_or_else(|| cid.clone()),
                motors,
                stages,
                deployments,
            },
        );
    }
    configs
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::{DeployEvent, IgnitionEvent};

    const ROCKET: &str = r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

[c.mmt]
type = "inner_tube"
attach = { to = "body.aft", at = "aft" }
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true

[c.chute]
type = "parachute"
attach = { to = "body.fore", at = "attach", offset = "30 mm" }
diameter = "300 mm"
cd = 0.8
packed_length = "42 mm"
packed_diameter = "18 mm"
"#;

    #[test]
    fn case1_configs_motor_delay_and_deployment() {
        let m = project(&[
            ("rocket.rw.toml", ROCKET),
            (
                "configs/c6_3.rw.toml",
                r#"name = "[RW_C6G-3]"
[motors.mmt]
motor = "generic:RW_C6G"
delay = "3 s"
[deploy.chute]
event = "ejection"
altitude = "200 m"
"#,
            ),
            (
                "configs/c6_plugged.rw.toml",
                r#"[motors.mmt]
motor = "generic:RW_C6G"
[deploy.chute]
event = "altitude"
altitude = "150 m"
"#,
            ),
        ]);
        assert_clean(&m);
        let c = &m.configs["c6_3"];
        assert_eq!(c.name, "[RW_C6G-3]");
        assert_eq!(c.motors[0].mount, "mmt");
        assert_eq!(c.motors[0].motor.as_deref(), Some("generic:RW_C6G"));
        assert_eq!(c.motors[0].delay, Some(3.0));
        assert_eq!(c.motors[0].ignition, IgnitionEvent::Launch);
        assert_eq!(c.deployments[0].event, DeployEvent::Ejection);
        assert_eq!(c.deployments[0].altitude, Some(200.0));
        let p = &m.configs["c6_plugged"];
        assert_eq!(p.motors[0].delay, None, "no delay = plugged");
        assert_eq!(p.deployments[0].event, DeployEvent::Altitude);
        assert_eq!(p.stages.len(), 1);
    }

    #[test]
    fn config_errors() {
        let m = project(&[
            ("rocket.rw.toml", ROCKET),
            (
                "configs/bad.rw.toml",
                r#"[motors.mmt]
motor = "generic:RW_C6G"
engine = "demo"
delay = "-1 s"
[motors.body]
[deploy.chute]
event = "timer"
"#,
            ),
            (
                "configs/alt.rw.toml",
                r#"[motors.mmt]
motor = "generic:RW_C6G"
[deploy.chute]
event = "altitude"
altitude = "0 m"
"#,
            ),
        ]);
        assert_diag(&m, "RW-E059", "/configs/bad/motors/mmt");
        assert_diag(&m, "RW-E059", "/configs/bad/motors/mmt/delay");
        assert_diag(&m, "RW-E059", "/configs/bad/motors/body");
        assert_diag(&m, "RW-E059", "/configs/bad/deploy/chute/delay");
        assert_diag(&m, "RW-E059", "/configs/alt/deploy/chute/altitude");
    }
}
