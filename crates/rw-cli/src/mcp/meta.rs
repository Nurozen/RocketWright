//! MCP `_meta` → [`CallCtx`]. The app sets `rw/thread`, `rw/tool_call`, and
//! `rw/label` on every forwarded call; CLI forwarding over the socket sets
//! `rw/origin: "cli"` (D4). Lecturn sets `lecturn/context` and
//! `lecturn/approval` on every proxied call; `lecturn/context.threadId`
//! attributes the call to its thread when `rw/thread` is absent (D21).

use rw_api::{CallCtx, Origin};
use serde_json::{Map, Value};

pub const THREAD: &str = "rw/thread";
pub const TOOL_CALL: &str = "rw/tool_call";
pub const LABEL: &str = "rw/label";
pub const ORIGIN: &str = "rw/origin";
/// Result `_meta` key echoing the [`CallCtx`] the sidecar ran the call with.
pub const CTX: &str = "rw/ctx";
/// Result `_meta` key carrying an [`rw_api::ApiError`] on `isError` results.
pub const ERROR: &str = "rw/error";
/// Tool `_meta`: the approval policy (I16).
pub const APPROVAL: &str = "rw/approval";
/// Tool `_meta`: `always_ask` on gated tools (I16).
pub const PERMISSION_POLICY: &str = "rw/permission_policy";
/// Tool `_meta`: returns a `CheckDelta` and honours `dry_run` (I6).
pub const MUTATING: &str = "rw/mutating";
/// Request `_meta` (Lecturn): `{projectId, threadId, workspaceRoot, turnId}`.
pub const LECTURN_CONTEXT: &str = "lecturn/context";
/// Request `_meta` (Lecturn): `{approved, requestId?}`.
pub const LECTURN_APPROVAL: &str = "lecturn/approval";
/// Result `_meta` (to Lecturn): `{reason}` on a gated, side-effect-free answer.
pub const LECTURN_APPROVAL_REQUIRED: &str = "lecturn/approval-required";
/// Request `_meta` keys echoed verbatim in the result `_meta`, so a caller
/// (and the relay tests) can see what reached the owner.
pub const ECHOED: &[&str] = &[LECTURN_CONTEXT, LECTURN_APPROVAL];

/// Builds the call context from request `_meta`; `default_origin` is the
/// front end's own (stdio: `mcp`, socket: `socket`).
pub fn call_ctx(meta: &Map<String, Value>, default_origin: Origin) -> CallCtx {
    let text = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_owned);
    let origin = meta
        .get(ORIGIN)
        .and_then(|v| serde_json::from_value::<Origin>(v.clone()).ok())
        .unwrap_or(default_origin);
    // D21: a Lecturn thread id stands in for `rw/thread`.
    let lecturn_thread = || {
        meta.get(LECTURN_CONTEXT)
            .and_then(|c| c.get("threadId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    CallCtx {
        origin,
        thread: text(THREAD).or_else(lecturn_thread),
        tool_call: text(TOOL_CALL),
        label: text(LABEL),
    }
}

/// The [`ECHOED`] keys present in `meta`.
pub fn echoed(meta: &Map<String, Value>) -> impl Iterator<Item = (&String, &Value)> {
    meta.iter().filter(|(k, _)| ECHOED.contains(&k.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_rw_keys() {
        let m = json!({"rw/thread": "t1", "rw/tool_call": "tc9", "rw/label": "Fin span", "rw/origin": "cli", "progressToken": 3});
        let ctx = call_ctx(m.as_object().unwrap(), Origin::Socket);
        assert_eq!(ctx.origin, Origin::Cli);
        assert_eq!(ctx.thread.as_deref(), Some("t1"));
        assert_eq!(ctx.tool_call.as_deref(), Some("tc9"));
        assert_eq!(ctx.label.as_deref(), Some("Fin span"));
    }

    #[test]
    fn defaults_and_bad_origin() {
        let m = json!({"rw/origin": "martian"});
        let ctx = call_ctx(m.as_object().unwrap(), Origin::Mcp);
        assert_eq!(ctx.origin, Origin::Mcp);
        assert!(ctx.thread.is_none());
    }

    #[test]
    fn lecturn_thread_fills_in_for_rw_thread() {
        let m = json!({"lecturn/context": {"projectId": "p", "threadId": "lt1", "workspaceRoot": "/w", "turnId": "u"}});
        let ctx = call_ctx(m.as_object().unwrap(), Origin::Mcp);
        assert_eq!(ctx.thread.as_deref(), Some("lt1"));
        assert_eq!(ctx.origin, Origin::Mcp);
        let m = json!({"rw/thread": "t1", "lecturn/context": {"threadId": "lt1"}});
        let ctx = call_ctx(m.as_object().unwrap(), Origin::Mcp);
        assert_eq!(ctx.thread.as_deref(), Some("t1"), "rw/thread wins");
        let m = json!({"lecturn/context": {"threadId": 7}, "lecturn/approval": {"approved": true}, "x": 1});
        assert!(
            call_ctx(m.as_object().unwrap(), Origin::Mcp)
                .thread
                .is_none()
        );
        let mut keys: Vec<&str> = echoed(m.as_object().unwrap())
            .map(|(k, _)| k.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["lecturn/approval", "lecturn/context"]);
    }
}
