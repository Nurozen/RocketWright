//! `render_picture` (CP-W1 r3): a stored render's PNG for the MCP Apps
//! render card.
//!
//! `render` and `history_compare` return their picture as an image content
//! block, but a host may hand a card the result without the image data:
//! Lecturn (pin4) omits tool-output image bytes from the thread it projects
//! to clients and the card's `ui/notifications/tool-result` carries
//! `{ "type": "image", "mimeType": "image/png" }` only. The card then asks
//! for the file the result names (`path`, or `visual.path` of a comparison)
//! through this tool.
//!
//! The tool is app-only (`_meta.ui.visibility: ["app"]`) and read-only, like
//! `run_series`: hosts hide it from the model and let cards call it without
//! asking. It reads PNGs under `renders/` only.

use std::path::{Component, Path};
use std::sync::Arc;

use base64::Engine as _;
use rmcp::model::{JsonObject, Tool, ToolAnnotations};
use rw_api::{ApiError, ApiErrorCode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::meta;

/// The tool name.
pub const NAME: &str = "render_picture";
/// The largest picture returned (bytes of PNG).
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;

fn err(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

fn object(v: Value) -> Arc<JsonObject> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

/// The input JSON Schema.
pub fn input_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "RenderPictureIn",
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "The PNG's project-relative path under renders/ (`render` `path`, `history_compare` `visual.path`)."
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

/// The output JSON Schema.
pub fn output_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "RenderPictureOut",
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "bytes": { "type": "integer", "minimum": 0, "description": "Size of the PNG (the image content block)." }
        },
        "required": ["path", "bytes"]
    })
}

/// The tool definition (app-only).
pub fn tool() -> Tool {
    let annotations = ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false);
    let m = json!({
        meta::APPROVAL: "never",
        meta::MUTATING: false,
        "ui": { "visibility": ["app"] },
    });
    Tool::new(
        NAME,
        "A stored render's PNG under renders/ as image content (for MCP Apps cards; hidden from the model).",
        object(input_schema()),
    )
    .with_raw_output_schema(object(output_schema()))
    .with_annotations(annotations)
    .with_meta(rmcp::model::MetaObject(
        m.as_object().cloned().unwrap_or_default(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderPictureIn {
    path: String,
}

/// A project-relative `renders/**.png` path with no `..`, root or prefix.
fn safe_path(p: &str) -> bool {
    let path = Path::new(p);
    let mut parts = path.components();
    parts.next() == Some(Component::Normal(crate::render::RENDERS_DIR.as_ref()))
        && path.components().count() >= 2
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && path.extension().is_some_and(|e| e == "png")
}

/// Runs the tool: `(structured output, base64 PNG)`.
pub fn call(root: &Path, args: Value) -> Result<(Value, String), ApiError> {
    let i: RenderPictureIn = serde_json::from_value(args).map_err(|e| {
        err(
            ApiErrorCode::InvalidInput,
            format!("`render_picture` input: {e}"),
        )
    })?;
    if !safe_path(&i.path) {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("`{}` is not a PNG under renders/", i.path),
        ));
    }
    let file = root.join(&i.path);
    let len = std::fs::metadata(&file)
        .map_err(|_| err(ApiErrorCode::NotFound, format!("no render at `{}`", i.path)))?
        .len();
    if len > MAX_BYTES {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("`{}` is over {MAX_BYTES} bytes", i.path),
        ));
    }
    let png = std::fs::read(&file)
        .map_err(|_| err(ApiErrorCode::NotFound, format!("no render at `{}`", i.path)))?;
    Ok((
        json!({ "path": i.path, "bytes": png.len() }),
        base64::engine::general_purpose::STANDARD.encode(png),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_under_renders() {
        assert!(safe_path("renders/default.profile.png"));
        assert!(safe_path("renders/compare/a.b.png"));
        assert!(!safe_path("renders"));
        assert!(!safe_path("renders/x.svg"));
        assert!(!safe_path("renders/../rocket.rw.json.png"));
        assert!(!safe_path("/renders/x.png"));
        assert!(!safe_path("runs/x.png"));
        assert!(!safe_path("./renders/x.png"));
    }

    #[test]
    fn reads_a_stored_png() {
        let dir = std::env::temp_dir().join(format!("rw-render-picture-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("renders")).unwrap();
        std::fs::write(dir.join("renders/a.png"), b"\x89PNG").unwrap();
        let (out, b64) = call(&dir, json!({ "path": "renders/a.png" })).unwrap();
        assert_eq!(out, json!({ "path": "renders/a.png", "bytes": 4 }));
        assert_eq!(b64, "iVBORw==");
        let e = call(&dir, json!({ "path": "renders/b.png" })).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::NotFound);
        let e = call(&dir, json!({ "path": "../a.png" })).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
