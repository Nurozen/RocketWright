//! `eval()` (M1.22): source set → [`EvaluatedModel`] (IF2).
//!
//! Steps: merge the sources into the model value ([`crate::patch::merge`]),
//! apply the variant and `--set` overrides, evaluate params, derive the tree
//! from `attach` ([`crate::attach`]), then, targets first, evaluate each
//! shape, place it (own anchor `at` on the target anchor plus `offset`),
//! expand instances, and evaluate overrides. Stages, configurations,
//! simulations, materials, asserts, and the model hash follow.
//!
//! Errors never abort: each is a diagnostic at its JSON pointer and the
//! offending value evaluates to 0 (the Session keeps the last good model).

use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{PI, TAU};

use serde_json::Value;

use rw_units::DimKind;

use crate::anchors::{RelAnchor, anchors, extent, inner_radius, outer_radius_at};
use crate::attach::{self, Tree};
use crate::components;
use crate::diag::{self, Diagnostic, Severity};
use crate::expr::Scope;
use crate::params::{apply_overrides, eval_params};
use crate::patch::merge;
use crate::shape::{Fields, ParentInfo, eval_shape};
use crate::types::*;

/// Default series grid and fixed step (s).
pub const DEFAULT_DT: f64 = 0.01;
/// Default simulation time limit (s).
pub const DEFAULT_MAX_TIME: f64 = 600.0;
/// Default integrator tolerances.
pub const DEFAULT_RTOL: f64 = 1e-6;
pub const DEFAULT_ATOL: f64 = 1e-9;
/// Default launch rail length (m) when a sim has no `[launch]`.
pub const DEFAULT_RAIL_LENGTH: f64 = 1.0;
/// Standard sea-level base temperature (K) and pressure (Pa).
pub const DEFAULT_BASE_TEMPERATURE: f64 = 288.15;
pub const DEFAULT_BASE_PRESSURE: f64 = 101_325.0;
/// The stage id used when the model defines no `[stage.*]`.
pub const IMPLICIT_STAGE: &str = "main";

/// Metric roots an `[[assert]]` can test without a simulation.
const STATIC_ROOTS: &[&str] = &[
    "stability",
    "cg",
    "cp",
    "mass",
    "dims",
    "aero",
    "c",
    "params",
    "length",
    "diameter",
    "motor_fit",
    "clearance",
    "reference",
];

struct Placed {
    shape: EvalShape,
    x_fore: f64,
    rel: Vec<RelAnchor>,
    parent_r: f64,
    radial: f64,
    roll: f64,
    attach: Option<EvalAttach>,
    instances: Vec<EvalInstance>,
    overrides: Option<EvalOverride>,
}

/// Cluster presets: unit positions `(y, z)` scaled by the center distance.
fn cluster_positions(preset: Option<&str>, count: u32) -> Option<Vec<(f64, f64)>> {
    let ring = |n: u32, center: bool| -> Vec<(f64, f64)> {
        let mut v = if center { vec![(0.0, 0.0)] } else { Vec::new() };
        // Adjacent ring members one unit apart (center ring: unit radius).
        let r = if center || n < 2 {
            1.0
        } else {
            0.5 / (PI / f64::from(n)).sin()
        };
        v.extend((0..n).map(|i| {
            let a = PI / 2.0 + TAU * f64::from(i) / f64::from(n);
            (r * a.cos(), r * a.sin())
        }));
        v
    };
    let v = match preset {
        None => {
            if count == 1 {
                vec![(0.0, 0.0)]
            } else {
                ring(count, false)
            }
        }
        Some("2-row") => vec![(-0.5, 0.0), (0.5, 0.0)],
        Some("3-ring") => ring(3, false),
        Some("4-square") => vec![(-0.5, 0.5), (0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)],
        Some("5-cross") => vec![(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)],
        Some("6-ring") => ring(6, false),
        Some("7-hex") => ring(6, true),
        Some(_) => return None,
    };
    (v.len() == count as usize).then_some(v)
}

/// Cluster preset names (for hints).
pub const CLUSTER_PRESETS: &[&str] = &["2-row", "3-ring", "4-square", "5-cross", "6-ring", "7-hex"];

fn is_fin_set(s: &EvalShape) -> Option<u32> {
    match s {
        EvalShape::TrapezoidalFinSet { fins, .. }
        | EvalShape::EllipticalFinSet { fins, .. }
        | EvalShape::FreeformFinSet { fins, .. } => Some(fins.count),
        EvalShape::TubeFinSet { count, .. } => Some(*count),
        _ => None,
    }
}

fn instances(id: &str, c: &Component, shape: &EvalShape, f: &mut Fields) -> Vec<EvalInstance> {
    let one = |pattern, offset, roll, index| EvalInstance {
        index,
        pattern,
        offset,
        roll,
    };
    let Some(ins) = &c.instances else {
        if let Some(n) = is_fin_set(shape) {
            let n = n.max(1);
            return (0..n)
                .map(|i| {
                    one(
                        Some(InstancePattern::Radial),
                        [0.0; 3],
                        TAU * f64::from(i) / f64::from(n),
                        i,
                    )
                })
                .collect();
        }
        return vec![one(None, [0.0; 3], 0.0, 0)];
    };
    let b = format!("c.{id}.instances");
    let n = ins.count.max(1);
    let start = f.opt(ins.start.as_ref(), &format!("{b}.start"), 0.0);
    let bad = |f: &mut Fields, msg: String, hint: &str| {
        f.diags.push(
            Diagnostic::new(diag::E_INSTANCES, format!("/c/{id}/instances"), msg)
                .with_hint(hint.to_string()),
        );
    };
    match ins.pattern {
        InstancePattern::Radial => (0..n)
            .map(|i| {
                one(
                    Some(InstancePattern::Radial),
                    [0.0; 3],
                    start + TAU * f64::from(i) / f64::from(n),
                    i,
                )
            })
            .collect(),
        InstancePattern::Linear => {
            if ins.spacing.is_none() && n > 1 {
                bad(
                    f,
                    format!("`{id}` has a linear pattern without `spacing`"),
                    "add e.g. `spacing = \"500 mm\"`",
                );
            }
            let s = f.opt(ins.spacing.as_ref(), &format!("{b}.spacing"), 0.0);
            (0..n)
                .map(|i| {
                    one(
                        Some(InstancePattern::Linear),
                        [s * f64::from(i), 0.0, 0.0],
                        start,
                        i,
                    )
                })
                .collect()
        }
        InstancePattern::Cluster => {
            if ins.scale.is_none() && n > 1 {
                bad(
                    f,
                    format!("`{id}` has a cluster pattern without `scale`"),
                    "add the center distance, e.g. `scale = \"30 mm\"`",
                );
            }
            let s = f.opt(ins.scale.as_ref(), &format!("{b}.scale"), 0.0);
            let pos = cluster_positions(ins.preset.as_deref(), n).unwrap_or_else(|| {
                bad(
                    f,
                    format!(
                        "`{id}`: cluster preset {:?} does not fit count {n}",
                        ins.preset.as_deref().unwrap_or("")
                    ),
                    &format!(
                        "presets: {}; or omit `preset` for a ring of `count`",
                        CLUSTER_PRESETS.join(", ")
                    ),
                );
                cluster_positions(None, n).unwrap_or_default()
            });
            pos.into_iter()
                .zip(0..)
                .map(|((y, z), i)| {
                    one(
                        Some(InstancePattern::Cluster),
                        [0.0, s * y, s * z],
                        start,
                        i,
                    )
                })
                .collect()
        }
    }
}

