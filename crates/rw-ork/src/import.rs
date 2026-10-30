//! `.ork` XML → `RocketDoc` (components, materials, stages), then configs,
//! sims, and motors (modules `sims`, `motors`).
//!
//! Placement follows the format's axial methods: a body component sits
//! `after` the previous one; any other component sits relative to its parent
//! (`top`, `middle`, `bottom`) or to the nose tip (`absolute`). Stations are
//! computed here with those rules (they decide `absolute` offsets and which
//! inner tube an auto-sized ring wraps), and each placement is written as an
//! `attach` whose offset reproduces the station.

use std::collections::{BTreeMap, BTreeSet};

use rw_model::diag::{self, Diagnostic};
use rw_model::{
    Appearance, Attach, BodyTube, Bulkhead, CenteringRing, Component, ComponentKind, ComponentType,
    Coupler, EllipticalFinSet, EngineBlock, FinCrossSection, FinTab, Finish, FreeformFinSet,
    ImportInfo, InnerTube, InstancePattern, Instances, LaunchLug, MassComponent, MassRole,
    Material, NoseCone, NoseShape, Overrides, Parachute, Radial, RailButton, RocketDoc, ShockCord,
    Shoulder, StageDef, Streamer, Transition, TrapezoidalFinSet, TubeFinSet,
};
use rw_units::markers::{
    Angle, AreaDensity, Density, Dimensionless as Number, Length, LineDensity, Mass,
};
use rw_units::{QLength, Qty};

use crate::util::{is_id, len_expr, q, qe, slug, unique};
use crate::xml::{Element, parse};
use crate::{ImportOptions, OrkError, OrkFiles, OrkImport};

/// Axial placement method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Method {
    After,
    Top,
    Middle,
    Bottom,
    Absolute,
}

/// One imported component.
#[derive(Debug, Clone)]
pub(crate) struct Node<'a> {
    pub el: &'a Element,
    pub ty: ComponentType,
    pub id: String,
    pub name: String,
    /// Parent node (None for body components).
    pub parent: Option<usize>,
    pub stage: usize,
    pub method: Method,
    pub offset: f64,
    /// Axial length in the format's sense (fins: root chord).
    pub len: f64,
    /// Fore station.
    pub x: f64,
}

/// One stage.
#[derive(Debug, Clone)]
pub(crate) struct StageNode<'a> {
    pub el: &'a Element,
    pub id: String,
    pub name: String,
    /// First body component (node index).
    pub first: Option<usize>,
}

/// The parsed component tree.
#[derive(Debug, Default)]
pub(crate) struct Tree<'a> {
    pub nodes: Vec<Node<'a>>,
    pub stages: Vec<StageNode<'a>>,
    /// Body components in order, all stages.
    pub chain: Vec<usize>,
}

impl Tree<'_> {
    pub fn by_ty(&self, ts: &[ComponentType]) -> impl Iterator<Item = &Node<'_>> {
        self.nodes.iter().filter(move |n| ts.contains(&n.ty))
    }
}

fn kind_of(tag: &str) -> Option<ComponentType> {
    use ComponentType as T;
    Some(match tag {
        "nosecone" => T::NoseCone,
        "bodytube" => T::BodyTube,
        "transition" => T::Transition,
        "trapezoidfinset" => T::TrapezoidalFinSet,
        "ellipticalfinset" => T::EllipticalFinSet,
        "freeformfinset" => T::FreeformFinSet,
        "tubefinset" => T::TubeFinSet,
        "launchlug" => T::LaunchLug,
        "railbutton" => T::RailButton,
        "innertube" => T::InnerTube,
        "tubecoupler" => T::Coupler,
        "centeringring" => T::CenteringRing,
        "bulkhead" => T::Bulkhead,
        "engineblock" => T::EngineBlock,
        "parachute" => T::Parachute,
        "streamer" => T::Streamer,
        "shockcord" => T::ShockCord,
        "masscomponent" => T::MassComponent,
        _ => return None,
    })
}

pub(crate) fn is_body(t: ComponentType) -> bool {
    matches!(
        t,
        ComponentType::NoseCone | ComponentType::BodyTube | ComponentType::Transition
    )
}

pub(crate) fn approx(path: Option<String>, msg: impl Into<String>) -> Diagnostic {
    Diagnostic::new(diag::W_IMPORT_APPROX, path, msg).with_hint(
        "review the imported component and adjust it by hand if the approximation matters",
    )
}

fn placement(el: &Element, body: bool) -> (Method, f64) {
    let (m, v) = match el.child("axialoffset").or_else(|| el.child("position")) {
        Some(p) => (
            p.attr("method").or_else(|| p.attr("type")).unwrap_or(""),
            crate::xml::parse_num(&p.text).unwrap_or(0.0),
        ),
        None => ("", 0.0),
    };
    let v = if v.is_finite() { v } else { 0.0 };
    let m = match m.to_ascii_lowercase().as_str() {
        "after" => Method::After,
        "middle" => Method::Middle,
        "bottom" => Method::Bottom,
        "absolute" => Method::Absolute,
        "top" => Method::Top,
        _ if body => Method::After,
        _ => Method::Top,
    };
    (m, v)
}

/// A radius field: `0.0125`, `auto`, or `auto 0.0125`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Radius {
    auto: bool,
    value: Option<f64>,
}

fn radius(el: &Element, name: &str) -> Radius {
    let Some(t) = el.text_of(name) else {
        return Radius {
            auto: false,
            value: None,
        };
    };
    match t.strip_prefix("auto") {
        Some(rest) => Radius {
            auto: true,
            value: rest.trim().parse().ok(),
        },
        None => Radius {
            auto: false,
            value: t.parse().ok(),
        },
    }
}

