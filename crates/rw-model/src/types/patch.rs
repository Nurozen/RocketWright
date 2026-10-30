//! `PatchOp`: RFC 6902 operations on id paths (`/c/fins/span`), the input of
//! `model_patch` and the WASM draft. Application: [`crate::patch`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One RFC 6902 operation. `path` and `from` are JSON pointers into the source
/// model keyed by id (`/c/<id>/<field>`, `/params/<name>/value`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PatchOp {
    Add {
        path: String,
        value: serde_json::Value,
    },
    Remove {
        path: String,
    },
    Replace {
        path: String,
        value: serde_json::Value,
    },
    Move {
        from: String,
        path: String,
    },
    Copy {
        from: String,
        path: String,
    },
    Test {
        path: String,
        value: serde_json::Value,
    },
}

/// A failed patch application.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PatchError {
    /// Index of the failing op.
    pub op: u32,
    pub path: String,
    pub message: String,
}

/// Applies `ops` to the source set (pure; M1.23). The Session applies the same
/// ops to the `toml_edit` documents (patch-equivalence, invariant I4).
/// Paths address the [`crate::patch::ModelValue`]; see [`crate::patch`].
pub fn apply(sources: &super::SourceSet, ops: &[PatchOp]) -> Result<super::SourceSet, PatchError> {
    crate::patch::apply_sources(sources, ops)
}
