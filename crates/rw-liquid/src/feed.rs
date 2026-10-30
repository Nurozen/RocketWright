//! Feed system: each propellant's path from its tank to the engine node as a
//! series of hydraulic resistances (lines, orifices, valves, the injector),
//! every one a ΔP = R ṁ² element, and the design-point pressure budget
//! P_tank = Pc + ΔP_injector + ΔP_lines + ΔP_valves.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rw_model::{EdgeBc, EvalEngine, EvalFeedEdge, FeedNodeKind};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Darcy friction factor assumed for feed lines (smooth drawn tubing,
/// turbulent; SP-125 fig. 7-20 range).
pub const DARCY_F: f64 = 0.02;
/// Discharge coefficient of a sharp-edged orifice edge (`bc = "orifice"`).
pub const ORIFICE_CD: f64 = 0.61;
/// Discharge coefficient of a valve without one.
pub const VALVE_CD: f64 = 0.8;

/// Pressure drop of a straight line: ΔP = f (L/d) ρ v² / 2 with v = ṁ/(ρ A).
///
/// cite: sp-125 eq 7-7 p 292
pub fn line_pressure_drop(mdot: f64, rho: f64, d: f64, l: f64, f: f64) -> f64 {
    let a = std::f64::consts::PI * d * d / 4.0;
    let v = mdot / (rho * a);
    f * (l / d) * rho * v * v / 2.0
}

/// Resistance R of a line, ΔP = R ṁ² (eq 7-7 with v = ṁ/(ρA)).
///
/// cite: sp-125 eq 7-7 p 292
pub fn line_resistance(rho: f64, d: f64, l: f64, f: f64) -> f64 {
    let a = std::f64::consts::PI * d * d / 4.0;
    f * (l / d) / (2.0 * rho * a * a)
}

/// Resistance R of an orifice, ΔP = R ṁ² (SP-125 eq 4-40 with R = 1/(2ρ(Cd A)²)).
///
/// cite: sp-125 eq 4-40 p 137
pub fn orifice_resistance(rho: f64, cd: f64, a: f64) -> f64 {
    let ca = cd * a;
    1.0 / (2.0 * rho * ca * ca)
}

/// One element on a feed path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[schemars(rename = "FeedElement")]
pub enum Element {
    /// A line (edge with `diameter` and `length`).
    Line {
        edge: usize,
        diameter: f64,
        length: f64,
    },
    /// An orifice edge (`bc = "orifice"`, the edge diameter).
    Orifice { edge: usize, cd: f64, area: f64 },
    /// A valve node; `area` is `None` until the budget sizes it.
    Valve {
        node: String,
        cd: f64,
        area: Option<f64>,
    },
}

/// A valve on a path at the design point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ValveSizing {
    pub node: String,
    pub cd: f64,
    pub area: f64,
    pub pressure_drop: f64,
    /// True when the budget computed the area (no `flow_area` given).
    pub sized: bool,
}

/// One propellant's feed path and its design-point pressure budget (SI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "FeedBranch")]
pub struct Branch {
    /// Tank node id.
    pub tank: String,
    pub fluid: String,
    pub density: f64,
    /// Node ids from the tank to the engine node.
    pub path: Vec<String>,
    pub elements: Vec<Element>,
    pub mdot: f64,
    pub tank_pressure: f64,
    pub chamber_pressure: f64,
    pub injector_pressure_drop: f64,
    pub line_pressure_drop: f64,
    pub valve_pressure_drop: f64,
    /// Tank pressure needed: Pc + injector + lines + given valves.
    pub required_pressure: f64,
    /// Pressure left over that no element takes (0 once a valve is sized).
    pub margin: f64,
    pub valves: Vec<ValveSizing>,
    /// Total resistance tank → chamber incl. the injector (ΔP = R ṁ²).
    pub resistance: f64,
}

/// The node path from `from` to `to` along open edges (breadth first), with
/// the edge index of each step.
/// cite: n/a graph search, no physics
pub fn path(from: &str, to: &str, edges: &[EvalFeedEdge]) -> Option<Vec<(String, Option<usize>)>> {
    let mut prev: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut seen = BTreeSet::from([from.to_string()]);
    let mut q = VecDeque::from([from.to_string()]);
    while let Some(n) = q.pop_front() {
        if n == to {
            let (mut nodes, mut via) = (vec![n.clone()], Vec::new());
            let mut cur = n;
            while let Some((p, e)) = prev.get(&cur) {
                via.push(*e);
                nodes.push(p.clone());
                cur = p.clone();
            }
            nodes.reverse();
            via.reverse();
            // Each node with the edge that leaves it toward `to`.
            return Some(
                nodes
                    .into_iter()
                    .enumerate()
                    .map(|(i, n)| (n, via.get(i).copied()))
                    .collect(),
            );
        }
        for (i, e) in edges.iter().enumerate() {
            if e.from == n && e.bc != Some(EdgeBc::Closed) && seen.insert(e.to.clone()) {
                prev.insert(e.to.clone(), (n.clone(), i));
                q.push_back(e.to.clone());
            }
        }
    }
    None
}

