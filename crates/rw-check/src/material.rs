//! A part that draws its mass from a material but names none (`RW-W004`).
//! Its mass is zero, so without this the check and the flight go ahead on a
//! lighter rocket than the one designed, and nothing says so.

use rw_model::components::material::density_kind;
use rw_model::{Diagnostic, EvaluatedModel, diag as model_diag};

/// `RW-W004` per part that needs a material and has none. Mass components carry
/// their own mass, and a cut takes its parent's density.
pub(crate) fn missing_material_diags(model: &EvaluatedModel) -> Vec<Diagnostic> {
    model
        .components
        .iter()
        .filter(|c| c.material.is_none() && !c.cut)
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
