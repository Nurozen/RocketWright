//! `schema_registry()`: every published JSON Schema (draft 2020-12) with its
//! `schema/` file name. M1.6's `cargo xtask schema` writes them; MCP tool
//! schemas and the TS types come from the same entries (invariant I3).

use std::borrow::Cow;

use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, Schema};
use serde::de::DeserializeOwned;

use crate::command::{COMMANDS, check_as};

/// Base of every `$id`.
pub const SCHEMA_ID_BASE: &str = "https://rocketwright.dev/schema/1/";

/// Which frozen interface an entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Iface {
    If1,
    If2,
    If3,
    If4,
    If5,
    If6,
    If7,
    If8,
}

/// One published schema.
#[derive(Clone)]
pub struct SchemaEntry {
    /// Registry name and `schema/` path stem (`check-report`, `tools/model_patch.input`).
    pub name: Cow<'static, str>,
    pub iface: Iface,
    /// Rust type name.
    pub rust_type: &'static str,
    schema: fn() -> Schema,
    /// Deserializes a JSON value as the Rust type.
    pub check: fn(&serde_json::Value) -> Result<(), String>,
    /// `fixtures/contracts/` must hold at least one payload of this type.
    pub fixture_required: bool,
    /// Oracle-file rules apply (string and key length caps).
    oracle: bool,
}

impl std::fmt::Debug for SchemaEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SchemaEntry")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl SchemaEntry {
    /// The root schema with `$id` set.
    pub fn schema(&self) -> Schema {
        let mut s = (self.schema)();
        if self.oracle
            && let Some(obj) = s.as_object_mut()
        {
            obj.values_mut().for_each(cap_strings);
        }
        let id = format!("{SCHEMA_ID_BASE}{}.json", self.name);
        if let Some(obj) = s.as_object_mut() {
            let mut out = serde_json::Map::new();
            for (k, v) in std::mem::take(obj) {
                out.insert(k.clone(), v);
                if k == "$schema" {
                    out.insert("$id".into(), serde_json::Value::String(id.clone()));
                }
            }
            if !out.contains_key("$id") {
                out.insert("$id".into(), serde_json::Value::String(id));
            }
            *obj = out;
        }
        s
    }

    /// Path under `schema/`.
    pub fn file(&self) -> String {
        format!("{}.json", self.name)
    }
}

/// The root schema of `T` (draft 2020-12).
pub fn root_schema<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>()
}

const fn entry<T: JsonSchema + DeserializeOwned>(
    name: &'static str,
    iface: Iface,
    rust_type: &'static str,
    fixture_required: bool,
) -> SchemaEntry {
    SchemaEntry {
        name: Cow::Borrowed(name),
        iface,
        rust_type,
        schema: root_schema::<T>,
        check: check_as::<T>,
        fixture_required,
        oracle: false,
    }
}

macro_rules! entries {
    ($( $name:literal => $ty:ty, $iface:ident, $fixture:expr; )*) => {
        &[ $( entry::<$ty>($name, Iface::$iface, stringify!($ty), $fixture), )* ]
    };
}