/// A child's instances repeated in every instance of its parent: the
/// parent instance's placement (its offset plus its radial distance rolled
/// to the instance roll) adds to the child's offset, rolls add, patterns
/// follow the parent (index = parent-major).
fn replicate(
    parent: &[EvalInstance],
    radial: f64,
    roll: f64,
    own: &[EvalInstance],
) -> Vec<EvalInstance> {
    parent
        .iter()
        .flat_map(|p| {
            let a = roll + p.roll;
            let (y, z) = (radial * a.cos(), radial * a.sin());
            own.iter().map(move |o| EvalInstance {
                index: 0,
                pattern: p.pattern.or(o.pattern),
                offset: [
                    p.offset[0] + o.offset[0],
                    p.offset[1] + o.offset[1] + y,
                    p.offset[2] + o.offset[2] + z,
                ],
                roll: p.roll + o.roll,
            })
        })
        .zip(0..)
        .map(|(mut e, i)| {
            e.index = i;
            e
        })
        .collect()
}

fn surface_radial(shape: &EvalShape, parent_r: f64) -> f64 {
    match shape {
        EvalShape::LaunchLug { od, .. } => parent_r + od / 2.0,
        _ if is_fin_set(shape).is_some() => 0.0,
        _ => parent_r,
    }
}

fn find<'a>(rel: &'a [RelAnchor], name: &str) -> Option<&'a RelAnchor> {
    rel.iter().find(|a| a.name == name)
}

/// The outer diameter that counts for the reference diameter.
fn body_diameter(s: &EvalShape) -> f64 {
    match s {
        EvalShape::NoseCone { od, .. } | EvalShape::BodyTube { od, .. } => *od,
        EvalShape::Transition {
            fore_od, aft_od, ..
        } => fore_od.max(*aft_od),
        _ => 0.0,
    }
}

pub(crate) fn typed_map<T: serde::de::DeserializeOwned>(
    value: &Value,
    coll: &str,
    diags: &mut Vec<Diagnostic>,
) -> BTreeMap<String, T> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(m)) = value.get(coll) {
        for (id, v) in m {
            match serde_json::from_value::<T>(v.clone()) {
                Ok(t) => {
                    out.insert(id.clone(), t);
                }
                Err(e) => diags.push(Diagnostic::new(
                    diag::E_SCHEMA,
                    format!("/{coll}/{id}"),
                    e.to_string(),
                )),
            }
        }
    }
    out
}

/// A `[stage.<id>] override`: mass and CG of the whole stage (its members'
/// dry parts; motors excluded). A stage owns no mass of its own, so the
/// override must cover its subcomponents, and a CD override is not modelled.
/// The CG is returned relative to the stage's fore end.
fn stage_override(sid: &str, o: &Overrides, fields: &mut Fields) -> Option<EvalOverride> {
    let path = format!("/stage/{sid}/override");
    let bad = |fields: &mut Fields, msg: String, hint: &str| {
        fields
            .diags
            .push(Diagnostic::new(diag::E_STAGE, path.clone(), msg).with_hint(hint.to_string()));
    };
    if !o.subtree {
        bad(
            fields,
            format!("stage `{sid}` override must cover its subcomponents"),
            "a stage owns no mass; set `subtree = true`",
        );
        return None;
    }
    if o.cd.is_some() {
        bad(
            fields,
            format!("stage `{sid}` override sets `cd`, which a stage does not take"),
            "override `cd` on the stage's components",
        );
    }
    let b = format!("stage.{sid}.override");
    Some(EvalOverride {
        mass: o.mass.as_ref().map(|q| fields.at(q, &format!("{b}.mass"))),
        cg: o.cg.as_ref().map(|q| fields.at(q, &format!("{b}.cg"))),
        cd: None,
        subtree: true,
    })
}

fn needs_sim(expr: &str) -> bool {
    let root: String = expr
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    !STATIC_ROOTS.contains(&root.as_str())
}

