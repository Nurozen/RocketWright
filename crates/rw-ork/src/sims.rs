//! Flight configurations (motors, ignition, deployment, stage separation)
//! and simulations (launch, atmosphere, wind, integrator).

use std::collections::{BTreeMap, BTreeSet};

use rw_model::diag::Diagnostic;
use rw_model::{
    AtmosphereModel, AtmosphereSpec, ConfigDoc, DeployEvent, Deployment, Geodetic, IgnitionEvent,
    IntegratorKind, IntegratorSpec, LaunchSpec, MotorAssignment, MotorImport, MotorResolution,
    SeparationEvent, SimDoc, SimKind, StageConfig, WindSpec,
};
use rw_units::markers::{Angle, Length, Pressure, Temperature, Time, Velocity};
use rw_units::{Qty, format_number};

use crate::import::{Tree, approx};
use crate::motors::Resolver;
use crate::util::{q, slug, unique};
use crate::xml::{Element, parse_num};
use crate::{ImportOptions, MotorKey, MotorUse, OrkFiles, OrkImport};
use rw_model::ComponentType;

fn secs(v: f64) -> Qty<Time> {
    q::<Time>(v, "s")
}

/// `<x configid="id">` children of `el` named `name` for config `id`.
fn for_config<'a>(el: &'a Element, name: &'a str, id: &str) -> Option<&'a Element> {
    el.all(name).find(|c| c.attr("configid") == Some(id))
}

fn ignition(s: &str, upper: bool) -> IgnitionEvent {
    match s.to_ascii_lowercase().as_str() {
        "launch" => IgnitionEvent::Launch,
        "burnout" => IgnitionEvent::PreviousBurnout,
        "ejection" => IgnitionEvent::StageSeparation,
        "never" => IgnitionEvent::Never,
        _ if upper => IgnitionEvent::PreviousBurnout,
        _ => IgnitionEvent::Launch,
    }
}

fn separation(s: &str) -> SeparationEvent {
    match s.to_ascii_lowercase().as_str() {
        "burnout" => SeparationEvent::Burnout,
        "ejection" => SeparationEvent::Ejection,
        "launch" | "ignition" => SeparationEvent::Launch,
        "never" => SeparationEvent::Never,
        _ => SeparationEvent::UpperIgnition,
    }
}

fn deploy_event(s: &str) -> Option<DeployEvent> {
    Some(match s.to_ascii_lowercase().as_str() {
        "ejection" => DeployEvent::Ejection,
        "apogee" => DeployEvent::Apogee,
        "altitude" => DeployEvent::Altitude,
        "launch" => DeployEvent::Timer,
        "never" => DeployEvent::Never,
        _ => return None,
    })
}

/// Seconds as text for config names (`3`, `2.5`, `P`).
fn delay_label(d: Option<f64>) -> String {
    match d {
        Some(v) => format_number(v),
        None => "P".into(),
    }
}

