//! `cargo xtask diag-docs [--check]`: the generated parts of the agent briefing
//! (plan M1.56, invariant I9).
//!
//! Writes:
//! - `docs/agents/diagnostics.md`: every diagnostic code from
//!   `rw_model::diag::CODES`, `rw_check::diag::CODES`, and
//!   `rw_liquid::diag::CODES`, sorted;
//! - the marked blocks of `docs/agents/rocketwright-model.md`
//!   (`<!-- generated:NAME -->` ... `<!-- /generated:NAME -->`):
//!   `components` (type, anchors, placement, required fields; from
//!   `ComponentType::anchors`, the containment rules, and the `rocket` schema),
//!   `units` (the unit table by dimension), and `diagnostics` (the code table).
//!
//! `--check` writes nothing and exits 1 when a file or block is stale.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rw_model::diag::CodeInfo;
use rw_model::types::{AnchorKind, ComponentType};
use rw_model::{Severity, containment};
use serde_json::Value;

pub const DIAG_MD: &str = "docs/agents/diagnostics.md";
pub const MODEL_MD: &str = "docs/agents/rocketwright-model.md";

pub fn main(args: &[String]) -> ExitCode {
    let mut check = false;
    let mut root: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--check" => check = true,
            "--root" => root = it.next().map(PathBuf::from),
            other => {
                eprintln!("xtask diag-docs: unknown argument `{other}`");
                eprintln!("usage: cargo xtask diag-docs [--check] [--root <repo>]");
                return ExitCode::from(2);
            }
        }
    }
    let root = root.unwrap_or_else(crate::audit::repo_root);
    let files = match expected(&root) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("xtask diag-docs: {e}");
            return ExitCode::FAILURE;
        }
    };
    if check {
        let stale = stale(&root, &files);
        if stale.is_empty() {
            println!("xtask diag-docs --check: {} files current", files.len());
            return ExitCode::SUCCESS;
        }
        for s in &stale {
            eprintln!("docs drift: {s}");
        }
        eprintln!("run `cargo xtask diag-docs` and commit docs/agents/");
        return ExitCode::FAILURE;
    }
    for (rel, text) in &files {
        let path = root.join(rel);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if let Some(dir) = path.parent()
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            eprintln!("xtask diag-docs: {}: {e}", dir.display());
            return ExitCode::FAILURE;
        }
        if let Err(e) = std::fs::write(&path, text) {
            eprintln!("xtask diag-docs: {}: {e}", path.display());
            return ExitCode::FAILURE;
        }
        println!("xtask diag-docs: wrote {rel}");
    }
    ExitCode::SUCCESS
}

/// Paths (relative to the repo) whose current text differs from `files`.
pub fn stale(root: &Path, files: &BTreeMap<String, String>) -> Vec<String> {
    files
        .iter()
        .filter(|(rel, text)| {
            std::fs::read_to_string(root.join(rel)).ok().as_deref() != Some(text.as_str())
        })
        .map(|(rel, _)| rel.clone())
        .collect()
}

/// The expected text of every generated file, keyed by repo-relative path.
pub fn expected(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    out.insert(DIAG_MD.to_string(), diagnostics_md());
    let model_path = root.join(MODEL_MD);
    let model = std::fs::read_to_string(&model_path)
        .map_err(|e| format!("{}: {e}", model_path.display()))?;
    let schema = rocket_schema()?;
    let mut text = splice(&model, "components", &components_table(&schema)?)?;
    text = splice(&text, "units", &units_table())?;
    text = splice(&text, "diagnostics", &diagnostics_table())?;
    out.insert(MODEL_MD.to_string(), text);
    Ok(out)
}

fn rocket_schema() -> Result<Value, String> {
    let files = crate::schema::generate()?;
    let text = files
        .get("rocket.json")
        .ok_or("the schema registry has no `rocket` entry")?;
    serde_json::from_str(text).map_err(|e| format!("rocket.json: {e}"))
}

