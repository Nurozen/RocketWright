//! IF8 `Command`: the single dispatch type (invariant I2). Every front end
//! builds one and calls `Session::execute(cmd, &CallCtx) -> Result<Response, ApiError>`.
//! [`COMMANDS`] is the catalogue: MCP name, annotations, approval policy, and
//! schema functions for each command's input and output.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};

use rw_check::CheckReport;

use crate::history::Revision;
use crate::render::RenderResult;
use crate::run::JobInfo;
use crate::tools::*;

/// Where a command came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Cli,
    Mcp,
    Socket,
    Watcher,
    Ui,
}

/// Call context; the app sets it from MCP `_meta`
/// (`rw/thread`, `rw/tool_call`, `rw/label`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CallCtx {
    pub origin: Origin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// MCP tool annotations plus the mutation flag (R7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ToolHints {
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
    pub open_world: bool,
    /// Returns a `CheckDelta` (I6) and honours `dry_run`.
    pub mutating: bool,
}

impl ToolHints {
    pub const READ: Self = Self {
        read_only: true,
        destructive: false,
        idempotent: true,
        open_world: false,
        mutating: false,
    };
    pub const MUTATE: Self = Self {
        read_only: false,
        destructive: false,
        idempotent: false,
        open_world: false,
        mutating: true,
    };
    pub const DESTROY: Self = Self {
        read_only: false,
        destructive: true,
        idempotent: false,
        open_world: false,
        mutating: true,
    };
    /// Rewrites files without changing the evaluated model (`rw fmt`).
    pub const FORMAT: Self = Self {
        read_only: false,
        destructive: false,
        idempotent: true,
        open_world: false,
        mutating: false,
    };
    /// Starts work or writes outside the model (jobs, renders, exports).
    pub const ACT: Self = Self {
        read_only: false,
        destructive: false,
        idempotent: false,
        open_world: false,
        mutating: false,
    };
}

/// Human-approval policy (I16). `Always` tools carry
/// `permission_policy: "always_ask"` and are never in `allowedTools`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Never,
    Always,
    /// Depends on arguments (e.g. `simulate` with a large `mc`, exports outside the project).
    Conditional,
}

type SchemaFn = fn() -> Schema;
type CheckFn = fn(&serde_json::Value) -> Result<(), String>;

/// One catalogue entry.
#[derive(Clone, Copy)]
pub struct CommandDef {
    /// MCP tool / command name (`model_patch`).
    pub name: &'static str,
    /// Exposed as an MCP tool (false: CLI-only).
    pub mcp: bool,
    pub hints: ToolHints,
    pub approval: Approval,
    /// One-line summary (full when-to-use descriptions land in M1.31).
    pub summary: &'static str,
    pub input_schema: SchemaFn,
    pub output_schema: SchemaFn,
    pub input_type: &'static str,
    pub output_type: &'static str,
    /// Deserializes a JSON value as the input type.
    pub check_input: CheckFn,
    pub check_output: CheckFn,
}

impl std::fmt::Debug for CommandDef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandDef")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

/// Deserializes `v` as `T`.
pub fn check_as<T: serde::de::DeserializeOwned>(v: &serde_json::Value) -> Result<(), String> {
    T::deserialize(v).map(|_| ()).map_err(|e| e.to_string())
}

macro_rules! commands {
    ($( $variant:ident = $name:literal ($input:ty) -> $output:ty, mcp: $mcp:expr, $hints:expr, $approval:expr, $summary:literal; )*) => {
        /// One operation on a project.
        #[allow(clippy::large_enum_variant)] // wire DTO, built once per call
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "command", content = "input")]
        pub enum Command {
            $( #[doc = $summary] #[serde(rename = $name)] $variant($input), )*
        }

        /// The result of a [`Command`], same variant.
        #[allow(clippy::large_enum_variant)] // wire DTO, built once per call
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "command", content = "output")]
        pub enum Response {
            $( #[serde(rename = $name)] $variant($output), )*
        }

        /// The catalogue, in a fixed order.
        pub const COMMANDS: &[CommandDef] = &[
            $( CommandDef {
                name: $name,
                mcp: $mcp,
                hints: $hints,
                approval: $approval,
                summary: $summary,
                input_schema: crate::registry::root_schema::<$input> as SchemaFn,
                output_schema: crate::registry::root_schema::<$output> as SchemaFn,
                input_type: stringify!($input),
                output_type: stringify!($output),
                check_input: check_as::<$input> as CheckFn,
                check_output: check_as::<$output> as CheckFn,
            }, )*
        ];

        impl Command {
            pub fn name(&self) -> &'static str {
                match self { $( Command::$variant(_) => $name, )* }
            }
        }

        impl Response {
            pub fn name(&self) -> &'static str {
                match self { $( Response::$variant(_) => $name, )* }
            }
        }
    };
}

