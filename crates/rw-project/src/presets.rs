//! Built-in parts presets (plan M2.13, D21): `lib/presets/*.json`, converted
//! by `scripts/presets/gen_presets.py` from the Apache-2.0
//! `openrocket-database` parts files (attribution in `lib/presets/README.md`
//! and `NOTICE.md`).
//!
//! Each file holds catalog parts in RocketWright source form
//! (`type = "body_tube"`, dimensions with the catalog's own units) plus the
//! materials they use. They are listed by `library_search` (`rw lib search`)
//! after the project's own library, as kind `preset` (parts) and `material`,
//! with ids `preset:<file>/<part>` and `preset:<file>/materials/<material>`.
//! They are not part of any model until a component is added from one.
//!
//! The files are compiled into the binary, so presets work in every project
//! without network or install steps.

use std::sync::OnceLock;

use rw_api::{LibItem, LibKind};
use serde_json::{Map, Value, json};

use crate::layout::sha256_hex;

macro_rules! preset_file {
    ($stem:literal) => {
        (
            $stem,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../lib/presets/",
                $stem,
                ".json"
            )),
        )
    };
}

/// `(file stem, contents)` of every `lib/presets/*.json`. The
/// `files_match_directory` test keeps this list in step with the directory.
const FILES: &[(&str, &str)] = &[
    preset_file!("apogee"),
    preset_file!("bluetube"),
    preset_file!("bms"),
    preset_file!("competition_chutes"),
    preset_file!("estes_classic"),
    preset_file!("estes_ps2"),
    preset_file!("giantleaprocketry"),
    preset_file!("loc_precision"),
    preset_file!("madcow"),
    preset_file!("mpc"),
    preset_file!("publicmissiles"),
    preset_file!("quest"),
    preset_file!("rocketarium"),
    preset_file!("semroc"),
    preset_file!("top_flight"),
];

/// The `source` label of a preset from `orc` (`orc/estes_classic.orc`).
fn source_label(orc: &str) -> String {
    format!("openrocket-database (Apache-2.0) {orc}")
}

/// Required fields of a component type that catalogs do not record
/// (listed in a preset's `preset.needs` when absent).
fn user_fields(ty: Option<&str>) -> &'static [&'static str] {
    match ty {
        Some("parachute") => &["cd", "packed_length", "packed_diameter"],
        Some("streamer") => &["packed_length", "packed_diameter"],
        _ => &[],
    }
}

fn file_items(stem: &str, text: &str) -> Vec<LibItem> {
    let doc: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let sha = sha256_hex(text.as_bytes());
    let orc = doc["source"].as_str().unwrap_or(stem);
    let source = source_label(orc);
    let materials = doc["materials"].as_object().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for p in doc["presets"].as_array().into_iter().flatten() {
        let mut data = p["component"].clone();
        let Some(obj) = data.as_object_mut() else {
            continue;
        };
        // The materials this part uses, so adding it can define them.
        let mut used = Map::new();
        for key in ["material", "line_material"] {
            if let Some(m) = obj.get(key).and_then(Value::as_str)
                && let Some(def) = materials.get(m)
            {
                used.insert(m.to_string(), def.clone());
            }
        }
        // Required fields the catalog does not carry; the user sets them
        // when adding the part.
        let needs: Vec<&str> = user_fields(obj.get("type").and_then(Value::as_str))
            .iter()
            .copied()
            .filter(|k| !obj.contains_key(*k))
            .collect();
        obj.insert(
            "preset".into(),
            json!({
                "manufacturer": p["manufacturer"],
                "part_number": p["part_number"],
                "description": p["description"],
                "materials": used,
                "needs": needs,
            }),
        );
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        out.push(LibItem {
            id: format!("preset:{stem}/{}", p["id"].as_str().unwrap_or_default()),
            kind: LibKind::Preset,
            name,
            source: source.clone(),
            sha256: Some(sha.clone()),
            data,
        });
    }
    for (id, m) in &materials {
        out.push(LibItem {
            id: format!("preset:{stem}/materials/{id}"),
            kind: LibKind::Material,
            name: m["doc"].as_str().unwrap_or(id).to_string(),
            source: source.clone(),
            sha256: Some(sha.clone()),
            data: m.clone(),
        });
    }
    out
}

/// Every preset item (parts, then materials, file by file).
pub fn items() -> &'static [LibItem] {
    static ITEMS: OnceLock<Vec<LibItem>> = OnceLock::new();
    ITEMS.get_or_init(|| {
        FILES
            .iter()
            .flat_map(|(stem, text)| file_items(stem, text))
            .collect()
    })
}

/// One preset item by id.
pub fn show(id: &str) -> Option<LibItem> {
    items().iter().find(|i| i.id == id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rw_model::{Component, Material};

    #[test]
    fn files_match_directory() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../lib/presets");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| {
                let n = e.ok()?.file_name().into_string().ok()?;
                n.strip_suffix(".json").map(String::from)
            })
            .collect();
        on_disk.sort();
        let listed: Vec<String> = FILES.iter().map(|(s, _)| s.to_string()).collect();
        assert_eq!(listed, on_disk, "update presets::FILES");
    }

    #[test]
    fn every_preset_is_a_valid_component() {
        let all = items();
        let parts: Vec<_> = all.iter().filter(|i| i.kind == LibKind::Preset).collect();
        assert!(parts.len() > 3000, "{} presets", parts.len());
        for p in &parts {
            assert!(
                p.source
                    .starts_with("openrocket-database (Apache-2.0) orc/")
            );
            let mut data = p.data.clone();
            let obj = data.as_object_mut().unwrap();
            let preset = obj.remove("preset").unwrap();
            // Fill what the user would set on adding the part.
            for k in preset["needs"].as_array().unwrap() {
                let k = k.as_str().unwrap();
                let v = if k == "cd" {
                    json!(0.8)
                } else {
                    json!("50 mm")
                };
                obj.insert(k.to_string(), v);
            }
            let c: Result<Component, _> = serde_json::from_value(data);
            assert!(c.is_ok(), "{}: {:?}", p.id, c.err());
        }
        for m in all.iter().filter(|i| i.kind == LibKind::Material) {
            let mat: Result<Material, _> = serde_json::from_value(m.data.clone());
            assert!(mat.is_ok(), "{}: {:?}", m.id, mat.err());
        }
        let ids: std::collections::BTreeSet<_> = all.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids.len(), all.len(), "preset ids are unique");
    }

    #[test]
    fn finds_a_catalog_tube() {
        let bt = all_matching("bt-20");
        assert!(!bt.is_empty());
        let estes = items()
            .iter()
            .find(|i| i.id.starts_with("preset:estes_classic/bt_20j"))
            .expect("Estes BT-20J");
        assert_eq!(show(&estes.id).as_ref(), Some(estes));
        assert_eq!(estes.data["type"], "body_tube");
        assert_eq!(estes.data["preset"]["manufacturer"], "Estes");
        assert!(
            estes.data["preset"]["materials"]
                .as_object()
                .is_some_and(|m| !m.is_empty())
        );
    }

    fn all_matching(q: &str) -> Vec<&'static LibItem> {
        items()
            .iter()
            .filter(|i| i.name.to_lowercase().contains(q))
            .collect()
    }
}