/// Every code, sorted: `rw-model` (E000-099, W0xx, liquid E200-219 and
/// W2xx), `rw-check` (E100-199, W1xx), and `rw-liquid` (E220-249).
pub fn all_codes() -> Vec<&'static CodeInfo> {
    let mut v: Vec<&CodeInfo> = rw_model::diag::CODES
        .iter()
        .chain(rw_check::diag::CODES.iter())
        .chain(rw_liquid::diag::CODES.iter())
        .collect();
    v.sort_by_key(|c| c.code);
    v
}

fn sev(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
    }
}

/// The diagnostic code table (markdown).
pub fn diagnostics_table() -> String {
    let mut s = String::from("| Code | Slug | Severity | Meaning |\n|---|---|---|---|\n");
    for c in all_codes() {
        s.push_str(&format!(
            "| `{}` | `{}` | {} | {} |\n",
            c.code,
            c.slug,
            sev(c.severity),
            c.summary.replace('|', "\\|")
        ));
    }
    s
}

/// `docs/agents/diagnostics.md`.
pub fn diagnostics_md() -> String {
    format!(
        "# RocketWright diagnostic codes\n\n\
         <!-- Generated by `cargo xtask diag-docs` from rw-model and rw-check. Do not edit. -->\n\n\
         Every finding of `rw check` carries a stable code, a JSON-pointer `path`\n\
         into the model, a message, and usually a `hint` saying what to change.\n\
         Code ranges: E000-049 parse, units, expressions; E050-099 anchors,\n\
         containment, and component values; E100-149 aero and stability; E150-199\n\
         clearance and fit; W001-099 model warnings; W100-149 motor; W150-199\n\
         clearance advisories. `rw check` exits 1 on any error or failed\n\
         `[[assert]]`, and with `--strict` also on any warning.\n\n{}",
        diagnostics_table()
    )
}

/// Replaces the body between `<!-- generated:NAME -->` and
/// `<!-- /generated:NAME -->` (both kept) with `body`.
pub fn splice(doc: &str, name: &str, body: &str) -> Result<String, String> {
    let open = format!("<!-- generated:{name} -->");
    let close = format!("<!-- /generated:{name} -->");
    let a = doc
        .find(&open)
        .ok_or_else(|| format!("{MODEL_MD} has no `{open}` marker"))?;
    let start = a + open.len();
    let b = doc[start..]
        .find(&close)
        .ok_or_else(|| format!("{MODEL_MD} has no `{close}` after `{open}`"))?
        + start;
    Ok(format!("{}\n{}{}", &doc[..start], body, &doc[b..]))
}

fn kind_name(k: AnchorKind) -> &'static str {
    match k {
        AnchorKind::Axial => "axial",
        AnchorKind::Inner => "inner",
        AnchorKind::Surface => "surface",
    }
}

/// Where a type may go: `first` (root) and/or `<kind> of a, b, c`.
fn placement(t: ComponentType) -> String {
    let mut parts = Vec::new();
    if containment::can_be_root(t) {
        parts.push("first body component".to_string());
    }
    for k in [AnchorKind::Axial, AnchorKind::Surface, AnchorKind::Inner] {
        let ps = containment::parents_of(t, k);
        if !ps.is_empty() {
            let names: Vec<String> = ps.iter().map(|p| format!("`{}`", p.name())).collect();
            parts.push(format!("{} of {}", kind_name(k), names.join(", ")));
        }
    }
    parts.join("; ")
}

/// Required fields of each component type, `name (dimension)`, from the
/// published `rocket` schema (`$defs.Component.oneOf[*]`).
fn required_fields(schema: &Value) -> Result<BTreeMap<String, Vec<String>>, String> {
    let defs = &schema["$defs"];
    let one_of = defs["Component"]["oneOf"]
        .as_array()
        .ok_or("rocket schema: no $defs.Component.oneOf")?;
    let mut out = BTreeMap::new();
    for item in one_of {
        let ty = item["properties"]["type"]["const"]
            .as_str()
            .ok_or("rocket schema: a Component variant has no `type` const")?;
        let def_name = item["$ref"]
            .as_str()
            .and_then(|r| r.strip_prefix("#/$defs/"))
            .ok_or_else(|| format!("rocket schema: `{ty}` has no $ref"))?;
        let def = &defs[def_name];
        let fields = def["required"]
            .as_array()
            .map(|r| {
                r.iter()
                    .filter_map(Value::as_str)
                    .map(
                        |f| match def["properties"][f]["x-unit-dimension"].as_str() {
                            Some(d) => format!("`{f}` ({d})"),
                            None => format!("`{f}`"),
                        },
                    )
                    .collect()
            })
            .unwrap_or_default();
        out.insert(ty.to_string(), fields);
    }
    Ok(out)
}

