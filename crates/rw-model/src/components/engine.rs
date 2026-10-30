//! Liquid engines (`engines/<id>.rw.toml`, R2.7, M4.4): the engine inputs,
//! the feed graph (`[feed.node.<id>]` of kind `tank|valve|line|engine|sensor`
//! with a station and radial placement, `[[feed.edge]]` with optional
//! waypoints), and tank nodes resolved against `tank` components or an
//! inline `tank` table.
//!
//! Evaluation turns every quantity into SI ([`EvalEngine`]). The rules here
//! are structural: input ranges (`RW-E201`), the feed graph (`RW-E200`), and
//! missing inputs (`RW-W210` fluid model, `RW-W211` edge boundary condition,
//! `RW-W212` anything else the design needs). Design rules that need the
//! thermochemistry (injector pressure-drop band, L*, exit pressure, tank
//! margin, hoop stress) live in `rw-liquid`.

use std::collections::{BTreeMap, BTreeSet};

use rw_units::DimKind;

use super::{Check, show};
use crate::diag::{self, Diagnostic};
use crate::shape::{Fields, tank_volume};
use crate::types::{
    ComponentKind, EdgeBc, EngineDoc, EvalComponent, EvalEngine, EvalFeedEdge, EvalFeedNode,
    EvalFeedPoint, EvalInjector, EvalMaterial, EvalShape, EvalTankSpec, FeedNodeKind, RocketDoc,
    Tank,
};

/// Relative tolerance between a node's `volume` and its tank geometry.
pub const VOLUME_TOL: f64 = 0.01;

fn push(out: &mut Vec<Diagnostic>, code: &str, ptr: String, msg: String, hint: &str) {
    out.push(Diagnostic::new(code, ptr, msg).with_hint(hint.to_string()));
}

fn missing(out: &mut Vec<Diagnostic>, ptr: String, msg: String, hint: &str) {
    push(out, diag::W_ENGINE_INPUT_MISSING, ptr, msg, hint);
}

/// The loaded liquid volume of a tank fill (`volume`, else `fraction` × internal).
fn fill_volume(
    f: &mut Fields,
    t: &Tank,
    base: &str,
    internal: f64,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(fill) = &t.fill else {
        return (None, None, None);
    };
    let frac = fill
        .fraction
        .as_ref()
        .map(|q| f.q(q, None, &format!("{base}/fill/fraction")));
    let vol = fill
        .volume
        .as_ref()
        .map(|q| f.q(q, None, &format!("{base}/fill/volume")));
    let v = vol.or(frac.map(|x| x * internal));
    (v, frac, vol)
}

/// A tank component's geometry, fill, and material as a tank spec.
fn component_tank(
    c: &EvalComponent,
    rocket: &RocketDoc,
    materials: &BTreeMap<String, EvalMaterial>,
    f: &mut Fields,
) -> Option<EvalTankSpec> {
    let EvalShape::Tank {
        length,
        od,
        wall,
        end_cap,
        volume,
        ..
    } = &c.shape
    else {
        return None;
    };
    let src = rocket.c.get(&c.id)?;
    let fill = match &src.kind {
        ComponentKind::Tank(t) => fill_volume(f, t, &format!("/c/{}", c.id), *volume).0,
        _ => None,
    };
    let mat = src.material.clone();
    let m = mat.as_ref().and_then(|n| materials.get(n));
    Some(EvalTankSpec {
        length: *length,
        od: *od,
        wall: *wall,
        end_cap: *end_cap,
        volume: *volume,
        fill_volume: fill,
        material: mat,
        density: m.and_then(|m| m.density),
        yield_strength: m.and_then(|m| m.yield_strength),
    })
}

/// Evaluates every engine document and checks its structure. Returns the
/// engines and the rule findings (unit and expression errors go to `f`).
pub(crate) fn eval_engines(
    docs: &BTreeMap<String, EngineDoc>,
    rocket: &RocketDoc,
    components: &[EvalComponent],
    materials: &BTreeMap<String, EvalMaterial>,
    f: &mut Fields,
) -> (BTreeMap<String, EvalEngine>, Vec<Diagnostic>) {
    let mut engines = BTreeMap::new();
    let mut out = Vec::new();
    for (id, doc) in docs {
        let e = eval_one(id, doc, rocket, components, materials, f, &mut out);
        engines.insert(id.clone(), e);
    }
    (engines, out)
}

