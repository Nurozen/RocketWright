//! Contract-fixture doubles (`doubles` feature, tests only): the payloads of
//! `fixtures/contracts/**/*.json`, embedded at build time, keyed by registry
//! type name. Every payload carries `provenance: "contract-fixture"` in its
//! wrapper, so nothing mistakes it for a real result.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use rw_api::{CONTRACT_FIXTURE, ContractFixture};
use serde_json::Value;

include!(concat!(env!("OUT_DIR"), "/doubles_gen.rs"));

fn index() -> &'static BTreeMap<String, Value> {
    static INDEX: OnceLock<BTreeMap<String, Value>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut m = BTreeMap::new();
        for (path, text) in FIXTURES {
            let fx: ContractFixture = serde_json::from_str(text)
                .unwrap_or_else(|e| panic!("fixtures/contracts/{path}: {e}"));
            assert_eq!(fx.provenance, CONTRACT_FIXTURE, "{path}");
            m.entry(fx.type_name).or_insert(fx.payload);
        }
        m
    })
}

/// The fixture payload of registry type `type_name` (first file by path).
pub fn payload(type_name: &str) -> Option<Value> {
    index().get(type_name).cloned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn has_a_double_per_tool_output() {
        for d in rw_api::COMMANDS.iter().filter(|d| d.mcp) {
            let name = format!("tools/{}.output", d.name);
            let v = super::payload(&name).unwrap_or_else(|| panic!("no fixture for {name}"));
            (d.check_output)(&v).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
        assert!(super::payload("evaluated-model").is_some());
    }
}
