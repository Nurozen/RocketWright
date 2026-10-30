//! Frozen model contracts: IF1 source types ([`source`], [`component`]) and
//! IF2 [`eval::EvaluatedModel`], plus [`refs`] and [`patch`].
//!
//! Change rule: after M1.5 a change needs a PR touching `schema/` and a line
//! in `docs/dev/contract-changes.md`.

pub mod component;
pub mod eval;
pub mod patch;
pub mod refs;
pub mod source;

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use component::*;
pub use eval::*;
pub use patch::*;
pub use refs::*;
pub use source::*;

/// The JSON contract version written into every JSON output (D19c).
pub const SCHEMA_VERSION: &str = "rw/1";

/// Pattern for a component, config, sim, or engine id (`[c.<id>]`).
pub const ID_PATTERN: &str = r"^[a-z][a-z0-9_]*$";

/// Pattern for a lowercase hex blake3/sha256 digest.
pub const HEX64_PATTERN: &str = r"^[0-9a-f]{64}$";

/// The `"schema": "rw/1"` tag. Deserializing any other value is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SchemaTag;

impl Serialize for SchemaTag {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(SCHEMA_VERSION)
    }
}
impl<'de> Deserialize<'de> for SchemaTag {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if s == SCHEMA_VERSION {
            Ok(SchemaTag)
        } else {
            Err(serde::de::Error::custom(format!(
                "schema `{s}` is not `{SCHEMA_VERSION}`"
            )))
        }
    }
}
impl JsonSchema for SchemaTag {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("SchemaTag")
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "const": SCHEMA_VERSION })
    }
}
