//! Evaluated model → `.ork` XML (M2.6), written from this crate's own
//! reading of the format: the elements the importer understands, in SI,
//! with every placement as an explicit offset. Expressions and `rw:` refs do
//! not survive (the format has no place for them); each component's id is
//! kept in its comment (`rw-id: <id>`) so a re-import restores it.

use std::collections::BTreeMap;
use std::f64::consts::PI;

use rw_model::{
    AnchorKind, Component, ComponentType, DeployEvent, EvalComponent, EvalShape, EvaluatedModel,
    Geodetic, IgnitionEvent, InstancePattern, IntegratorKind, MassRole, SeparationEvent,
};
use rw_motor::ThrustCurve;

use crate::xml::{Writer, fmt_num};

/// A motor the exporter can name and embed.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportMotor {
    pub curve: ThrustCurve,
    /// Source file bytes to embed (`.rse` or `.eng`), if available.
    pub file: Option<(String, Vec<u8>)>,
}

/// The written document plus files to place beside it in the container.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OrkOut {
    pub xml: String,
    /// Container entries (`thrustcurves/<sha256>.rse`).
    pub files: BTreeMap<String, Vec<u8>>,
    /// Components that could not be written (e.g. tanks).
    pub skipped: Vec<String>,
}

fn tag(t: ComponentType) -> Option<&'static str> {
    use ComponentType as T;
    Some(match t {
        T::NoseCone => "nosecone",
        T::BodyTube => "bodytube",
        T::Transition => "transition",
        T::TrapezoidalFinSet => "trapezoidfinset",
        T::EllipticalFinSet => "ellipticalfinset",
        T::FreeformFinSet => "freeformfinset",
        T::TubeFinSet => "tubefinset",
        T::LaunchLug => "launchlug",
        T::RailButton => "railbutton",
        T::InnerTube => "innertube",
        T::Coupler => "tubecoupler",
        T::CenteringRing => "centeringring",
        T::Bulkhead => "bulkhead",
        T::EngineBlock => "engineblock",
        T::Parachute => "parachute",
        T::Streamer => "streamer",
        T::ShockCord => "shockcord",
        T::MassComponent => "masscomponent",
        T::Tank => return None,
    })
}