commands! {
    ProjectCreate = "project_create" (ProjectCreateIn) -> MutationOut, mcp: true, ToolHints::MUTATE, Approval::Never,
        "Create a project from a template (rw init).";
    ProjectValidate = "project_validate" (ProjectValidateIn) -> ValidateOut, mcp: true, ToolHints::READ, Approval::Never,
        "Schema-only validation of project files (rw validate).";
    Fmt = "fmt" (FmtIn) -> FmtOut, mcp: false, ToolHints::FORMAT, Approval::Never,
        "Canonical formatting (rw fmt); CLI only, writes are automatic over MCP.";
    ModelGet = "model_get" (ModelGetIn) -> ModelGetOut, mcp: true, ToolHints::READ, Approval::Never,
        "The evaluated SI model or a subtree (rw eval).";
    ModelPatch = "model_patch" (ModelPatchIn) -> MutationOut, mcp: true, ToolHints::MUTATE, Approval::Never,
        "RFC 6902 ops on id paths (rw set); returns the check delta.";
    ComponentAdd = "component_add" (ComponentAddIn) -> MutationOut, mcp: true, ToolHints::MUTATE, Approval::Never,
        "Add a component attached to a named anchor (rw add).";
    ComponentRemove = "component_remove" (ComponentRemoveIn) -> MutationOut, mcp: true, ToolHints::DESTROY, Approval::Never,
        "Remove a component (rw rm).";
    ComponentMove = "component_move" (ComponentMoveIn) -> MutationOut, mcp: false, ToolHints::MUTATE, Approval::Never,
        "Re-attach a component (rw mv); MCP agents use model_patch.";
    DesignCheck = "design_check" (DesignCheckIn) -> CheckReport, mcp: true, ToolHints::READ, Approval::Never,
        "Full check report (rw check); run after every edit.";
    Render = "render" (RenderIn) -> RenderResult, mcp: true, ToolHints::ACT, Approval::Never,
        "Render a fixed view to renders/ (rw render).";
    LibrarySearch = "library_search" (LibrarySearchIn) -> LibrarySearchOut, mcp: true, ToolHints::READ, Approval::Never,
        "Search components, materials, and presets (rw lib search).";
    LibraryShow = "library_show" (LibraryShowIn) -> LibItem, mcp: false, ToolHints::READ, Approval::Never,
        "Show one library item (rw lib show).";
    MotorSearch = "motor_search" (MotorSearchIn) -> MotorSearchOut, mcp: true, ToolHints::READ, Approval::Never,
        "Search motors by class, diameter, impulse (rw motor search).";
    MotorShow = "motor_show" (MotorShowIn) -> MotorShowOut, mcp: false, ToolHints::READ, Approval::Never,
        "Show one motor and its curve (rw motor show).";
    Simulate = "simulate" (SimulateIn) -> SimulateOut, mcp: true, ToolHints::ACT, Approval::Conditional,
        "Run a sim; returns a cache hit or a job id (rw sim).";
    JobStatus = "job_status" (JobRef) -> JobInfo, mcp: true, ToolHints::READ, Approval::Never,
        "Poll a job.";
    JobCancel = "job_cancel" (JobRef) -> JobInfo, mcp: true, ToolHints::ACT, Approval::Never,
        "Cancel a job.";
    RunList = "run_list" (RunListIn) -> RunListOut, mcp: true, ToolHints::READ, Approval::Never,
        "Runs per sim with computed status (Complete/Outdated/...).";
    RunDiff = "run_diff" (RunDiffIn) -> RunDiffOut, mcp: true, ToolHints::READ, Approval::Never,
        "Compare two runs or a run and an oracle golden (rw diff run).";
    ModelDiff = "model_diff" (ModelDiffIn) -> ModelDiff, mcp: true, ToolHints::READ, Approval::Never,
        "Semantic model diff keyed by component id (rw diff model).";
    HistoryList = "history_list" (HistoryListIn) -> HistoryListOut, mcp: true, ToolHints::READ, Approval::Never,
        "Steps and revisions (rw history log).";
    HistoryShow = "history_show" (HistoryShowIn) -> HistoryShowOut, mcp: true, ToolHints::READ, Approval::Never,
        "One step and its diff (rw history show).";
    HistoryCompare = "history_compare" (HistoryCompareIn) -> CompareOut, mcp: true, ToolHints::READ, Approval::Never,
        "Compare two versions: model, metrics, visual (rw history compare).";
    HistoryTag = "history_tag" (HistoryTagIn) -> Revision, mcp: true, ToolHints::ACT, Approval::Never,
        "Name a revision Rev NN (rw history tag).";
    HistoryRestore = "history_restore" (HistoryRestoreIn) -> MutationOut, mcp: true, ToolHints::MUTATE, Approval::Never,
        "Restore a version as a new step (Revert).";
    ImportFile = "import_file" (ImportFileIn) -> ImportOut, mcp: true, ToolHints::MUTATE, Approval::Always,
        "Import an .ork or a motor file (rw import ork, rw motor import).";
    ExportFile = "export_file" (ExportFileIn) -> ExportOut, mcp: true, ToolHints::ACT, Approval::Always,
        "Export ork/rasp/glb/stl/csv (rw export).";
    SchemaGet = "schema_get" (SchemaGetIn) -> SchemaGetOut, mcp: true, ToolHints::READ, Approval::Never,
        "A published JSON Schema by name (rw schema).";
    EngineDesign = "engine_design" (EngineDesignIn) -> EngineDesignOut, mcp: true, ToolHints::READ, Approval::Never,
        "Liquid engine sizing and performance (rw engine design).";
    EngineSimulate = "engine_simulate" (EngineSimulateIn) -> SimulateOut, mcp: true, ToolHints::ACT, Approval::Conditional,
        "Tank and feed simulation; returns a job (rw engine sim).";
    CfdImport = "cfd_import" (CfdImportIn) -> CfdImportOut, mcp: true, ToolHints::MUTATE, Approval::Always,
        "Import a CFD point dataset (R6.15).";
}

