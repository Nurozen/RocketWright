//! The MCP tool and resource listings, built from the `rw_api` registry: the
//! tool `inputSchema`/`outputSchema` are the published `schema/tools/*.json`
//! (invariant I3), annotations come from `ToolHints`, and `_meta` carries the
//! approval policy (I16) and, for tools with an MCP Apps card, the card's
//! `ui.resourceUri` (B3, D7). The app-only `run_series` follows the
//! registry tools. Every tool carries its display `title` (and
//! `annotations.title`), [`super::presentation::TITLES`] (CPW1R4B).

use std::sync::{Arc, OnceLock};

use rmcp::model::{JsonObject, Resource, ResourceTemplate, Tool, ToolAnnotations};
use rw_api::{Approval, COMMANDS, CommandDef, RESOURCES, ResourceDef, schema_entry};
use serde_json::{Value, json};

use super::meta;

fn object(v: &Value) -> Arc<JsonObject> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

fn schema_object(name: &str) -> Arc<JsonObject> {
    let e = schema_entry(name).unwrap_or_else(|| panic!("registry lacks `{name}`"));
    object(e.schema().as_value())
}

fn tool(d: &CommandDef) -> Tool {
    let h = d.hints;
    let annotations = ToolAnnotations::new()
        .read_only(h.read_only)
        .destructive(h.destructive)
        .idempotent(h.idempotent)
        .open_world(h.open_world);
    let mut m = json!({
        meta::APPROVAL: d.approval,
        meta::MUTATING: h.mutating,
    });
    if d.approval == Approval::Always {
        m[meta::PERMISSION_POLICY] = json!("always_ask");
    }
    if let Some(card) = super::resources::card_for(d.name) {
        m["ui"] = json!({ "resourceUri": card.uri });
    }
    Tool::new(
        d.name,
        super::descriptions::describe(d),
        schema_object(&format!("tools/{}.input", d.name)),
    )
    .with_raw_output_schema(schema_object(&format!("tools/{}.output", d.name)))
    .with_annotations(annotations)
    .with_meta(rmcp::model::MetaObject(
        m.as_object().cloned().unwrap_or_default(),
    ))
}

/// `t` with its display title, top-level and in `annotations` (CPW1R4B).
fn titled(t: Tool) -> Tool {
    let title = super::presentation::title(&t.name)
        .unwrap_or_else(|| panic!("tool `{}` has no title in presentation::TITLES", t.name));
    let mut annotations = t.annotations.clone().unwrap_or_default();
    annotations.title = Some(title.to_string());
    t.with_title(title).with_annotations(annotations)
}

/// Every MCP tool: the registry's, in catalogue order, then the app-only
/// tools (`run_series`, `render_picture`).
pub fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        COMMANDS
            .iter()
            .filter(|d| d.mcp)
            .map(tool)
            .chain([super::series::tool(), super::picture::tool()])
            .map(titled)
            .collect()
    })
}

/// True when a tool's `_meta.ui.visibility` hides it from the model (MCP
/// Apps: `["app"]` tools are for cards only).
pub fn app_only(t: &Tool) -> bool {
    t.meta
        .as_ref()
        .and_then(|m| m.get("ui"))
        .and_then(|ui| ui.get("visibility"))
        .and_then(Value::as_array)
        .is_some_and(|v| !v.iter().any(|x| x == "model"))
}

/// The MCP tool catalogue entry, if `name` is an MCP tool.
pub fn mcp_command(name: &str) -> Option<&'static CommandDef> {
    COMMANDS.iter().find(|d| d.mcp && d.name == name)
}

fn is_template(uri: &str) -> bool {
    uri.contains('{')
}

fn title(r: &ResourceDef) -> String {
    r.uri.trim_start_matches("rw://").to_string()
}

fn description(r: &ResourceDef) -> String {
    super::resources::describe(r)
}

/// Fixed-URI resources: the registry's `rw://` resources, then the
/// [`ui_resources`].
pub fn resources() -> Vec<Resource> {
    RESOURCES
        .iter()
        .filter(|r| !is_template(r.uri))
        .map(|r| {
            Resource::new(r.uri, title(r))
                .with_description(description(r))
                .with_mime_type("application/json")
        })
        .chain(ui_resources())
        .collect()
}