#[allow(clippy::too_many_lines)]
fn eval_one(
    id: &str,
    doc: &EngineDoc,
    rocket: &RocketDoc,
    components: &[EvalComponent],
    materials: &BTreeMap<String, EvalMaterial>,
    f: &mut Fields,
    out: &mut Vec<Diagnostic>,
) -> EvalEngine {
    let base = format!("/engines/{id}");
    let p = |n: &str| format!("{base}/{n}");
    let mixture_ratio = f.q(&doc.mixture_ratio, None, &p("mixture_ratio"));
    let chamber_pressure = f.q(&doc.chamber_pressure, None, &p("chamber_pressure"));
    let thrust = f.q(&doc.thrust, None, &p("thrust"));
    let expansion_ratio = doc
        .expansion_ratio
        .as_ref()
        .map(|q| f.q(q, None, &p("expansion_ratio")));
    let exit_pressure = doc
        .exit_pressure
        .as_ref()
        .map(|q| f.q(q, None, &p("exit_pressure")));
    let contraction_ratio = doc
        .contraction_ratio
        .as_ref()
        .map(|q| f.q(q, None, &p("contraction_ratio")));
    let l_star = doc.l_star.as_ref().map(|q| f.q(q, None, &p("l_star")));
    let injector = doc.injector.as_ref().map(|inj| {
        let dp = inj
            .pressure_drop
            .as_ref()
            .map(|q| f.q(q, None, &p("injector/pressure_drop")));
        let frac = inj
            .pressure_drop_fraction
            .as_ref()
            .map(|q| f.q(q, None, &p("injector/pressure_drop_fraction")));
        let cd = inj.cd.as_ref().map(|q| f.q(q, None, &p("injector/cd")));
        if let Some(x) = frac
            && !(x > 0.0 && x < 1.0)
        {
            push(
                out,
                diag::E_ENGINE_INPUT,
                p("injector/pressure_drop_fraction"),
                format!(
                    "engine `{id}`: injector pressure-drop fraction is {x}; it must be in (0, 1)"
                ),
                "give the drop as a fraction of chamber pressure, e.g. 0.2",
            );
        }
        if let Some(c) = cd {
            unit_interval(
                out,
                id,
                &p("injector/cd"),
                "injector discharge coefficient",
                c,
            );
        }
        EvalInjector {
            kind: inj.kind,
            pressure_drop: dp.or(frac.map(|x| x * chamber_pressure)),
            cd,
        }
    });

    // ---- input ranges
    for (field, v, what) in [
        ("mixture_ratio", mixture_ratio, "mixture ratio"),
        ("chamber_pressure", chamber_pressure, "chamber pressure"),
        ("thrust", thrust, "thrust"),
    ] {
        positive(out, id, &p(field), what, v);
    }
    if let Some(v) = expansion_ratio
        && v <= 1.0
    {
        push(
            out,
            diag::E_ENGINE_INPUT,
            p("expansion_ratio"),
            format!("engine `{id}`: expansion ratio {v} must be greater than 1"),
            "Ae/At of a supersonic nozzle, e.g. 4",
        );
    }
    if let Some(v) = exit_pressure
        && !(v > 0.0 && v < chamber_pressure)
    {
        push(
            out,
            diag::E_ENGINE_INPUT,
            p("exit_pressure"),
            format!(
                "engine `{id}`: exit pressure {} must be positive and below the chamber pressure {}",
                show(v, DimKind::Pressure),
                show(chamber_pressure, DimKind::Pressure)
            ),
            "e.g. \"1 atm\" for a sea-level nozzle",
        );
    }
    if let Some(v) = contraction_ratio
        && v <= 1.0
    {
        push(
            out,
            diag::E_ENGINE_INPUT,
            p("contraction_ratio"),
            format!("engine `{id}`: contraction ratio {v} must be greater than 1"),
            "Ac/At, 2 to 5 for pressure-fed engines (SP-125 sec. 4.3)",
        );
    }
    if let Some(v) = l_star {
        positive(out, id, &p("l_star"), "L*", v);
    }
    if let Some(dp) = injector.as_ref().and_then(|i| i.pressure_drop) {
        positive(
            out,
            id,
            &p("injector/pressure_drop"),
            "injector pressure drop",
            dp,
        );
    }

    // ---- feed graph
    let mut nodes = BTreeMap::new();
    let mut edges = Vec::new();
    match &doc.feed {
        None => {}
        Some(feed) => {
            for (nid, n) in &feed.node {
                let nb = format!("{base}/feed/node/{nid}");
                let np = |x: &str| format!("{nb}/{x}");
                let volume = n.volume.as_ref().map(|q| f.q(q, None, &np("volume")));
                let pressure = n.pressure.as_ref().map(|q| f.q(q, None, &np("pressure")));
                let pressurant_mass = n
                    .pressurant_mass
                    .as_ref()
                    .map(|q| f.q(q, None, &np("pressurant_mass")));
                let flow_area = n.flow_area.as_ref().map(|q| f.q(q, None, &np("flow_area")));
                let cd = n.cd.as_ref().map(|q| f.q(q, None, &np("cd")));
                let mut station = n.station.as_ref().map(|q| f.q(q, None, &np("station")));
                let radial = n.radial.as_ref().map(|q| f.q(q, None, &np("radial")));
                let mut tank = None;
                if let Some(cid) = &n.component {
                    match components.iter().find(|c| &c.id == cid) {
                        Some(c) => match component_tank(c, rocket, materials, f) {
                            Some(t) => {
                                station = station.or(Some(0.5 * (c.x_fore + c.x_aft)));
                                tank = Some(t);
                            }
                            None => push(
                                out,
                                diag::E_FEED_GRAPH,
                                np("component"),
                                format!("feed node `{nid}` names `{cid}`, which is not a tank"),
                                "point `component` at a `type = \"tank\"` component",
                            ),
                        },
                        None => push(
                            out,
                            diag::E_FEED_GRAPH,
                            np("component"),
                            format!("feed node `{nid}` names `{cid}`, which does not exist"),
                            "point `component` at a `type = \"tank\"` component",
                        ),
                    }
                    if n.tank.is_some() {
                        push(
                            out,
                            diag::E_FEED_GRAPH,
                            np("tank"),
                            format!(
                                "feed node `{nid}` gives both `component` and an inline `tank`"
                            ),
                            "keep one: the component or the inline tank",
                        );
                    }
                } else if let Some(t) = &n.tank {
                    tank = inline_tank(
                        t,
                        &np("tank"),
                        nid,
                        n.material.as_deref(),
                        materials,
                        f,
                        out,
                    );
                }
                for (field, v, what) in [
                    ("pressure", pressure, "pressure"),
                    ("volume", volume, "volume"),
                    ("flow_area", flow_area, "flow area"),
                    ("pressurant_mass", pressurant_mass, "pressurant mass"),
                ] {
                    if let Some(v) = v {
                        positive(out, id, &np(field), &format!("node `{nid}` {what}"), v);
                    }
                }
                if let Some(c) = cd {
                    unit_interval(
                        out,
                        id,
                        &np("cd"),
                        &format!("node `{nid}` discharge coefficient"),
                        c,
                    );
                }
                nodes.insert(
                    nid.clone(),
                    EvalFeedNode {
                        kind: n.kind,
                        component: n.component.clone(),
                        fluid: n.fluid.clone(),
                        volume,
                        pressure,
                        pressurant: n.pressurant.clone(),
                        pressurant_mass,
                        flow_area,
                        cd,
                        station,
                        radial,
                        tank,
                    },
                );
            }
            for (i, e) in feed.edge.iter().enumerate() {
                let eb = format!("{base}/feed/edge/{i}");
                let ep = |x: &str| format!("{eb}/{x}");
                let diameter = e.diameter.as_ref().map(|q| f.q(q, None, &ep("diameter")));
                let length = e.length.as_ref().map(|q| f.q(q, None, &ep("length")));
                for (field, v) in [("diameter", diameter), ("length", length)] {
                    if let Some(v) = v {
                        positive(out, id, &ep(field), &format!("edge {i} {field}"), v);
                    }
                }
                let waypoints =
                    e.waypoints
                        .iter()
                        .enumerate()
                        .map(|(k, w)| EvalFeedPoint {
                            station: f.q(&w.station, None, &ep(&format!("waypoints/{k}/station"))),
                            radial: f.q(&w.radial, None, &ep(&format!("waypoints/{k}/radial"))),
                            depth: w.depth.as_ref().map_or(0.0, |q| {
                                f.q(q, None, &ep(&format!("waypoints/{k}/depth")))
                            }),
                        })
                        .collect();
                for (end, name) in [("from", &e.from), ("to", &e.to)] {
                    if !feed.node.contains_key(name) {
                        push(
                            out,
                            diag::E_FEED_GRAPH,
                            ep(end),
                            format!(
                                "feed edge {i} `{end}` names `{name}`, which is not a feed node"
                            ),
                            "name a `[feed.node.<id>]` of this engine",
                        );
                    }
                }
                edges.push(EvalFeedEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    diameter,
                    length,
                    bc: e.bc,
                    waypoints,
                });
            }
        }
    }

    let e = EvalEngine {
        id: id.to_string(),
        name: doc.name.clone().unwrap_or_else(|| id.to_string()),
        oxidizer: doc.propellants.oxidizer.clone(),
        fuel: doc.propellants.fuel.clone(),
        mixture_ratio,
        chamber_pressure,
        thrust,
        expansion_ratio,
        exit_pressure,
        contraction_ratio,
        l_star,
        injector,
        fluid_model: doc.fluid_model,
        nodes,
        edges,
    };
    out.extend(check(&e));
    e
}