/// Looks up a catalogue entry by name.
pub fn command_def(name: &str) -> Option<&'static CommandDef> {
    COMMANDS.iter().find(|d| d.name == name)
}

/// A read-only MCP resource and the registry type it serves.
#[derive(Debug, Clone, Copy)]
pub struct ResourceDef {
    /// URI or URI template (`{id}`).
    pub uri: &'static str,
    /// Registry name of the content type.
    pub type_name: &'static str,
    /// Supports `resources/subscribe` (`notifications/resources/updated`).
    pub subscribable: bool,
}

/// MCP resources (S:85 + D6).
pub const RESOURCES: &[ResourceDef] = &[
    ResourceDef {
        uri: "rw://project/model",
        type_name: "evaluated-model",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://project/check",
        type_name: "check-report",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://project/files",
        type_name: "project-files",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://project/history",
        type_name: "tools/history_list.output",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://runs/index",
        type_name: "tools/run_list.output",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://runs/{id}/summary",
        type_name: "run-summary",
        subscribable: false,
    },
    ResourceDef {
        uri: "rw://jobs/{id}",
        type_name: "job-info",
        subscribable: true,
    },
    ResourceDef {
        uri: "rw://schema/{type}",
        type_name: "json-schema",
        subscribable: false,
    },
];
