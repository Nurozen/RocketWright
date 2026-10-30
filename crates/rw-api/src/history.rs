//! IF8 history types (D2/D3): `HistoryStep` (one line of
//! `.rw/history/steps.jsonl`), revisions, and file changes.
//!
//! Version grammar: `live | step:<seq> | rev:<NN> | commit:<sha> | run:<id>`
//! (a run stands for the step its model was recorded at).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::Origin;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum FileStatus {
    A,
    M,
    D,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FileChange {
    pub path: String,
    pub status: FileStatus,
}

/// Metrics stored per step so the history strip can draw sparklines without
/// re-evaluating.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct StepMetrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stability_liftoff: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(extend("x-unit-dimension" = "mass"))]
    pub mass_liftoff: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apogee_m: Option<f64>,
}

/// One recorded step: a snapshot-tree change (D3) in `.rw/history.git`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HistoryStep {
    /// 1-based sequence number (`step:<seq>`, shown as `Step 04`).
    pub seq: u32,
    /// Commit id in `.rw/history.git`.
    #[schemars(extend("pattern" = "^[0-9a-f]{40}$"))]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev: Option<String>,
    /// RFC 3339 time (from `RW_CLOCK` when set).
    pub ts: String,
    pub origin: Origin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    /// Tool or CLI command that caused the step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<String>,
    /// Short human title, e.g. `Exploded assembly`.
    pub title: String,
    pub files: Vec<FileChange>,
    #[schemars(extend("pattern" = rw_model::HEX64_PATTERN))]
    pub model_hash: String,
    pub metrics: StepMetrics,
    /// Revision tagged at this step, e.g. `rev:07`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
}

/// A named revision (`Rev NN`, `refs/rw/rev/<NN>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Revision {
    pub number: u32,
    /// User-facing name, e.g. `Flight-ready fins`.
    pub name: String,
    pub step: u32,
    #[schemars(extend("pattern" = "^[0-9a-f]{40}$"))]
    pub id: String,
}

/// How a component differs between two versions (the visual diff colours:
/// removed red, changed amber, added green).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarkStatus {
    Removed,
    Changed,
    Added,
}

/// One evaluated quantity that differs between two versions, in SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QuantityChange {
    /// Pointer into the evaluated component (`/shape/span`, `/length`).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new: Option<f64>,
    /// SI unit (`m`, `rad`); absent for pure numbers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// A component marked by the visual diff, keyed by id. Unmarked components
/// are unchanged (drawn dimmed). A component that only moved because a part
/// fore of it changed length is unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ComponentMark {
    pub id: String,
    pub name: String,
    pub status: MarkStatus,
    /// The evaluated quantities that differ (`changed` only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<QuantityChange>,
}
