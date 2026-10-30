//! Contract fixtures (`fixtures/contracts/**.json`): one schema-valid payload
//! per frozen type, wrapped with `provenance = "contract-fixture"` so no
//! consumer mistakes them for real results. The mock RPC server (M1.6b) and
//! the sidecar doubles (M1.8) serve `payload`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The only accepted `provenance` value.
pub const CONTRACT_FIXTURE: &str = "contract-fixture";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContractFixture {
    /// Always `contract-fixture`.
    #[schemars(extend("const" = CONTRACT_FIXTURE))]
    pub provenance: String,
    /// Registry name of the payload type (`evaluated-model`, `tools/model_patch.input`).
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub payload: serde_json::Value,
}