fn freeform_points(el: &Element) -> Vec<[f64; 2]> {
    el.child("finpoints")
        .map(|fp| {
            fp.all("point")
                .filter_map(|p| {
                    Some([
                        p.attr("x")?.trim().parse().ok()?,
                        p.attr("y")?.trim().parse().ok()?,
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

fn or_length(ty: ComponentType, el: &Element) -> f64 {
    use ComponentType as T;
    let v = match ty {
        T::TrapezoidalFinSet | T::EllipticalFinSet => el.num("rootchord"),
        T::FreeformFinSet => {
            let p = freeform_points(el);
            match (p.first(), p.last()) {
                (Some(a), Some(b)) => Some((b[0] - a[0]).abs()),
                _ => None,
            }
        }
        T::RailButton => el.num("outerdiameter"),
        T::Parachute | T::Streamer | T::ShockCord | T::MassComponent => el.num("packedlength"),
        _ => el.num("length"),
    };
    v.filter(|v| v.is_finite()).unwrap_or(0.0)
}

struct Collector<'a> {
    tree: Tree<'a>,
    diags: Vec<Diagnostic>,
}

impl<'a> Collector<'a> {
    fn subcomponents(el: &'a Element) -> impl Iterator<Item = &'a Element> + 'a {
        el.child("subcomponents")
            .into_iter()
            .flat_map(|s| s.children.iter())
    }

    fn component(&mut self, el: &'a Element, parent: Option<usize>, stage: usize) {
        let Some(ty) = kind_of(&el.name) else {
            let name = el.text_of("name").unwrap_or(&el.name).to_string();
            self.diags.push(approx(
                None,
                format!(
                    "`{name}` ({}) has no RocketWright equivalent; it and its contents were skipped",
                    el.name
                ),
            ));
            return;
        };
        let body = parent.is_none();
        if body != is_body(ty) {
            let name = el.text_of("name").unwrap_or(&el.name).to_string();
            self.diags.push(approx(
                None,
                format!(
                    "`{name}` ({}) sits where RocketWright cannot place it; it was skipped",
                    el.name
                ),
            ));
            return;
        }
        let (method, offset) = placement(el, body);
        let idx = self.tree.nodes.len();
        self.tree.nodes.push(Node {
            el,
            ty,
            id: String::new(),
            name: el
                .text_of("name")
                .map(str::to_string)
                .unwrap_or_else(|| ty.name().replace('_', " ")),
            parent,
            stage,
            method,
            offset,
            len: or_length(ty, el),
            x: 0.0,
        });
        if body {
            self.tree.chain.push(idx);
            if self.tree.stages[stage].first.is_none() {
                self.tree.stages[stage].first = Some(idx);
            }
        }
        for c in Self::subcomponents(el) {
            self.component(c, Some(idx), stage);
        }
    }
}

/// Assigns slug ids (a `rw-id: <id>` comment wins) and stations.
fn finish_tree(tree: &mut Tree<'_>) {
    let mut taken = BTreeSet::new();
    // Comment ids first, so an exported file keeps its ids.
    let mut fixed: Vec<Option<String>> = Vec::with_capacity(tree.nodes.len());
    for n in &tree.nodes {
        let hint = n.el.text_of("comment").and_then(|c| {
            c.lines().find_map(|l| {
                l.trim()
                    .strip_prefix("rw-id:")
                    .map(|s| s.trim().to_string())
            })
        });
        let hint = hint.filter(|h| is_id(h) && !taken.contains(h));
        if let Some(h) = &hint {
            taken.insert(h.clone());
        }
        fixed.push(hint);
    }
    for (n, f) in tree.nodes.iter_mut().zip(fixed) {
        n.id = match f {
            Some(h) => h,
            None => unique(&slug(&n.name), &mut taken),
        };
    }
    let mut taken = BTreeSet::new();
    for s in &mut tree.stages {
        s.id = unique(&slug(&s.name), &mut taken);
    }
    // Body chain.
    let mut end = 0.0;
    for (k, &i) in tree.chain.clone().iter().enumerate() {
        let n = &mut tree.nodes[i];
        n.x = if k == 0 { 0.0 } else { end + n.offset };
        end = n.x + n.len;
    }
    // Everything else, parents first (nodes are in document order).
    for i in 0..tree.nodes.len() {
        let Some(p) = tree.nodes[i].parent else {
            continue;
        };
        let (px, pl) = (tree.nodes[p].x, tree.nodes[p].len);
        let n = &mut tree.nodes[i];
        n.x = match n.method {
            Method::Top | Method::After => px + n.offset,
            Method::Middle => px + (pl - n.len) / 2.0 + n.offset,
            Method::Bottom => px + pl - n.len + n.offset,
            Method::Absolute => n.offset,
        };
    }
}

// ---- radii ----------------------------------------------------------------------

/// Fore and aft radii of the body chain with autos resolved numerically.
struct ChainRadii {
    fore: Vec<Radius>,
    aft: Vec<Radius>,
}

fn chain_radii(tree: &Tree<'_>, diags: &mut Vec<Diagnostic>) -> ChainRadii {
    let n = tree.chain.len();
    let mut fore = Vec::with_capacity(n);
    let mut aft = Vec::with_capacity(n);
    for &i in &tree.chain {
        let node = &tree.nodes[i];
        let (f, a) = match node.ty {
            ComponentType::NoseCone => (
                Radius {
                    auto: false,
                    value: Some(0.0),
                },
                radius(node.el, "aftradius"),
            ),
            ComponentType::BodyTube => {
                let r = radius(node.el, "radius");
                (r, r)
            }
            _ => (radius(node.el, "foreradius"), radius(node.el, "aftradius")),
        };
        fore.push(f);
        aft.push(a);
    }
    // Fill autos without a stored value from the neighbours.
    for _ in 0..n.max(1) {
        for k in 0..n {
            let tube = tree.nodes[tree.chain[k]].ty == ComponentType::BodyTube;
            if fore[k].value.is_none() && k > 0 {
                fore[k].value = aft[k - 1].value;
            }
            if aft[k].value.is_none() && k + 1 < n {
                aft[k].value = fore[k + 1].value;
            }
            if tube {
                let v = fore[k].value.or(aft[k].value);
                fore[k].value = v;
                aft[k].value = v;
            }
        }
    }
    for k in 0..n {
        if fore[k].value.is_none() || aft[k].value.is_none() {
            let node = &tree.nodes[tree.chain[k]];
            diags.push(approx(
                Some(format!("/c/{}", node.id)),
                format!(
                    "`{}` has an automatic radius with no neighbour to take it from; 12.5 mm was used",
                    node.name
                ),
            ));
            fore[k].value.get_or_insert(0.0125);
            aft[k].value.get_or_insert(0.0125);
        }
    }
    ChainRadii { fore, aft }
}

fn fore_field(t: ComponentType) -> &'static str {
    if t == ComponentType::Transition {
        "fore_od"
    } else {
        "od"
    }
}

fn aft_field(t: ComponentType) -> &'static str {
    if t == ComponentType::Transition {
        "aft_od"
    } else {
        "od"
    }
}

// ---- emission ---------------------------------------------------------------------

struct Emitter<'t, 'a> {
    tree: &'t Tree<'a>,
    radii: ChainRadii,
    materials: BTreeMap<String, Material>,
    material_keys: BTreeMap<(String, String, u64), String>,
    diags: Vec<Diagnostic>,
}

fn len(v: f64) -> QLength {
    q::<Length>(v, "mm")
}

fn deg(v: f64) -> Qty<Angle> {
    crate::util::degrees(v)
}

impl Emitter<'_, '_> {
    fn chain_pos(&self, i: usize) -> Option<usize> {
        self.tree.chain.iter().position(|&c| c == i)
    }

    fn path(&self, i: usize) -> Option<String> {
        Some(format!("/c/{}", self.tree.nodes[i].id))
    }

    /// The material key for `<material>` (or another material element).
    fn material(&mut self, el: Option<&Element>) -> Option<String> {
        let el = el?;
        let name = if el.text.trim().is_empty() {
            "material".to_string()
        } else {
            el.text.trim().to_string()
        };
        let kind = el.attr("type").unwrap_or("bulk").to_ascii_lowercase();
        let density = el
            .attr("density")
            .and_then(|d| d.trim().parse::<f64>().ok())?;
        let key = (name.clone(), kind.clone(), density.to_bits());
        if let Some(k) = self.material_keys.get(&key) {
            return Some(k.clone());
        }
        let mut taken: BTreeSet<String> = self.materials.keys().cloned().collect();
        let id = unique(&slug(&name), &mut taken);
        let m = match kind.as_str() {
            "surface" => Material {
                density: None,
                surface_density: Some(q::<AreaDensity>(density, "g/m^2")),
                line_density: None,
                yield_strength: None,
                doc: Some(name),
            },
            "line" => Material {
                density: None,
                surface_density: None,
                line_density: Some(q::<LineDensity>(density, "g/m")),
                yield_strength: None,
                doc: Some(name),
            },
            _ => Material {
                density: Some(q::<Density>(density, "kg/m^3")),
                surface_density: None,
                line_density: None,
                yield_strength: None,
                doc: Some(name),
            },
        };
        self.materials.insert(id.clone(), m);
        self.material_keys.insert(key, id.clone());
        Some(id)
    }

    fn finish(el: &Element) -> Option<Finish> {
        let um = match el.text_of("finish")?.to_ascii_lowercase().as_str() {
            "rough" => 500.0,
            "unfinished" => 150.0,
            "normal" => 60.0,
            "smooth" => 20.0,
            "polished" => 2.0,
            "mirror" => 0.0,
            _ => return None,
        };
        Some(Finish::Custom {
            roughness: q::<Length>(um * 1e-6, "um"),
        })
    }

    fn appearance(el: &Element) -> Option<Appearance> {
        let a = el.child("appearance")?;
        let paint = a.child("paint")?;
        let ch = |k: &str| -> Option<u8> {
            paint
                .attr(k)?
                .trim()
                .parse::<f64>()
                .ok()
                .map(|v| v.clamp(0.0, 255.0).round() as u8)
        };
        let (r, g, b) = (ch("red")?, ch("green")?, ch("blue")?);
        let roughness = a
            .num("shine")
            .filter(|s| s.is_finite())
            .map(|s| ((1.0 - s.clamp(0.0, 1.0)) * 1e3).round() / 1e3);
        Some(Appearance {
            preset: None,
            color: Some(format!("#{r:02x}{g:02x}{b:02x}")),
            roughness,
            metalness: None,
            transmission: None,
        })
    }

    fn overrides(el: &Element) -> Option<Overrides> {
        let pos = |v: Option<f64>| v.filter(|v| v.is_finite());
        let enabled = |k: &str| el.flag(k).unwrap_or(true);
        let mass = pos(el.num("overridemass")).filter(|_| enabled("overridemassenabled"));
        let cg = pos(el.num("overridecg")).filter(|_| enabled("overridecgenabled"));
        let cd = pos(el.num("overridecd")).filter(|_| enabled("overridecdenabled"));
        if mass.is_none() && cg.is_none() && cd.is_none() {
            return None;
        }
        let subtree = [
            "overridesubcomponents",
            "overridesubcomponentsmass",
            "overridesubcomponentscg",
            "overridesubcomponentscd",
        ]
        .iter()
        .any(|k| el.flag(k) == Some(true));
        Some(Overrides {
            mass: mass.map(|m| q::<Mass>(m, "g")),
            cg: cg.map(len),
            cd: cd.map(Qty::<Number>::number),
            subtree,
        })
    }

    /// `= c.<p>.od - 2 * c.<p>.thickness` for tube parents, else the number.
    fn parent_inner_dia(&self, p: usize) -> (Option<String>, f64) {
        let pn = &self.tree.nodes[p];
        let el = pn.el;
        let t = el.num("thickness").unwrap_or(0.0);
        let numeric = match pn.ty {
            ComponentType::BodyTube | ComponentType::NoseCone | ComponentType::Transition => {
                let k = self.chain_pos(p).unwrap_or(0);
                let r = match pn.ty {
                    ComponentType::BodyTube => self.radii.fore[k].value.unwrap_or(0.0),
                    ComponentType::NoseCone => self.radii.aft[k].value.unwrap_or(0.0),
                    _ => self.radii.fore[k]
                        .value
                        .unwrap_or(0.0)
                        .min(self.radii.aft[k].value.unwrap_or(0.0)),
                };
                2.0 * (r - t)
            }
            ComponentType::InnerTube | ComponentType::Coupler => {
                2.0 * (radius(el, "outerradius").value.unwrap_or(0.0) - t)
            }
            _ => 0.0,
        };
        let expr = matches!(
            pn.ty,
            ComponentType::BodyTube | ComponentType::InnerTube | ComponentType::Coupler
        )
        .then(|| format!("c.{0}.od - 2 * c.{0}.thickness", pn.id));
        (expr, numeric.max(0.0))
    }

    fn start_anchor(t: ComponentType) -> &'static str {
        ["fore", "tip", "root_le", "attach"]
            .into_iter()
            .find(|a| t.anchors().contains(a))
            .unwrap_or("fore")
    }

    fn end_anchor(t: ComponentType) -> Option<&'static str> {
        ["aft", "base", "root_te"]
            .into_iter()
            .find(|a| t.anchors().contains(a))
    }

    /// The child's axial length as an expression on its own fields.
    fn extent_ref(n: &Node<'_>) -> Option<String> {
        use ComponentType as T;
        let f = match n.ty {
            T::TrapezoidalFinSet | T::EllipticalFinSet => "root_chord",
            T::FreeformFinSet => return None,
            T::RailButton => "od",
            T::Parachute | T::Streamer | T::ShockCord => "packed_length",
            _ => "length",
        };
        Some(format!("c.{}.{f}", n.id))
    }

    fn attach(&self, i: usize) -> Option<Attach> {
        let n = &self.tree.nodes[i];
        let (to, at, offset) = match n.parent {
            None => {
                let k = self.chain_pos(i)?;
                if k == 0 {
                    return None;
                }
                let prev = &self.tree.nodes[self.tree.chain[k - 1]];
                let anchor = if prev.ty == ComponentType::NoseCone {
                    "base"
                } else {
                    "aft"
                };
                let gap = n.x - (prev.x + prev.len);
                (
                    format!("{}.{anchor}", prev.id),
                    None,
                    (gap.abs() > 0.0).then(|| len(gap)),
                )
            }
            Some(p) => {
                let pn = &self.tree.nodes[p];
                let chain = is_body(pn.ty);
                let (fore, aft, mid) = match pn.ty {
                    ComponentType::NoseCone => ("tip", Some("base"), None),
                    ComponentType::BodyTube => ("fore", Some("aft"), Some("mid")),
                    ComponentType::Transition => ("fore", Some("aft"), None),
                    _ => ("inner", None, None),
                };
                let start = Self::start_anchor(n.ty);
                let ext = Self::extent_ref(n);
                let plen = format!("c.{}.length", pn.id);
                let mut terms: Vec<(f64, String)> = Vec::new();
                let mut constant = n.offset;
                let ext_term = |k: f64, terms: &mut Vec<(f64, String)>, c: &mut f64| match &ext {
                    Some(e) => terms.push((k, e.clone())),
                    None => *c += k * n.len,
                };
                let (to, at) = match n.method {
                    Method::Top | Method::After => (fore, start),
                    Method::Absolute => {
                        constant = n.offset - pn.x;
                        (fore, start)
                    }
                    Method::Bottom => match (chain, aft, Self::end_anchor(n.ty)) {
                        (true, Some(a), Some(e)) => (a, e),
                        (true, Some(a), None) => {
                            ext_term(-1.0, &mut terms, &mut constant);
                            (a, start)
                        }
                        _ => {
                            terms.push((1.0, plen.clone()));
                            ext_term(-1.0, &mut terms, &mut constant);
                            (fore, start)
                        }
                    },
                    Method::Middle => match mid {
                        Some(m) if n.ty.anchors().contains(&"mid") => (m, "mid"),
                        Some(m) => {
                            ext_term(-0.5, &mut terms, &mut constant);
                            (m, start)
                        }
                        None => {
                            terms.push((0.5, plen.clone()));
                            ext_term(-0.5, &mut terms, &mut constant);
                            (fore, start)
                        }
                    },
                };
                let off = if terms.is_empty() && constant == 0.0 {
                    None
                } else {
                    Some(len_expr(&terms, constant))
                };
                (format!("{}.{to}", pn.id), Some(at.to_string()), off)
            }
        };
        let mut a = Attach {
            to,
            at,
            offset,
            spin: None,
            radial: None,
        };
        let el = n.el;
        let angle = el
            .num("angleoffset")
            .or_else(|| el.num("rotation"))
            .or_else(|| el.num("radialdirection"))
            .filter(|v| v.is_finite() && *v != 0.0);
        a.spin = angle.map(deg);
        if n.parent.is_some()
            && let Some(r) = el
                .num("radialposition")
                .filter(|r| r.is_finite() && *r > 0.0)
        {
            a.radial = Some(Radial::Radius(len(r)));
        }
        Some(a)
    }

    fn shoulder(el: &Element, prefix: &str) -> Option<Shoulder> {
        let l = el.num(&format!("{prefix}shoulderlength")).unwrap_or(0.0);
        let r = el.num(&format!("{prefix}shoulderradius")).unwrap_or(0.0);
        if l <= 0.0 || r <= 0.0 {
            return None;
        }
        Some(Shoulder {
            length: len(l),
            od: len(2.0 * r),
            thickness: el
                .num(&format!("{prefix}shoulderthickness"))
                .filter(|t| *t > 0.0)
                .map(len),
            capped: el.flag(&format!("{prefix}shouldercapped")).unwrap_or(false),
        })
    }

    fn shape(&mut self, i: usize) -> (NoseShape, Option<Qty<Number>>) {
        let el = self.tree.nodes[i].el;
        let s = match el
            .text_of("shape")
            .unwrap_or("ogive")
            .to_ascii_lowercase()
            .as_str()
        {
            "conical" => NoseShape::Conical,
            "ellipsoid" => NoseShape::Ellipsoid,
            "power" => NoseShape::Power,
            "parabolic" => NoseShape::Parabolic,
            "haack" => NoseShape::Haack,
            "ogive" => NoseShape::Ogive,
            other => {
                let p = self.path(i);
                self.diags.push(approx(
                    p,
                    format!("unknown shape `{other}`; ogive was used"),
                ));
                NoseShape::Ogive
            }
        };
        let param = match s {
            NoseShape::Conical | NoseShape::Ellipsoid => None,
            _ => el
                .num("shapeparameter")
                .filter(|v| v.is_finite())
                .map(Qty::number),
        };
        (s, param)
    }

    /// True when chain field (`k`, fore side or not) is automatic. A body
    /// tube has one diameter, so either side being automatic makes it so.
    fn chain_auto(&self, k: usize, fore: bool) -> bool {
        if self.tree.nodes[self.tree.chain[k]].ty == ComponentType::BodyTube {
            self.radii.fore[k].auto || self.radii.aft[k].auto
        } else if fore {
            self.radii.fore[k].auto
        } else {
            self.radii.aft[k].auto
        }
    }

    /// The non-automatic chain field an automatic one takes its value from:
    /// side `fore` of `k`, reached walking fore (`fore`) or aft. Only a body
    /// tube passes the walk on; any other automatic field faces back the way
    /// the walk came (a cycle), so there is no source.
    fn literal_source(&self, k: usize, fore: bool) -> Option<(usize, bool)> {
        let ty = self.tree.nodes[self.tree.chain[k]].ty;
        if ty == ComponentType::NoseCone && fore {
            return None;
        }
        if !self.chain_auto(k, fore) {
            return Some((k, fore));
        }
        if ty != ComponentType::BodyTube {
            return None;
        }
        // Entered on the aft side → walking fore, and vice versa.
        if !fore {
            k.checked_sub(1).and_then(|j| self.literal_source(j, false))
        } else {
            Some(k + 1)
                .filter(|j| *j < self.tree.chain.len())
                .and_then(|j| self.literal_source(j, true))
        }
    }

    /// The diameter of a body field: for an automatic field, an expression
    /// on the non-automatic field it takes its value from (so references
    /// never form a cycle), else the number.
    fn chain_dia(&self, k: usize, fore: bool) -> QLength {
        let r = if fore {
            self.radii.fore[k]
        } else {
            self.radii.aft[k]
        };
        let value = 2.0 * r.value.unwrap_or(0.0);
        if !self.chain_auto(k, fore) {
            return len(value);
        }
        let node = |j: usize| &self.tree.nodes[self.tree.chain[j]];
        let tube = node(k).ty == ComponentType::BodyTube;
        let step = |f: bool| {
            if f {
                k.checked_sub(1).and_then(|j| self.literal_source(j, false))
            } else {
                Some(k + 1)
                    .filter(|j| *j < self.tree.chain.len())
                    .and_then(|j| self.literal_source(j, true))
            }
        };
        // The stated side first; a body tube may also take the other side.
        let found = step(fore).or_else(|| if tube { step(!fore) } else { None });
        match found {
            Some((j, j_fore)) => {
                let field = if j_fore {
                    fore_field(node(j).ty)
                } else {
                    aft_field(node(j).ty)
                };
                qe(format!("c.{}.{field}", node(j).id))
            }
            None => len(value),
        }
    }

    fn component(&mut self, i: usize) -> Component {
        use ComponentType as T;
        let n = self.tree.nodes[i].clone();
        let el = n.el;
        let num = |k: &str| el.num(k).filter(|v| v.is_finite());
        let thickness = num("thickness").unwrap_or(0.0);
        let mut material = self.material(el.child("material"));
        let mut instances = None;
        let mut synthetic_mass = false;
        let kind = match n.ty {
            T::NoseCone => {
                let k = self.chain_pos(i).unwrap_or(0);
                if el.flag("isflipped") == Some(true) {
                    let p = self.path(i);
                    self.diags.push(approx(
                        p,
                        format!("`{}` is a flipped nose cone (tail cone); it was imported pointing forward", n.name),
                    ));
                }
                let (shape, shape_param) = self.shape(i);
                ComponentKind::NoseCone(NoseCone {
                    shape,
                    shape_param,
                    length: len(n.len),
                    od: self.chain_dia(k, false),
                    thickness: (el.flag("filled") != Some(true) && thickness > 0.0)
                        .then(|| len(thickness)),
                    shoulder: Self::shoulder(el, "aft"),
                })
            }
            T::BodyTube => {
                let k = self.chain_pos(i).unwrap_or(0);
                let r = self.radii.fore[k].value.unwrap_or(0.0);
                ComponentKind::BodyTube(BodyTube {
                    length: len(n.len),
                    od: self.chain_dia(k, true),
                    id: None,
                    thickness: Some(len(if el.flag("filled") == Some(true) {
                        r
                    } else {
                        thickness
                    })),
                })
            }
            T::Transition => {
                let k = self.chain_pos(i).unwrap_or(0);
                let (shape, shape_param) = self.shape(i);
                ComponentKind::Transition(Transition {
                    shape,
                    shape_param,
                    length: len(n.len),
                    fore_od: self.chain_dia(k, true),
                    aft_od: self.chain_dia(k, false),
                    thickness: (el.flag("filled") != Some(true) && thickness > 0.0)
                        .then(|| len(thickness)),
                    fore_shoulder: Self::shoulder(el, "fore"),
                    aft_shoulder: Self::shoulder(el, "aft"),
                })
            }
            T::TrapezoidalFinSet | T::EllipticalFinSet | T::FreeformFinSet => {
                let count = el
                    .num("fincount")
                    .or_else(|| el.num("instancecount"))
                    .filter(|c| c.is_finite() && *c >= 1.0)
                    .map_or(3, |c| c as u32);
                let cross_section = match el.text_of("crosssection") {
                    Some("rounded") => Some(FinCrossSection::Rounded),
                    Some("airfoil") => Some(FinCrossSection::Airfoil),
                    Some("square") => Some(FinCrossSection::Square),
                    _ => None,
                };
                let cant = num("cant").filter(|c| *c != 0.0).map(deg);
                let tab = self.fin_tab(el, n.len);
                let fillet_radius = num("filletradius").filter(|r| *r > 0.0).map(len);
                match n.ty {
                    T::TrapezoidalFinSet => ComponentKind::TrapezoidalFinSet(TrapezoidalFinSet {
                        count,
                        root_chord: len(n.len),
                        tip_chord: len(num("tipchord").unwrap_or(0.0)),
                        span: len(num("height").unwrap_or(0.0)),
                        sweep: len(num("sweeplength").unwrap_or(0.0)),
                        thickness: len(thickness),
                        cross_section,
                        cant,
                        tab,
                        fillet_radius,
                    }),
                    T::EllipticalFinSet => ComponentKind::EllipticalFinSet(EllipticalFinSet {
                        count,
                        root_chord: len(n.len),
                        span: len(num("height").unwrap_or(0.0)),
                        thickness: len(thickness),
                        cross_section,
                        cant,
                        tab,
                        fillet_radius,
                    }),
                    _ => ComponentKind::FreeformFinSet(FreeformFinSet {
                        count,
                        points: freeform_points(el)
                            .into_iter()
                            .map(|[x, y]| [len(x), len(y)])
                            .collect(),
                        thickness: len(thickness),
                        cross_section,
                        cant,
                        tab,
                        fillet_radius,
                    }),
                }
            }
            T::TubeFinSet => {
                let count = el
                    .num("instancecount")
                    .or_else(|| el.num("fincount"))
                    .filter(|c| c.is_finite() && *c >= 1.0)
                    .map_or(6, |c| c as u32);
                let r = radius(el, "outerradius").value.unwrap_or_else(|| {
                    let p = n.parent.unwrap_or(i);
                    self.parent_inner_dia(p).1 / 2.0 + thickness
                });
                ComponentKind::TubeFinSet(TubeFinSet {
                    count,
                    length: len(n.len),
                    od: len(2.0 * r),
                    id: None,
                    thickness: Some(len(thickness)),
                })
            }
            T::LaunchLug | T::RailButton => {
                let count = num("instancecount").filter(|c| *c >= 2.0).map(|c| c as u32);
                if let Some(count) = count {
                    instances = Some(Instances {
                        count,
                        pattern: InstancePattern::Linear,
                        start: None,
                        spacing: Some(len(num("instanceseparation").unwrap_or(0.0))),
                        preset: None,
                        scale: None,
                    });
                }
                if n.ty == T::LaunchLug {
                    ComponentKind::LaunchLug(LaunchLug {
                        length: len(n.len),
                        od: len(2.0 * num("radius").unwrap_or(0.0)),
                        id: None,
                        thickness: Some(len(thickness)),
                    })
                } else {
                    ComponentKind::RailButton(RailButton {
                        od: len(num("outerdiameter").unwrap_or(0.0)),
                        id: len(num("innerdiameter").unwrap_or(0.0)),
                        height: len(num("height").unwrap_or(0.0)),
                        base_height: num("baseheight").filter(|v| *v >= 0.0).map(len),
                        flange_height: num("flangeheight").filter(|v| *v >= 0.0).map(len),
                    })
                }
            }
            T::InnerTube if el.child(SYNTHETIC).is_some() => {
                let p = n.parent.unwrap_or(i);
                let (expr, inner) = self.parent_inner_dia(p);
                synthetic_mass = true;
                ComponentKind::InnerTube(InnerTube {
                    length: len(n.len),
                    od: expr.map_or_else(|| len(inner), qe),
                    id: None,
                    thickness: Some(len(0.00001)),
                    motor_mount: true,
                    overhang: el
                        .child("motormount")
                        .and_then(|m| m.num("overhang"))
                        .filter(|o| o.is_finite() && *o != 0.0)
                        .map(len),
                })
            }
            T::InnerTube => {
                let r = radius(el, "outerradius").value.unwrap_or(0.0);
                instances = self.cluster(i, el);
                ComponentKind::InnerTube(InnerTube {
                    length: len(n.len),
                    od: len(2.0 * r),
                    id: None,
                    thickness: Some(len(thickness)),
                    motor_mount: el.child("motormount").is_some(),
                    overhang: el
                        .child("motormount")
                        .and_then(|m| m.num("overhang"))
                        .filter(|o| o.is_finite() && *o != 0.0)
                        .map(len),
                })
            }
            T::Coupler => {
                let r = radius(el, "outerradius");
                let p = n.parent.unwrap_or(i);
                let (expr, inner) = self.parent_inner_dia(p);
                let od = match (r.auto, expr) {
                    (true, Some(e)) => qe(e),
                    _ => len(r.value.map_or(inner, |v| 2.0 * v)),
                };
                ComponentKind::Coupler(Coupler {
                    length: len(n.len),
                    od,
                    id: None,
                    thickness: Some(len(thickness)),
                })
            }
            T::CenteringRing | T::Bulkhead | T::EngineBlock => {
                let mut outer = radius(el, "outerradius");
                // Adopted by a synthesized mount: fills the mount's bore.
                if n.parent
                    .is_some_and(|p| self.tree.nodes[p].el.child(SYNTHETIC).is_some())
                {
                    outer.auto = true;
                }
                let od = (!outer.auto)
                    .then_some(outer.value)
                    .flatten()
                    .map(|r| len(2.0 * r));
                match n.ty {
                    T::Bulkhead => ComponentKind::Bulkhead(Bulkhead {
                        length: len(n.len),
                        od,
                    }),
                    T::EngineBlock => {
                        let p = n.parent.unwrap_or(i);
                        let (expr, inner) = self.parent_inner_dia(p);
                        let id = match (&od, expr) {
                            (None, Some(e)) => len_expr(&[(1.0, e)], -2.0 * thickness),
                            _ => {
                                let o = if outer.auto {
                                    outer.value.map_or(inner, |v| 2.0 * v)
                                } else {
                                    2.0 * outer.value.unwrap_or(0.0)
                                };
                                len((o - 2.0 * thickness).max(0.0))
                            }
                        };
                        ComponentKind::EngineBlock(EngineBlock {
                            length: len(n.len),
                            od,
                            id,
                        })
                    }
                    _ => ComponentKind::CenteringRing(CenteringRing {
                        length: len(n.len),
                        od,
                        id: self.ring_bore(i, el),
                    }),
                }
            }
            T::Parachute => {
                let cd = match el.text_of("cd") {
                    Some(t) if !t.starts_with("auto") => t.parse().unwrap_or(0.8),
                    _ => 0.8,
                };
                let line_material = self.material(el.child("linematerial"));
                ComponentKind::Parachute(Parachute {
                    diameter: len(num("diameter").unwrap_or(0.0)),
                    cd: Qty::number(cd),
                    spill_hole: num("spillholediameter").filter(|v| *v > 0.0).map(len),
                    line_count: num("linecount").filter(|c| *c >= 1.0).map(|c| c as u32),
                    line_length: num("linelength").filter(|v| *v > 0.0).map(len),
                    line_material,
                    packed_length: len(n.len),
                    packed_diameter: self.packed_dia(i, el),
                })
            }
            T::Streamer => ComponentKind::Streamer(Streamer {
                length: len(num("striplength").unwrap_or(0.0)),
                width: len(num("stripwidth").unwrap_or(0.0)),
                cd: el
                    .text_of("cd")
                    .filter(|t| !t.starts_with("auto"))
                    .and_then(|t| t.parse().ok())
                    .map(Qty::number),
                packed_length: len(n.len),
                packed_diameter: self.packed_dia(i, el),
            }),
            T::ShockCord => ComponentKind::ShockCord(ShockCord {
                cord_length: len(num("cordlength").unwrap_or(0.0)),
                packed_length: len(n.len),
                packed_diameter: self.packed_dia(i, el),
            }),
            _ => {
                material = None;
                let role = match el.text_of("masscomponenttype").unwrap_or("") {
                    "altimeter" => Some(MassRole::Altimeter),
                    "flightcomputer" => Some(MassRole::FlightComputer),
                    "battery" => Some(MassRole::Battery),
                    "tracker" => Some(MassRole::Tracker),
                    "payload" => Some(MassRole::Payload),
                    "masscomponent" | "" => None,
                    _ => Some(MassRole::Other),
                };
                ComponentKind::MassComponent(MassComponent {
                    mass: q::<Mass>(num("mass").unwrap_or(0.0), "g"),
                    length: len(n.len),
                    od: Some(self.packed_dia(i, el)).filter(|_| {
                        radius(el, "packedradius").auto
                            || num("packedradius").is_some_and(|r| r > 0.0)
                    }),
                    role,
                })
            }
        };
        Component {
            name: Some(n.name.clone()).filter(|nm| *nm != n.id),
            attach: self.attach(i),
            instances,
            overrides: if synthetic_mass {
                Some(Overrides {
                    mass: Some(q::<Mass>(0.0, "g")),
                    cg: None,
                    cd: None,
                    subtree: false,
                })
            } else {
                Self::overrides(el)
            },
            cut: false,
            material,
            finish: Self::finish(el),
            appearance: Self::appearance(el),
            joint: None,
            import: el.text_of("id").map(|u| ImportInfo {
                uuid: Some(u.to_string()),
                source: None,
            }),
            kind,
        }
    }

    /// A packed diameter (recovery items, mass components): the stored
    /// radius, or for `auto` the parent's bore as an expression.
    fn packed_dia(&self, i: usize, el: &Element) -> QLength {
        let r = radius(el, "packedradius");
        let fallback = |s: &Self| {
            let p = s.tree.nodes[i].parent.unwrap_or(i);
            s.parent_inner_dia(p)
        };
        match (r.auto, r.value) {
            (false, Some(v)) if v > 0.0 => len(2.0 * v),
            (true, _) => match fallback(self) {
                (Some(e), _) => qe(e),
                (None, d) => len(r.value.map_or(d, |v| 2.0 * v)),
            },
            _ => len(fallback(self).1),
        }
    }

    fn fin_tab(&self, el: &Element, root: f64) -> Option<FinTab> {
        let h = el.num("tabheight").filter(|v| v.is_finite()).unwrap_or(0.0);
        let l = el.num("tablength").filter(|v| v.is_finite()).unwrap_or(0.0);
        if h <= 0.0 && l <= 0.0 {
            return None;
        }
        let pos = el.child("tabposition");
        let off = pos
            .and_then(|p| crate::xml::parse_num(&p.text))
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
        let rel = pos
            .and_then(|p| p.attr("relativeto").or_else(|| p.attr("method")))
            .unwrap_or("front")
            .to_ascii_lowercase();
        let fore = match rel.as_str() {
            "center" | "middle" => root / 2.0 + off - l / 2.0,
            "end" | "bottom" => root + off - l,
            _ => off,
        };
        // Rounding in the placement arithmetic must not push a tab that
        // fills the root past it.
        let fore = if fore.abs() < 1e-12 { 0.0 } else { fore };
        let l = if fore + l > root && fore + l - root < 1e-12 {
            root - fore
        } else {
            l
        };
        Some(FinTab {
            height: len(h),
            length: len(l),
            offset: (fore != 0.0).then(|| len(fore)),
        })
    }

    /// A ring's bore: an auto bore wraps the inner tube it overlaps.
    fn ring_bore(&self, i: usize, el: &Element) -> QLength {
        let inner = radius(el, "innerradius");
        if inner.auto {
            let n = &self.tree.nodes[i];
            let tube = self.tree.nodes.iter().find(|t| {
                t.ty == ComponentType::InnerTube
                    && t.parent == n.parent
                    && t.x < n.x + n.len - 1e-12
                    && n.x < t.x + t.len - 1e-12
            });
            if let Some(t) = tube {
                return qe(format!("c.{}.od", t.id));
            }
        }
        len(2.0 * inner.value.unwrap_or(0.0))
    }

    fn cluster(&mut self, i: usize, el: &Element) -> Option<Instances> {
        let name = el.text_of("clusterconfiguration")?.to_ascii_lowercase();
        if name == "single" {
            return None;
        }
        let count: u32 = name
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(if name == "double" { 2 } else { 1 });
        if count < 2 {
            return None;
        }
        let preset = match (count, name.as_str()) {
            (2, _) => Some("2-row"),
            (3, n) if n.contains("ring") || n.contains("triangle") => Some("3-ring"),
            (4, n) if n.contains("ring") || n.contains("square") => Some("4-square"),
            (5, n) if n.contains("cross") || n.contains("plus") => Some("5-cross"),
            (6, n) if n.contains("ring") => Some("6-ring"),
            (7, n) if n.contains("hex") => Some("7-hex"),
            (_, n) if n.contains("ring") => None,
            _ => {
                let p = self.path(i);
                self.diags.push(approx(
                    p,
                    format!(
                        "cluster `{name}` has no RocketWright preset; a ring of {count} was used"
                    ),
                ));
                None
            }
        };
        let id = &self.tree.nodes[i].id;
        let scale = el
            .num("clusterscale")
            .filter(|s| s.is_finite())
            .unwrap_or(1.0);
        Some(Instances {
            count,
            pattern: InstancePattern::Cluster,
            start: el
                .num("clusterrotation")
                .filter(|r| r.is_finite() && *r != 0.0)
                .map(deg),
            spacing: None,
            preset: preset.map(str::to_string),
            scale: Some(if scale == 1.0 {
                qe(format!("c.{id}.od"))
            } else {
                qe(format!("{} * c.{id}.od", rw_units::format_number(scale)))
            }),
        })
    }
}

/// Marks a mount tube the importer made (child element name).
const SYNTHETIC: &str = "rw-synthetic-mount";

fn leaf(name: &str, text: &str) -> Element {
    Element {
        name: name.into(),
        text: text.into(),
        ..Element::default()
    }
}

/// A body tube that is itself a motor mount gets an inner tube holding its
/// motors (RocketWright mounts motors in inner tubes only): the tube's full
/// length and bore, zero mass, so mass and aero are unchanged.
fn synthesize_body_mounts(el: &mut Element, diags: &mut Vec<Diagnostic>) {
    if el.name == "bodytube"
        && let Some(k) = el.children.iter().position(|c| c.name == "motormount")
    {
        let mm = el.children.remove(k);
        let name = el.text_of("name").unwrap_or("Body tube").to_string();
        let mut tube = Element {
            name: "innertube".into(),
            ..Element::default()
        };
        tube.children
            .push(leaf("name", &format!("{name} motor mount")));
        let mut at = leaf("axialoffset", "0.0");
        at.attrs.insert("method".into(), "bottom".into());
        tube.children.push(at);
        // As long as the longest motor's part inside the tube.
        let overhang = mm.num("overhang").filter(|o| o.is_finite()).unwrap_or(0.0);
        let motor_len = mm
            .all("motor")
            .filter_map(|m| m.num("length"))
            .filter(|l| l.is_finite() && *l > 0.0)
            .fold(0.0, f64::max);
        let body_len = el.num("length").filter(|l| l.is_finite()).unwrap_or(0.0);
        let len = if motor_len > 0.0 {
            (motor_len - overhang).clamp(1e-3, body_len.max(1e-3))
        } else {
            body_len
        };
        tube.children
            .push(leaf("length", &crate::xml::fmt_num(len)));
        tube.children.push(leaf(SYNTHETIC, "true"));
        tube.children.push(mm);
        let subs = match el.children.iter().position(|c| c.name == "subcomponents") {
            Some(i) => i,
            None => {
                el.children.push(Element {
                    name: "subcomponents".into(),
                    ..Element::default()
                });
                el.children.len() - 1
            }
        };
        el.children[subs].children.push(tube);
        diags.push(approx(
            None,
            format!(
                "`{name}` is itself a motor mount; its motors moved to `{name} motor mount`, a zero-mass inner tube in its bore, as long as the motor (aft of any engine block)"
            ),
        ));
    }
    for c in &mut el.children {
        synthesize_body_mounts(c, diags);
    }
}

/// Engine blocks that overlap a synthesized mount tube (see
/// [`synthesize_body_mounts`]) move into it, keeping their stations, so
/// they sit in the motor tube as they did in the body tube.
fn adopt_engine_blocks(tree: &mut Tree<'_>) {
    for s in 0..tree.nodes.len() {
        if tree.nodes[s].el.child(SYNTHETIC).is_none() {
            continue;
        }
        let (parent, x0, x1) = {
            let n = &tree.nodes[s];
            (n.parent, n.x, n.x + n.len)
        };
        for b in &mut tree.nodes {
            if b.ty == ComponentType::EngineBlock
                && b.parent == parent
                && b.x < x1
                && b.x + b.len > x0
            {
                b.parent = Some(s);
                b.method = Method::Absolute;
                b.offset = b.x;
            }
        }
    }
}

/// Imports an `.ork` (see the crate docs).
pub fn import(files: &OrkFiles, opts: &ImportOptions<'_>) -> Result<OrkImport, OrkError> {
    let mut root = parse(&files.xml)?;
    let mut pre_diags = Vec::new();
    synthesize_body_mounts(&mut root, &mut pre_diags);
    let root = root;
    if root.name != "openrocket" {
        return Err(OrkError::NotOrk(format!(
            "the root element is <{}>, not <openrocket>",
            root.name
        )));
    }
    let rocket = root
        .child("rocket")
        .ok_or_else(|| OrkError::NotOrk("no <rocket> element".into()))?;
    let mut col = Collector {
        tree: Tree::default(),
        diags: pre_diags,
    };
    let stages: Vec<&Element> = Collector::subcomponents(rocket).collect();
    for s in stages {
        if s.name != "stage" && s.name != "axialstage" {
            col.diags.push(approx(
                None,
                format!("a <{}> at the top level was skipped", s.name),
            ));
            continue;
        }
        let k = col.tree.stages.len();
        col.tree.stages.push(StageNode {
            el: s,
            id: String::new(),
            name: s
                .text_of("name")
                .map(str::to_string)
                .unwrap_or_else(|| format!("Stage {}", k + 1)),
            first: None,
        });
        for c in Collector::subcomponents(s) {
            col.component(c, None, k);
        }
    }
    if col.tree.chain.is_empty() {
        return Err(OrkError::NotOrk("the rocket has no body components".into()));
    }
    let mut tree = col.tree;
    finish_tree(&mut tree);
    adopt_engine_blocks(&mut tree);
    let mut diags = col.diags;
    let radii = chain_radii(&tree, &mut diags);
    let mut em = Emitter {
        tree: &tree,
        radii,
        materials: BTreeMap::new(),
        material_keys: BTreeMap::new(),
        diags,
    };
    let mut doc = RocketDoc {
        name: rocket.text_of("name").map(str::to_string),
        ..RocketDoc::default()
    };
    for i in 0..tree.nodes.len() {
        let c = em.component(i);
        doc.c.insert(tree.nodes[i].id.clone(), c);
    }
    doc.materials = std::mem::take(&mut em.materials);
    let stage_overrides: Vec<Option<Overrides>> = tree
        .stages
        .iter()
        .map(|s| {
            let mut o = Emitter::overrides(s.el)?;
            let path = Some(format!("/stage/{}/override", s.id));
            if o.cd.take().is_some() {
                em.diags.push(approx(
                    path.clone(),
                    format!("stage `{}`: the CD override was dropped", s.name),
                ));
            }
            if !o.subtree {
                em.diags.push(approx(
                    path,
                    format!(
                        "stage `{}`: a mass/CG override that leaves out the subcomponents was dropped",
                        s.name
                    ),
                ));
                return None;
            }
            (o.mass.is_some() || o.cg.is_some()).then_some(o)
        })
        .collect();
    let staged = tree.stages.iter().filter(|s| s.first.is_some()).count() > 1;
    for (s, o) in tree.stages.iter().zip(stage_overrides) {
        if !(staged || o.is_some()) {
            continue;
        }
        if let Some(f) = s.first {
            doc.stage.insert(
                s.id.clone(),
                StageDef {
                    first: tree.nodes[f].id.clone(),
                    name: Some(s.name.clone()),
                    overrides: o,
                },
            );
        }
    }
    let mut out = OrkImport {
        name: doc.name.clone().unwrap_or_else(|| "Imported rocket".into()),
        format_version: root.attr("version").map(str::to_string),
        uuids: tree
            .nodes
            .iter()
            .filter_map(|n| Some((n.id.clone(), n.el.text_of("id")?.to_string())))
            .collect(),
        diagnostics: std::mem::take(&mut em.diags),
        ..OrkImport::default()
    };
    crate::sims::configs(&root, rocket, &tree, files, opts, &mut out);
    crate::sims::sims(&root, &mut out);
    out.rocket = doc;
    Ok(out)
}
