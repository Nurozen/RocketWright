//! M1.5 verification: `cargo test -p rw-api schema_registry_complete`.
//! Every frozen IF type and every MCP tool's input and output is registered,
//! each schema compiles (draft 2020-12), and the `x-` metadata is present.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::collections::BTreeSet;

use rw_api::{COMMANDS, Command, Iface, RESOURCES, schema_entry, schema_registry};

/// The frozen type list (IF1-IF8). Adding or removing one is a contract change.
const EXPECTED: &[&str] = &[
    "project",
    "rocket",
    "config",
    "sim",
    "engine",
    "patch-op",
    "diagnostic",
    "evaluated-model",
    "geometry",
    "thrust-curve",
    "motor-source",
    "mounted-motor",
    "aero-state",
    "aero-coeffs",
    "mass-props",
    "sim-input",
    "sim-result",
    "run-summary",
    "events",
    "check-report",
    "check-delta",
    "command",
    "response",
    "call-ctx",
    "api-error",
    "history-step",
    "run-manifest",
    "visual-run",
    "job-info",
    "render-request",
    "render-result",
    "project-files",
    "contract-fixture",
    "oracle-golden",
];

/// The MCP tool surface: S:85 plus D6.
const MCP_TOOLS: &[&str] = &[
    "project_create",
    "project_validate",
    "model_get",
    "model_patch",
    "component_add",
    "component_remove",
    "design_check",
    "render",
    "library_search",
    "motor_search",
    "simulate",
    "job_status",
    "job_cancel",
    "run_list",
    "run_diff",
    "model_diff",
    "history_list",
    "history_show",
    "history_compare",
    "history_tag",
    "history_restore",
    "import_file",
    "export_file",
    "schema_get",
    "engine_design",
    "engine_simulate",
    "cfd_import",
    "thrustcurve_search",
    "thrustcurve_fetch",
];

#[test]
fn schema_registry_complete() {
    let reg = schema_registry();

    // Unique names.
    let names: Vec<&str> = reg.iter().map(|e| e.name.as_ref()).collect();
    let set: BTreeSet<&str> = names.iter().copied().collect();
    assert_eq!(set.len(), names.len(), "duplicate registry names");

    // Every frozen type is present.
    for n in EXPECTED {
        assert!(set.contains(n), "missing schema `{n}`");
    }

    // The MCP tool list is exactly S:85 + D6, each with input and output.
    let mcp: BTreeSet<&str> = COMMANDS.iter().filter(|d| d.mcp).map(|d| d.name).collect();
    assert_eq!(mcp, MCP_TOOLS.iter().copied().collect::<BTreeSet<_>>());
    for t in MCP_TOOLS {
        for io in ["input", "output"] {
            let n = format!("tools/{t}.{io}");
            let e = schema_entry(&n).unwrap_or_else(|| panic!("missing `{n}`"));
            // MCP roots must be objects (F:91).
            let s = e.schema();
            assert_eq!(
                s.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "`{n}` root is not an object"
            );
        }
    }

    // Each interface has entries; every schema compiles and carries $id and draft 2020-12.
    let ifaces: BTreeSet<Iface> = reg.iter().map(|e| e.iface).collect();
    assert_eq!(ifaces.len(), 8, "IF1-IF8 all represented");
    for e in &reg {
        let s = e.schema();
        let v = s.as_value();
        assert_eq!(
            v["$schema"], "https://json-schema.org/draft/2020-12/schema",
            "{}",
            e.name
        );
        assert_eq!(
            v["$id"],
            format!("https://rocketwright.dev/schema/1/{}.json", e.name)
        );
        jsonschema::validator_for(v)
            .unwrap_or_else(|err| panic!("{} does not compile: {err}", e.name));
    }

    // Command covers every catalogue entry (one oneOf branch per command).
    let cmd = schema_entry("command").unwrap().schema();
    let branches = cmd
        .get("oneOf")
        .and_then(|v| v.as_array())
        .map(Vec::len)
        .unwrap_or(0);
    assert_eq!(branches, COMMANDS.len());

    // Mutating tools return a CheckDelta (I6): their output schema references it.
    for d in COMMANDS.iter().filter(|d| d.hints.mutating) {
        let out = serde_json::to_string((d.output_schema)().as_value()).unwrap();
        assert!(
            out.contains("CheckDelta"),
            "`{}` output lacks a CheckDelta",
            d.name
        );
    }

    // Resources point at registered types.
    for r in RESOURCES {
        assert!(
            r.type_name == "json-schema" || set.contains(r.type_name),
            "resource {} → {}",
            r.uri,
            r.type_name
        );
    }

    // x- metadata (R2.11) reaches the published schemas.
    let rocket =
        serde_json::to_string(schema_entry("rocket").unwrap().schema().as_value()).unwrap();
    for kw in ["x-unit-dimension", "x-anchors", "x-expr", "x-ui-group"] {
        assert!(rocket.contains(kw), "rocket schema lacks {kw}");
    }
    let evaluated =
        serde_json::to_string(schema_entry("evaluated-model").unwrap().schema().as_value())
            .unwrap();
    assert!(evaluated.contains("x-unit-dimension"));

    // Command names round-trip through serde.
    let c: Command = serde_json::from_value(
        serde_json::json!({"command": "job_status", "input": {"job_id": "j1"}}),
    )
    .unwrap();
    assert_eq!(c.name(), "job_status");
}

#[test]
fn units_rule_in_schema() {
    // R2.2 / M1.6: a dimensional field accepts "54 mm" and 0, rejects 54.
    let s = schema_entry("rocket").unwrap().schema();
    let tube = |od: serde_json::Value| serde_json::json!({"c": {"body": {"type": "body_tube", "length": "300 mm", "od": od, "id": "52 mm"}}});
    assert!(common::errors(s.as_value(), &tube("54 mm".into())).is_empty());
    assert!(common::errors(s.as_value(), &tube("= params.d".into())).is_empty());
    assert!(!common::errors(s.as_value(), &tube(54.into())).is_empty());
    assert!(!common::errors(s.as_value(), &tube("54".into())).is_empty());
}