/// One row per component type: anchors, placement, required fields.
pub fn components_table(schema: &Value) -> Result<String, String> {
    let req = required_fields(schema)?;
    let mut s = String::from(
        "| `type` | Anchors | May go (containment: parent types) | Required fields |\n|---|---|---|---|\n",
    );
    for &t in ComponentType::ALL {
        let anchors: Vec<String> = t.anchors().iter().map(|a| format!("`{a}`")).collect();
        let fields = req
            .get(t.name())
            .ok_or_else(|| format!("rocket schema has no component type `{}`", t.name()))?;
        s.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            t.name(),
            anchors.join(" "),
            placement(t),
            if fields.is_empty() {
                "none".to_string()
            } else {
                fields.join(", ")
            }
        ));
    }
    Ok(s)
}

/// Unit symbols by named dimension (aliases in parentheses).
pub fn units_table() -> String {
    let mut s = String::from("| Dimension | Units |\n|---|---|\n");
    let mut seen = Vec::new();
    for &k in rw_units::DimKind::ALL {
        let d = k.dimension();
        if seen.contains(&d) {
            continue;
        }
        seen.push(d);
        // Dimensions that share an exponent vector (energy, torque) share a row.
        let names: Vec<&str> = rw_units::DimKind::ALL
            .iter()
            .filter(|o| o.dimension() == d)
            .map(|o| o.name())
            .collect();
        let units: Vec<String> = rw_units::UNITS
            .iter()
            .filter(|u| u.dim == d)
            .map(|u| {
                if u.aliases.is_empty() {
                    format!("`{}`", u.symbol)
                } else {
                    let al: Vec<String> = u.aliases.iter().map(|a| format!("`{a}`")).collect();
                    format!("`{}` ({})", u.symbol, al.join(", "))
                }
            })
            .collect();
        if units.is_empty() {
            continue;
        }
        s.push_str(&format!(
            "| {} | {} |\n",
            names.join(", "),
            units.join(", ")
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splice_replaces_only_the_marked_body() {
        let doc = "a\n<!-- generated:x -->\nold\n<!-- /generated:x -->\nb\n";
        let out = splice(doc, "x", "new\n").unwrap();
        assert_eq!(
            out,
            "a\n<!-- generated:x -->\nnew\n<!-- /generated:x -->\nb\n"
        );
        assert_eq!(splice(&out, "x", "new\n").unwrap(), out);
        assert!(splice(doc, "y", "z").is_err());
    }

    #[test]
    fn codes_are_unique_and_sorted() {
        let v = all_codes();
        for w in v.windows(2) {
            assert!(w[0].code < w[1].code, "{} !< {}", w[0].code, w[1].code);
        }
        let t = diagnostics_table();
        assert!(t.contains("| `RW-E101` | `unstable` | error |"));
        assert!(t.contains("| `RW-E021` | `unit-missing` | error |"));
    }

    #[test]
    fn components_table_covers_every_type() {
        let t = components_table(&rocket_schema().unwrap()).unwrap();
        for &ty in ComponentType::ALL {
            assert!(t.contains(&format!("| `{}` |", ty.name())), "{}", ty.name());
        }
        assert!(t.contains("`root_le` `root_te`"));
        assert!(t.contains("first body component"));
    }

    #[test]
    fn units_table_lists_lengths() {
        let t = units_table();
        assert!(t.contains("| length | `m`, `km`, `cm`, `mm`"), "{t}");
    }
}