/// Structural findings on an evaluated engine: missing inputs (`RW-W210`
/// fluid model, `RW-W211` edge `bc`, `RW-W212` the rest), the feed graph
/// (`RW-E200`), and node volumes against their tanks (`RW-E201`). Pure on
/// [`EvalEngine`], so the WASM preview reports the same `Missing inputs · N`.
pub fn check(e: &EvalEngine) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let out = &mut out;
    let id = e.id.as_str();
    let base = format!("/engines/{id}");
    let p = |n: &str| format!("{base}/{n}");
    if e.fluid_model.is_none() {
        push(
            out,
            diag::W_FLUID_MODEL_MISSING,
            p("fluid_model"),
            format!("engine `{id}` has no fluid model"),
            "set `fluid_model = \"single_phase_liquid\"` (two-phase N2O is not modelled yet)",
        );
    }
    if e.expansion_ratio.is_none() && e.exit_pressure.is_none() {
        missing(
            out,
            p("expansion_ratio"),
            format!("engine `{id}` gives neither an expansion ratio nor an exit pressure"),
            "set `expansion_ratio = 4` or `exit_pressure = \"1 atm\"`",
        );
    }
    if e.l_star.is_none() {
        missing(
            out,
            p("l_star"),
            format!("engine `{id}` has no characteristic length L*"),
            "set `l_star`, e.g. \"1.5 m\" (SP-125 gives 15-120 in)",
        );
    }
    if e.contraction_ratio.is_none() {
        missing(
            out,
            p("contraction_ratio"),
            format!("engine `{id}` has no chamber contraction ratio"),
            "set `contraction_ratio`, e.g. 4 (2-5 for pressure-fed engines)",
        );
    }
    match &e.injector {
        None => missing(
            out,
            p("injector"),
            format!("engine `{id}` has no injector"),
            "add `injector = { type = \"impinging\", pressure_drop_fraction = 0.2 }`",
        ),
        Some(i) if i.pressure_drop.is_none() => missing(
            out,
            p("injector/pressure_drop"),
            format!("engine `{id}`: the injector has no pressure drop"),
            "set `pressure_drop` or `pressure_drop_fraction` (15-25% of chamber pressure)",
        ),
        Some(_) => {}
    }
    if e.nodes.is_empty() && e.edges.is_empty() {
        missing(
            out,
            p("feed"),
            format!("engine `{id}` has no feed graph"),
            "add `[feed.node.<id>]` tables (tanks, valves, the engine) and `[[feed.edge]]` lines",
        );
        return std::mem::take(out);
    }
    for (nid, n) in e.nodes.iter().filter(|(_, n)| n.kind == FeedNodeKind::Tank) {
        tank_inputs(out, nid, &format!("{base}/feed/node/{nid}"), n);
    }
    for (i, edge) in e.edges.iter().enumerate() {
        if edge.bc.is_none() {
            push(
                out,
                diag::W_FEED_BC_MISSING,
                format!("{base}/feed/edge/{i}/bc"),
                format!(
                    "feed edge {i} ({} → {}) has no boundary condition",
                    edge.from, edge.to
                ),
                "set `bc = \"open\"` (or closed, check_valve, orifice)",
            );
        }
    }
    graph_rules(out, e, &base);
    std::mem::take(out)
}

