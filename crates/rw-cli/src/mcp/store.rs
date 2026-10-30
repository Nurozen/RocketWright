//! `render_store` (CPW2B): stores a window render's PNG under `renders/`
//! for the app server.
//!
//! The window answers the agent's `viewport_render` and `plot_render` with a
//! PNG the app server returns as image content. Lecturn omits tool-output
//! image bytes from the results it hands MCP Apps cards, so the render card
//! reads the stored file the result names (`path`) through `render_picture`,
//! as it does for `render`. The app server stores the window's PNG here
//! first: through the session (the only writer of project files, I1), at
//! `renders/window/<kind>.<sha256 prefix>.png` (content-addressed, so the
//! same picture is one file). Each store keeps the newest [`KEEP`] files of
//! its kind and removes the rest (POL): a stored picture is rewritten, so
//! it counts as the newest.
//!
//! The tool is internal: it is not in `tools/list` (no host, model or card
//! sees it; Lecturn proxies listed tools only, and the app server's own
//! agent route only its policy's), and a call Lecturn proxied
//! (`_meta["lecturn/context"]`) is refused.

use base64::Engine as _;
use rw_api::{ApiError, ApiErrorCode};
use rw_project::SharedSession;
use serde::Deserialize;
use serde_json::{Value, json};

use super::picture;

/// The tool name.
pub const NAME: &str = "render_store";
/// Where window renders are stored, under the project root.
pub const WINDOW_DIR: &str = "renders/window";
/// Window renders kept per kind (op); older ones are removed on each store.
pub const KEEP: usize = 50;
/// The PNG signature.
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

fn err(code: ApiErrorCode, message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenderStoreIn {
    /// What drew it (`viewport_render`, `plot_render`): the file name's stem.
    kind: String,
    png_base64: String,
}

/// A file-name-safe kind: `[a-z0-9_]{1,32}`.
fn safe_kind(k: &str) -> bool {
    (1..=32).contains(&k.len())
        && k.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The project-relative path a PNG is stored at.
pub fn stored_path(kind: &str, png: &[u8]) -> String {
    let sha = crate::render::sha256_hex(png);
    format!("{WINDOW_DIR}/{kind}.{}.png", &sha[..16])
}

/// Validates the input: `(path, png bytes)`.
fn parse(args: Value) -> Result<(String, Vec<u8>), ApiError> {
    let i: RenderStoreIn = serde_json::from_value(args)
        .map_err(|e| err(ApiErrorCode::InvalidInput, format!("`{NAME}` input: {e}")))?;
    if !safe_kind(&i.kind) {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("kind `{}` is not [a-z0-9_]{{1,32}}", i.kind),
        ));
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(i.png_base64.as_bytes())
        .map_err(|e| err(ApiErrorCode::InvalidInput, format!("png_base64: {e}")))?;
    if !png.starts_with(PNG_MAGIC) {
        return Err(err(ApiErrorCode::InvalidInput, "png_base64 is not a PNG"));
    }
    if png.len() as u64 > picture::MAX_BYTES {
        return Err(err(
            ApiErrorCode::InvalidInput,
            format!("the PNG is over {} bytes", picture::MAX_BYTES),
        ));
    }
    Ok((stored_path(&i.kind, &png), png))
}

/// Runs the tool: `{path, bytes}`. Without a session (contract-fixture
/// mode, an empty directory) nothing can be stored.
pub fn call(session: Option<&SharedSession>, args: Value) -> Result<Value, ApiError> {
    let (path, png) = parse(args)?;
    let Some(session) = session else {
        return Err(err(ApiErrorCode::NotFound, "no project here to store into"));
    };
    let bytes = png.len();
    let mut s = session
        .lock()
        .map_err(|_| err(ApiErrorCode::Internal, "the session lock is poisoned"))?;
    // Content-addressed: rewriting the same bytes marks the file newest.
    s.write_outputs(&[(path.clone(), png)])?;
    let kind = path
        .strip_prefix(&format!("{WINDOW_DIR}/"))
        .and_then(|f| f.split_once('.'))
        .map_or("", |(k, _)| k);
    s.prune_outputs(WINDOW_DIR, &format!("{kind}."), KEEP)?;
    Ok(json!({ "path": path, "bytes": bytes }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[test]
    fn paths_are_content_addressed_under_renders_window() {
        let p = stored_path("plot_render", PNG);
        assert!(p.starts_with("renders/window/plot_render."), "{p}");
        assert!(p.ends_with(".png"));
        assert_eq!(p.len(), "renders/window/plot_render.".len() + 16 + 4);
        assert_eq!(p, stored_path("plot_render", PNG));
        assert_ne!(p, stored_path("plot_render", b"\x89PNG\r\n\x1a\nother"));
    }

    #[test]
    fn refuses_bad_input() {
        for (args, what) in [
            (json!({"kind": "plot_render"}), "missing png"),
            (
                json!({"kind": "../x", "png_base64": b64(PNG)}),
                "unsafe kind",
            ),
            (json!({"kind": "", "png_base64": b64(PNG)}), "empty kind"),
            (
                json!({"kind": "plot_render", "png_base64": "%%%"}),
                "not base64",
            ),
            (
                json!({"kind": "plot_render", "png_base64": b64(b"GIF89a")}),
                "not a PNG",
            ),
            (
                json!({"kind": "plot_render", "png_base64": b64(PNG), "x": 1}),
                "unknown field",
            ),
        ] {
            let e = call(None, args).unwrap_err();
            assert_eq!(e.code, ApiErrorCode::InvalidInput, "{what}");
        }
        let e = call(None, json!({"kind": "plot_render", "png_base64": b64(PNG)})).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::NotFound);
    }
}