const TYPES: &[SchemaEntry] = entries! {
    // IF1 source documents
    "project" => rw_model::ProjectManifest, If1, false;
    "rocket" => rw_model::RocketDoc, If1, true;
    "config" => rw_model::ConfigDoc, If1, false;
    "sim" => rw_model::SimDoc, If1, false;
    "engine" => rw_model::EngineDoc, If1, false;
    "patch-op" => rw_model::PatchOp, If1, false;
    "diagnostic" => rw_model::Diagnostic, If1, false;
    // IF2
    "evaluated-model" => rw_model::EvaluatedModel, If2, true;
    // IF3
    "geometry" => rw_geom::Geometry, If3, true;
    // IF4
    "thrust-curve" => rw_motor::ThrustCurve, If4, true;
    "motor-source" => rw_motor::MotorSource, If4, false;
    "mounted-motor" => rw_motor::MountedMotor, If4, false;
    // IF5
    "aero-state" => rw_aero::AeroState, If5, false;
    "aero-coeffs" => rw_aero::AeroCoeffs, If5, false;
    "mass-props" => rw_mass::MassProps, If5, false;
    // IF6
    "sim-input" => rw_sim::SimInput, If6, true;
    "sim-result" => rw_sim::SimResult, If6, true;
    "run-summary" => rw_sim::RunSummary, If6, true;
    "events" => rw_sim::RunEvents, If6, true;
    // IF7
    "check-report" => rw_check::CheckReport, If7, true;
    "check-delta" => rw_check::CheckDelta, If7, true;
    // IF8
    "command" => crate::Command, If8, true;
    "response" => crate::Response, If8, true;
    "call-ctx" => crate::CallCtx, If8, true;
    "api-error" => crate::ApiError, If8, true;
    "history-step" => crate::HistoryStep, If8, true;
    "run-manifest" => crate::RunManifest, If8, true;
    "visual-run" => crate::VisualRun, If8, false;
    "job-info" => crate::JobInfo, If8, true;
    "render-request" => crate::RenderRequest, If8, true;
    "render-result" => crate::RenderResult, If8, true;
    "project-files" => crate::ProjectFiles, If8, true;
    "contract-fixture" => crate::ContractFixture, If8, false;
};

/// `schema/oracle-golden.json`: any file under `tests/oracle/`.
pub const ORACLE_GOLDEN: SchemaEntry = SchemaEntry {
    name: Cow::Borrowed("oracle-golden"),
    iface: Iface::If8,
    rust_type: "OracleFile",
    schema: root_schema::<crate::OracleFile>,
    check: check_as::<crate::OracleFile>,
    fixture_required: true,
    oracle: true,
};

/// Every published schema: the types, the oracle file schema, then one input
/// and one output schema per MCP tool (`tools/<name>.input|output`).
pub fn schema_registry() -> Vec<SchemaEntry> {
    let mut v: Vec<SchemaEntry> = TYPES.to_vec();
    v.push(ORACLE_GOLDEN);
    for d in COMMANDS.iter().filter(|d| d.mcp) {
        v.push(SchemaEntry {
            name: Cow::Owned(format!("tools/{}.input", d.name)),
            iface: Iface::If8,
            rust_type: d.input_type,
            schema: d.input_schema,
            check: d.check_input,
            fixture_required: true,
            oracle: false,
        });
        v.push(SchemaEntry {
            name: Cow::Owned(format!("tools/{}.output", d.name)),
            iface: Iface::If8,
            rust_type: d.output_type,
            schema: d.output_schema,
            check: d.check_output,
            fixture_required: true,
            oracle: false,
        });
    }
    v
}

/// Looks up an entry by name.
pub fn schema_entry(name: &str) -> Option<SchemaEntry> {
    schema_registry().into_iter().find(|e| e.name == name)
}

/// Adds `maxLength` to every string schema and `propertyNames.maxLength` to
/// every object schema (oracle files carry numbers plus names only).
fn cap_strings(v: &mut serde_json::Value) {
    use serde_json::{Value, json};
    match v {
        Value::Object(m) => {
            let is_string = match m.get("type") {
                Some(Value::String(t)) => t == "string",
                Some(Value::Array(ts)) => ts.iter().any(|t| t == "string"),
                _ => false,
            };
            let is_object = matches!(m.get("type"), Some(Value::String(t)) if t == "object");
            if is_string && !m.contains_key("maxLength") {
                m.insert("maxLength".into(), json!(crate::oracle::ORACLE_MAX_STRING));
            }
            if is_object && !m.contains_key("propertyNames") {
                m.insert(
                    "propertyNames".into(),
                    json!({ "maxLength": crate::oracle::ORACLE_MAX_STRING }),
                );
            }
            for (_, x) in m.iter_mut() {
                cap_strings(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(cap_strings),
        _ => {}
    }
}