fn positive(out: &mut Vec<Diagnostic>, id: &str, ptr: &str, what: &str, v: f64) {
    if v.is_nan() || v <= 0.0 {
        push(
            out,
            diag::E_ENGINE_INPUT,
            ptr.to_string(),
            format!("engine `{id}`: {what} must be greater than 0 (is {v})"),
            "give a positive value",
        );
    }
}

fn unit_interval(out: &mut Vec<Diagnostic>, id: &str, ptr: &str, what: &str, v: f64) {
    if !(v > 0.0 && v <= 1.0) {
        push(
            out,
            diag::E_ENGINE_INPUT,
            ptr.to_string(),
            format!("engine `{id}`: {what} is {v}; it must be in (0, 1]"),
            "discharge coefficients lie between 0.5 and 0.92 (SP-125 p 128)",
        );
    }
}

/// An inline `[feed.node.<id>.tank]`: evaluated and checked like a component.
fn inline_tank(
    t: &Tank,
    tb: &str,
    nid: &str,
    material: Option<&str>,
    materials: &BTreeMap<String, EvalMaterial>,
    f: &mut Fields,
    out: &mut Vec<Diagnostic>,
) -> Option<EvalTankSpec> {
    let length = f.q(&t.length, None, &format!("{tb}/length"));
    let od = f.q(&t.od, None, &format!("{tb}/od"));
    let wall = f.q(&t.wall, None, &format!("{tb}/wall"));
    let base = tb.strip_suffix("/tank").unwrap_or(tb).to_string();
    let mut chk = Check::at(nid, base);
    let ok = super::tank::check_geometry(&mut chk, "tank/", length, od, wall, t.end_cap);
    let volume = tank_volume(length, od, wall, t.end_cap);
    let (fill, frac, vol) = fill_volume(f, t, tb, volume);
    if ok {
        super::tank::check_fill(&mut chk, "tank/", frac, vol, volume);
    }
    if let Some(name) = material {
        let m = materials.get(name);
        if m.is_none() {
            chk.push(
                diag::E_MATERIAL_UNKNOWN,
                "material",
                format!("feed node `{nid}` names material `{name}`, which is not defined"),
                format!("add `[materials.{name}]` to the rocket model"),
            );
        }
    }
    out.append(&mut chk.out);
    let m = material.and_then(|n| materials.get(n));
    Some(EvalTankSpec {
        length,
        od,
        wall,
        end_cap: t.end_cap,
        volume,
        fill_volume: fill,
        material: material.map(str::to_string),
        density: m.and_then(|m| m.density),
        yield_strength: m.and_then(|m| m.yield_strength),
    })
}

