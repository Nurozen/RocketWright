//! Tree derivation from `attach` (R2.4, gaps §4.3).
//!
//! `attach = { to = "<id>.<anchor>", at = "<anchor>" }` places a component's
//! own anchor `at` on the target's anchor. The tree is derived, never written:
//!
//! - `to` names an `inner` anchor of a container (`body.inner`): the child sits
//!   inside the target (containment `inner`).
//! - `to` names the `outer` anchor of a body component: the child sits on its
//!   surface (containment `surface`).
//! - any other anchor (`aft`, `fore`, `mid`, `root_te`, `motor_retainer`, ...)
//!   is positional. On a body-chain target the target becomes the parent; on
//!   any other target (a ring placed against an inner tube's `fore`) the child
//!   becomes the target's sibling. The containment is the child type's
//!   natural kind ([`natural_kind`]).
//!
//! The pair (parent type, child type, containment) must be in the rule table
//! ([`crate::containment`]), else `RW-E030`.

use std::collections::BTreeMap;

use crate::anchors::{default_at, type_has_anchor};
use crate::containment::{BODY, CONTAINERS, allowed, can_be_root, natural_kind, parents_of};
use crate::diag::{self, Diagnostic};
use crate::types::{AnchorKind, Component, ComponentType, anchor_kind};

/// One component's place in the tree.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: String,
    pub ty: ComponentType,
    pub parent: Option<String>,
    pub containment: AnchorKind,
    /// `(target id, target anchor)` when the attach resolved.
    pub target: Option<(String, String)>,
    /// Own anchor placed on the target (explicit or mirrored default).
    pub at: Option<String>,
}

/// The derived tree.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tree {
    pub nodes: BTreeMap<String, Node>,
    /// Targets before the components attached to them (placement order).
    pub order: Vec<String>,
    /// The first body component, then any orphans (with `RW-E050`/`RW-E054`).
    pub roots: Vec<String>,
}

impl Tree {
    /// Children of `id`, unsorted (callers sort by station).
    pub fn children(&self, id: &str) -> Vec<&str> {
        self.nodes
            .values()
            .filter(|n| n.parent.as_deref() == Some(id))
            .map(|n| n.id.as_str())
            .collect()
    }
}

fn names(ts: &[ComponentType]) -> String {
    ts.iter().map(|t| t.name()).collect::<Vec<_>>().join(", ")
}

