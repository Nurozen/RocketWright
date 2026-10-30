//! MCP resources (S:85 + D6, M1.31): what each `rw://` resource holds, when
//! to read or subscribe to it, and the URIs a change touches.
//!
//! Subscribable resources announce changes with
//! `notifications/resources/updated`: `rw://project/*` after every recorded
//! mutation or watched save, `rw://runs/index` and `rw://jobs/<id>` on every
//! job state change and every 10 % of progress.

use rw_api::ResourceDef;

/// The MCP Apps card mime type (Lecturn accepts only this exact string).
pub const UI_MIME: &str = "text/html;profile=mcp-app";

/// One `ui://rw/*` MCP Apps card (B3, D7): a self-contained HTML document
/// (inline script and style, `data:` images only) that renders a tool call
/// from its input and result and styles itself from the host's MCP Apps
/// `--color-*` / `--font-*` variables.
pub struct UiCard {
    pub uri: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub html: &'static str,
    /// The tools whose `_meta.ui.resourceUri` names this card.
    pub tools: &'static [&'static str],
}

/// `ui://rw/run-card`.
pub const RUN_CARD: &str = "ui://rw/run-card";
/// `ui://rw/step-card`.
pub const STEP_CARD: &str = "ui://rw/step-card";
/// `ui://rw/render-card`.
pub const RENDER_CARD: &str = "ui://rw/render-card";

/// Every card, with the tools it renders.
pub const UI_CARDS: &[UiCard] = &[
    UiCard {
        uri: RUN_CARD,
        name: "run-card",
        description: "A simulation run: summary stats and the altitude (flight) or thrust \
                      (engine) chart, or two flights compared (run_diff: both altitude \
                      traces in the Results series colours). Follows a started flight's \
                      job (the full card is on the job_status that completes it) and \
                      reads samples with run_series.",
        html: include_str!("cards/run-card.html"),
        tools: &["simulate", "engine_simulate", "job_status", "run_diff"],
    },
    UiCard {
        uri: STEP_CARD,
        name: "step-card",
        description: "A recorded design step: what the edit did (or, for history_show, \
                      the step's title), the changed metrics, and a Compare action \
                      (rw:step/<n>).",
        html: include_str!("cards/step-card.html"),
        tools: &[
            "component_add",
            "component_remove",
            "model_patch",
            "import_file",
            "history_restore",
            "history_show",
        ],
    },
    UiCard {
        uri: RENDER_CARD,
        name: "render-card",
        description: "A render or visual comparison: the picture from the result's image \
                      content and its caption.",
        html: include_str!("cards/render-card.html"),
        tools: &["render", "history_compare"],
    },
];

/// The card a tool's result renders in, if any.
pub fn card_for(tool: &str) -> Option<&'static UiCard> {
    UI_CARDS.iter().find(|c| c.tools.contains(&tool))
}

/// The card served at `uri`, if any.
pub fn ui_card(uri: &str) -> Option<&'static UiCard> {
    UI_CARDS.iter().find(|c| c.uri == uri)
}

/// `rw://jobs/<id>`.
pub fn job_uri(id: &str) -> String {
    rw_project::session::job_uri(id)
}

/// URIs a job update changes.
pub fn job_update_uris(id: &str) -> Vec<String> {
    vec![job_uri(id), rw_project::session::URI_RUNS.to_string()]
}

fn when(uri: &str) -> &'static str {
    match uri {
        "rw://project/model" => {
            "The evaluated model (SI). Subscribe to follow edits from any front end."
        }
        "rw://project/check" => {
            "The current static check report (same as design_check with no arguments)."
        }
        "rw://project/files" => "Every source file's text, keyed by project-relative path.",
        "rw://project/history" => "History steps and named revisions (as history_list).",
        "rw://runs/index" => {
            "Each simulation's latest run with computed status (as run_list); updates as jobs progress."
        }
        "rw://runs/{id}/summary" => "One run's summary.json (apogee_m, max_velocity_ms, ...).",
        "rw://jobs/{id}" => {
            "One job's status (as job_status). Subscribe after simulate instead of polling; an update \
             arrives on every state change and every 10 % of progress."
        }
        "rw://schema/{type}" => "A published JSON Schema (draft 2020-12) by registry name.",
        _ => "",
    }
}

/// The description of a resource or template.
pub fn describe(r: &ResourceDef) -> String {
    let what = if r.type_name == "json-schema" {
        "JSON Schema".to_string()
    } else {
        format!("JSON per schema/{}.json", r.type_name)
    };
    let sub = if r.subscribable {
        " Supports resources/subscribe."
    } else {
        ""
    };
    let w = when(r.uri).split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{w} {what}.{sub}").trim().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_resource_is_described() {
        for r in rw_api::RESOURCES {
            assert!(!super::when(r.uri).is_empty(), "{}", r.uri);
            assert_eq!(
                super::describe(r).contains("subscribe"),
                r.subscribable,
                "{}",
                r.uri
            );
        }
        assert_eq!(
            super::job_update_uris("job-1"),
            ["rw://jobs/job-1", "rw://runs/index"]
        );
    }

    #[test]
    fn cards_are_self_contained_mcp_apps() {
        for c in super::UI_CARDS {
            assert!(c.uri.starts_with("ui://rw/"), "{}", c.uri);
            assert!(c.html.starts_with("<!doctype html>"), "{}", c.uri);
            // Lecturn's CSP: no external scripts, styles, images, or fetches.
            for banned in [
                "<script src",
                "<link",
                "src=\"http",
                "url(http",
                "@import",
                "fetch(",
                "XMLHttpRequest",
            ] {
                assert!(!c.html.contains(banned), "{}: {banned}", c.uri);
            }
            assert!(c.html.contains("ui/initialize"), "{}", c.uri);
            assert!(c.html.contains("--color-ring-primary"), "{}", c.uri);
            for t in c.tools {
                assert_eq!(super::card_for(t).map(|x| x.uri), Some(c.uri));
            }
        }
        assert!(super::card_for("design_check").is_none());
    }
}
