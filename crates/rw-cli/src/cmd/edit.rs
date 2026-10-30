//! `rw set`, `rw add`, `rw rm`, `rw mv`: mutations through the session's
//! pipeline; each prints the check delta (I6) and then its own strict check
//! (`check --strict: <status>`, exit 1 unless clean). Removing a field (a
//! key back to its default) is `rw set <path>... --unset` or `rw rm <path>`
//! with a dotted path or JSON pointer (B3 round 13: no raw `rw call`).

use serde_json::{Value, json};

use super::{CmdResult, Opts, kv, mutation_outcome, usage};

/// `c.fins.span` → `/c/fins/span`; JSON pointers pass through.
pub fn pointer(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{}", path.replace('.', "/"))
    }
}

/// A value from the command line: JSON when it parses (`3`, `true`,
/// `{"a":1}`, `"x"`), otherwise the text itself (`30 mm`, `ogive`).
pub fn value(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|_| Value::String(s.to_string()))
}

fn mutation(opts: &Opts, v: Value) -> CmdResult {
    Ok(mutation_outcome(opts, v, "", ""))
}

/// `rw set <path>... --unset [--dry-run] [--label]`: removes each field.
pub fn unset(opts: &Opts, paths: &[String], dry_run: bool, label: Option<String>) -> CmdResult {
    if paths.is_empty() {
        return Err(usage("rw set --unset needs at least one path"));
    }
    let mut ops = Vec::new();
    for p in paths {
        if p.contains('=') {
            let mut e = usage(format!("--unset takes paths, not path=value (`{p}`)"));
            e.hint = Some("e.g. rw set sims.flight.launch_into_wind --unset".into());
            return Err(e);
        }
        ops.push(json!({"op": "remove", "path": pointer(p)}));
    }
    let mut args = json!({"ops": ops, "dry_run": dry_run});
    if let Some(l) = &label {
        args["label"] = json!(l);
    }
    mutation(opts, opts.call("model_patch", args, label)?)
}

/// `rw set <path>=<value>... [--dry-run] [--label]`.
pub fn set(opts: &Opts, assignments: &[String], dry_run: bool, label: Option<String>) -> CmdResult {
    if assignments.is_empty() {
        return Err(usage("rw set needs at least one path=value"));
    }
    let mut ops = Vec::new();
    for a in assignments {
        let (k, v) = kv(a)?;
        ops.push(json!({"op": "add", "path": pointer(&k), "value": value(&v)}));
    }
    loop {
        let mut args = json!({"ops": ops, "dry_run": dry_run});
        if let Some(l) = &label {
            args["label"] = json!(l);
        }
        match opts.call("model_patch", args, label.clone()) {
            Ok(v) => return mutation(opts, v),
            // A table under an existing component, configuration, or sim
            // that the file does not have yet (`configs.a.deploy.chute.event`
            // with no `[deploy.chute]`): set it one level up instead.
            Err(e) => match missing_parent(&e.message).filter(|i| nest(&mut ops[*i])) {
                Some(_) => continue,
                None => return Err(e),
            },
        }
    }
}

/// The op index of a `model_patch` rejection whose parent path does not
/// exist (`op 0 at `/configs/a/deploy/chute/event`: not_found: ...`).
fn missing_parent(message: &str) -> Option<usize> {
    let rest = message.strip_prefix("op ")?;
    let (i, rest) = rest.split_once(' ')?;
    rest.contains(": not_found: ").then(|| i.parse().ok())?
}

/// Moves an `add` op one level up, wrapping its value: `/a/b/c/d = v` →
/// `/a/b/c = {"d": v}`. Never above `/<root>/<id>/<key>`, so a mistyped
/// component, configuration, or sim id stays an error. False when it cannot.
fn nest(op: &mut Value) -> bool {
    let Some(path) = op["path"].as_str().map(str::to_string) else {
        return false;
    };
    let toks: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if op["op"] != "add" || toks.len() <= 3 {
        return false;
    }
    let (last, parent) = toks.split_last().unwrap_or((&"", &[]));
    let mut wrapped = serde_json::Map::new();
    wrapped.insert(
        last.replace("~1", "/").replace("~0", "~"),
        op["value"].take(),
    );
    op["path"] = json!(format!("/{}", parent.join("/")));
    op["value"] = Value::Object(wrapped);
    true
}