/// Missing inputs of a tank node, and its `volume` against its geometry.
fn tank_inputs(out: &mut Vec<Diagnostic>, nid: &str, nb: &str, n: &EvalFeedNode) {
    let (tank, volume) = (&n.tank, n.volume);
    if n.fluid.is_none() {
        missing(
            out,
            format!("{nb}/fluid"),
            format!("tank node `{nid}` has no fluid"),
            "set `fluid` to the engine's oxidizer or fuel id",
        );
    }
    if n.pressure.is_none() {
        missing(
            out,
            format!("{nb}/pressure"),
            format!("tank node `{nid}` has no pressure"),
            "set the initial ullage pressure, e.g. \"50 bar\"",
        );
    }
    if n.pressurant.is_none() {
        missing(
            out,
            format!("{nb}/pressurant"),
            format!("tank node `{nid}` has no pressurant gas"),
            "set `pressurant = \"n2\"` (n2, he, or air)",
        );
    }
    match tank {
        None if n.component.is_none() => missing(
            out,
            format!("{nb}/tank"),
            format!("tank node `{nid}` has no geometry"),
            "point `component` at a tank component or add an inline `tank` table",
        ),
        Some(t) => {
            if t.fill_volume.is_none() {
                let field = if n.component.is_some() {
                    format!("/c/{}/fill", n.component.as_deref().unwrap_or_default())
                } else {
                    format!("{nb}/tank/fill")
                };
                missing(
                    out,
                    field,
                    format!("tank node `{nid}`: the tank has no propellant fill"),
                    "set `fill = { propellant = \"...\", fraction = 0.8 }`",
                );
            }
            if let Some(v) = volume
                && v > 0.0
                && (v - t.volume).abs() > VOLUME_TOL * v
            {
                push(
                    out,
                    diag::E_ENGINE_INPUT,
                    format!("{nb}/volume"),
                    format!(
                        "tank node `{nid}` gives a volume of {} but its tank holds {}",
                        show(v, DimKind::Volume),
                        show(t.volume, DimKind::Volume)
                    ),
                    "make the tank geometry match the volume, or drop `volume`",
                );
            }
        }
        None => {}
    }
}

