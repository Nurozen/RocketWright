//! A part that draws its mass from a material but names none (`RW-W004`).
//! Its mass is zero, so without this the check and the flight go ahead on a
//! lighter rocket than the one designed, and nothing says so.

use std::collections::{BTreeMap, BTreeSet};

use rw_mass::inactive_members;
use rw_model::components::material::density_kind;
use rw_model::{Diagnostic, EvalComponent, EvaluatedModel, diag as model_diag};

/// The parts an override leaves with a mass, worked out in the order
/// `rw_mass::MassModel::new` applies them: deepest component first, then
/// stages, so the last override to reach a part decides. Parts in a stage the
/// configuration disables take no part, and neither does an override set on
/// one, even over a subtree that still flies. A mass of zero stays zero, and
/// a `cg` or `cd` override changes no mass, so neither of those counts.
fn mass_overridden(model: &EvaluatedModel) -> BTreeSet<&str> {
    let skip = inactive_members(model);
    let by_id: BTreeMap<&str, &EvalComponent> = model
        .components
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();
    let parent = |c: &EvalComponent| c.parent.as_deref().and_then(|p| by_id.get(p).copied());
    let within = |c: &EvalComponent, root: &str| {
        std::iter::successors(Some(c), |a| parent(a))
            // Bounded in case a parent chain ever loops.
            .take(model.components.len() + 1)
            .any(|a| a.id == root)
    };
    let mut last: BTreeMap<&str, f64> = BTreeMap::new();
    for c in model.components.iter().rev() {
        let Some(o) = c.overrides.as_ref() else {
            continue;
        };
        let Some(mass) = o.mass else { continue };
        if skip.contains(c.id.as_str()) {
            continue;
        }
        let members = model.components.iter().filter(|p| {
            !skip.contains(p.id.as_str()) && (p.id == c.id || (o.subtree && within(p, &c.id)))
        });
        for member in members {
            last.insert(member.id.as_str(), mass);
        }
    }
    for st in &model.stages {
        let Some(mass) = st.overrides.as_ref().and_then(|o| o.mass) else {
            continue;
        };
        for id in st.members.iter().filter(|id| !skip.contains(id.as_str())) {
            last.insert(id.as_str(), mass);
        }
    }
    last.into_iter()
        .filter(|&(_, mass)| mass > 0.0)
        .map(|(id, _)| id)
        .collect()
}

/// `RW-W004` per part that needs a material and has none. Mass components carry
/// their own mass, a cut takes its parent's density, a part under a mass
/// override gets its mass from that, and a part whose stage is switched off
/// does not fly at all.
pub(crate) fn missing_material_diags(model: &EvaluatedModel) -> Vec<Diagnostic> {
    let overridden = mass_overridden(model);
    let skip = inactive_members(model);
    model
        .components
        .iter()
        .filter(|c| c.material.is_none() && !c.cut && !overridden.contains(c.id.as_str()))
        .filter(|c| !skip.contains(c.id.as_str()))
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

    fn source(files: &[(&str, &str)]) -> SourceSet {
        let mut set = SourceSet::default();
        for (path, text) in files {
            let (doc, warnings) = parse_source_with_warnings(path, text).unwrap();
            assert!(warnings.is_empty(), "{warnings:?}");
            set.docs.insert((*path).to_string(), doc);
        }
        set
    }

    fn reported(model: &EvaluatedModel) -> Vec<String> {
        missing_material_diags(model)
            .into_iter()
            .map(|d| format!("{} {}", d.code, d.path.unwrap_or_default()))
            .collect()
    }

    fn codes(rocket: &str) -> Vec<String> {
        let model = eval(
            &source(&[("rocket.rw.toml", rocket)]),
            &EvalOptions::default(),
        );
        assert!(model.diagnostics.is_empty(), "{:#?}", model.diagnostics);
        reported(&model)
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

    /// The mass engine flies an override of 0 as 0, so the warning is true.
    #[test]
    fn a_zero_mass_override_leaves_the_warning() {
        let all = missing(&["body", "tube", "liner"]);
        assert_eq!(nested(r#"override = { mass = "0 g" }"#), all);
        assert_eq!(
            nested(r#"override = { mass = "0 g", subtree = true }"#),
            all
        );
    }

    /// A body with a tube inside, each with its own override text.
    fn parent_and_child(body: &str, tube: &str) -> Vec<String> {
        codes(&format!(
            r#"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
{body}

[c.tube]
type = "inner_tube"
attach = {{ to = "body.inner", at = "fore" }}
length = "100 mm"
od = "20 mm"
thickness = "1 mm"
{tube}
"#
        ))
    }

    /// Overrides apply deepest first, so the outer one decides what is left.
    #[test]
    fn the_last_override_the_engine_applies_decides() {
        assert_eq!(
            parent_and_child(
                r#"override = { mass = "0 g", subtree = true }"#,
                r#"override = { mass = "50 g" }"#
            ),
            missing(&["body", "tube"])
        );
        assert_eq!(
            parent_and_child(
                r#"override = { mass = "50 g", subtree = true }"#,
                r#"override = { mass = "0 g" }"#
            ),
            Vec::<String>::new()
        );
    }

    /// The configuration switches the sustainer off; the booster below it still flies.
    fn sustainer_off(nose_override: &str) -> Vec<String> {
        let rocket = format!(
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
thickness = "1 mm"
{nose_override}

[c.booster]
type = "body_tube"
attach = {{ to = "nose.base" }}
length = "150 mm"
od = "40 mm"
thickness = "1 mm"
"#
        );
        let set = source(&[
            (
                "rocketwright.toml",
                "format = 1\nname = \"T\"\ndefault_config = \"flight\"\n",
            ),
            ("rocket.rw.toml", &rocket),
            (
                "configs/flight.rw.toml",
                "name = \"Flight\"\n\n[stages.sustainer]\nactive = false\n",
            ),
        ]);
        let model = eval(&set, &EvalOptions::default());
        assert_eq!(model.config.as_deref(), Some("flight"));
        reported(&model)
    }

    /// `rw_mass::MassModel::new` drops an override on a part that does not fly.
    #[test]
    fn an_inactive_ancestors_subtree_override_covers_nothing() {
        assert_eq!(
            sustainer_off(r#"override = { mass = "50 g", subtree = true }"#),
            missing(&["booster"])
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