/// Derives the tree from the components' `attach` tables.
pub fn derive(components: &BTreeMap<String, Component>, diags: &mut Vec<Diagnostic>) -> Tree {
    let mut tree = Tree::default();
    let mut targets: BTreeMap<&str, (String, String)> = BTreeMap::new();
    let mut unattached: Vec<&str> = Vec::new();

    for (id, c) in components {
        let ty = c.kind.component_type();
        let ptr = format!("/c/{id}/attach");
        let Some(att) = &c.attach else {
            unattached.push(id);
            continue;
        };
        let Some((tid, tanchor)) = att.to.split_once('.') else {
            diags.push(
                Diagnostic::new(
                    diag::E_ATTACH_TARGET,
                    format!("{ptr}/to"),
                    format!("`{}` is not `<id>.<anchor>`", att.to),
                )
                .with_hint("write e.g. `to = \"body.aft\"`"),
            );
            unattached.push(id);
            continue;
        };
        let Some(target) = components.get(tid) else {
            diags.push(
                Diagnostic::new(
                    diag::E_ATTACH_TARGET,
                    format!("{ptr}/to"),
                    format!("`{id}` attaches to `{tid}`, which does not exist"),
                )
                .with_hint("use the id of an existing component (`[c.<id>]`)"),
            );
            unattached.push(id);
            continue;
        };
        let tty = target.kind.component_type();
        if !type_has_anchor(tty, tanchor) {
            diags.push(
                Diagnostic::new(
                    diag::E_ATTACH_ANCHOR,
                    format!("{ptr}/to"),
                    format!("a {} has no anchor `{tanchor}`", tty.name()),
                )
                .with_hint(format!(
                    "anchors of {}: {}",
                    tty.name(),
                    tty.anchors().join(", ")
                )),
            );
            unattached.push(id);
            continue;
        }
        let at = match &att.at {
            Some(a) if type_has_anchor(ty, a) => a.clone(),
            Some(a) => {
                diags.push(
                    Diagnostic::new(
                        diag::E_ATTACH_AT,
                        format!("{ptr}/at"),
                        format!("a {} has no anchor `{a}`", ty.name()),
                    )
                    .with_hint(format!(
                        "anchors of {}: {}",
                        ty.name(),
                        ty.anchors().join(", ")
                    )),
                );
                default_at(tanchor, ty).to_string()
            }
            None => default_at(tanchor, ty).to_string(),
        };
        targets.insert(id, (tid.to_string(), tanchor.to_string()));
        tree.nodes.insert(
            id.clone(),
            Node {
                id: id.clone(),
                ty,
                parent: None,
                containment: natural_kind(ty),
                target: Some((tid.to_string(), tanchor.to_string())),
                at: Some(at),
            },
        );
    }

    // Placement order (targets first) and attach cycles.
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Visiting,
        Done,
    }
    let mut marks: BTreeMap<&str, Mark> = BTreeMap::new();
    let mut in_cycle: Vec<String> = Vec::new();
    for start in components.keys() {
        let mut path: Vec<&str> = Vec::new();
        let mut cur = start.as_str();
        loop {
            match marks.get(cur) {
                Some(Mark::Done) => break,
                Some(Mark::Visiting) => {
                    let pos = path.iter().position(|p| *p == cur).unwrap_or(0);
                    in_cycle.extend(path[pos..].iter().map(|s| s.to_string()));
                    break;
                }
                None => {}
            }
            marks.insert(cur, Mark::Visiting);
            path.push(cur);
            match targets.get(cur) {
                Some((t, _)) => cur = t.as_str(),
                None => break,
            }
        }
        for p in path.iter().rev() {
            marks.insert(p, Mark::Done);
            if !in_cycle.iter().any(|c| c == p) && !tree.order.iter().any(|o| o == p) {
                tree.order.push(p.to_string());
            }
        }
    }
    in_cycle.sort();
    in_cycle.dedup();
    for id in &in_cycle {
        diags.push(
            Diagnostic::new(
                diag::E_ATTACH_CYCLE,
                format!("/c/{id}/attach/to"),
                format!("`{id}` attaches into a cycle: {}", in_cycle.join(", ")),
            )
            .with_hint("attach one of these to a body component instead"),
        );
        if let Some(n) = tree.nodes.get_mut(id) {
            n.target = None;
            n.at = None;
        }
    }
    // Cycle members become orphans; they are placed first.
    tree.order.splice(0..0, in_cycle.iter().cloned());

    // Roots: the first body component, then orphans.
    let primary = unattached
        .iter()
        .copied()
        .filter(|id| {
            components[*id].attach.is_none() && can_be_root(components[*id].kind.component_type())
        })
        .min_by_key(|id| {
            (
                components[*id].kind.component_type() != ComponentType::NoseCone,
                *id,
            )
        });
    let primary = primary.or_else(|| {
        unattached
            .iter()
            .copied()
            .find(|id| components[*id].attach.is_none())
    });
    for id in unattached.iter().copied() {
        let ty = components[id].kind.component_type();
        tree.nodes.entry(id.to_string()).or_insert_with(|| Node {
            id: id.to_string(),
            ty,
            parent: None,
            containment: natural_kind(ty),
            target: None,
            at: None,
        });
        if Some(id) == primary {
            if !can_be_root(ty) {
                diags.push(
                    Diagnostic::new(
                        diag::E_INVALID_PARENT,
                        format!("/c/{id}"),
                        format!(
                            "the first component is a {}, not a body component",
                            ty.name()
                        ),
                    )
                    .with_hint(format!("start the rocket with one of: {}", names(BODY))),
                );
            }
            if let Some(n) = tree.nodes.get_mut(id) {
                n.containment = AnchorKind::Axial;
            }
            continue;
        }
        let has_attach = components[id].attach.is_some();
        if !has_attach {
            diags.push(
                Diagnostic::new(
                    diag::E_ATTACH_MISSING,
                    format!("/c/{id}"),
                    format!("`{id}` has no `attach`; only the first body component may omit it"),
                )
                .with_hint("add e.g. `attach = { to = \"<body>.aft\" }`"),
            );
        }
    }
    if let Some(p) = primary {
        tree.roots.push(p.to_string());
    }
    for id in &unattached {
        if Some(*id) != primary {
            tree.roots.push(id.to_string());
        }
    }
    for id in &in_cycle {
        tree.roots.push(id.clone());
    }

    // Parents and containment, targets first.
    let order = tree.order.clone();
    for id in &order {
        let Some((tid, tanchor)) = tree.nodes[id].target.clone() else {
            continue;
        };
        let ty = tree.nodes[id].ty;
        let tnode = tree.nodes[&tid].clone();
        let akind = anchor_kind(&tanchor);
        let (parent, kind) = if akind == AnchorKind::Inner && CONTAINERS.contains(&tnode.ty) {
            (tid.clone(), AnchorKind::Inner)
        } else if akind == AnchorKind::Surface && BODY.contains(&tnode.ty) {
            (tid.clone(), AnchorKind::Surface)
        } else if tnode.containment == AnchorKind::Axial || tnode.parent.is_none() {
            (tid.clone(), natural_kind(ty))
        } else {
            (
                tnode.parent.clone().unwrap_or(tid.clone()),
                natural_kind(ty),
            )
        };
        let pty = tree.nodes[&parent].ty;
        if !allowed(pty, ty, kind) {
            let ok = parents_of(ty, kind);
            let hint = if ok.is_empty() {
                format!(
                    "a {} cannot be placed by a {tanchor} anchor; attach it to a valid parent's anchor",
                    ty.name()
                )
            } else {
                format!("attach it to one of: {}", names(&ok))
            };
            diags.push(
                Diagnostic::new(
                    diag::E_INVALID_PARENT,
                    format!("/c/{id}/attach/to"),
                    format!(
                        "a {} cannot sit in a {} ({} containment)",
                        ty.name(),
                        pty.name(),
                        match kind {
                            AnchorKind::Axial => "axial",
                            AnchorKind::Inner => "inner",
                            AnchorKind::Surface => "surface",
                        }
                    ),
                )
                .with_hint(hint),
            );
        }
        let n = tree.nodes.get_mut(id).expect("node");
        n.parent = Some(parent);
        n.containment = kind;
    }
    tree
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comps(v: serde_json::Value) -> BTreeMap<String, Component> {
        serde_json::from_value(v).unwrap()
    }

    fn tube(attach: Option<&str>) -> serde_json::Value {
        let mut t = json!({"type": "body_tube", "length": "100 mm", "od": "54 mm"});
        if let Some(a) = attach {
            t["attach"] = json!({"to": a});
        }
        t
    }

    #[test]
    fn derives_parents_and_containment() {
        let c = comps(json!({
            "nose": {"type": "nose_cone", "shape": "ogive", "length": "200 mm", "od": "54 mm"},
            "body": tube(Some("nose.base")),
            "mount": {"type": "inner_tube", "attach": {"to": "body.aft", "at": "aft"}, "length": "70 mm", "od": "24 mm"},
            "ring": {"type": "centering_ring", "attach": {"to": "mount.fore"}, "length": "3 mm", "id": "24 mm"},
            "block": {"type": "engine_block", "attach": {"to": "mount.inner"}, "length": "5 mm", "id": "18 mm"},
            "fins": {"type": "trapezoidal_fin_set", "attach": {"to": "body.aft", "at": "root_te"}, "count": 3,
                "root_chord": "60 mm", "tip_chord": "30 mm", "span": "50 mm", "sweep": "30 mm", "thickness": "3 mm"},
            "lug": {"type": "launch_lug", "attach": {"to": "body.outer"}, "length": "30 mm", "od": "5 mm"},
            "chute": {"type": "parachute", "attach": {"to": "body.inner"}, "diameter": "300 mm", "cd": 0.8,
                "packed_length": "40 mm", "packed_diameter": "30 mm"},
        }));
        let mut d = Vec::new();
        let t = derive(&c, &mut d);
        assert!(d.is_empty(), "{d:?}");
        let p = |id: &str| (t.nodes[id].parent.as_deref(), t.nodes[id].containment);
        assert_eq!(p("nose"), (None, AnchorKind::Axial));
        assert_eq!(p("body"), (Some("nose"), AnchorKind::Axial));
        assert_eq!(p("mount"), (Some("body"), AnchorKind::Inner));
        assert_eq!(
            p("ring"),
            (Some("body"), AnchorKind::Inner),
            "sibling placement"
        );
        assert_eq!(p("block"), (Some("mount"), AnchorKind::Inner));
        assert_eq!(p("fins"), (Some("body"), AnchorKind::Surface));
        assert_eq!(p("lug"), (Some("body"), AnchorKind::Surface));
        assert_eq!(p("chute"), (Some("body"), AnchorKind::Inner));
        assert_eq!(t.nodes["ring"].at.as_deref(), Some("aft"));
        assert_eq!(t.roots, vec!["nose"]);
        let pos = |id: &str| t.order.iter().position(|o| o == id).unwrap();
        assert!(
            pos("mount") < pos("ring") && pos("body") < pos("mount") && pos("nose") < pos("body")
        );
    }

    #[test]
    fn diagnoses_bad_attachments() {
        let c = comps(json!({
            "body": tube(None),
            "other": tube(None),
            "a": tube(Some("nope.aft")),
            "b": tube(Some("body.root_le")),
            "c": tube(Some("body.inner")),
            "x": tube(Some("y.aft")),
            "y": tube(Some("x.aft")),
            "z": {"type": "body_tube", "attach": {"to": "body.aft", "at": "tip"}, "length": "1 m", "od": "54 mm"},
        }));
        let mut d = Vec::new();
        let t = derive(&c, &mut d);
        let got: Vec<(&str, &str)> = d
            .iter()
            .map(|x| (x.code.as_str(), x.path.as_deref().unwrap()))
            .collect();
        for want in [
            ("RW-E051", "/c/a/attach/to"),
            ("RW-E052", "/c/b/attach/to"),
            ("RW-E053", "/c/z/attach/at"),
            ("RW-E054", "/c/x/attach/to"),
            ("RW-E054", "/c/y/attach/to"),
            ("RW-E050", "/c/other"),
            ("RW-E030", "/c/c/attach/to"),
        ] {
            assert!(got.contains(&want), "missing {want:?} in {got:?}");
        }
        assert_eq!(t.roots[0], "body");
        assert!(t.roots.contains(&"x".to_string()));
    }
}