pub(crate) fn configs(
    _root: &Element,
    rocket: &Element,
    tree: &Tree<'_>,
    files: &OrkFiles,
    opts: &ImportOptions<'_>,
    out: &mut OrkImport,
) {
    let mounts: Vec<usize> = (0..tree.nodes.len())
        .filter(|&i| {
            tree.nodes[i].ty == ComponentType::InnerTube
                && tree.nodes[i].el.child("motormount").is_some()
        })
        .collect();
    // Configuration ids, in file order, with names and default flags.
    let mut ids: Vec<(String, Option<String>, bool, &Element)> = rocket
        .all("motorconfiguration")
        .filter_map(|c| {
            let id = c.attr("configid")?.to_string();
            let name = c.text_of("name").map(str::to_string);
            let def = c.attr("default").is_some_and(|d| d == "true");
            Some((id, name, def, c))
        })
        .collect();
    let mut seen: BTreeSet<String> = ids.iter().map(|x| x.0.clone()).collect();
    for &m in &mounts {
        if let Some(mm) = tree.nodes[m].el.child("motormount") {
            for motor in mm.all("motor") {
                if let Some(id) = motor.attr("configid")
                    && seen.insert(id.to_string())
                {
                    ids.push((id.to_string(), None, false, rocket));
                }
            }
        }
    }
    let mut resolver = Resolver::new(files, opts.cache);
    let upper_stages = tree.stages.len().saturating_sub(1);
    for (cid, name, def, cel) in &ids {
        let mut doc = ConfigDoc::default();
        let mut labels = Vec::new();
        for &m in &mounts {
            let node = &tree.nodes[m];
            let mm = node.el.child("motormount").expect("mount");
            let Some(motor) = for_config(mm, "motor", cid) else {
                continue;
            };
            let Some(designation) = motor.text_of("designation") else {
                continue;
            };
            let key = MotorKey {
                manufacturer: motor.text_of("manufacturer").map(str::to_string),
                designation: designation.to_string(),
                digest: motor.text_of("digest").map(str::to_string),
                diameter: motor.num("diameter").filter(|d| d.is_finite() && *d > 0.0),
                length: motor.num("length").filter(|d| d.is_finite() && *d > 0.0),
            };
            let delay = motor.num("delay").filter(|d| d.is_finite() && *d >= 0.0);
            let (motor_ref, resolution) = resolver.resolve(&key);
            let upper = node.stage + 1 < tree.stages.len();
            let ic = for_config(mm, "ignitionconfiguration", cid);
            let ev = ic
                .and_then(|c| c.text_of("ignitionevent"))
                .or_else(|| mm.text_of("ignitionevent"))
                .unwrap_or("automatic");
            let ig = ignition(ev, upper);
            let ig_delay = ic
                .and_then(|c| c.num("ignitiondelay"))
                .or_else(|| mm.num("ignitiondelay"))
                .filter(|d| d.is_finite() && *d > 0.0);
            labels.push(format!("{}-{}", key.designation, delay_label(delay)));
            if resolution == MotorResolution::Substituted {
                // `RW-W103` is rw-check's code; rw-model's table does not know
                // it, so `Diagnostic::new` would default it to an error.
                out.diagnostics.push(Diagnostic {
                    severity: rw_model::Severity::Warning,
                    ..Diagnostic::new(
                        "RW-W103",
                        Some(format!("/configs/{cid}/motors/{}/motor", node.id)),
                        format!(
                            "no curve for `{}` is available offline; `{}` stands in for it",
                            key.designation,
                            motor_ref.as_deref().unwrap_or("-")
                        ),
                    )
                    .with_hint(format!(
                        "import the motor file into lib/motors/ and point the configuration at it, or accept the generic curve: `rw set configs.{cid}.motors.{}.accept_substitution=true`",
                        node.id
                    ))
                });
            }
            out.motors.push(MotorUse {
                config: cid.clone(),
                mount: node.id.clone(),
                key: key.clone(),
                resolution,
                motor_ref: motor_ref.clone().unwrap_or_default(),
            });
            doc.motors.insert(
                node.id.clone(),
                MotorAssignment {
                    motor: motor_ref,
                    engine: None,
                    delay: delay.map(secs),
                    ignition: (ig != IgnitionEvent::Launch).then_some(ig),
                    ignition_delay: ig_delay.map(secs),
                    import: Some(MotorImport {
                        manufacturer: key.manufacturer,
                        designation: key.designation,
                        digest: key.digest,
                        resolution,
                    }),
                    accept_substitution: false,
                },
            );
        }
        // Stage separation (every stage below the top one) and activity.
        for (k, s) in tree.stages.iter().enumerate().skip(1) {
            let sc = for_config(s.el, "separationconfiguration", cid);
            let ev = sc
                .and_then(|c| c.text_of("separationevent"))
                .or_else(|| s.el.text_of("separationevent"))
                .unwrap_or("upperignition");
            let delay = sc
                .and_then(|c| c.num("separationdelay"))
                .or_else(|| s.el.num("separationdelay"))
                .filter(|d| d.is_finite() && *d > 0.0);
            let active = cel
                .all("stage")
                .find(|st| st.attr("number").and_then(|n| n.parse::<usize>().ok()) == Some(k))
                .and_then(|st| st.attr("active"))
                .is_none_or(|a| a != "false");
            if upper_stages > 0 && s.first.is_some() {
                doc.stages.insert(
                    s.id.clone(),
                    StageConfig {
                        active,
                        separation: Some(separation(ev)),
                        separation_delay: delay.map(secs),
                    },
                );
            }
        }
        // Recovery deployment.
        for n in tree.by_ty(&[ComponentType::Parachute, ComponentType::Streamer]) {
            let dc = for_config(n.el, "deploymentconfiguration", cid);
            let get = |k: &str| dc.and_then(|c| c.child(k)).or_else(|| n.el.child(k));
            let ev = get("deployevent")
                .map(|e| e.text.as_str())
                .unwrap_or("ejection");
            let event = match deploy_event(ev) {
                Some(e) => e,
                None => {
                    out.diagnostics.push(approx(
                        Some(format!("/configs/{cid}/deploy/{}", n.id)),
                        format!(
                            "deployment event `{ev}` of `{}` was imported as `ejection`",
                            n.name
                        ),
                    ));
                    DeployEvent::Ejection
                }
            };
            let num = |k: &str| {
                get(k)
                    .and_then(|e| parse_num(&e.text))
                    .filter(|v| v.is_finite())
            };
            doc.deploy.insert(
                n.id.clone(),
                Deployment {
                    event,
                    altitude: (event == DeployEvent::Altitude)
                        .then(|| num("deployaltitude").map(|a| q::<Length>(a, "m")))
                        .flatten(),
                    delay: num("deploydelay").filter(|d| *d > 0.0).map(secs),
                },
            );
        }
        doc.name = Some(match name {
            Some(n) if !n.trim().is_empty() => n.clone(),
            _ if labels.is_empty() => "No motors".into(),
            _ => format!("[{}]", labels.join("; ")),
        });
        if *def && out.default_config.is_none() {
            out.default_config = Some(cid.clone());
        }
        out.configs.insert(cid.clone(), doc);
    }
    if out.default_config.is_none() {
        out.default_config = ids.first().map(|x| x.0.clone());
    }
    out.lib_files = std::mem::take(&mut resolver.files);
}

