//! Materials (`[materials.<name>]`) with bulk, surface, or line density, and
//! the density kind each component kind draws its mass from.
//!
//! Library materials (`lib/materials/`) reach the model through the project
//! layout (M1.25b), so a name that is not under `[materials]` once the
//! sources are merged is unknown.

use std::collections::BTreeMap;

use rw_units::DimKind;
use serde::{Deserialize, Serialize};

use super::{Check, show};
use crate::diag::{self, Diagnostic};
use crate::types::{ComponentType, EvalComponent, EvalMaterial, EvalShape, Material};

/// How a component's mass follows from its material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DensityKind {
    /// kg/m³ × solid volume (shells, tubes, rings, fins).
    Bulk,
    /// kg/m² × area (parachute canopies, streamers).
    Surface,
    /// kg/m × length (shock cords, shroud lines).
    Line,
}

impl DensityKind {
    pub const fn field(self) -> &'static str {
        match self {
            DensityKind::Bulk => "density",
            DensityKind::Surface => "surface_density",
            DensityKind::Line => "line_density",
        }
    }

    const fn dim(self) -> DimKind {
        match self {
            DensityKind::Bulk => DimKind::Density,
            DensityKind::Surface => DimKind::AreaDensity,
            DensityKind::Line => DimKind::LineDensity,
        }
    }
}

/// The density kind a component kind's `material` must define; `None` for
/// kinds whose mass is given directly (mass components).
pub const fn density_kind(t: ComponentType) -> Option<DensityKind> {
    match t {
        ComponentType::Parachute | ComponentType::Streamer => Some(DensityKind::Surface),
        ComponentType::ShockCord => Some(DensityKind::Line),
        ComponentType::MassComponent => None,
        _ => Some(DensityKind::Bulk),
    }
}

/// The density of `kind` a material defines, if any.
pub fn density_of(m: &EvalMaterial, kind: DensityKind) -> Option<f64> {
    match kind {
        DensityKind::Bulk => m.density,
        DensityKind::Surface => m.surface_density,
        DensityKind::Line => m.line_density,
    }
}

fn check_ref(
    chk: &mut Check,
    field: &str,
    name: &str,
    kind: DensityKind,
    materials: &BTreeMap<String, EvalMaterial>,
) {
    let Some(m) = materials.get(name) else {
        let known: Vec<&str> = materials.keys().map(String::as_str).collect();
        chk.push(
            diag::E_MATERIAL_UNKNOWN,
            field,
            format!("`{}.{field}` names `{name}`, which is not defined", chk.id),
            if known.is_empty() {
                format!("add `[materials.{name}]` with a `{}`", kind.field())
            } else {
                format!(
                    "use one of: {}; or add `[materials.{name}]`",
                    known.join(", ")
                )
            },
        );
        return;
    };
    if density_of(m, kind).is_none() {
        chk.push(
            diag::E_MATERIAL_DENSITY,
            field,
            format!(
                "material `{name}` has no `{}`, which `{}` needs",
                kind.field(),
                chk.id
            ),
            format!(
                "add `{} = \"...\"` to `[materials.{name}]` or pick another material",
                kind.field()
            ),
        );
    }
}

/// Component-side checks: `material` (and a parachute's `line_material`)
/// exist and define the density kind the component needs.
pub(crate) fn check(
    chk: &mut Check,
    src: &crate::types::Component,
    e: &EvalComponent,
    materials: &BTreeMap<String, EvalMaterial>,
) {
    if let (Some(name), Some(kind)) = (&src.material, density_kind(e.component_type())) {
        check_ref(chk, "material", name, kind, materials);
    }
    if let EvalShape::Parachute {
        line_material: Some(name),
        ..
    } = &e.shape
    {
        check_ref(chk, "line_material", name, DensityKind::Line, materials);
    }
}

