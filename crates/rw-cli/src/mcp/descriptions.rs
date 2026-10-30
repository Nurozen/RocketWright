//! MCP tool descriptions (R7.3, M1.31): when to use each tool, and for
//! mutating tools the `CheckDelta` shape every one of them returns (I6).
//! The one-line summaries in `rw_api::COMMANDS` stay the schema docs; these
//! longer texts are what an agent reads in `tools/list`.
//!
//! Sibling tools are named bare and prefix-neutral ("the design_check
//! tool"): hosts may list them prefixed (Lecturn: `rw_design_check`) while
//! passing these texts through unchanged, so a text never says the bare name
//! is the exact callable one.

use rw_api::CommandDef;

/// The `CheckDelta` every mutating tool returns, as agents see it.
pub const CHECK_DELTA_SHAPE: &str = "Returns {step, model_hash, dry_run, files: [{path, status: A|M|D}], \
delta: {status: clean|warnings|errors, model_hash, step?, changed: {\"<metric path>\": [before, after]} \
(e.g. \"stability.liftoff\": [1.42, 1.87], SI units; metric paths as in rw://schema/check-report), \
new_diagnostics: [{code, severity, path, message, hint}], resolved_diagnostics: [\"<code>@<path>\"]}}. \
Read delta.status and new_diagnostics before claiming success. dry_run: true previews the delta and writes nothing.";

/// When-to-use text per MCP tool.
fn when(name: &str) -> &'static str {
    match name {
        "project_create" => {
            "Create a new project from a template (minimum, simple-rocket) in an empty project directory. \
             Use once, before any edit; an existing project answers conflict."
        }
        "project_validate" => {
            "Schema-only validation of the project files (parse, units, unknown keys), without evaluating \
             physics. Use after editing files directly, or when the design_check tool reports parse errors."
        }
        "model_get" => {
            "Read the evaluated model (SI values, resolved expressions, component stations) or one subtree \
             by JSON pointer (path: /components/3). Use before editing to learn ids, anchors, and current \
             values; version reads a past step (step:<n>, rev:<NN>)."
        }
        "model_patch" => {
            "Edit the model with RFC 6902 ops on id paths (/c/<id>/<field>, /params/<name>/value, \
             /configs/<id>/...). Values with units are strings (\"30 mm\"). The main editing tool: use it \
             for any field change, several ops at once for one logical edit."
        }
        "component_add" => {
            "Add a new component under a fresh id, attached to a named anchor of an existing component \
             (attach.to = \"<id>.<anchor>\"). Use for new parts; edit existing ones with the model_patch tool."
        }
        "component_remove" => {
            "Remove a component. Components attached to it must be removed too (recursive: true) or \
             re-attached first."
        }
        "design_check" => {
            "The full check report: diagnostics with hints, dims (length in calibers and fineness \
             included), mass breakdown (mass.components[]: component, mass, cg), aero terms \
             (aero.terms[]: component, cna, cp, model), CG/CP, stability at liftoff and burnout, motor fit, clearances, \
             assertions. Run it after every edit and before claiming a design works. set: what-if \
             overrides (rw set paths), nothing written. sim: \"quick\" adds a flight summary of the \
             checked model (overrides included) and sim-based assertions; strict: true treats warnings \
             as failures."
        }
        "render" => {
            "Render a view to renders/<config>.<view>.png and return it as an image: the 2D drawings \
             (profile, fin, stations, anchors) with CG/CP markers, or a headless 3D view (iso, top, side, \
             front, rear) with flat check materials (needs rocketwright-render; exits with an I/O error \
             and a hint when absent). compare=<version> draws what changed since it (removed red, \
             changed amber, added green). Use for visual confirmation of an edit; in the app, \
             the viewport_render tool shows the live viewport."
        }
        "library_search" => {
            "Search the project library (lib/components, lib/materials, lib/motors) and the built-in \
             parts presets (openrocket-database catalogs) by text and kind. Use to find a part or \
             material ref before adding or editing a component. Without a limit, at most 100 \
             presets are listed."
        }
        "motor_search" => {
            "Search motors (generic curves and lib/motors) by text, impulse class, diameter (\"18 mm\"), \
             and impulse range. Use to pick a motor ref (generic:RW_C6G, lib:<path>#<designation>) for a \
             configuration's mount."
        }
        "simulate" => {
            "Fly a simulation (sims/<id>.rw.toml). Returns at once: a cache hit (status complete, summary) \
             when the inputs are unchanged, otherwise a job_id. Poll the job_status tool or subscribe to \
             rw://jobs/<id>; the run lands in runs/<sim>/<run_id>/ (manifest, summary, events, series). \
             force: true re-runs a cached run."
        }
        "job_status" => {
            "Poll a job started by the simulate tool: state (queued, running, complete, failed, cancelled), \
             progress 0..1, and the run summary once complete."
        }
        "job_cancel" => "Cancel a queued or running job. Finished jobs are returned unchanged.",
        "run_list" => {
            "List each simulation's latest run with computed status: complete (current model), outdated \
             (the model changed since), running, failed, or not_run, with its summary. Use to decide \
             whether to re-simulate."
        }
        "run_diff" => {
            "Compare two runs (a, b), or a run and an oracle golden (golden: tests/oracle/case1-generic.json) \
             with per-key tolerances (tol: {apogee_m: \"3%\"}; defaults from tolerances.json beside the \
             golden). Setup mismatches (conditions, config, sim, motor digest) are listed and the rows \
             are not scored. Against a golden with a static block, rows mass.cg, aero.cp, aero.cna, and \
             stability.liftoff compare the run's own model (its history step when outdated) with the \
             golden: a, b, delta (a - b) and delta_pct, tol, pass; `notes` say which model they came from. \
             `phases`: time, altitude, and speed of rail exit, burnout, apogee, the last deployment, and \
             landing on both sides in time order (never gated): read where a gap opens from these rows."
        }
        "model_diff" => {
            "Semantic diff of two model versions keyed by component id: added, removed, changed fields. \
             Versions: live, HEAD, step:<n>, rev:<NN>, commit:<sha>."
        }
        "history_list" => {
            "List history steps (one per mutating call or watched save) with origin, thread, title, and \
             metrics, plus named revisions. Filter by thread."
        }
        "history_show" => "One history step and its model diff against the previous step.",
        "history_compare" => {
            "Compare any two versions (step:N, rev:NN, run:<id>, live): the source edits keyed by \
             component id with SI values and units, the components removed/changed/added (marks), and \
             the metrics with units (two runs: their flight summaries first). visual=true also draws \
             the red/amber/green profile. breakdown=true adds per-component rows \
             (mass.components.<id>.mass|cg, aero.terms.<id>.cna|cp): attribute a change to a component \
             only from these rows."
        }
        "history_tag" => {
            "Name a version as a revision (Rev NN) so it can be compared or restored later. Use at \
             milestones the user cares about."
        }
        "history_restore" => {
            "Restore an earlier version as a new step (nothing is lost). Use to undo; dry_run previews \
             the delta."
        }
        "import_file" => {
            "Import an OpenRocket .ork or a motor file (.eng, .rse) into the project. Needs the user's \
             approval."
        }
        "export_file" => {
            "Export the model or a run (ork, rasp, glb, stl, csv) to a path inside the project (e.g. \
             exports/rocket.glb). Needs the user's approval; a path outside the project also needs \
             allow_outside: true."
        }
        "schema_get" => {
            "Read a published JSON Schema by name (check-report, tools/model_patch.input, ...), or list \
             the names. Use when unsure of a field or metric path."
        }
        "engine_design" => {
            "Liquid engine sizing and performance from engines/<id>.rw.toml (Isp, c*, throat and exit \
             diameters), listing missing inputs."
        }
        "engine_simulate" => "Tank and feed blowdown simulation of a liquid engine; returns a job.",
        "cfd_import" => {
            "Import a CFD point dataset (CSV: header x,y,z in m, body frame; optional vx,vy,vz and \
             scalar columns; one file per step <prefix>_t<s>.csv, or a directory of them) into \
             runs/cfd.<id>/ with provenance cfd, for page 06 Imported CFD. Display only. Needs approval."
        }
        _ => "",
    }
}