/// Evaluates parsed source documents into the SI [`EvaluatedModel`] (IF2).
pub fn eval(sources: &SourceSet, opts: &EvalOptions) -> EvaluatedModel {
    let (mv, origins, mut diags) = merge(sources);
    let base_value = mv.0;
    let mut value = base_value.clone();
    apply_overrides(&mut value, opts.variant.as_deref(), &opts.set, &mut diags);
    let rocket: RocketDoc = match serde_json::from_value(value.clone()) {
        Ok(r) => r,
        Err(e) => {
            if value != base_value {
                diags.push(
                    Diagnostic::new(
                        diag::E_SET,
                        None,
                        format!("the overrides make the model invalid: {e}"),
                    )
                    .with_hint("check the values given with --set or in the variant"),
                );
                value = base_value.clone();
            }
            serde_json::from_value(value.clone()).unwrap_or_default()
        }
    };
    let manifest: Option<ProjectManifest> = value
        .get("project")
        .and_then(|p| serde_json::from_value(p.clone()).ok());

    let mut fields = Fields::new(Scope::new(&value));
    let params = eval_params(&value, &mut fields.scope, &mut diags);
    let tree: Tree = attach::derive(&rocket.c, &mut diags);

    // ---- shapes and placement, targets first
    let mut placed: BTreeMap<String, Placed> = BTreeMap::new();
    for id in &tree.order {
        let node = &tree.nodes[id];
        let c = &rocket.c[id];
        let pinfo = node
            .parent
            .as_ref()
            .and_then(|p| placed.get(p))
            .map(|p| ParentInfo {
                inner_r: inner_radius(&p.shape),
            })
            .unwrap_or_default();
        let shape = eval_shape(id, c, &mut fields, pinfo);
        let b = format!("c.{id}");
        let att = c.attach.as_ref();
        let offset = fields.opt(
            att.and_then(|a| a.offset.as_ref()),
            &format!("{b}.attach.offset"),
            0.0,
        );
        let roll = fields.opt(
            att.and_then(|a| a.spin.as_ref()),
            &format!("{b}.attach.spin"),
            0.0,
        );
        let ov = c.overrides.as_ref();
        let cg_dx = ov
            .and_then(|o| o.cg.as_ref())
            .map(|q| fields.at(q, &format!("{b}.override.cg")));
        let own = anchors(&shape, 0.0, cg_dx);
        let mut x_fore = 0.0;
        let mut eval_attach = None;
        if let (Some((tid, tanchor)), Some(at)) = (&node.target, &node.at) {
            let t = &placed[tid];
            let tx = match find(&t.rel, tanchor) {
                Some(a) => t.x_fore + a.dx,
                None => {
                    fields.diags.push(
                        Diagnostic::new(
                            diag::E_ATTACH_ANCHOR,
                            format!("/c/{id}/attach/to"),
                            format!("`{tid}` has no `{tanchor}` anchor as built (no shoulder, tab, or that fin)"),
                        )
                        .with_hint(format!(
                            "anchors of `{tid}`: {}",
                            t.rel.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
                        )),
                    );
                    t.x_fore
                }
            };
            let own_dx = match find(&own, at) {
                Some(a) => a.dx,
                None => {
                    fields.diags.push(Diagnostic::new(
                        diag::E_ATTACH_AT,
                        format!("/c/{id}/attach/at"),
                        format!("`{id}` has no `{at}` anchor as built"),
                    ));
                    0.0
                }
            };
            x_fore = tx + offset - own_dx;
            eval_attach = Some(EvalAttach {
                to: format!("{tid}.{tanchor}"),
                at: at.clone(),
                offset,
            });
        }
        let parent_r = node
            .parent
            .as_ref()
            .and_then(|p| placed.get(p))
            .map_or(0.0, |p| outer_radius_at(&p.shape, x_fore - p.x_fore));
        let rel = anchors(&shape, parent_r, cg_dx);
        let parent_inner = node
            .parent
            .as_ref()
            .and_then(|p| placed.get(p))
            .map_or(0.0, |p| inner_radius(&p.shape));
        let radial = match att.and_then(|a| a.radial.as_ref()) {
            Some(Radial::Keyword(RadialKeyword::Axis)) => 0.0,
            Some(Radial::Keyword(RadialKeyword::Outer)) => surface_radial(&shape, parent_r),
            Some(Radial::Keyword(RadialKeyword::Inner)) => {
                (parent_inner - outer_radius_at(&shape, 0.0)).max(0.0)
            }
            Some(Radial::Radius(q)) => fields.at(q, &format!("{b}.attach.radial")),
            None if node.containment == AnchorKind::Surface => surface_radial(&shape, parent_r),
            None => 0.0,
        };
        let inst = instances(id, c, &shape, &mut fields);
        // Inside an instanced parent (a clustered motor tube), a part repeats
        // in every parent instance (M2.2).
        let inst = match node.parent.as_ref().and_then(|p| placed.get(p)) {
            Some(p) if node.containment == AnchorKind::Inner && p.instances.len() > 1 => {
                replicate(&p.instances, p.radial, p.roll, &inst)
            }
            _ => inst,
        };
        let overrides = ov.map(|o| EvalOverride {
            mass: o
                .mass
                .as_ref()
                .map(|q| fields.at(q, &format!("{b}.override.mass"))),
            cg: cg_dx.map(|d| x_fore + d),
            cd: o
                .cd
                .as_ref()
                .map(|q| fields.at(q, &format!("{b}.override.cd"))),
            subtree: o.subtree,
        });
        if c.cut && node.parent.is_none() {
            fields.diags.push(
                Diagnostic::new(
                    diag::E_CUT,
                    format!("/c/{id}/cut"),
                    format!("`{id}` is a cut with nothing to cut from"),
                )
                .with_hint("attach the cut to the component it removes material from"),
            );
        }
        placed.insert(
            id.clone(),
            Placed {
                shape,
                x_fore,
                rel,
                parent_r,
                radial,
                roll,
                attach: eval_attach,
                instances: inst,
                overrides,
            },
        );
    }

    // ---- tree order: depth first, children by station then id
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in placed.keys() {
        let mut ch: Vec<String> = tree.children(id).into_iter().map(str::to_string).collect();
        ch.sort_by(|a, b| {
            placed[a]
                .x_fore
                .total_cmp(&placed[b].x_fore)
                .then_with(|| a.cmp(b))
        });
        children.insert(id.clone(), ch);
    }
    let mut dfs: Vec<String> = Vec::new();
    let mut stack: Vec<String> = tree.roots.iter().rev().cloned().collect();
    while let Some(id) = stack.pop() {
        if dfs.contains(&id) || !placed.contains_key(&id) {
            continue;
        }
        stack.extend(children[&id].iter().rev().cloned());
        dfs.push(id);
    }

    // ---- body chain and stages
    let primary = tree.roots.first().cloned();
    let mut chain: Vec<String> = Vec::new();
    if let Some(root) = &primary {
        let mut q = vec![root.clone()];
        while let Some(id) = q.pop() {
            chain.push(id.clone());
            for ch in &children[&id] {
                if tree.nodes[ch].containment == AnchorKind::Axial {
                    q.push(ch.clone());
                }
            }
        }
    }
    chain.sort_by(|a, b| {
        placed[a]
            .x_fore
            .total_cmp(&placed[b].x_fore)
            .then_with(|| a.cmp(b))
    });
    let mut firsts: BTreeMap<String, String> = BTreeMap::new(); // first component -> stage id
    for (sid, def) in &rocket.stage {
        if chain.contains(&def.first) {
            firsts.insert(def.first.clone(), sid.clone());
        } else {
            diags.push(
                Diagnostic::new(
                    diag::E_STAGE,
                    format!("/stage/{sid}/first"),
                    format!(
                        "stage `{sid}` starts at `{}`, which is not on the body chain",
                        def.first
                    ),
                )
                .with_hint(format!("use a body component id: {}", chain.join(", "))),
            );
        }
    }
    let implicit = firsts.is_empty();
    let mut chain_stage: BTreeMap<String, String> = BTreeMap::new();
    let mut stage_order: Vec<String> = Vec::new();
    if !chain.is_empty() {
        let mut cur = if implicit {
            IMPLICIT_STAGE.to_string()
        } else {
            chain
                .iter()
                .find_map(|c| firsts.get(c).cloned())
                .unwrap_or_default()
        };
        stage_order.push(cur.clone());
        for c in &chain {
            if let Some(s) = firsts.get(c)
                && *s != cur
            {
                cur = s.clone();
                stage_order.push(cur.clone());
            }
            chain_stage.insert(c.clone(), cur.clone());
        }
    }
    let stage_of = |id: &str| -> Option<String> {
        let mut cur = Some(id.to_string());
        while let Some(c) = cur {
            if let Some(s) = chain_stage.get(&c) {
                return Some(s.clone());
            }
            cur = tree.nodes.get(&c).and_then(|n| n.parent.clone());
        }
        None
    };

    let mut components = Vec::new();
    for id in &dfs {
        let p = &placed[id];
        let node = &tree.nodes[id];
        let c = &rocket.c[id];
        let roughness = components::finish::eval_roughness(id, c.finish.as_ref(), &mut fields);
        let aero = matches!(node.containment, AnchorKind::Axial | AnchorKind::Surface) && !c.cut;
        components.push(EvalComponent {
            id: id.clone(),
            name: c.name.clone().unwrap_or_else(|| id.clone()),
            parent: node.parent.clone(),
            children: children[id].clone(),
            stage: stage_of(id),
            containment: node.containment,
            aero,
            cut: c.cut,
            x_fore: p.x_fore,
            x_aft: p.x_fore + extent(&p.shape),
            radial: p.radial,
            roll: p.roll,
            attach: p.attach.clone(),
            instances: p.instances.clone(),
            anchors: p
                .rel
                .iter()
                .map(|a| EvalAnchor {
                    name: a.name.clone(),
                    kind: a.kind,
                    x: p.x_fore + a.dx,
                    r: a.r,
                })
                .collect(),
            material: c.material.clone(),
            roughness,
            appearance: c.appearance.clone(),
            joint: c.joint.clone(),
            overrides: p.overrides.clone(),
            shape: p.shape.clone(),
        });
        let _ = p.parent_r;
    }

    let mut stages = Vec::new();
    for sid in &stage_order {
        let overrides = rocket
            .stage
            .get(sid)
            .and_then(|d| d.overrides.as_ref())
            .and_then(|o| stage_override(sid, o, &mut fields));
        let (name, first) = match rocket.stage.get(sid) {
            Some(def) => (
                def.name.clone().unwrap_or_else(|| sid.clone()),
                def.first.clone(),
            ),
            None => ("Main".to_string(), primary.clone().unwrap_or_default()),
        };
        let axial: Vec<&String> = chain
            .iter()
            .filter(|c| chain_stage.get(*c) == Some(sid))
            .collect();
        let x_fore = axial
            .iter()
            .map(|c| placed[*c].x_fore)
            .fold(f64::INFINITY, f64::min);
        let x_aft = axial
            .iter()
            .map(|c| placed[*c].x_fore + extent(&placed[*c].shape))
            .fold(f64::NEG_INFINITY, f64::max);
        stages.push(EvalStage {
            id: sid.clone(),
            name,
            first,
            members: components
                .iter()
                .filter(|c| c.stage.as_deref() == Some(sid))
                .map(|c| c.id.clone())
                .collect(),
            x_fore: if x_fore.is_finite() { x_fore } else { 0.0 },
            x_aft: if x_aft.is_finite() { x_aft } else { 0.0 },
            overrides: overrides.map(|mut o| {
                // The CG is given from the stage's fore end.
                o.cg =
                    o.cg.map(|d| d + if x_fore.is_finite() { x_fore } else { 0.0 });
                o
            }),
        });
    }

    // ---- reference dimensions
    let diameter = chain
        .iter()
        .map(|c| body_diameter(&placed[c].shape))
        .fold(0.0, f64::max);
    let lo = chain
        .iter()
        .map(|c| placed[c].x_fore)
        .fold(f64::INFINITY, f64::min);
    let hi = chain
        .iter()
        .map(|c| placed[c].x_fore + extent(&placed[c].shape))
        .fold(f64::NEG_INFINITY, f64::max);
    let reference = Reference {
        length: if lo.is_finite() && hi.is_finite() {
            hi - lo
        } else {
            0.0
        },
        diameter,
        area: PI * diameter * diameter / 4.0,
    };

    // ---- configurations and simulations
    let config_docs: BTreeMap<String, ConfigDoc> = typed_map(&value, "configs", &mut diags);
    let configs =
        components::config::eval_configs(&config_docs, &components, &stage_order, &mut fields);
    let sims = components::sim::eval_sims(&value, &configs, &mut fields, &mut diags);

    // ---- materials, asserts, report
    let mut materials = BTreeMap::new();
    let mut unit_dims: BTreeMap<&'static str, DimKind> = BTreeMap::new();
    let add_dim = |m: &mut BTreeMap<&'static str, DimKind>, k: DimKind| {
        m.insert(k.name(), k);
    };
    for k in [
        DimKind::Length,
        DimKind::Mass,
        DimKind::Time,
        DimKind::Angle,
        DimKind::Area,
    ] {
        add_dim(&mut unit_dims, k);
    }
    for (name, m) in &rocket.materials {
        let p = format!("/materials/{name}");
        let em = EvalMaterial {
            density: m
                .density
                .as_ref()
                .map(|q| fields.q(q, None, &format!("{p}/density"))),
            surface_density: m
                .surface_density
                .as_ref()
                .map(|q| fields.q(q, None, &format!("{p}/surface_density"))),
            line_density: m
                .line_density
                .as_ref()
                .map(|q| fields.q(q, None, &format!("{p}/line_density"))),
            yield_strength: m
                .yield_strength
                .as_ref()
                .map(|q| fields.q(q, None, &format!("{p}/yield_strength"))),
        };
        if em.density.is_some() {
            add_dim(&mut unit_dims, DimKind::Density);
        }
        if em.surface_density.is_some() {
            add_dim(&mut unit_dims, DimKind::AreaDensity);
        }
        if em.line_density.is_some() {
            add_dim(&mut unit_dims, DimKind::LineDensity);
        }
        materials.insert(name.clone(), em);
    }
    if components
        .iter()
        .any(|c| matches!(c.shape, EvalShape::Tank { .. }))
    {
        add_dim(&mut unit_dims, DimKind::Volume);
    }

    // ---- liquid engines (M4.4)
    let engine_docs: BTreeMap<String, EngineDoc> = typed_map(&value, "engines", &mut diags);
    let (engines, engine_rules) = components::engine::eval_engines(
        &engine_docs,
        &rocket,
        &components,
        &materials,
        &mut fields,
    );
    if !engines.is_empty() {
        for k in [
            DimKind::Volume,
            DimKind::Pressure,
            DimKind::Force,
            DimKind::Area,
        ] {
            add_dim(&mut unit_dims, k);
        }
    }
    for p in params.values() {
        if p.dim != DimKind::Dimensionless {
            add_dim(&mut unit_dims, p.dim);
        }
    }
    let asserts = rocket
        .asserts
        .iter()
        .map(|a| EvalAssert {
            id: a.id.clone(),
            expr: a.expr.clone(),
            severity: a.severity.unwrap_or(Severity::Error),
            message: a.message.clone(),
            needs_sim: needs_sim(&a.expr),
        })
        .collect();

    let config = opts
        .config
        .clone()
        .or_else(|| manifest.as_ref().and_then(|m| m.default_config.clone()));
    if let Some(c) = &config
        && !configs.contains_key(c)
    {
        diags.push(
            Diagnostic::new(
                diag::E_CONFIG,
                format!("/configs/{c}"),
                format!("configuration `{c}` does not exist"),
            )
            .with_hint(format!(
                "configs: {}",
                configs.keys().cloned().collect::<Vec<_>>().join(", ")
            )),
        );
    }

    diags.append(&mut fields.diags);

    // ---- per-kind rules (M1.24). A field that already failed to evaluate
    // has its diagnostic; its 0 placeholder is not reported again.
    let failed: BTreeSet<String> = diags.iter().filter_map(|d| d.path.clone()).collect();
    let mut rules = components::material::check_defs(&rocket.materials, &materials);
    rules.extend(engine_rules);
    rules.extend(components::engine::check_config_refs(&configs, &engines));
    rules.extend(components::sim::check_visual_refs(&sims, &engines));
    for e in &components {
        if let Some(src) = rocket.c.get(&e.id) {
            rules.extend(components::validate(src, e, &materials));
        }
    }
    diags.extend(
        rules
            .into_iter()
            .filter(|d| d.path.as_ref().is_none_or(|p| !failed.contains(p))),
    );

    let mut seen = BTreeSet::new();
    diags.retain(|d| seen.insert((d.code.clone(), d.path.clone(), d.message.clone())));
    for d in &mut diags {
        if d.file.is_none()
            && let Some(p) = &d.path
        {
            d.file = origins.file_of(p).map(str::to_string);
        }
    }

    let mut model = EvaluatedModel {
        schema: SchemaTag,
        model_hash: String::new(),
        name: manifest
            .as_ref()
            .map(|m| m.name.clone())
            .or_else(|| rocket.name.clone())
            .unwrap_or_else(|| "rocket".to_string()),
        config,
        variant: opts.variant.clone(),
        reference,
        params,
        components,
        stages,
        configs,
        sims,
        materials,
        asserts,
        engines,
        report: rocket
            .report
            .as_ref()
            .map(|r| r.values.clone())
            .unwrap_or_default(),
        units: unit_dims
            .into_values()
            .map(|k| (k.name().to_string(), k.si_unit().to_string()))
            .collect(),
        diagnostics: diags,
    };
    model.model_hash = model_hash(&model);
    model
}

