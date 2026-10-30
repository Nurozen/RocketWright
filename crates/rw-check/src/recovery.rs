//! Recovery deployment: a parachute or streamer that no configuration ever
//! deploys (`RW-W250`). It deploys in a configuration when its event there
//! is not `never`, and an `ejection` event also needs a motor with an
//! ejection delay (no `delay` = plugged, no charge).

use rw_model::{DeployEvent, Diagnostic, EvalConfig, EvalShape, EvaluatedModel, IgnitionEvent};

use crate::diag::{self, diag};

/// True when `component` deploys in `cfg`.
fn deploys_in(cfg: &EvalConfig, component: &str) -> bool {
    let Some(d) = cfg.deployments.iter().find(|d| d.component == component) else {
        return false;
    };
    match d.event {
        DeployEvent::Never => false,
        DeployEvent::Ejection => cfg.motors.iter().any(|m| {
            (m.motor.is_some() || m.engine.is_some())
                && m.delay.is_some()
                && m.ignition != IgnitionEvent::Never
        }),
        DeployEvent::Apogee | DeployEvent::Altitude | DeployEvent::Timer => true,
    }
}

/// `RW-W250` for every parachute and streamer that deploys in no configuration.
pub(crate) fn deployment_diags(model: &EvaluatedModel) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for c in &model.components {
        let kind = match c.shape {
            EvalShape::Parachute { .. } => "Parachute",
            EvalShape::Streamer { .. } => "Streamer",
            _ => continue,
        };
        if model.configs.values().any(|cfg| deploys_in(cfg, &c.id)) {
            continue;
        }
        let id = &c.id;
        // Point at the active configuration when there is one, else the first.
        let cfg = model
            .config
            .as_deref()
            .and_then(|k| model.configs.get(k))
            .or_else(|| model.configs.values().next());
        let d = match cfg {
            Some(cfg) => {
                let plugged = cfg
                    .deployments
                    .iter()
                    .find(|d| d.component == *id)
                    .is_some_and(|d| d.event == DeployEvent::Ejection);
                let why = if plugged {
                    "deploys at `ejection`, but no motor has an ejection `delay` (plugged)"
                } else {
                    "deploys `never`"
                };
                let mount = cfg.motors.first().map_or("<mount>", |m| m.mount.as_str());
                let hint = if plugged {
                    format!(
                        "Set `configs.{c}.deploy.{id}.event` to `apogee` (`rw set configs.{c}.deploy.{id}.event=apogee`), or give the motor an ejection delay (`rw set configs.{c}.motors.{mount}.delay=\"5 s\"`).",
                        c = cfg.id
                    )
                } else {
                    format!(
                        "Set `configs.{c}.deploy.{id}.event` to `apogee` or `ejection` (`rw set configs.{c}.deploy.{id}.event=apogee`).",
                        c = cfg.id
                    )
                };
                diag(
                    diag::W_NO_DEPLOYMENT,
                    Some(format!("/configs/{}/deploy/{id}/event", cfg.id)),
                    format!(
                        "{kind} `{id}` never deploys: in configuration `{}` it {why}, and no other configuration deploys it",
                        cfg.id
                    ),
                    hint,
                )
            }
            None => diag(
                diag::W_NO_DEPLOYMENT,
                Some(format!("/c/{id}")),
                format!("{kind} `{id}` never deploys: the project has no flight configuration"),
                format!(
                    "Add `configs/<id>.rw.toml` with a motor and `[deploy.{id}] event = \"apogee\"` (or `ejection` with a motor `delay`)."
                ),
            ),
        };
        out.push(d);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rw_model::{EvalOptions, SourceSet, eval, parse_source_with_warnings};

    const ROCKET: &str = r#"
[c.body]
type = "body_tube"
material = "card"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

[c.mount]
type = "inner_tube"
attach = { to = "body.aft", at = "aft" }
material = "card"
length = "70 mm"
od = "19.6 mm"
id = "18.8 mm"
motor_mount = true

[c.chute]
type = "parachute"
attach = { to = "body.fore", at = "attach", offset = "40 mm" }
material = "nylon"
diameter = "300 mm"
cd = 0.8
packed_length = "40 mm"
packed_diameter = "18 mm"

[c.tape]
type = "streamer"
attach = { to = "body.fore", at = "attach", offset = "90 mm" }
material = "nylon"
length = "600 mm"
width = "50 mm"
cd = 0.6
packed_length = "30 mm"
packed_diameter = "15 mm"

[materials.card]
density = "680 kg/m^3"

[materials.nylon]
surface_density = "67 g/m^2"
"#;

    fn model(configs: &[(&str, &str)]) -> EvaluatedModel {
        let mut s = SourceSet::default();
        let mut add = |p: &str, t: &str| {
            let (d, w) = parse_source_with_warnings(p, t).unwrap();
            assert!(w.is_empty(), "{p}: {w:?}");
            s.docs.insert(p.to_string(), d);
        };
        add("rocket.rw.toml", ROCKET);
        for (id, t) in configs {
            add(&format!("configs/{id}.rw.toml"), t);
        }
        let m = eval(&s, &EvalOptions::default());
        assert!(m.diagnostics.is_empty(), "{:#?}", m.diagnostics);
        m
    }

    fn codes(m: &EvaluatedModel) -> Vec<(String, String)> {
        deployment_diags(m)
            .into_iter()
            .map(|d| (d.code, d.path.unwrap_or_default()))
            .collect()
    }

    #[test]
    fn ejection_with_a_delay_deploys() {
        let m = model(&[(
            "a",
            "[motors.mount]\nmotor = \"generic:RW_C6G\"\ndelay = \"5 s\"\n",
        )]);
        assert!(codes(&m).is_empty(), "{:?}", deployment_diags(&m));
    }

    #[test]
    fn plugged_motor_and_never_warn_with_the_field_to_set() {
        let m = model(&[(
            "a",
            "[motors.mount]\nmotor = \"generic:RW_C6G\"\n\n[deploy.tape]\nevent = \"never\"\n",
        )]);
        assert_eq!(
            codes(&m),
            [
                (
                    "RW-W250".to_string(),
                    "/configs/a/deploy/chute/event".to_string()
                ),
                (
                    "RW-W250".to_string(),
                    "/configs/a/deploy/tape/event".to_string()
                ),
            ]
        );
        let d = deployment_diags(&m);
        assert_eq!(d[0].severity, rw_model::Severity::Warning);
        assert!(d[0].message.contains("plugged"), "{}", d[0].message);
        let hint = d[0].hint.as_deref().unwrap();
        assert!(
            hint.contains("rw set configs.a.deploy.chute.event=apogee")
                && hint.contains("configs.a.motors.mount.delay"),
            "{hint}"
        );
        assert!(d[1].message.contains("`never`"), "{}", d[1].message);
    }

    #[test]
    fn one_deploying_configuration_is_enough() {
        let m = model(&[
            (
                "a",
                "[motors.mount]\nmotor = \"generic:RW_C6G\"\n\n[deploy.chute]\nevent = \"never\"\n\n[deploy.tape]\nevent = \"never\"\n",
            ),
            (
                "b",
                "[motors.mount]\nmotor = \"generic:RW_C6G\"\n\n[deploy.chute]\nevent = \"apogee\"\n\n[deploy.tape]\nevent = \"altitude\"\naltitude = \"100 m\"\n",
            ),
        ]);
        assert!(codes(&m).is_empty(), "{:?}", deployment_diags(&m));
    }

    #[test]
    fn no_configuration_warns_on_the_component() {
        let m = model(&[]);
        assert_eq!(
            codes(&m),
            [
                ("RW-W250".to_string(), "/c/chute".to_string()),
                ("RW-W250".to_string(), "/c/tape".to_string()),
            ]
        );
    }
}