/// A stable UUID-shaped id derived from a component id (FNV-1a, 128 bits).
pub fn derived_uuid(id: &str) -> String {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x8422_2325_cbf2_9ce4;
    for byte in id.bytes() {
        a = (a ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
        b = (b ^ u64::from(byte).rotate_left(3)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    let h = format!("{a:016x}{b:016x}");
    format!(
        "{}-{}-4{}-8{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

fn finish_name(roughness: f64) -> &'static str {
    const TABLE: [(&str, f64); 6] = [
        ("mirror", 0.0),
        ("polished", 2e-6),
        ("smooth", 20e-6),
        ("normal", 60e-6),
        ("unfinished", 150e-6),
        ("rough", 500e-6),
    ];
    TABLE
        .iter()
        .min_by(|x, y| (x.1 - roughness).abs().total_cmp(&(y.1 - roughness).abs()))
        .map_or("normal", |x| x.0)
}

struct Ctx<'a> {
    model: &'a EvaluatedModel,
    source: &'a BTreeMap<String, Component>,
    motors: &'a dyn Fn(&str) -> Option<ExportMotor>,
    out: OrkOut,
}

impl Ctx<'_> {
    fn comp(&self, id: &str) -> Option<&EvalComponent> {
        self.model.components.iter().find(|c| c.id == id)
    }

    fn material(&self, w: &mut Writer, el: &str, key: Option<&str>, kind: &str) {
        let Some(key) = key else { return };
        let Some(m) = self.model.materials.get(key) else {
            return;
        };
        let density = match kind {
            "surface" => m.surface_density,
            "line" => m.line_density,
            _ => m.density,
        };
        let Some(d) = density else { return };
        w.leaf(el, &[("type", kind.into()), ("density", fmt_num(d))], key);
    }

    fn deploy_for(&self, w: &mut Writer, c: &EvalComponent) {
        let mut first = true;
        for (cid, cfg) in &self.model.configs {
            let Some(d) = cfg.deployments.iter().find(|d| d.component == c.id) else {
                continue;
            };
            let ev = match d.event {
                DeployEvent::Ejection => "ejection",
                DeployEvent::Apogee => "apogee",
                DeployEvent::Altitude => "altitude",
                DeployEvent::Timer => "launch",
                DeployEvent::Never => "never",
            };
            let alt = d.altitude.unwrap_or(200.0);
            if first {
                w.leaf("deployevent", &[], ev);
                w.num("deployaltitude", alt);
                w.num("deploydelay", d.delay);
                first = false;
            }
            w.open("deploymentconfiguration", &[("configid", cid.clone())]);
            w.leaf("deployevent", &[], ev);
            w.num("deployaltitude", alt);
            w.num("deploydelay", d.delay);
            w.close();
        }
    }

    fn mount(&mut self, w: &mut Writer, c: &EvalComponent, overhang: f64) {
        w.open("motormount", &[]);
        w.leaf("ignitionevent", &[], "automatic");
        w.num("ignitiondelay", 0.0);
        w.num("overhang", overhang);
        let configs: Vec<(String, rw_model::EvalMotorMount)> = self
            .model
            .configs
            .iter()
            .filter_map(|(cid, cfg)| {
                cfg.motors
                    .iter()
                    .find(|m| m.mount == c.id)
                    .map(|m| (cid.clone(), m.clone()))
            })
            .collect();
        for (cid, mm) in &configs {
            let Some(r) = mm.motor.as_deref() else {
                continue;
            };
            let Some(em) = (self.motors)(r) else {
                continue;
            };
            let curve = &em.curve;
            w.open("motor", &[("configid", cid.clone())]);
            w.leaf("type", &[], "single");
            if let Some(m) = &curve.manufacturer {
                w.leaf("manufacturer", &[], m);
            }
            w.leaf("digest", &[], &curve.sha256);
            w.leaf("designation", &[], &curve.designation);
            w.num("diameter", curve.diameter);
            w.num("length", curve.length);
            w.num("delay", mm.delay.unwrap_or(f64::NAN));
            w.close();
            if let Some((name, bytes)) = &em.file {
                let ext = if name.to_ascii_lowercase().ends_with(".eng") {
                    "eng"
                } else {
                    "rse"
                };
                self.out.files.insert(
                    format!("thrustcurves/{}.{ext}", curve.sha256),
                    bytes.clone(),
                );
            }
        }
        for (cid, mm) in &configs {
            let ev = match mm.ignition {
                IgnitionEvent::Launch => "launch",
                IgnitionEvent::PreviousBurnout => "burnout",
                IgnitionEvent::StageSeparation => "ejection",
                IgnitionEvent::Never => "never",
            };
            w.open("ignitionconfiguration", &[("configid", cid.clone())]);
            w.leaf("ignitionevent", &[], ev);
            w.num("ignitiondelay", mm.ignition_delay);
            w.close();
        }
        w.close();
    }

    fn component(&mut self, w: &mut Writer, c: &EvalComponent, method: &str, offset: f64) {
        let Some(t) = tag(c.component_type()) else {
            self.out.skipped.push(c.id.clone());
            return;
        };
        let src = self.source.get(&c.id);
        w.open(t, &[]);
        w.leaf("name", &[], &c.name);
        let uuid = src
            .and_then(|s| s.import.as_ref())
            .and_then(|i| i.uuid.clone())
            .unwrap_or_else(|| derived_uuid(&c.id));
        w.leaf("id", &[], &uuid);
        w.leaf("comment", &[], &format!("rw-id: {}", c.id));
        w.leaf(
            "axialoffset",
            &[("method", method.into())],
            &fmt_num(offset),
        );
        if let Some(a) = &c.appearance
            && let Some(col) = a
                .color
                .as_deref()
                .and_then(rw_model::components::appearance::parse_hex)
        {
            w.open("appearance", &[]);
            w.leaf(
                "paint",
                &[
                    ("red", col[0].to_string()),
                    ("green", col[1].to_string()),
                    ("blue", col[2].to_string()),
                    ("alpha", "255".into()),
                ],
                "",
            );
            if let Some(r) = a.roughness {
                w.num("shine", 1.0 - r);
            }
            w.close();
        }
        if let Some(r) = c.roughness {
            w.leaf("finish", &[], finish_name(r));
        }
        if let Some(o) = &c.overrides {
            if let Some(m) = o.mass {
                w.num("overridemass", m);
            }
            if let Some(cg) = o.cg {
                w.num("overridecg", cg - c.x_fore);
            }
            if let Some(cd) = o.cd {
                w.num("overridecd", cd);
            }
            w.leaf(
                "overridesubcomponents",
                &[],
                if o.subtree { "true" } else { "false" },
            );
        }
        let surface = c.containment == AnchorKind::Surface;
        if surface && c.roll != 0.0 {
            w.leaf(
                "angleoffset",
                &[("method", "relative".into())],
                &fmt_num(c.roll * 180.0 / PI),
            );
        }
        if c.containment == AnchorKind::Inner {
            if c.radial != 0.0 {
                w.num("radialposition", c.radial);
            }
            if c.roll != 0.0 {
                w.num("radialdirection", c.roll * 180.0 / PI);
            }
        }
        let mat = c.material.as_deref();
        let inst = c.instances.len();
        match &c.shape {
            EvalShape::NoseCone {
                shape,
                shape_param,
                length,
                od,
                thickness,
                shoulder,
            } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("thickness", *thickness);
                w.leaf(
                    "filled",
                    &[],
                    if *thickness <= 0.0 { "true" } else { "false" },
                );
                w.leaf("shape", &[], shape_name(*shape));
                w.num("shapeparameter", *shape_param);
                w.num("aftradius", od / 2.0);
                if let Some(s) = shoulder {
                    w.num("aftshoulderradius", s.od / 2.0);
                    w.num("aftshoulderlength", s.length);
                    w.num("aftshoulderthickness", s.thickness);
                    w.leaf(
                        "aftshouldercapped",
                        &[],
                        if s.capped { "true" } else { "false" },
                    );
                }
            }
            EvalShape::BodyTube { length, od, id } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("thickness", (od - id) / 2.0);
                w.num("radius", od / 2.0);
            }
            EvalShape::Transition {
                shape,
                shape_param,
                length,
                fore_od,
                aft_od,
                thickness,
                fore_shoulder,
                aft_shoulder,
            } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("thickness", *thickness);
                w.leaf(
                    "filled",
                    &[],
                    if *thickness <= 0.0 { "true" } else { "false" },
                );
                w.leaf("shape", &[], shape_name(*shape));
                w.num("shapeparameter", *shape_param);
                w.num("foreradius", fore_od / 2.0);
                w.num("aftradius", aft_od / 2.0);
                for (p, s) in [("fore", fore_shoulder), ("aft", aft_shoulder)] {
                    if let Some(s) = s {
                        w.num(&format!("{p}shoulderradius"), s.od / 2.0);
                        w.num(&format!("{p}shoulderlength"), s.length);
                        w.num(&format!("{p}shoulderthickness"), s.thickness);
                        w.leaf(
                            &format!("{p}shouldercapped"),
                            &[],
                            if s.capped { "true" } else { "false" },
                        );
                    }
                }
            }
            EvalShape::TrapezoidalFinSet { fins, .. }
            | EvalShape::EllipticalFinSet { fins, .. }
            | EvalShape::FreeformFinSet { fins, .. } => {
                self.material(w, "material", mat, "bulk");
                w.num("fincount", f64::from(fins.count));
                w.num("thickness", fins.thickness);
                w.leaf(
                    "crosssection",
                    &[],
                    match fins.cross_section {
                        rw_model::FinCrossSection::Square => "square",
                        rw_model::FinCrossSection::Rounded => "rounded",
                        rw_model::FinCrossSection::Airfoil => "airfoil",
                    },
                );
                w.num("cant", fins.cant * 180.0 / PI);
                if let Some(tab) = &fins.tab {
                    w.num("tabheight", tab.height);
                    w.num("tablength", tab.length);
                    w.leaf(
                        "tabposition",
                        &[("relativeto", "front".into())],
                        &fmt_num(tab.offset),
                    );
                }
                w.num("filletradius", fins.fillet_radius);
                match &c.shape {
                    EvalShape::TrapezoidalFinSet {
                        root_chord,
                        tip_chord,
                        span,
                        sweep,
                        ..
                    } => {
                        w.num("rootchord", *root_chord);
                        w.num("tipchord", *tip_chord);
                        w.num("sweeplength", *sweep);
                        w.num("height", *span);
                    }
                    EvalShape::EllipticalFinSet {
                        root_chord, span, ..
                    } => {
                        w.num("rootchord", *root_chord);
                        w.num("height", *span);
                    }
                    EvalShape::FreeformFinSet { points, .. } => {
                        w.open("finpoints", &[]);
                        for p in points {
                            w.leaf("point", &[("x", fmt_num(p[0])), ("y", fmt_num(p[1]))], "");
                        }
                        w.close();
                    }
                    _ => {}
                }
            }
            EvalShape::TubeFinSet {
                count,
                length,
                od,
                id,
            } => {
                self.material(w, "material", mat, "bulk");
                w.num("instancecount", f64::from(*count));
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
                w.num("thickness", (od - id) / 2.0);
            }
            EvalShape::LaunchLug { length, od, id } => {
                self.material(w, "material", mat, "bulk");
                linear(w, c, inst);
                w.num("radius", od / 2.0);
                w.num("thickness", (od - id) / 2.0);
                w.num("length", *length);
            }
            EvalShape::RailButton {
                od,
                id,
                height,
                base_height,
                flange_height,
            } => {
                self.material(w, "material", mat, "bulk");
                linear(w, c, inst);
                w.num("outerdiameter", *od);
                w.num("innerdiameter", *id);
                w.num("height", *height);
                w.num("baseheight", *base_height);
                w.num("flangeheight", *flange_height);
            }
            EvalShape::InnerTube {
                length,
                od,
                id,
                motor_mount,
                overhang,
            } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
                w.num("thickness", (od - id) / 2.0);
                self.cluster(w, c, *od);
                if *motor_mount {
                    self.mount(w, c, *overhang);
                }
            }
            EvalShape::Coupler { length, od, id } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
                w.num("thickness", (od - id) / 2.0);
            }
            EvalShape::CenteringRing { length, od, id } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
                w.num("innerradius", id / 2.0);
            }
            EvalShape::Bulkhead { length, od } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
            }
            EvalShape::EngineBlock { length, od, id } => {
                self.material(w, "material", mat, "bulk");
                w.num("length", *length);
                w.num("outerradius", od / 2.0);
                w.num("thickness", (od - id) / 2.0);
            }
            EvalShape::Parachute {
                diameter,
                cd,
                spill_hole,
                line_count,
                line_length,
                line_material,
                packed_length,
                packed_diameter,
            } => {
                self.material(w, "material", mat, "surface");
                w.num("cd", *cd);
                w.num("packedlength", *packed_length);
                w.num("packedradius", packed_diameter / 2.0);
                self.deploy_for(w, c);
                w.num("diameter", *diameter);
                if *spill_hole > 0.0 {
                    w.num("spillholediameter", *spill_hole);
                }
                w.num("linecount", f64::from(*line_count));
                w.num("linelength", *line_length);
                self.material(w, "linematerial", line_material.as_deref(), "line");
            }
            EvalShape::Streamer {
                length,
                width,
                cd,
                packed_length,
                packed_diameter,
            } => {
                self.material(w, "material", mat, "surface");
                w.num("cd", *cd);
                w.num("packedlength", *packed_length);
                w.num("packedradius", packed_diameter / 2.0);
                self.deploy_for(w, c);
                w.num("striplength", *length);
                w.num("stripwidth", *width);
            }
            EvalShape::ShockCord {
                cord_length,
                packed_length,
                packed_diameter,
            } => {
                self.material(w, "material", mat, "line");
                w.num("packedlength", *packed_length);
                w.num("packedradius", packed_diameter / 2.0);
                w.num("cordlength", *cord_length);
            }
            EvalShape::MassComponent {
                mass,
                length,
                od,
                role,
            } => {
                w.num("packedlength", *length);
                w.num("packedradius", od / 2.0);
                w.num("mass", *mass);
                let r = match role {
                    None => "masscomponent",
                    Some(MassRole::Altimeter) => "altimeter",
                    Some(MassRole::FlightComputer) => "flightcomputer",
                    Some(MassRole::Battery) => "battery",
                    Some(MassRole::Tracker) => "tracker",
                    Some(MassRole::Payload) => "payload",
                    Some(MassRole::Ballast | MassRole::Other) => "masscomponent",
                };
                w.leaf("masscomponenttype", &[], r);
            }
            EvalShape::Tank { .. } => {}
        }
        let kids: Vec<String> = c
            .children
            .iter()
            .filter(|k| {
                self.comp(k)
                    .is_some_and(|kc| kc.containment != AnchorKind::Axial)
            })
            .cloned()
            .collect();
        if !kids.is_empty() {
            w.open("subcomponents", &[]);
            for k in kids {
                let Some(kc) = self.comp(&k).cloned() else {
                    continue;
                };
                let off = kc.x_fore - c.x_fore;
                self.component(w, &kc, "top", off);
            }
            w.close();
        }
        w.close();
    }

    fn cluster(&self, w: &mut Writer, c: &EvalComponent, od: f64) {
        let n = c.instances.len();
        if n < 2 || c.instances[0].pattern != Some(InstancePattern::Cluster) {
            return;
        }
        let preset = self
            .source
            .get(&c.id)
            .and_then(|s| s.instances.as_ref())
            .and_then(|i| i.preset.clone());
        let name = match preset.as_deref() {
            Some("2-row") => "double".to_string(),
            Some(p) => p.to_string(),
            None => format!("{n}-ring"),
        };
        let (a, b) = (c.instances[0].offset, c.instances[1].offset);
        let d = ((a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
        w.leaf("clusterconfiguration", &[], &name);
        w.num("clusterscale", if od > 0.0 { d / od } else { 1.0 });
        w.num("clusterrotation", c.instances[0].roll * 180.0 / PI);
    }
}

fn linear(w: &mut Writer, c: &EvalComponent, n: usize) {
    if n >= 2 {
        w.num("instancecount", n as f64);
        w.num(
            "instanceseparation",
            c.instances[1].offset[0] - c.instances[0].offset[0],
        );
    }
}

fn shape_name(s: rw_model::NoseShape) -> &'static str {
    use rw_model::NoseShape as S;
    match s {
        S::Conical => "conical",
        S::Ogive => "ogive",
        S::Ellipsoid => "ellipsoid",
        S::Power => "power",
        S::Parabolic => "parabolic",
        S::Haack => "haack",
    }
}