/// The MCP description of a tool: when to use it, plus the `CheckDelta`
/// shape for mutating tools.
pub fn describe(d: &CommandDef) -> String {
    let w = when(d.name);
    let base = if w.is_empty() { d.summary } else { w };
    let base = base.split_whitespace().collect::<Vec<_>>().join(" ");
    if d.hints.mutating {
        format!("{base} {CHECK_DELTA_SHAPE}")
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mcp_tool_has_a_when_to_use_text() {
        for d in rw_api::COMMANDS.iter().filter(|d| d.mcp) {
            assert!(!when(d.name).is_empty(), "{}", d.name);
            let text = describe(d);
            assert_eq!(
                text.contains("delta: {status"),
                d.hints.mutating,
                "{}",
                d.name
            );
            assert!(!text.contains("  "), "{}", d.name);
        }
    }

    /// Sibling tools appear only as "the <name> tool" (prefix-neutral);
    /// schema and file paths (`tools/model_patch.input`) do not count.
    #[test]
    fn sibling_tools_are_named_prefix_neutral() {
        let names: Vec<&str> = rw_api::COMMANDS
            .iter()
            .filter(|d| d.mcp)
            .map(|d| d.name)
            .chain(["viewport_render", "viewport_select", "plot_render"])
            .collect();
        let word = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/');
        for d in rw_api::COMMANDS.iter().filter(|d| d.mcp) {
            let text = describe(d);
            for n in names.iter().filter(|n| **n != d.name) {
                for (i, _) in text.match_indices(n) {
                    let before = &text[..i];
                    let after = &text[i + n.len()..];
                    if before.ends_with(word) || after.starts_with(word) {
                        continue;
                    }
                    assert!(
                        before.ends_with("the ") && after.starts_with(" tool"),
                        "{}: names `{n}` bare: …{}…",
                        d.name,
                        &text[i.saturating_sub(20)..(i + n.len() + 10).min(text.len())]
                    );
                }
            }
        }
    }
}