/// The `ui://rw/*` MCP Apps cards (`text/html;profile=mcp-app`).
pub fn ui_resources() -> Vec<Resource> {
    super::resources::UI_CARDS
        .iter()
        .map(|c| {
            Resource::new(c.uri, c.name)
                .with_description(
                    c.description
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                )
                .with_mime_type(super::resources::UI_MIME)
        })
        .collect()
}

/// URI-template resources (`rw://runs/{id}/summary`, ...).
pub fn resource_templates() -> Vec<ResourceTemplate> {
    RESOURCES
        .iter()
        .filter(|r| is_template(r.uri))
        .map(|r| {
            ResourceTemplate::new(r.uri, title(r))
                .with_description(description(r))
                .with_mime_type("application/json")
        })
        .collect()
}

/// Matches `uri` against a resource URI or a one-variable template. The
/// variable matches a non-empty segment, or the non-empty rest of the URI when
/// it ends the template (`rw://schema/tools/model_patch.input`).
pub fn matches(template: &str, uri: &str) -> Option<String> {
    let Some(open) = template.find('{') else {
        return (template == uri).then(String::new);
    };
    let close = template[open..].find('}')? + open;
    let (prefix, suffix) = (&template[..open], &template[close + 1..]);
    let rest = uri.strip_prefix(prefix)?;
    let var = rest.strip_suffix(suffix)?;
    let ok = !var.is_empty() && (suffix.is_empty() || !var.contains('/'));
    ok.then(|| var.to_string())
}

