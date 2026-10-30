//! The single dispatch point (invariant I2): a tool call becomes an
//! `rw_api::Command`, validated against its published input schema, then
//! executed by the project's `rw_project::Session` (M1.26a), with the
//! rw-cli bodies (`render`) in [`execute_session`] (M1.31).
//!
//! With a session every tool body is real (`import_file` covers `.ork`,
//! M2.5, and motor files, M2.14; `engine_design` and `engine_simulate`,
//! M4.6; `cfd_import`, M5.4). A sidecar started on a directory without `rocketwright.toml`
//! has no session: `project_create` creates the project there (without the
//! `doubles` feature), and the rest answer from the contract-fixture doubles
//! (`doubles` feature, the app's offline tests) or "no project here" with a
//! hint to call `project_create`.

use rw_api::{ApiError, ApiErrorCode, CallCtx, Command, schema_entry};
use rw_project::SharedSession;
use serde_json::{Value, json};

use super::catalog;

/// Tools whose bodies stay `NotImplemented` even with doubles (none since
/// `import_file`/`export_file` landed in M2.5/M2.6).
pub const ALWAYS_NOT_IMPLEMENTED: &[&str] = &[];

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::InvalidInput,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

fn not_found(message: impl Into<String>) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::NotFound,
        message: message.into(),
        hint: None,
        diagnostics: Vec::new(),
    }
}

/// Validates `args` against `tools/<name>.input` and builds the [`Command`].
/// CLI-only commands (`component_move`, `fmt`, ...) publish no tool schema;
/// their input is checked by deserialization alone.
pub fn command(name: &str, args: Value) -> Result<Command, ApiError> {
    let Some(entry) = schema_entry(&format!("tools/{name}.input")) else {
        if rw_api::command_def(name).is_none() {
            return Err(not_found(format!("unknown tool `{name}`")));
        }
        if !args.is_object() {
            return Err(invalid(format!("`{name}` input must be an object")));
        }
        return serde_json::from_value(json!({"command": name, "input": args}))
            .map_err(|e| invalid(format!("`{name}` input: {e}")));
    };
    let schema = entry.schema();
    let validator = jsonschema::validator_for(schema.as_value())
        .map_err(|e| invalid(format!("tools/{name}.input does not compile: {e}")))?;
    let errors: Vec<String> = validator
        .iter_errors(&args)
        .map(|e| format!("{} at `{}`", e, e.instance_path()))
        .collect();
    if !errors.is_empty() {
        let mut err = invalid(format!("`{name}` input: {}", errors.join("; ")));
        err.hint = Some(format!("see rw://schema/tools/{name}.input"));
        return Err(err);
    }
    serde_json::from_value(json!({"command": name, "input": args}))
        .map_err(|e| invalid(format!("`{name}` input: {e}")))
}

