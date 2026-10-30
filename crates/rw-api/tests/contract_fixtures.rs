//! Every `fixtures/contracts/**/*.json` is a `contract-fixture` wrapper whose
//! payload validates against its registry schema and deserializes into the
//! Rust type; every type that needs a fixture has one.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeSet;

use rw_api::{CONTRACT_FIXTURE, ContractFixture, schema_entry, schema_registry};

#[test]
fn contract_fixtures_validate() {
    let dir = common::repo_root().join("fixtures/contracts");
    let files = common::json_files(&dir);
    assert!(!files.is_empty(), "no fixtures under {}", dir.display());
    let wrapper = schema_entry("contract-fixture").unwrap().schema();

    let mut covered = BTreeSet::new();
    let mut failures = Vec::new();
    for f in &files {
        let rel = f.strip_prefix(&dir).unwrap().display().to_string();
        let v = common::read_json(f);
        let errs = common::errors(wrapper.as_value(), &v);
        if !errs.is_empty() {
            failures.push(format!("{rel}: wrapper: {errs:?}"));
            continue;
        }
        let fx: ContractFixture = serde_json::from_value(v).unwrap();
        assert_eq!(fx.provenance, CONTRACT_FIXTURE);
        let Some(entry) = schema_entry(&fx.type_name) else {
            failures.push(format!("{rel}: unknown type `{}`", fx.type_name));
            continue;
        };
        let errs = common::errors(entry.schema().as_value(), &fx.payload);
        if !errs.is_empty() {
            failures.push(format!("{rel}: schema: {}", errs.join("; ")));
        }
        if let Err(e) = (entry.check)(&fx.payload) {
            failures.push(format!("{rel}: serde: {e}"));
        }
        covered.insert(fx.type_name.clone());
    }
    assert!(
        failures.is_empty(),
        "invalid fixtures:\n{}",
        failures.join("\n")
    );

    let missing: Vec<String> = schema_registry()
        .into_iter()
        .filter(|e| e.fixture_required && !covered.contains(e.name.as_ref()))
        .map(|e| e.name.into_owned())
        .collect();
    assert!(
        missing.is_empty(),
        "types without a contract fixture: {missing:?}"
    );
}