fn angle(v: f64) -> Qty<Angle> {
    crate::util::degrees(v)
}

pub(crate) fn sims(root: &Element, out: &mut OrkImport) {
    let Some(list) = root.child("simulations") else {
        return;
    };
    let mut taken = BTreeSet::new();
    let mut sims = BTreeMap::new();
    for (k, s) in list.all("simulation").enumerate() {
        let name = s
            .text_of("name")
            .map(str::to_string)
            .unwrap_or_else(|| format!("Simulation {}", k + 1));
        let Some(c) = s.child("conditions") else {
            continue;
        };
        let config = c
            .text_of("configid")
            .filter(|id| out.configs.contains_key(*id))
            .map(str::to_string)
            .or_else(|| out.default_config.clone());
        let Some(config) = config else {
            out.diagnostics.push(approx(
                None,
                format!("simulation `{name}` has no flight configuration; it was skipped"),
            ));
            continue;
        };
        let num = |k: &str| c.num(k).filter(|v| v.is_finite());
        let wind_el = c.child("wind");
        let wnum = |k: &str| {
            num(k).or_else(|| {
                wind_el
                    .and_then(|w| w.num(k).or_else(|| w.num(k.trim_start_matches("wind"))))
                    .filter(|v| v.is_finite())
            })
        };
        let geodetic = match c
            .text_of("geodeticmethod")
            .or_else(|| c.text_of("calculationmethod"))
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("spherical") => Some(Geodetic::Spherical),
            Some("wgs84") | Some("ellipsoidal") => Some(Geodetic::Wgs84),
            Some("flat") => Some(Geodetic::Flat),
            _ => None,
        };
        let atm = c.child("atmosphere");
        let atmosphere = match atm
            .and_then(|a| a.attr("model"))
            .map(str::to_ascii_lowercase)
        {
            Some(m) if m.contains("extended") || m.contains("custom") => AtmosphereSpec {
                model: AtmosphereModel::IsaCustom,
                base_temperature: atm
                    .and_then(|a| a.num("basetemperature"))
                    .map(|t| q::<Temperature>(t, "K")),
                base_pressure: atm
                    .and_then(|a| a.num("basepressure"))
                    .map(|p| q::<Pressure>(p, "Pa")),
            },
            _ => AtmosphereSpec {
                model: AtmosphereModel::Ussa1976,
                base_temperature: None,
                base_pressure: None,
            },
        };
        let method = s
            .text_of("simulator")
            .or_else(|| c.text_of("simulationsteppermethod"))
            .map(str::to_ascii_lowercase);
        let integrator = match method.as_deref() {
            Some(m) if m.contains("dp") || m.contains("adaptive") => IntegratorKind::Dp54,
            _ => IntegratorKind::Rk4,
        };
        let id = unique(&slug(&name), &mut taken);
        sims.insert(
            id,
            SimDoc {
                schema_url: None,
                name: Some(name),
                kind: SimKind::Flight,
                config,
                launch: Some(LaunchSpec {
                    rail_length: q::<Length>(num("launchrodlength").unwrap_or(1.0), "m"),
                    rod_angle: num("launchrodangle").map(angle),
                    rod_direction: num("launchroddirection").map(angle),
                    altitude: num("launchaltitude").map(|a| q::<Length>(a, "m")),
                    latitude: num("launchlatitude").map(angle),
                    longitude: num("launchlongitude").map(angle),
                    geodetic,
                }),
                atmosphere: Some(atmosphere),
                wind: Some(WindSpec {
                    speed: q::<Velocity>(wnum("windaverage").unwrap_or(0.0), "m/s"),
                    // OpenRocket stores the wind direction in radians (the rod angles in degrees).
                    direction: wnum("winddirection").map(|r| angle(r.to_degrees())),
                    turbulence: wnum("windturbulence").map(Qty::number),
                }),
                integrator: Some(IntegratorSpec {
                    method: integrator,
                    dt: num("timestep").filter(|d| *d > 0.0).map(secs),
                    rtol: None,
                    atol: None,
                    max_time: num("maxtime").filter(|d| *d > 0.0).map(secs),
                }),
                series_dt: None,
                gravity: None,
                launch_into_wind: c.flag("launchintowind").filter(|b| *b),
                seed: None,
                visual_flow: None,
            },
        );
    }
    out.sims = sims;
}