/// Material-side checks: each material defines at least one density, and
/// every density given is positive. Pointers are `/materials/<name>/...`.
pub fn check_defs(
    src: &BTreeMap<String, Material>,
    eval: &BTreeMap<String, EvalMaterial>,
) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (name, m) in eval {
        let given = [DensityKind::Bulk, DensityKind::Surface, DensityKind::Line]
            .into_iter()
            .filter_map(|k| density_of(m, k).map(|v| (k, v)))
            .collect::<Vec<_>>();
        if given.is_empty() && src.contains_key(name) {
            out.push(
                Diagnostic::new(
                    diag::E_MATERIAL_DENSITY,
                    format!("/materials/{name}"),
                    format!("material `{name}` defines no density"),
                )
                .with_hint("add `density`, `surface_density`, or `line_density`"),
            );
        }
        for (k, v) in given {
            if v <= 0.0 {
                out.push(
                    Diagnostic::new(
                        diag::E_MATERIAL_DENSITY,
                        format!("/materials/{name}/{}", k.field()),
                        format!(
                            "material `{name}`: `{}` must be greater than 0 (is {})",
                            k.field(),
                            show(v, k.dim())
                        ),
                    )
                    .with_hint(format!("set a positive `{}`", k.field())),
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn density_kind_per_component_kind() {
        use ComponentType as T;
        for t in ComponentType::ALL {
            let want = match t {
                T::Parachute | T::Streamer => Some(DensityKind::Surface),
                T::ShockCord => Some(DensityKind::Line),
                T::MassComponent => None,
                _ => Some(DensityKind::Bulk),
            };
            assert_eq!(density_kind(*t), want, "{t:?}");
        }
    }

    #[test]
    fn bulk_surface_and_line_densities_evaluate_in_si() {
        let m = on_body(
            r#"
[materials.cardboard]
density = "0.68 g/cm^3"
[materials.ripstop]
surface_density = "67 g/m^2"
[materials.elastic]
line_density = "1.8 g/m"
"#,
        );
        assert_clean(&m);
        let close = |a: Option<f64>, b: f64| (a.unwrap() - b).abs() < 1e-12;
        assert!(close(m.materials["cardboard"].density, 680.0));
        assert!(close(m.materials["ripstop"].surface_density, 0.067));
        assert!(close(m.materials["elastic"].line_density, 0.0018));
        assert_eq!(m.units["density"], "kg/m^3");
    }

    #[test]
    fn unknown_material_and_wrong_density_kind() {
        let m = model(
            r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
material = "cardbord"

[c.chute]
type = "parachute"
attach = { to = "body.inner", at = "attach" }
material = "cardboard"
line_material = "cardboard"
diameter = "300 mm"
cd = 0.8
packed_length = "42 mm"
packed_diameter = "18 mm"

[c.cord]
type = "shock_cord"
attach = { to = "body.inner", at = "attach" }
material = "elastic"
cord_length = "400 mm"
packed_length = "52 mm"
packed_diameter = "12 mm"

[c.w]
type = "mass_component"
attach = { to = "body.inner", at = "fore" }
mass = "2 g"
length = "30 mm"
material = "cardboard"

[materials.cardboard]
density = "680 kg/m^3"

[materials.elastic]
line_density = "1.8 g/m"

[materials.empty]
doc = "nothing"

[materials.negative]
density = "-1 kg/m^3"
"#,
        );
        assert_diag(&m, "RW-E063", "/c/body/material");
        assert_diag(&m, "RW-E064", "/c/chute/material");
        assert_diag(&m, "RW-E064", "/c/chute/line_material");
        assert_diag(&m, "RW-E064", "/materials/empty");
        assert_diag(&m, "RW-E064", "/materials/negative/density");
        // The cord's line density is right; a mass component ignores its material.
        let got = codes(&m);
        assert!(
            !got.iter().any(|(_, p)| p.starts_with("/c/cord")),
            "{got:?}"
        );
        assert!(!got.iter().any(|(_, p)| p.starts_with("/c/w/")), "{got:?}");
        let d = m
            .diagnostics
            .iter()
            .find(|d| d.path.as_deref() == Some("/c/body/material"))
            .unwrap();
        assert!(d.hint.as_deref().unwrap().contains("cardboard"), "{d:?}");
    }
}