/// Writes the model as `.ork` XML. `source` holds the merged source
/// components (import UUIDs, cluster presets); `motors` resolves a motor ref.
pub fn write_ork(
    model: &EvaluatedModel,
    source: &BTreeMap<String, Component>,
    motors: &dyn Fn(&str) -> Option<ExportMotor>,
    creator: &str,
) -> OrkOut {
    let mut ctx = Ctx {
        model,
        source,
        motors,
        out: OrkOut::default(),
    };
    let mut w = Writer::new();
    w.open(
        "openrocket",
        &[("version", "1.9".into()), ("creator", creator.into())],
    );
    w.open("rocket", &[]);
    w.leaf("name", &[], &model.name);
    w.leaf("id", &[], &derived_uuid(&format!("rocket:{}", model.name)));
    for (cid, cfg) in &model.configs {
        w.open(
            "motorconfiguration",
            &[
                ("configid", cid.clone()),
                (
                    "default",
                    (model.config.as_deref() == Some(cid.as_str())).to_string(),
                ),
            ],
        );
        w.leaf("name", &[], &cfg.name);
        for (k, s) in cfg.stages.iter().enumerate() {
            if !s.active {
                w.leaf(
                    "stage",
                    &[("number", (k + 1).to_string()), ("active", "false".into())],
                    "",
                );
            }
        }
        w.close();
    }
    w.leaf("referencetype", &[], "maximum");
    w.open("subcomponents", &[]);
    // Body chain by stage, fore to aft.
    let mut chain: Vec<&EvalComponent> = model
        .components
        .iter()
        .filter(|c| c.containment == AnchorKind::Axial)
        .collect();
    chain.sort_by(|a, b| a.x_fore.total_cmp(&b.x_fore));
    let stages: Vec<(String, String)> = if model.stages.is_empty() {
        vec![(String::new(), "Sustainer".into())]
    } else {
        model
            .stages
            .iter()
            .map(|s| (s.id.clone(), s.name.clone()))
            .collect()
    };
    let mut prev_end: Option<f64> = None;
    for (k, (sid, sname)) in stages.iter().enumerate() {
        let members: Vec<&EvalComponent> = chain
            .iter()
            .copied()
            .filter(|c| model.stages.is_empty() || c.stage.as_deref() == Some(sid.as_str()))
            .collect();
        if members.is_empty() {
            continue;
        }
        w.open("stage", &[]);
        w.leaf("name", &[], sname);
        w.leaf("id", &[], &derived_uuid(&format!("stage:{sid}")));
        if let Some(st) = model.stages.iter().find(|s| s.id == *sid)
            && let Some(o) = &st.overrides
        {
            if let Some(m) = o.mass {
                w.num("overridemass", m);
            }
            if let Some(cg) = o.cg {
                w.num("overridecg", cg - st.x_fore);
            }
            w.leaf("overridesubcomponents", &[], "true");
        }
        if k > 0 {
            for (cid, cfg) in &model.configs {
                if let Some(sc) = cfg.stages.iter().find(|s| s.stage == *sid) {
                    let ev = match sc.separation {
                        SeparationEvent::UpperIgnition => "upperignition",
                        SeparationEvent::Burnout => "burnout",
                        SeparationEvent::Ejection => "ejection",
                        SeparationEvent::Launch => "launch",
                        SeparationEvent::Never => "never",
                    };
                    w.open("separationconfiguration", &[("configid", cid.clone())]);
                    w.leaf("separationevent", &[], ev);
                    w.num("separationdelay", sc.separation_delay);
                    w.close();
                }
            }
        }
        w.open("subcomponents", &[]);
        for c in members {
            let len = rw_model::anchors::extent(&c.shape);
            let off = prev_end.map_or(0.0, |e| c.x_fore - e);
            ctx.component(&mut w, c, "after", off);
            prev_end = Some(c.x_fore + len);
        }
        w.close();
        w.close();
    }
    w.close();
    w.close();
    let flights: Vec<_> = model
        .sims
        .values()
        .filter(|s| s.kind == rw_model::SimKind::Flight)
        .collect();
    if !flights.is_empty() {
        w.open("simulations", &[]);
        for s in flights {
            let c = &s.conditions;
            w.open("simulation", &[("status", "outdated".into())]);
            w.leaf("name", &[], &s.name);
            w.open("conditions", &[]);
            w.leaf("configid", &[], &s.config);
            w.num("launchrodlength", c.rail_length_m);
            w.num("launchrodangle", c.rod_angle_deg);
            w.num("launchroddirection", c.rod_direction_deg);
            w.num("windaverage", c.wind_speed_ms);
            w.num("windturbulence", c.wind_turbulence);
            // Radians, as OpenRocket reads it (the rod angles are degrees).
            w.num("winddirection", c.wind_direction_deg.to_radians());
            w.num("launchaltitude", c.site_altitude_m);
            w.num("launchlatitude", c.latitude_deg);
            w.num("launchlongitude", c.longitude_deg);
            w.leaf(
                "geodeticmethod",
                &[],
                match c.geodetic {
                    Geodetic::Flat => "flat",
                    Geodetic::Spherical => "spherical",
                    Geodetic::Wgs84 => "wgs84",
                },
            );
            if c.launch_into_wind == Some(true) {
                w.leaf("launchintowind", &[], "true");
            }
            match c.atmosphere {
                rw_model::AtmosphereModel::Ussa1976 => {
                    w.leaf("atmosphere", &[("model", "isa".into())], "");
                }
                rw_model::AtmosphereModel::IsaCustom => {
                    w.open("atmosphere", &[("model", "extendedisa".into())]);
                    w.num("basetemperature", c.base_temperature_k);
                    w.num("basepressure", c.base_pressure_pa);
                    w.close();
                }
            }
            w.num("timestep", c.time_step_s);
            w.leaf(
                "simulationsteppermethod",
                &[],
                match c.integrator {
                    IntegratorKind::Rk4 => "rk4",
                    IntegratorKind::Dp54 => "dp54",
                },
            );
            w.close();
            w.close();
        }
        w.close();
    }
    w.close();
    ctx.out.xml = w.out;
    ctx.out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_uuids_are_stable_and_shaped() {
        let a = derived_uuid("body");
        assert_eq!(a, derived_uuid("body"));
        assert_ne!(a, derived_uuid("nose"));
        assert_eq!(a.len(), 36);
        assert_eq!(a.matches('-').count(), 4);
    }

    #[test]
    fn finish_names_pick_the_nearest_roughness() {
        assert_eq!(finish_name(60e-6), "normal");
        assert_eq!(finish_name(1.5e-6), "polished");
        assert_eq!(finish_name(1.0), "rough");
    }
}
