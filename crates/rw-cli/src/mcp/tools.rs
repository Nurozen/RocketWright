//! MCP tool bodies (M1.31): every call goes through [`dispatch`] onto the
//! real session (I2). This module adds what only the MCP surface needs:
//!
//! - result content: the output JSON as text (mirroring
//!   `structuredContent`), plus the PNG as image content for `render` and
//!   `history_compare` with `visual`;
//! - `project_create` on a sidecar started in an empty directory: the
//!   project is created there and the sidecar adopts its session (without
//!   the `doubles` feature; contract-fixture mode keeps the double).
//!
//! Progress: long work (`simulate`) returns a `job_id` at once and runs on
//! the job queue; clients follow it with `job_status` or a `rw://jobs/<id>`
//! subscription. No `notifications/progress` is ever sent after a response
//! (the sidecar sends none).

use std::sync::{Arc, Mutex};

use base64::Engine;
use rmcp::model::ContentBlock;
use rw_api::{ApiError, ApiErrorCode, CallCtx, CommandDef, ProjectCreateIn};
use serde_json::Value;

use super::server::Hub;
use super::{DOUBLES, dispatch};

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::Internal,
        message: e.to_string(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

/// Creates the project in the hub's directory and adopts its session.
fn create_here(hub: &Arc<Hub>, args: Value, ctx: &CallCtx) -> Result<Value, ApiError> {
    let i: ProjectCreateIn = serde_json::from_value(args).map_err(|e| ApiError {
        outcome: None,
        code: ApiErrorCode::InvalidInput,
        message: format!("`project_create` input: {e}"),
        hint: None,
        diagnostics: Vec::new(),
    })?;
    // The sidecar already holds `.rw/lock`; create without a writer session,
    // then adopt the project with the held lock.
    let out = rw_project::create::create_project(
        &hub.project,
        &ProjectCreateIn {
            dry_run: true,
            ..i.clone()
        },
        ctx,
    )?;
    if i.dry_run {
        return serde_json::to_value(out).map_err(internal);
    }
    let files = rw_project::create::project_files(&i)?
        .into_iter()
        .map(|(p, t)| (p, t.into_bytes()))
        .collect();
    // An existing `.gitignore` gains `.rw/` (the dry run above planned it).
    let planned = rw_project::create::planned_writes(&hub.project, files);
    rw_project::create::write_planned(&hub.project, &planned)?;
    let lock = hub
        .take_lock()
        .ok_or_else(|| internal("the sidecar lost its lock"))?;
    let opts = rw_project::SessionOptions::writer()
        .with_lock(rw_project::LockMode::Held(lock))
        .with_snapshot_origin(ctx.origin);
    let s = rw_project::Session::open(&hub.project, opts)?;
    let step = s
        .steps()
        .ok()
        .and_then(|v| v.last().map(|st| format!("step:{}", st.seq)));
    let mut out = out;
    out.dry_run = false;
    out.step = step.clone();
    out.delta = s.delta_from_empty(step);
    out.model_hash = s.model().model_hash.clone();
    hub.attach_session(Arc::new(Mutex::new(s)), true);
    hub.post_updated(
        rw_project::session::MUTATION_URIS
            .iter()
            .map(|u| (*u).to_string())
            .collect(),
    );
    serde_json::to_value(out).map_err(internal)
}

/// Runs one tool call; returns the output JSON and the result content.
pub fn call(
    hub: &Arc<Hub>,
    def: &CommandDef,
    args: Value,
    ctx: &CallCtx,
) -> Result<(Value, Vec<ContentBlock>), ApiError> {
    let out = if def.name == "project_create" && hub.session().is_none() && !DOUBLES {
        create_here(hub, args, ctx)?
    } else {
        dispatch::call(hub.session(), def.name, args, ctx)?
    };
    let mut content = vec![ContentBlock::text(
        serde_json::to_string(&out).unwrap_or_default(),
    )];
    // The picture of a render, or of a visual comparison (the render card's
    // thumbnail, B3).
    let picture = match def.name {
        "render" => out.get("path"),
        "history_compare" => out.get("visual").and_then(|v| v.get("path")),
        _ => None,
    };
    if hub.session().is_some()
        && let Some(path) = picture.and_then(Value::as_str)
        && let Ok(png) = std::fs::read(hub.project.join(path))
    {
        content.push(ContentBlock::image(
            base64::engine::general_purpose::STANDARD.encode(png),
            "image/png",
        ));
    }
    Ok((out, content))
}