/// The resource definition serving `uri`, and its template variable.
pub fn resource_for(uri: &str) -> Option<(&'static ResourceDef, String)> {
    RESOURCES
        .iter()
        .find_map(|r| matches(r.uri, uri).map(|v| (r, v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mcp_command_is_a_tool_with_object_schemas() {
        let n = COMMANDS.iter().filter(|d| d.mcp).count();
        assert_eq!(tools().len(), n + 2);
        assert_eq!(
            tools()
                .iter()
                .filter(|t| app_only(t))
                .map(|t| &*t.name)
                .collect::<Vec<_>>(),
            [super::super::series::NAME, super::super::picture::NAME]
        );
        for t in tools() {
            assert_eq!(
                t.input_schema.get("type"),
                Some(&json!("object")),
                "{}",
                t.name
            );
            let out = t.output_schema.as_ref().expect("output schema");
            assert_eq!(out.get("type"), Some(&json!("object")), "{}", t.name);
        }
        let gated = tools().iter().find(|t| t.name == "import_file").unwrap();
        let m = gated.meta.as_ref().unwrap();
        assert_eq!(m.get(meta::PERMISSION_POLICY), Some(&json!("always_ask")));
        // The card table: `rw/*` keys stay beside `ui.resourceUri`.
        for (name, uri) in [
            ("simulate", "ui://rw/run-card"),
            ("engine_simulate", "ui://rw/run-card"),
            ("job_status", "ui://rw/run-card"),
            ("run_diff", "ui://rw/run-card"),
            ("component_add", "ui://rw/step-card"),
            ("component_remove", "ui://rw/step-card"),
            ("model_patch", "ui://rw/step-card"),
            ("import_file", "ui://rw/step-card"),
            ("history_restore", "ui://rw/step-card"),
            ("history_show", "ui://rw/step-card"),
            ("render", "ui://rw/render-card"),
            ("history_compare", "ui://rw/render-card"),
        ] {
            let t = tools().iter().find(|t| t.name == name).unwrap();
            let m = t.meta.as_ref().unwrap();
            assert_eq!(m["ui"]["resourceUri"], uri, "{name}");
            assert!(m.get(meta::APPROVAL).is_some(), "{name}");
            assert!(m.get(meta::MUTATING).is_some(), "{name}");
        }
        // CPW1R4B: every tool reads as its title, never its raw name.
        for t in tools() {
            let title = super::super::presentation::title(&t.name).unwrap();
            assert_eq!(t.title.as_deref(), Some(title), "{}", t.name);
            let a = t.annotations.as_ref().unwrap();
            assert_eq!(a.title.as_deref(), Some(title), "{}", t.name);
            assert!(a.read_only_hint.is_some(), "{}: hints kept", t.name);
        }
        let titles = |names: &[&str]| -> Vec<String> {
            names
                .iter()
                .map(|n| {
                    tools()
                        .iter()
                        .find(|t| t.name == *n)
                        .unwrap()
                        .title
                        .clone()
                        .unwrap()
                })
                .collect()
        };
        assert_eq!(
            titles(&[
                "design_check",
                "simulate",
                "engine_simulate",
                "motor_search",
                "model_patch",
                "model_get",
                "run_list",
                "run_diff",
                "job_status",
                "history_show",
                "render"
            ]),
            [
                "Check design",
                "Run simulation",
                "Simulate engine",
                "Find motors",
                "Edit model",
                "Read model",
                "List runs",
                "Compare runs",
                "Check run",
                "Show history step",
                "Render view"
            ]
        );
        let plain = tools().iter().find(|t| t.name == "design_check").unwrap();
        assert!(plain.meta.as_ref().unwrap().get("ui").is_none());
    }

    #[test]
    fn uri_templates() {
        assert_eq!(
            matches("rw://project/model", "rw://project/model"),
            Some(String::new())
        );
        assert_eq!(matches("rw://project/model", "rw://project/check"), None);
        assert_eq!(
            matches("rw://runs/{id}/summary", "rw://runs/abc/summary"),
            Some("abc".into())
        );
        assert_eq!(
            matches("rw://runs/{id}/summary", "rw://runs/a/b/summary"),
            None
        );
        assert_eq!(
            matches("rw://runs/{id}/summary", "rw://runs//summary"),
            None
        );
        assert_eq!(
            matches("rw://schema/{type}", "rw://schema/tools/model_patch.input"),
            Some("tools/model_patch.input".into())
        );
        assert!(resource_for("rw://jobs/j1").is_some());
        assert!(resource_for("rw://nope").is_none());
        assert_eq!(
            resources().len() + resource_templates().len(),
            RESOURCES.len() + ui_resources().len()
        );
        assert_eq!(
            ui_resources().len(),
            super::super::resources::UI_CARDS.len()
        );
        for r in ui_resources() {
            assert_eq!(r.mime_type.as_deref(), Some("text/html;profile=mcp-app"));
        }
    }

    /// The `rw:` refs inside backtick spans or code blocks of `text`
    /// (`rw://` resource URIs are not refs).
    fn backticked_refs(text: &str) -> Vec<String> {
        text.split('`')
            .enumerate()
            .filter(|(i, span)| i % 2 == 1 && span.replace("rw://", "").contains("rw:"))
            .map(|(_, span)| span.to_string())
            .collect()
    }

    #[test]
    fn agent_facing_text_writes_rw_refs_as_plain_text() {
        // CPW2A: hosts render inline code literally, so a backticked ref is no link.
        assert_eq!(
            backticked_refs("see `rw:c/fins` or `rw://project/model`"),
            ["rw:c/fins"]
        );
        assert_eq!(backticked_refs("```\nrw:run/x\n```"), ["\nrw:run/x\n"]);
        assert!(backticked_refs("plain rw:c/fins and `design_check`").is_empty());
        let listed = serde_json::to_string(&json!({
            "tools": tools(),
            "resources": resources(),
            "templates": resource_templates(),
        }))
        .unwrap();
        // JSON escapes nothing in a backtick; read the raw serialized text.
        assert_eq!(backticked_refs(&listed), Vec::<String>::new());
        assert_eq!(
            backticked_refs(super::super::server::INSTRUCTIONS),
            Vec::<String>::new()
        );
        let text = super::super::server::INSTRUCTIONS;
        // CPW2B: the rule leads, the prose models plain identifiers (no
        // backticks at all), and one example sentence uses a ref.
        let rule = text
            .find("Write rw: references as plain text (rw:c/fins), never inside backticks")
            .expect("the plain-text rule");
        assert!(rule < 80, "the rule is near the top: {rule}");
        assert!(!text.contains('`'), "no code formatting: {text}");
        assert!(text.contains("Example reply: The fins rw:c/fins now span 50 mm"));
    }
}