fn lock(session: &SharedSession) -> std::sync::MutexGuard<'_, rw_project::Session> {
    session.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs one command on a session: the rw-cli bodies (`render`, which
/// rasterizes through resvg) first, then `Session::execute`.
pub fn execute_session(
    s: &mut rw_project::Session,
    cmd: &Command,
    ctx: &CallCtx,
) -> Result<Value, ApiError> {
    let name = cmd.name();
    if ALWAYS_NOT_IMPLEMENTED.contains(&name) {
        return Err(ApiError::not_implemented(name));
    }
    match cmd {
        Command::Render(i) => {
            let out = crate::render::render(s, i)?;
            serde_json::to_value(out).map_err(|e| ApiError {
                outcome: None,
                code: ApiErrorCode::Internal,
                message: e.to_string(),
                hint: None,
                diagnostics: Vec::new(),
            })
        }
        // `visual`: the compare profile of `b` against `a` (rw-draw lives here).
        Command::HistoryCompare(i) if i.visual => {
            let mut out = match s.execute(cmd, ctx)? {
                rw_api::Response::HistoryCompare(o) => o,
                _ => unreachable!("history_compare answers HistoryCompare"),
            };
            let r = rw_api::RenderIn {
                view: rw_api::View::Profile,
                config: None,
                explode: None,
                compare: Some(i.a.clone()),
                width: None,
                height: None,
                scheme: None,
            };
            out.visual = Some(crate::render::render_2d_at(s, &r, &i.b)?);
            serde_json::to_value(out).map_err(|e| ApiError {
                outcome: None,
                code: ApiErrorCode::Internal,
                message: e.to_string(),
                hint: None,
                diagnostics: Vec::new(),
            })
        }
        _ => s.execute_json(cmd, ctx),
    }
}

/// The answer of a tool that needs a project on a sidecar without one.
pub fn no_project(name: &str) -> ApiError {
    ApiError {
        outcome: None,
        code: ApiErrorCode::NotFound,
        message: format!(
            "no project here: `{name}` needs a rocketwright.toml in the project directory"
        ),
        hint: Some(
            "create one with project_create (rw init), or open a directory that holds a project"
                .into(),
        ),
        diagnostics: Vec::new(),
    }
}

/// Runs one command. Returns the output JSON (`tools/<name>.output`).
/// With a session, every body is real (`NotImplemented` only for rows that
/// have not landed). Without one, the contract-fixture doubles answer
/// (`doubles` feature); otherwise `schema_get` is real and the rest answer
/// [`no_project`]
/// (`project_create` without a session is handled by the server, which
/// knows the directory).
pub fn execute(
    session: Option<&SharedSession>,
    cmd: &Command,
    ctx: &CallCtx,
) -> Result<Value, ApiError> {
    let name = cmd.name();
    if ALWAYS_NOT_IMPLEMENTED.contains(&name) {
        return Err(ApiError::not_implemented(name));
    }
    if let Some(s) = session {
        return execute_session(&mut lock(s), cmd, ctx);
    }
    #[cfg(feature = "doubles")]
    if let Some(v) = super::doubles::payload(&format!("tools/{name}.output")) {
        return Ok(v);
    }
    if let Command::SchemaGet(i) = cmd {
        return serde_json::to_value(rw_project::session::schema_get(i.name.as_deref())?)
            .map_err(|e| invalid(e.to_string()));
    }
    Err(no_project(name))
}

/// Validates, builds, and runs a tool call.
pub fn call(
    session: Option<&SharedSession>,
    name: &str,
    args: Value,
    ctx: &CallCtx,
) -> Result<Value, ApiError> {
    execute(session, &command(name, args)?, ctx)
}

/// True when the call wrote nothing (`dry_run: true`).
pub fn is_dry_run(args: &Value) -> bool {
    args.get("dry_run")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Reads a resource. `rw://schema/<name>` is always real (the registry);
/// with a session every other resource is real; without one, doubles.
pub fn read_resource(session: Option<&SharedSession>, uri: &str) -> Result<Value, ApiError> {
    let (def, var) =
        catalog::resource_for(uri).ok_or_else(|| not_found(format!("unknown resource `{uri}`")))?;
    if def.type_name == "json-schema" {
        let e = schema_entry(&var).ok_or_else(|| not_found(format!("no schema named `{var}`")))?;
        return Ok(e.schema().as_value().clone());
    }
    if let Some(s) = session {
        return lock(s).read_resource(uri);
    }
    #[cfg(feature = "doubles")]
    if let Some(v) = super::doubles::payload(def.type_name) {
        return Ok(v);
    }
    Err(no_project(uri))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rw_api::Origin;

    fn ctx() -> CallCtx {
        CallCtx {
            origin: Origin::Mcp,
            thread: None,
            tool_call: None,
            label: None,
        }
    }

    #[test]
    fn rejects_schema_invalid_input() {
        let e = call(None, "job_status", json!({}), &ctx()).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::InvalidInput);
        assert!(e.message.contains("job_id"), "{}", e.message);
        let e = call(None, "no_such_tool", json!({}), &ctx()).unwrap_err();
        assert_eq!(e.code, ApiErrorCode::NotFound);
    }

    #[test]
    fn builds_a_command() {
        let c = command("job_status", json!({"job_id": "j1"})).unwrap();
        assert_eq!(c.name(), "job_status");
    }

    #[test]
    fn export_without_a_session_is_a_double_or_not_implemented() {
        let r = execute(
            None,
            &command(
                "export_file",
                serde_json::from_str(
                    &std::fs::read_to_string(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../../fixtures/contracts/tools/export_file.input.json"
                    ))
                    .unwrap(),
                )
                .map(|v: Value| v["payload"].clone())
                .unwrap(),
            )
            .unwrap(),
            &ctx(),
        );
        if cfg!(feature = "doubles") {
            assert!(r.is_ok(), "{r:?}");
        } else {
            assert_eq!(r.unwrap_err().code, ApiErrorCode::NotFound);
        }
    }

    /// REV-core item 6: a sessionless sidecar says there is no project and
    /// points at project_create, not "not implemented".
    #[test]
    fn no_project_points_at_project_create() {
        let e = no_project("model_get");
        assert_eq!(e.code, ApiErrorCode::NotFound);
        assert!(e.message.contains("no project here"), "{}", e.message);
        assert!(e.hint.unwrap().contains("project_create"));
    }

    #[test]
    fn schema_resources_are_real() {
        let v = read_resource(None, "rw://schema/check-delta").unwrap();
        assert_eq!(
            v["$id"],
            "https://rocketwright.dev/schema/1/check-delta.json"
        );
        let v = read_resource(None, "rw://schema/tools/model_patch.input").unwrap();
        assert_eq!(v["type"], "object");
        assert_eq!(
            read_resource(None, "rw://schema/nope").unwrap_err().code,
            ApiErrorCode::NotFound
        );
        assert_eq!(
            read_resource(None, "rw://nope").unwrap_err().code,
            ApiErrorCode::NotFound
        );
    }
}
