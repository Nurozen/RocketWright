//! A part that draws its mass from a material but names none (`RW-W004`).
//! Its mass is zero, so without this the check and the flight go ahead on a
//! lighter rocket than the one designed, and nothing says so.

use std::collections::{BTreeMap, BTreeSet};

use rw_model::components::material::density_kind;
use rw_model::{Diagnostic, EvalComponent, EvalOverride, EvaluatedModel, diag as model_diag};

fn sets_mass(o: &EvalOverride) -> bool {
    o.mass.is_some()
}

/// The parts an override gives a mass: the part itself, everything below a
/// `subtree` override, and a stage's members. These are the groups
/// `rw_mass::MassModel::new` applies overrides to. A `cg` or `cd` override
/// leaves a part with no material weighing nothing, so it does not count.
fn mass_overridden(model: &EvaluatedModel) -> BTreeSet<&str> {
    let by_id: BTreeMap<&str, &EvalComponent> = model
        .components
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();
    let parent = |c: &EvalComponent| c.parent.as_deref().and_then(|p| by_id.get(p).copied());
    let below_a_subtree_override = |c: &EvalComponent| {
        std::iter::successors(parent(c), |a| parent(a))
            // Bounded in case a parent chain ever loops.
            .take(model.components.len())
            .any(|a| {
                a.overrides
                    .as_ref()
                    .is_some_and(|o| sets_mass(o) && o.subtree)
            })
    };
    let parts = model
        .components
        .iter()
        .filter(|c| c.overrides.as_ref().is_some_and(sets_mass) || below_a_subtree_override(c))
        .map(|c| c.id.as_str());
    let stage_members = model
        .stages
        .iter()
        .filter(|s| s.overrides.as_ref().is_some_and(sets_mass))
        .flat_map(|s| s.members.iter().map(String::as_str));
    parts.chain(stage_members).collect()
}

/// `RW-W004` per part that needs a material and has none. Mass components carry
/// their own mass, a cut takes its parent's density, and a part under a mass
/// override gets its mass from that.
pub(crate) fn missing_material_diags(model: &EvaluatedModel) -> Vec<Diagnostic> {
    let overridden = mass_overridden(model);
    model
        .components
        .iter()
        .filter(|c| c.material.is_none() && !c.cut && !overridden.contains(c.id.as_str()))
        .filter_map(|c| {
            let kind = density_kind(c.component_type())?;
            Some(
                Diagnostic::new(
                    model_diag::W_MATERIAL_MISSING,
                    format!("/c/{}/material", c.id),
                    format!(
                        "`{}` has no material, so it has no mass in checks or flights",
                        c.id
                    ),
                )
                .with_hint(format!("Pick a material with a `{}`.", kind.field())),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use rw_model::{EvalOptions, SourceSet, eval, parse_source_with_warnings};

    use super::*;

    fn codes(rocket: &str) -> Vec<String> {
        let (doc, warnings) = parse_source_with_warnings("rocket.rw.toml", rocket).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let mut set = SourceSet::default();
        set.docs.insert("rocket.rw.toml".to_string(), doc);
        let model = eval(&set, &EvalOptions::default());
        assert!(model.diagnostics.is_empty(), "{:#?}", model.diagnostics);
        missing_material_diags(&model)
            .into_iter()
            .map(|d| format!("{} {}", d.code, d.path.unwrap_or_default()))
            .collect()
    }

    #[test]
    fn warns_for_a_part_with_no_material_and_not_for_a_mass_component_or_a_cut() {
        assert_eq!(
            codes(
                r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

[c.w]
type = "mass_component"
attach = { to = "body.inner", at = "fore" }
mass = "2 g"
length = "30 mm"

[c.slot]
type = "inner_tube"
attach = { to = "body.inner", at = "fore" }
cut = true
length = "30 mm"
od = "20 mm"
thickness = "1 mm"
"#
            ),
            vec!["RW-W004 /c/body/material".to_string()]
        );
    }

    /// A body with an inner tube, and a tube inside that, none with a material.
    fn nested(over: &str) -> Vec<String> {
        codes(&format!(
            r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
{over}

[c.tube]
type = "inner_tube"
attach = {{ to = "body.inner", at = "fore" }}
length = "100 mm"
od = "20 mm"
thickness = "1 mm"

[c.liner]
type = "inner_tube"
attach = {{ to = "tube.inner", at = "fore" }}
length = "50 mm"
od = "15 mm"
thickness = "1 mm"
"#
        ))
    }

    fn missing(ids: &[&str]) -> Vec<String> {
        ids.iter()
            .map(|id| format!("RW-W004 /c/{id}/material"))
            .collect()
    }

    #[test]
    fn a_mass_override_covers_its_part_and_no_other() {
        assert_eq!(
            nested(r#"override = { mass = "50 g" }"#),
            missing(&["tube", "liner"])
        );
    }

    #[test]
    fn a_subtree_mass_override_covers_every_descendant() {
        assert_eq!(
            nested(r#"override = { mass = "50 g", subtree = true }"#),
            Vec::<String>::new()
        );
    }

    /// Without a mass, the part still weighs nothing, so the warning is true.
    #[test]
    fn an_override_without_a_mass_leaves_the_warning() {
        let all = missing(&["body", "tube", "liner"]);
        assert_eq!(nested(r#"override = { cg = "20 mm" }"#), all);
        assert_eq!(
            nested(r#"override = { cg = "20 mm", subtree = true }"#),
            all
        );
    }

    fn staged(over: &str) -> Vec<String> {
        codes(&format!(
            r#"
[stage.sustainer]
first = "nose"
[stage.booster]
first = "booster"
override = {over}

[c.nose]
type = "nose_cone"
shape = "conical"
length = "100 mm"
od = "40 mm"
thickness = "1 mm"

[c.booster]
type = "body_tube"
attach = {{ to = "nose.base" }}
length = "150 mm"
od = "40 mm"
thickness = "1 mm"
"#
        ))
    }

    #[test]
    fn a_stage_mass_override_covers_its_members_only() {
        assert_eq!(
            staged(r#"{ mass = "300 g", subtree = true }"#),
            missing(&["nose"])
        );
        assert_eq!(
            staged(r#"{ cg = "50 mm", subtree = true }"#),
            missing(&["nose", "booster"])
        );
    }

    #[test]
    fn a_part_with_a_material_is_silent() {
        assert!(
            codes(
                r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
material = "cardboard"

[materials.cardboard]
density = "680 kg/m^3"
"#
            )
            .is_empty()
        );
    }
}