/// One engine node; every tank reaches it through edges that are not
/// closed; the oxidizer and the fuel each have a tank.
fn graph_rules(out: &mut Vec<Diagnostic>, e: &EvalEngine, base: &str) {
    let (id, nodes, edges) = (e.id.as_str(), &e.nodes, &e.edges[..]);
    let engine_nodes: Vec<&String> = nodes
        .iter()
        .filter(|(_, n)| n.kind == FeedNodeKind::Engine)
        .map(|(k, _)| k)
        .collect();
    if engine_nodes.len() != 1 {
        push(
            out,
            diag::E_FEED_GRAPH,
            format!("{base}/feed/node"),
            format!(
                "engine `{id}`'s feed graph has {} `engine` nodes; it needs exactly one",
                engine_nodes.len()
            ),
            "add one `[feed.node.<id>] kind = \"engine\"` that the lines end at",
        );
        return;
    }
    let target = engine_nodes[0];
    for (nid, n) in nodes.iter().filter(|(_, n)| n.kind == FeedNodeKind::Tank) {
        if !reaches(nid, target, edges) {
            push(
                out,
                diag::E_FEED_GRAPH,
                format!("{base}/feed/node/{nid}"),
                format!("tank node `{nid}` has no open path to the engine node `{target}`"),
                "connect it with `[[feed.edge]]` lines (`from` tank side, `to` engine side) that are not `closed`",
            );
        }
        let _ = n;
    }
    let fluids: BTreeSet<&str> = nodes
        .values()
        .filter(|n| n.kind == FeedNodeKind::Tank)
        .filter_map(|n| n.fluid.as_deref())
        .collect();
    let all_named = nodes
        .values()
        .filter(|n| n.kind == FeedNodeKind::Tank)
        .all(|n| n.fluid.is_some());
    if all_named {
        for (role, prop) in [("oxidizer", &e.oxidizer), ("fuel", &e.fuel)] {
            if !fluids.contains(prop.as_str()) {
                missing(
                    out,
                    format!("{base}/feed/node"),
                    format!("engine `{id}`: no tank node holds the {role} `{prop}`"),
                    "add a tank node with that `fluid`",
                );
            }
        }
    }
}

