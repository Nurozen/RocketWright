//! API errors returned by `Session::execute` and mapped to MCP `isError` and
//! CLI exit codes (1 failure, 2 usage/I-O).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use rw_model::Diagnostic;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApiErrorCode {
    /// The command exists but its body has not landed (e.g. `import_file` before M2.5).
    NotImplemented,
    InvalidInput,
    NotFound,
    /// `.rw/lock` is held by another live owner (D4).
    Locked,
    Io,
    Conflict,
    /// Needs a human approval first (gated tool, I16).
    ApprovalRequired,
    /// The project's owner went away before answering; retryable (D4). A
    /// lost mutation carries `outcome: "unknown"`: it may have committed, so
    /// reconcile through `history_list` before retrying it.
    Unavailable,
    Internal,
}

/// What is known about the effect of a call that failed (D4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorOutcome {
    /// The call may or may not have taken effect (a mutation lost with the
    /// project's owner, after it may have committed).
    Unknown,
}

impl ApiErrorCode {
    /// CLI exit code: 2 for usage/I-O/lock, 1 otherwise.
    pub const fn exit_code(self) -> u8 {
        match self {
            ApiErrorCode::InvalidInput
            | ApiErrorCode::Io
            | ApiErrorCode::Locked
            | ApiErrorCode::Unavailable => 2,
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    /// Set when the call's effect is not known (`unavailable`, D4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ErrorOutcome>,
}

impl ApiError {
    pub fn not_implemented(what: &str) -> Self {
        Self {
            code: ApiErrorCode::NotImplemented,
            message: format!("{what} is not implemented yet"),
            hint: None,
            diagnostics: Vec::new(),
            outcome: None,
        }
    }

    /// The project's owner went away before answering a call (D4).
    /// `mutating`: the call may have committed (`outcome: "unknown"`).
    pub fn unavailable(what: &str, mutating: bool) -> Self {
        let (message, hint) = if mutating {
            (
                format!(
                    "the project's owner went away before answering `{what}`; it may or may not have been applied"
                ),
                "check history_list for the step before retrying: the call may have committed",
            )
        } else {
            (
                format!("the project's owner went away before answering `{what}`"),
                "retry: the relay reconnected to the project's new owner",
            )
        };
        Self {
            code: ApiErrorCode::Unavailable,
            message,
            hint: Some(hint.into()),
            diagnostics: Vec::new(),
            outcome: mutating.then_some(ErrorOutcome::Unknown),
        }
    }
}