/// `rw add <id> <component JSON | @file.json> [--dry-run]`.
pub fn add(opts: &Opts, id: &str, component: &str, dry_run: bool) -> CmdResult {
    let text = match component.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).map_err(|e| {
            let mut x = usage(format!("{path}: {e}"));
            x.code = rw_api::ApiErrorCode::Io;
            x
        })?,
        None => component.to_string(),
    };
    let comp: Value = serde_json::from_str(&text).map_err(|e| {
        let mut x = usage(format!("the component is not JSON: {e}"));
        x.hint = Some(
            r#"e.g. rw add tube2 '{"type":"body_tube","attach":{"to":"body.aft"},"length":"100 mm","od":"25 mm","thickness":"1 mm"}'"#
                .into(),
        );
        x
    })?;
    mutation(
        opts,
        opts.call(
            "component_add",
            json!({"id": id, "component": comp, "dry_run": dry_run}),
            None,
        )?,
    )
}

/// What `rw rm <target>` removes.
#[derive(Debug, PartialEq)]
enum RmTarget {
    /// A component id (`fins`, or the path `c.fins`).
    Component(String),
    /// A field, as a JSON pointer (`sims.flight.launch_into_wind`).
    Field(String),
}

fn rm_target(target: &str) -> RmTarget {
    if !target.contains('.') && !target.starts_with('/') {
        return RmTarget::Component(target.to_string());
    }
    let p = pointer(target);
    match p.trim_start_matches('/').split('/').collect::<Vec<_>>()[..] {
        ["c", id] => RmTarget::Component(id.to_string()),
        _ => RmTarget::Field(p),
    }
}

/// `rw rm <id | path> [--recursive] [--dry-run]`: a component, or (a dotted
/// path or JSON pointer) one field.
pub fn rm(opts: &Opts, id: &str, recursive: bool, dry_run: bool) -> CmdResult {
    let id = match rm_target(id) {
        RmTarget::Component(c) => c,
        RmTarget::Field(path) => {
            return mutation(
                opts,
                opts.call(
                    "model_patch",
                    json!({"ops": [{"op": "remove", "path": path}], "dry_run": dry_run}),
                    None,
                )?,
            );
        }
    };
    let id = id.as_str();
    mutation(
        opts,
        opts.call(
            "component_remove",
            json!({"id": id, "recursive": recursive, "dry_run": dry_run}),
            None,
        )?,
    )
}

/// `rw mv <id> <to.anchor> [--at <anchor>] [--offset <len>] [--dry-run]`.
pub fn mv(
    opts: &Opts,
    id: &str,
    to: &str,
    at: Option<String>,
    offset: Option<String>,
    dry_run: bool,
) -> CmdResult {
    let mut attach = json!({"to": to});
    if let Some(a) = at {
        attach["at"] = json!(a);
    }
    if let Some(o) = offset {
        attach["offset"] = value(&o);
    }
    mutation(
        opts,
        opts.call(
            "component_move",
            json!({"id": id, "attach": attach, "dry_run": dry_run}),
            None,
        )?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_values() {
        assert_eq!(pointer("c.fins.span"), "/c/fins/span");
        assert_eq!(pointer("/params/x/value"), "/params/x/value");
        assert_eq!(value("30 mm"), json!("30 mm"));
        assert_eq!(value("3"), json!(3));
        assert_eq!(value("true"), json!(true));
    }

    #[test]
    fn rm_takes_a_component_or_a_field() {
        assert_eq!(rm_target("fins"), RmTarget::Component("fins".into()));
        assert_eq!(rm_target("c.fins"), RmTarget::Component("fins".into()));
        assert_eq!(rm_target("/c/fins"), RmTarget::Component("fins".into()));
        assert_eq!(
            rm_target("sims.flight.launch_into_wind"),
            RmTarget::Field("/sims/flight/launch_into_wind".into())
        );
        assert_eq!(
            rm_target("c.fins.cant"),
            RmTarget::Field("/c/fins/cant".into())
        );
    }

    #[test]
    fn a_missing_table_is_set_one_level_up() {
        let msg = "op 1 at `/configs/a/deploy/chute/event`: not_found: `/configs/a/deploy` does not exist";
        assert_eq!(missing_parent(msg), Some(1));
        assert_eq!(missing_parent("op 0 at `/c/x`: schema_error: bad"), None);
        let mut op =
            json!({"op": "add", "path": "/configs/a/deploy/chute/event", "value": "apogee"});
        assert!(nest(&mut op));
        assert_eq!(
            op,
            json!({"op": "add", "path": "/configs/a/deploy/chute", "value": {"event": "apogee"}})
        );
        assert!(nest(&mut op));
        assert_eq!(
            op,
            json!({"op": "add", "path": "/configs/a/deploy", "value": {"chute": {"event": "apogee"}}})
        );
        // Never creates a component, configuration, or sim.
        assert!(!nest(&mut op));
        let mut typo = json!({"op": "add", "path": "/c/fnis/span", "value": "30 mm"});
        assert!(!nest(&mut typo));
    }
}