/// True when `to` is reachable from `from` along edges that are not closed.
pub fn reaches(from: &str, to: &str, edges: &[EvalFeedEdge]) -> bool {
    let mut seen = BTreeSet::from([from.to_string()]);
    let mut stack = vec![from.to_string()];
    while let Some(n) = stack.pop() {
        if n == to {
            return true;
        }
        for e in edges
            .iter()
            .filter(|e| e.from == n && e.bc != Some(EdgeBc::Closed))
        {
            if seen.insert(e.to.clone()) {
                stack.push(e.to.clone());
            }
        }
    }
    false
}

/// Configurations that name an engine which is not defined.
pub(crate) fn check_config_refs(
    configs: &BTreeMap<String, crate::types::EvalConfig>,
    engines: &BTreeMap<String, EvalEngine>,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (cid, c) in configs {
        for m in &c.motors {
            if let Some(e) = &m.engine
                && !engines.contains_key(e)
            {
                push(
                    &mut out,
                    diag::E_CONFIG,
                    format!("/configs/{cid}/motors/{}/engine", m.mount),
                    format!(
                        "mount `{}` names engine `{e}`, which has no engines/{e}.rw.toml",
                        m.mount
                    ),
                    "create the engine file or fix the id",
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;

    const ROCKET: &str = r#"
[c.body]
type = "body_tube"
length = "1.2 m"
od = "160 mm"
thickness = "2 mm"

[c.ox]
type = "tank"
attach = { to = "body.inner", at = "fore", offset = "100 mm" }
material = "al"
length = "500 mm"
od = "150 mm"
wall = "3 mm"
end_cap = "hemispherical"
fill = { propellant = "n2o", fraction = 0.8 }

[materials.al]
density = "2700 kg/m^3"
yield_strength = "276 MPa"
"#;

    const ENGINE: &str = r#"
propellants = { oxidizer = "n2o", fuel = "ethanol" }
mixture_ratio = 4.0
chamber_pressure = "20 bar"
thrust = "1.5 kN"
expansion_ratio = 4
contraction_ratio = 4
l_star = "1.5 m"
injector = { type = "impinging", pressure_drop_fraction = 0.2, cd = 0.7 }
fluid_model = "single_phase_liquid"

[feed.node.tank_a]
kind = "tank"
component = "ox"
fluid = "n2o"
pressure = "50 bar"
pressurant = "n2"

[feed.node.tank_b]
kind = "tank"
fluid = "ethanol"
pressure = "35 bar"
pressurant = "n2"
material = "al"
station = "900 mm"
radial = "0 mm"
tank = { length = "200 mm", od = "140 mm", wall = "3 mm", end_cap = "hemispherical", fill = { propellant = "ethanol", fraction = 0.6 } }

[feed.node.engine]
kind = "engine"
station = "1.2 m"

[[feed.edge]]
from = "tank_a"
to = "engine"
diameter = "10 mm"
length = "0.5 m"
bc = "open"
waypoints = [{ station = "1 m", radial = "20 mm" }]

[[feed.edge]]
from = "tank_b"
to = "engine"
diameter = "8 mm"
length = "0.3 m"
bc = "open"
"#;

    fn with_engine(engine: &str) -> crate::types::EvaluatedModel {
        project(&[("rocket.rw.toml", ROCKET), ("engines/e.rw.toml", engine)])
    }

    #[test]
    fn a_complete_engine_is_clean_and_resolved_in_si() {
        let m = with_engine(ENGINE);
        assert_clean(&m);
        let e = &m.engines["e"];
        assert_eq!((e.oxidizer.as_str(), e.fuel.as_str()), ("n2o", "ethanol"));
        assert!((e.chamber_pressure - 2e6).abs() < 1e-6);
        assert!((e.injector.as_ref().unwrap().pressure_drop.unwrap() - 4e5).abs() < 1e-6);
        let a = &e.nodes["tank_a"];
        let t = a.tank.as_ref().unwrap();
        assert!((t.fill_volume.unwrap() - 0.8 * t.volume).abs() < 1e-12);
        assert_eq!(t.yield_strength, Some(276e6));
        // Station defaults to the tank component's mid-length.
        let ox = comp(&m, "ox");
        assert!((a.station.unwrap() - 0.5 * (ox.x_fore + ox.x_aft)).abs() < 1e-12);
        let b = e.nodes["tank_b"].tank.as_ref().unwrap();
        assert_eq!(b.density, Some(2700.0));
        assert_eq!(e.edges[0].waypoints.len(), 1);
        assert!((e.edges[0].waypoints[0].radial - 0.02).abs() < 1e-12);
    }

    #[test]
    fn missing_inputs_are_w21x_at_their_fields() {
        let text = ENGINE
            .replace("fluid_model = \"single_phase_liquid\"\n", "")
            .replacen("bc = \"open\"\nwaypoints", "waypoints", 1);
        let m = with_engine(&text);
        let w: Vec<_> = codes(&m)
            .into_iter()
            .filter(|(c, _)| c.starts_with("RW-W2"))
            .collect();
        assert_eq!(
            w,
            vec![
                ("RW-W210".to_string(), "/engines/e/fluid_model".to_string()),
                (
                    "RW-W211".to_string(),
                    "/engines/e/feed/edge/0/bc".to_string()
                ),
            ],
            "{:#?}",
            m.diagnostics
        );
        assert_eq!(
            m.diagnostics[0].file.as_deref(),
            Some("engines/e.rw.toml"),
            "{:?}",
            m.diagnostics
        );
        let bare = with_engine(
            r#"
propellants = { oxidizer = "n2o", fuel = "ethanol" }
mixture_ratio = 4.0
chamber_pressure = "20 bar"
thrust = "1.5 kN"
fluid_model = "single_phase_liquid"
"#,
        );
        for p in [
            "expansion_ratio",
            "l_star",
            "contraction_ratio",
            "injector",
            "feed",
        ] {
            assert_diag(&bare, "RW-W212", &format!("/engines/e/{p}"));
        }
    }

    #[test]
    fn feed_graph_and_range_errors() {
        let m = with_engine(
            &ENGINE
                .replace("component = \"ox\"", "component = \"body\"")
                .replace(
                    "to = \"engine\"\ndiameter = \"8 mm\"",
                    "to = \"nowhere\"\ndiameter = \"8 mm\"",
                )
                .replace(
                    "chamber_pressure = \"20 bar\"",
                    "chamber_pressure = \"-1 bar\"",
                ),
        );
        assert_diag(&m, "RW-E200", "/engines/e/feed/node/tank_a/component");
        assert_diag(&m, "RW-E200", "/engines/e/feed/edge/1/to");
        assert_diag(&m, "RW-E200", "/engines/e/feed/node/tank_b");
        assert_diag(&m, "RW-E201", "/engines/e/chamber_pressure");
        let closed = with_engine(&ENGINE.replacen("bc = \"open\"", "bc = \"closed\"", 1));
        assert_diag(&closed, "RW-E200", "/engines/e/feed/node/tank_a");
        let vol = with_engine(&ENGINE.replace(
            "pressure = \"35 bar\"",
            "pressure = \"35 bar\"\nvolume = \"9 L\"",
        ));
        assert_diag(&vol, "RW-E201", "/engines/e/feed/node/tank_b/volume");
    }

    #[test]
    fn a_config_naming_an_unknown_engine_is_an_error() {
        let rocket = format!(
            "{ROCKET}\n[c.mmt]\ntype = \"inner_tube\"\nattach = {{ to = \"body.inner\", at = \"aft\", offset = \"1.2 m\" }}\nlength = \"100 mm\"\nod = \"30 mm\"\nid = \"29 mm\"\nmotor_mount = true\n"
        );
        let m = project(&[
            ("rocket.rw.toml", rocket.as_str()),
            ("engines/e.rw.toml", ENGINE),
            ("configs/c.rw.toml", "[motors.mmt]\nengine = \"nope\"\n"),
        ]);
        assert_diag(&m, "RW-E059", "/configs/c/motors/mmt/engine");
    }
}
