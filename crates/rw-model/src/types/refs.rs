//! The `rw:` ref grammar (R2.8): `rw:<kind>/<id>[#anchor][@version]`, with an
//! optional JSON pointer after the ref (`rw:c/fins/span`). Parser: [`crate::refs`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Pattern for an `rw:` ref.
pub const REF_PATTERN: &str = r"^rw:(c|cfg|sim|run|step|rev|thread|eng)/[A-Za-z0-9_.-]+(#[A-Za-z0-9_<>]+)?(@[A-Za-z0-9_.:-]+)?(/[^\s]*)?$";

/// An rw: ref string (rw:c/fins).
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
pub struct RwRef(#[schemars(extend("pattern" = REF_PATTERN))] pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    C,
    Cfg,
    Sim,
    Run,
    Step,
    Rev,
    Thread,
    Eng,
}

/// A parsed ref.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RefParts {
    pub kind: RefKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// JSON pointer after the ref (`/span`), empty when absent.
    #[serde(default)]
    pub pointer: String,
}

impl RwRef {
    /// Parses the ref (M1.23; vectors in `schema/testdata/refs.json`). The
    /// error is a reason slug: `missing_scheme`, `resource_uri`,
    /// `unknown_kind`, `empty_id`, `empty_anchor`, `empty_version`, `syntax`.
    pub fn parse(&self) -> Result<RefParts, String> {
        crate::refs::parse_ref(&self.0).map_err(|e| e.slug().to_string())
    }
}