/// The elements along a node path.
/// cite: n/a assembly of the path's elements, no physics
pub fn elements(engine: &EvalEngine, path: &[(String, Option<usize>)]) -> Vec<Element> {
    let mut out = Vec::new();
    for (k, (node, edge)) in path.iter().enumerate() {
        if k > 0
            && let Some(n) = engine.nodes.get(node)
            && n.kind == FeedNodeKind::Valve
        {
            out.push(Element::Valve {
                node: node.clone(),
                cd: n.cd.unwrap_or(VALVE_CD),
                area: n.flow_area,
            });
        }
        if let Some(i) = edge {
            let e = &engine.edges[*i];
            if let (Some(d), Some(l)) = (e.diameter, e.length) {
                out.push(Element::Line {
                    edge: *i,
                    diameter: d,
                    length: l,
                });
            }
            if e.bc == Some(EdgeBc::Orifice)
                && let Some(d) = e.diameter
            {
                out.push(Element::Orifice {
                    edge: *i,
                    cd: ORIFICE_CD,
                    area: std::f64::consts::PI * d * d / 4.0,
                });
            }
        }
    }
    out
}

/// The design-point budget of one branch: fixed losses at `mdot`, then any
/// valve without a flow area sized to take the remaining pressure (shared
/// equally). `inj_dp` and `inj_r` are the injector's drop and resistance.
///
/// cite: sp-125 eq 4-40 p 137
#[allow(clippy::too_many_arguments)]
pub fn budget(
    tank: &str,
    fluid: &str,
    rho: f64,
    node_path: Vec<String>,
    mut elems: Vec<Element>,
    mdot: f64,
    tank_pressure: f64,
    pc: f64,
    inj_dp: f64,
    inj_r: f64,
) -> Branch {
    let mut line_r = 0.0;
    let mut valve_r = 0.0;
    let mut open = 0usize;
    for e in &elems {
        match e {
            Element::Line {
                diameter, length, ..
            } => line_r += line_resistance(rho, *diameter, *length, DARCY_F),
            Element::Orifice { cd, area, .. } => line_r += orifice_resistance(rho, *cd, *area),
            Element::Valve { cd, area, .. } => match area {
                Some(a) => valve_r += orifice_resistance(rho, *cd, *a),
                None => open += 1,
            },
        }
    }
    let m2 = mdot * mdot;
    let line_dp = line_r * m2;
    let given_valve_dp = valve_r * m2;
    let required = pc + inj_dp + line_dp + given_valve_dp;
    let excess = tank_pressure - required;
    let mut valves = Vec::new();
    let mut margin = excess;
    let mut sized_r = 0.0;
    for e in &mut elems {
        if let Element::Valve { node, cd, area } = e {
            let (a, sized) = match *area {
                Some(a) => (a, false),
                None if excess > 0.0 => {
                    let a = crate::injector::orifice_area(mdot, *cd, rho, excess / open as f64);
                    *area = Some(a);
                    sized_r += orifice_resistance(rho, *cd, a);
                    (a, true)
                }
                None => continue,
            };
            valves.push(ValveSizing {
                node: node.clone(),
                cd: *cd,
                area: a,
                pressure_drop: orifice_resistance(rho, *cd, a) * m2,
                sized,
            });
        }
    }
    if open > 0 && excess > 0.0 {
        margin = 0.0;
    }
    Branch {
        tank: tank.to_string(),
        fluid: fluid.to_string(),
        density: rho,
        path: node_path,
        elements: elems,
        mdot,
        tank_pressure,
        chamber_pressure: pc,
        injector_pressure_drop: inj_dp,
        line_pressure_drop: line_dp,
        valve_pressure_drop: (valve_r + sized_r) * m2,
        required_pressure: required,
        margin,
        valves,
        resistance: inj_r + line_r + valve_r + sized_r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resistances_match_their_pressure_drops() {
        let (m, rho, d, l) = (0.5, 789.3, 0.01, 0.7);
        let dp = line_pressure_drop(m, rho, d, l, DARCY_F);
        assert!((line_resistance(rho, d, l, DARCY_F) * m * m - dp).abs() < 1e-6 * dp);
        let a = 3e-5;
        let r = orifice_resistance(rho, 0.6, a);
        assert!(
            (r * m * m - crate::injector::pressure_drop(m, 0.6, a, rho)).abs() < 1e-6 * r * m * m
        );
    }

    #[test]
    fn an_unsized_valve_takes_the_excess_pressure() {
        let elems = vec![
            Element::Valve {
                node: "v".into(),
                cd: 0.8,
                area: None,
            },
            Element::Line {
                edge: 0,
                diameter: 0.01,
                length: 1.0,
            },
        ];
        let b = budget(
            "t",
            "ethanol",
            789.3,
            vec!["t".into(), "v".into(), "e".into()],
            elems,
            0.14,
            35e5,
            20e5,
            4e5,
            4e5 / (0.14 * 0.14),
        );
        assert!(b.line_pressure_drop > 0.0);
        let sum = b.chamber_pressure
            + b.injector_pressure_drop
            + b.line_pressure_drop
            + b.valve_pressure_drop;
        assert!((sum - 35e5).abs() < 1e-3, "{sum}");
        assert_eq!(b.margin, 0.0);
        assert!(b.valves[0].sized);
        assert!((b.resistance * 0.14 * 0.14 - (35e5 - 20e5)).abs() < 1e-3);
    }
}