/// blake3 hex of the canonical JSON of the model with an empty `model_hash`.
/// Source comments and formatting never reach the model, so they cannot change it.
pub fn model_hash(m: &EvaluatedModel) -> String {
    let mut m = m.clone();
    m.model_hash = String::new();
    let bytes = serde_json::to_vec(&m).unwrap_or_default();
    blake3::hash(&bytes).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::parse_source_with_warnings;

    /// The tiny hand-written project under `tests/fixtures/simple/`.
    const SIMPLE: &[(&str, &str)] = &[
        (
            "rocketwright.toml",
            include_str!("../tests/fixtures/simple/rocketwright.toml"),
        ),
        (
            "rocket.rw.toml",
            include_str!("../tests/fixtures/simple/rocket.rw.toml"),
        ),
        (
            "parts/fin_can.rw.toml",
            include_str!("../tests/fixtures/simple/parts/fin_can.rw.toml"),
        ),
        (
            "configs/baseline.rw.toml",
            include_str!("../tests/fixtures/simple/configs/baseline.rw.toml"),
        ),
        (
            "sims/baseline.rw.toml",
            include_str!("../tests/fixtures/simple/sims/baseline.rw.toml"),
        ),
    ];
    const GOLDEN: &str = include_str!("../tests/fixtures/simple.eval.json");

    fn load(files: &[(&str, &str)]) -> SourceSet {
        let mut s = SourceSet::default();
        for (p, t) in files {
            let (d, w) = parse_source_with_warnings(p, t).unwrap_or_else(|e| panic!("{p}: {e:?}"));
            assert!(w.is_empty(), "{p}: {w:?}");
            s.docs.insert((*p).to_string(), d);
        }
        s
    }

    fn comp<'a>(m: &'a EvaluatedModel, id: &str) -> &'a EvalComponent {
        m.components.iter().find(|c| c.id == id).unwrap()
    }

    #[allow(clippy::disallowed_methods)] // test-only golden blessing
    fn bless(text: &str) {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/simple.eval.json"
        );
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn golden_simple() {
        let m = eval(&load(SIMPLE), &EvalOptions::default());
        let text = serde_json::to_string_pretty(&m).unwrap() + "\n";
        if std::env::var_os("RW_BLESS").is_some() {
            bless(&text);
            return;
        }
        assert!(m.diagnostics.is_empty(), "{:#?}", m.diagnostics);
        assert_eq!(
            text, GOLDEN,
            "rerun with RW_BLESS=1 to update the golden after checking the diff"
        );
        // The golden parses back as the contract type.
        let back: EvaluatedModel = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(back.components.len(), m.components.len());
    }

    #[test]
    fn simple_placement_and_tree() {
        let m = eval(&load(SIMPLE), &EvalOptions::default());
        let ids: Vec<&str> = m.components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids[0], "nose");
        let body = comp(&m, "body");
        assert_eq!((body.x_fore, body.parent.as_deref()), (0.15, Some("nose")));
        let fins = comp(&m, "fins");
        assert!(
            (fins.x_aft - 0.55).abs() < 1e-12,
            "fins end at the body aft"
        );
        assert_eq!(fins.instances.len(), 3);
        assert_eq!(fins.containment, AnchorKind::Surface);
        assert!(fins.aero);
        let mount = comp(&m, "mount");
        assert_eq!((mount.containment, mount.aero), (AnchorKind::Inner, false));
        let ring = comp(&m, "ring");
        assert_eq!(ring.parent.as_deref(), Some("body"));
        let EvalShape::CenteringRing { od, .. } = ring.shape else {
            panic!()
        };
        assert!(
            (od - 0.0398).abs() < 1e-12,
            "ring OD defaults to the body bore"
        );
        // span = params.span (variant-free) = 50 mm
        let EvalShape::TrapezoidalFinSet { span, .. } = fins.shape else {
            panic!()
        };
        assert!((span - 0.05).abs() < 1e-12);
        assert_eq!(m.stages.len(), 1);
        assert_eq!(m.stages[0].members.len(), m.components.len());
        assert!((m.reference.diameter - 0.0416).abs() < 1e-12);
        assert!((m.reference.length - 0.55).abs() < 1e-12);
        assert_eq!(m.config.as_deref(), Some("baseline"));
        assert_eq!(m.configs["baseline"].motors[0].delay, Some(5.0));
        assert_eq!(m.sims["baseline"].conditions.rail_length_m, 1.5);
    }

    #[test]
    fn variant_and_set_change_values_and_hash() {
        let s = load(SIMPLE);
        let base = eval(&s, &EvalOptions::default());
        let long = eval(
            &s,
            &EvalOptions {
                variant: Some("long_fins".into()),
                ..Default::default()
            },
        );
        let span = |m: &EvaluatedModel| match comp(m, "fins").shape {
            EvalShape::TrapezoidalFinSet { span, .. } => span,
            _ => unreachable!(),
        };
        assert!((span(&long) - 0.07).abs() < 1e-12);
        assert_ne!(base.model_hash, long.model_hash);
        let set = eval(
            &s,
            &EvalOptions {
                set: BTreeMap::from([("params.span".into(), "60 mm".into())]),
                ..Default::default()
            },
        );
        assert!((span(&set) - 0.06).abs() < 1e-12);
        assert!(set.diagnostics.is_empty(), "{:?}", set.diagnostics);
    }

    #[test]
    fn hash_ignores_comments_and_formatting() {
        let s = load(SIMPLE);
        let mut files: Vec<(&str, String)> =
            SIMPLE.iter().map(|(p, t)| (*p, t.to_string())).collect();
        files[1].1 = format!("# a comment\n\n{}", files[1].1.replace(" = ", "   =   "));
        let mut s2 = SourceSet::default();
        for (p, t) in &files {
            s2.docs
                .insert((*p).to_string(), crate::parse_source(p, t).unwrap());
        }
        assert_eq!(
            eval(&s, &EvalOptions::default()).model_hash,
            eval(&s2, &EvalOptions::default()).model_hash
        );
    }

    fn model(rocket: &str) -> EvaluatedModel {
        let mut s = SourceSet::default();
        s.docs.insert(
            "rocket.rw.toml".into(),
            crate::parse_source("rocket.rw.toml", rocket).unwrap(),
        );
        eval(&s, &EvalOptions::default())
    }

    fn codes(m: &EvaluatedModel) -> Vec<(String, String)> {
        m.diagnostics
            .iter()
            .map(|d| (d.code.clone(), d.path.clone().unwrap_or_default()))
            .collect()
    }

    #[test]
    fn errors_become_diagnostics_at_their_fields() {
        let m = model(
            r#"
[params.a]
value = "= params.b"
[params.b]
value = "= params.a"

[c.body]
type = "body_tube"
length = "= params.a"
od = 54

[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 3
root_chord = "= c.body.od * 2 kg"
tip_chord = "30 mm"
span = "40 mm"
sweep = "20 mm"
thickness = "3 mm"

[c.lug]
type = "launch_lug"
attach = { to = "body.inner" }
length = "30 mm"
od = "5 mm"
"#,
        );
        let got = codes(&m);
        for want in [
            ("RW-E042", "/params/a/value"),
            ("RW-E042", "/c/body/length"),
            ("RW-E021", "/c/body/od"),
            ("RW-E043", "/c/fins/root_chord"),
            ("RW-E030", "/c/lug/attach/to"),
        ] {
            assert!(
                got.contains(&(want.0.into(), want.1.into())),
                "missing {want:?} in {got:?}"
            );
        }
        assert!(
            m.diagnostics
                .iter()
                .all(|d| d.file.as_deref() == Some("rocket.rw.toml"))
        );
    }

    #[test]
    fn stages_split_the_body_chain() {
        let m = model(
            r#"
[stage.sustainer]
first = "nose"
[stage.booster]
first = "booster"

[c.nose]
type = "nose_cone"
shape = "conical"
length = "100 mm"
od = "40 mm"
[c.upper]
type = "body_tube"
attach = { to = "nose.base" }
length = "200 mm"
od = "40 mm"
[c.chute]
type = "parachute"
attach = { to = "upper.inner" }
diameter = "300 mm"
cd = 0.8
packed_length = "50 mm"
packed_diameter = "30 mm"
[c.booster]
type = "body_tube"
attach = { to = "upper.aft" }
length = "150 mm"
od = "40 mm"
[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "booster.aft", at = "root_te", offset = "-5 mm", spin = "45 deg" }
count = 4
root_chord = "50 mm"
tip_chord = "20 mm"
span = "30 mm"
sweep = "25 mm"
thickness = "2 mm"
"#,
        );
        assert!(m.diagnostics.is_empty(), "{:?}", m.diagnostics);
        let ids: Vec<&str> = m.stages.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["sustainer", "booster"]);
        assert_eq!(m.stages[0].members, ["nose", "upper", "chute"]);
        assert_eq!(m.stages[1].members, ["booster", "fins"]);
        assert!(
            (m.stages[1].x_fore - 0.3).abs() < 1e-12 && (m.stages[1].x_aft - 0.45).abs() < 1e-12
        );
        let fins = comp(&m, "fins");
        assert!((fins.x_fore - 0.395).abs() < 1e-12);
        assert!((fins.roll - PI / 4.0).abs() < 1e-12);
        assert_eq!(
            fins.anchors
                .iter()
                .filter(|a| a.name.starts_with("fin"))
                .count(),
            4
        );
    }

    #[test]
    fn stage_override_evaluates_from_the_stage_fore_end() {
        let src = |ov: &str| {
            format!(
                r#"
[stage.sustainer]
first = "nose"
[stage.booster]
first = "booster"
override = {ov}

[c.nose]
type = "nose_cone"
shape = "conical"
length = "100 mm"
od = "40 mm"
[c.booster]
type = "body_tube"
attach = {{ to = "nose.base" }}
length = "150 mm"
od = "40 mm"
"#
            )
        };
        let m = model(&src(r#"{ mass = "300 g", cg = "50 mm", subtree = true }"#));
        assert!(m.diagnostics.is_empty(), "{:?}", m.diagnostics);
        assert!(m.stages[0].overrides.is_none());
        let o = m.stages[1].overrides.as_ref().unwrap();
        assert!((o.mass.unwrap() - 0.3).abs() < 1e-12);
        assert!((o.cg.unwrap() - 0.15).abs() < 1e-12 && o.subtree);
        // A stage owns no mass: an override that leaves out its parts is an error.
        let m = model(&src(r#"{ mass = "300 g" }"#));
        assert!(m.stages[1].overrides.is_none());
        assert!(
            m.diagnostics
                .iter()
                .any(|d| d.code == diag::E_STAGE
                    && d.path.as_deref() == Some("/stage/booster/override")),
            "{:?}",
            m.diagnostics
        );
    }

    #[test]
    fn instances_overrides_and_cut() {
        let m = model(
            r#"
[c.body]
type = "body_tube"
length = "1 m"
od = "100 mm"
thickness = "2 mm"
[c.buttons]
type = "rail_button"
attach = { to = "body.outer", offset = "200 mm" }
instances = { count = 2, pattern = "linear", spacing = "500 mm" }
od = "10 mm"
id = "6 mm"
height = "8 mm"
[c.mounts]
type = "inner_tube"
attach = { to = "body.aft", at = "aft" }
instances = { count = 3, pattern = "cluster", preset = "3-ring", scale = "30 mm" }
length = "100 mm"
od = "25 mm"
motor_mount = true
[c.pods]
type = "launch_lug"
attach = { to = "body.outer" }
instances = { count = 2, pattern = "radial", start = "90 deg" }
length = "50 mm"
od = "10 mm"
[c.payload]
type = "mass_component"
attach = { to = "body.inner", offset = "100 mm" }
mass = "250 g"
length = "80 mm"
override = { cg = "20 mm", subtree = true }
[c.slot]
type = "launch_lug"
attach = { to = "body.outer" }
cut = true
length = "10 mm"
od = "4 mm"
[c.bad]
type = "inner_tube"
attach = { to = "body.inner" }
instances = { count = 4, pattern = "cluster", preset = "3-ring", scale = "1 mm" }
length = "10 mm"
od = "10 mm"
"#,
        );
        assert_eq!(
            codes(&m),
            vec![("RW-E056".to_string(), "/c/bad/instances".to_string())]
        );
        let b = comp(&m, "buttons");
        assert_eq!(b.instances[1].offset, [0.5, 0.0, 0.0]);
        assert!((b.radial - 0.05).abs() < 1e-12);
        let mounts = comp(&m, "mounts");
        let d01 = {
            let (a, b) = (mounts.instances[0].offset, mounts.instances[1].offset);
            ((a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };
        assert!(
            (d01 - 0.03).abs() < 1e-12,
            "cluster center distance = scale"
        );
        let pods = comp(&m, "pods");
        assert!((pods.instances[1].roll - 1.5 * PI).abs() < 1e-12);
        assert!((pods.radial - 0.055).abs() < 1e-12);
        let p = comp(&m, "payload");
        let o = p.overrides.as_ref().unwrap();
        assert!((o.cg.unwrap() - 0.12).abs() < 1e-12 && o.subtree);
        let cg = p.anchors.iter().find(|a| a.name == "cg").unwrap();
        assert!((cg.x - 0.12).abs() < 1e-12);
        let EvalShape::MassComponent { od, .. } = p.shape else {
            panic!()
        };
        assert!((od - 0.096).abs() < 1e-12, "mass OD defaults to the bore");
        let slot = comp(&m, "slot");
        assert!(slot.cut && !slot.aero);
    }

    #[test]
    fn sibling_and_sweep_positions_follow_anchors() {
        let m = model(
            r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "54 mm"
id = "52 mm"
[c.mount]
type = "inner_tube"
attach = { to = "body.aft", at = "aft", offset = "10 mm" }
length = "100 mm"
od = "30 mm"
[c.ring]
type = "centering_ring"
attach = { to = "mount.fore", at = "fore", offset = "5 mm" }
length = "3 mm"
id = "30 mm"
[c.block]
type = "engine_block"
attach = { to = "mount.inner" }
length = "6 mm"
id = "20 mm"
"#,
        );
        assert!(m.diagnostics.is_empty(), "{:?}", m.diagnostics);
        let mount = comp(&m, "mount");
        assert!(
            (mount.x_fore - 0.21).abs() < 1e-12 && (mount.x_aft - 0.31).abs() < 1e-12,
            "overhang past the aft"
        );
        let ring = comp(&m, "ring");
        assert!((ring.x_fore - 0.215).abs() < 1e-12);
        assert_eq!(ring.parent.as_deref(), Some("body"));
        let block = comp(&m, "block");
        assert_eq!(block.parent.as_deref(), Some("mount"));
        let EvalShape::EngineBlock { od, .. } = block.shape else {
            panic!()
        };
        assert!(
            (od - 0.03).abs() < 1e-12,
            "no id or thickness: the bore is the OD"
        );
        assert_eq!(comp(&m, "body").children, ["mount", "ring"]);
    }

    #[test]
    fn config_and_sim_references_are_checked() {
        let mut s = SourceSet::default();
        let rocket = r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "54 mm"
"#;
        s.docs.insert(
            "rocket.rw.toml".into(),
            crate::parse_source("rocket.rw.toml", rocket).unwrap(),
        );
        s.docs.insert(
            "configs/a.rw.toml".into(),
            crate::parse_source(
                "configs/a.rw.toml",
                "[motors.body]\nmotor = \"generic:RW_C6G\"\n[deploy.body]\nevent = \"apogee\"\n",
            )
            .unwrap(),
        );
        s.docs.insert(
            "sims/s.rw.toml".into(),
            crate::parse_source("sims/s.rw.toml", "config = \"nope\"\n").unwrap(),
        );
        let m = eval(
            &s,
            &EvalOptions {
                config: Some("zz".into()),
                ..Default::default()
            },
        );
        let got = codes(&m);
        for want in [
            ("RW-E059", "/configs/a/motors/body"),
            ("RW-E059", "/configs/a/deploy/body"),
            ("RW-E060", "/sims/s/config"),
            ("RW-E059", "/configs/zz"),
        ] {
            assert!(
                got.contains(&(want.0.into(), want.1.into())),
                "missing {want:?} in {got:?}"
            );
        }
        let d = m
            .diagnostics
            .iter()
            .find(|d| d.path.as_deref() == Some("/sims/s/config"))
            .unwrap();
        assert_eq!(d.file.as_deref(), Some("sims/s.rw.toml"));
        let sim = &m.sims["s"];
        assert_eq!(sim.conditions.rail_length_m, DEFAULT_RAIL_LENGTH);
        assert_eq!(sim.conditions.base_temperature_k, DEFAULT_BASE_TEMPERATURE);
    }

    #[test]
    fn asserts_flag_sim_metrics() {
        assert!(!needs_sim("stability.liftoff >= 1.0 cal"));
        assert!(needs_sim("rail_exit_velocity_ms >= 15 m/s"));
        assert!(needs_sim("apogee_m < 300"));
    }

    #[test]
    fn contract_fixture_source_evaluates() {
        let v: Value =
            serde_json::from_str(include_str!("../../../fixtures/contracts/rocket.json")).unwrap();
        let doc: RocketDoc = serde_json::from_value(v["payload"].clone()).unwrap();
        let mut s = SourceSet::default();
        s.docs
            .insert("rocket.rw.toml".into(), SourceDoc::Rocket(doc));
        let m = eval(&s, &EvalOptions::default());
        assert!(m.diagnostics.is_empty(), "{:#?}", m.diagnostics);
        let fins = comp(&m, "fins");
        assert!((fins.x_fore - 0.7).abs() < 1e-12 && (fins.x_aft - 0.84).abs() < 1e-12);
        assert!((comp(&m, "parachute").x_fore - 0.235).abs() < 1e-12);
        assert!((comp(&m, "avionics").x_fore - 0.36).abs() < 1e-12);
        assert!((m.reference.length - 0.84).abs() < 1e-12);
        assert_eq!(m.stages[0].id, "sustainer");
    }
}

#[cfg(test)]
mod cluster {
    use crate::components::testutil::{assert_clean, comp, on_body};

    #[test]
    fn parts_inside_a_cluster_repeat_per_tube() {
        let m = on_body(
            r#"
[c.mmt]
type = "inner_tube"
attach = { to = "body.aft", at = "aft" }
length = "75 mm"
od = "6 mm"
thickness = "0.5 mm"
motor_mount = true
instances = { count = 3, pattern = "cluster", scale = "8 mm" }

[c.block]
type = "engine_block"
attach = { to = "mmt.inner", at = "fore" }
length = "5 mm"
od = "5 mm"
id = "3 mm"
"#,
        );
        assert_clean(&m);
        let mmt = comp(&m, "mmt");
        let block = comp(&m, "block");
        assert_eq!(mmt.instances.len(), 3);
        assert_eq!(block.instances.len(), 3);
        // Each block sits on its own tube's axis, indices in parent order.
        for (i, (t, b)) in mmt.instances.iter().zip(&block.instances).enumerate() {
            assert_eq!(b.index as usize, i);
            for k in 1..3 {
                assert!((t.offset[k] - b.offset[k]).abs() < 1e-12, "{t:?} {b:?}");
            }
        }
        let r = mmt.instances[1].offset[1].hypot(mmt.instances[1].offset[2]);
        assert!(r > 1e-3, "{r}");
    }
}
