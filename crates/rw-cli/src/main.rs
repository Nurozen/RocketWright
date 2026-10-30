//! `rocketwright` binary entry point (also installed as `rw`). R3.1, M1.30.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use rw_cli::cmd::{self, Opts};

/// Build provenance in the file bytes (`rw_cli::BUILD_PROVENANCE`), read by
/// `cargo xtask audit`; `#[used]` keeps the linker from stripping it.
#[used]
static BUILD_PROVENANCE: [u8; rw_cli::BUILD_PROVENANCE.len()] = rw_cli::provenance_bytes();

#[derive(Parser)]
#[command(
    name = "rocketwright",
    version = rw_cli::VERSION,
    about = "Agent-driven model rocketry CAD and simulation",
    after_help = "Exit codes: 0 clean, 1 failure (check errors, failed diff or sim), 2 usage or I/O."
)]
struct Cli {
    /// Print the tool output as JSON.
    #[arg(long, global = true)]
    json: bool,
    /// Project directory (default: the nearest ancestor with rocketwright.toml).
    #[arg(long, short = 'C', global = true)]
    project: Option<PathBuf>,
    /// Title of the snapshot step this command records when it opens a
    /// project with unrecorded changes (default: `Initial snapshot` for a
    /// project without history, else `External edit`).
    #[arg(long, global = true, value_name = "TITLE")]
    snapshot_label: Option<String>,
    /// Units of the text output: `display` (the project's
    /// `[display_units]`; default mm, g, m/s, m for flight distances, s, deg)
    /// or `si`. `--json` output is always SI and carries a `units` map.
    #[arg(long, global = true, value_name = "si|display", value_parser = ["si", "display"])]
    units: Option<String>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a project from a template (minimum, simple-rocket).
    Init {
        /// Directory (default: --project or the working directory).
        dir: Option<PathBuf>,
        #[arg(long)]
        template: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// Canonical formatting of the project files.
    Fmt {
        /// Report only; exit 1 when a file would change.
        #[arg(long)]
        check: bool,
        files: Vec<String>,
    },
    /// Schema-only validation of the project files.
    Validate { files: Vec<String> },
    /// The evaluated model, or one value (`c.fins.span`, `/components/0`).
    Eval {
        path: Option<String>,
        #[arg(long)]
        config: Option<String>,
        #[arg(long)]
        variant: Option<String>,
        /// live, step:<n>, rev:<NN>, commit:<sha>.
        #[arg(long)]
        version: Option<String>,
    },
    /// Set fields: `rw set c.fins.span="30 mm" params.d.value="25 mm"`;
    /// remove them (back to the default): `rw set sims.s.launch_into_wind --unset`.
    Set {
        /// `path=value` (or, with --unset, `path`).
        #[arg(required = true)]
        assignments: Vec<String>,
        /// Remove each path instead of setting it.
        #[arg(long)]
        unset: bool,
        #[arg(long)]
        dry_run: bool,
        /// Step title.
        #[arg(long)]
        label: Option<String>,
    },
    /// Add a component: `rw add <id> '<component JSON>'` (or `@file.json`).
    Add {
        id: String,
        component: String,
        #[arg(long)]
        dry_run: bool,
    },
    /// Remove a component (`rw rm fins`) or a field (`rw rm sims.s.launch_into_wind`).
    Rm {
        /// Component id, or a dotted path / JSON pointer to one field.
        id: String,
        /// Also remove components attached to it.
        #[arg(long)]
        recursive: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// Re-attach a component: `rw mv <id> <parent>.<anchor> [--at a] [--offset "5 mm"]`.
    Mv {
        id: String,
        to: String,
        #[arg(long)]
        at: Option<String>,
        #[arg(long, allow_hyphen_values = true)]
        offset: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// The design check; exit 1 on errors (or warnings with --strict).
    Check {
        #[arg(long)]
        strict: bool,
        /// `quick`: also fly the configuration's sim.
        #[arg(long)]
        sim: Option<String>,
        #[arg(long)]
        config: Option<String>,
        #[arg(long)]
        variant: Option<String>,
        /// `path=value` overrides (not written).
        #[arg(long = "set")]
        set: Vec<String>,
    },
    /// Render a view to renders/<config>.<view>.png.
    Render {
        /// profile, fin, stations, anchors (3D: iso, top, side, front, rear, exploded, section).
        #[arg(long)]
        view: String,
        #[arg(long)]
        config: Option<String>,
        /// Exact PNG size, `WxH`.
        #[arg(long)]
        imgsize: Option<String>,
        /// 3D: explode factor 0..1.
        #[arg(long)]
        explode: Option<f64>,
        /// 3D: `check` (flat check materials, default) or `pbr`.
        #[arg(long)]
        scheme: Option<String>,
        /// Visual diff against a version (`step:3`, `rev:7`, `run:<id>`):
        /// removed red, changed amber, added green (profile and 3D views).
        #[arg(long)]
        compare: Option<String>,
    },
    /// Fly a simulation (or reuse its cached run) and print the summary.
    Sim {
        /// The sim's id (`simulation_5`) or display name (`"Simulation 5"`).
        sim: String,
        #[arg(long)]
        config: Option<String>,
        /// Re-run a cached run.
        #[arg(long)]
        force: bool,
    },
    /// Read finished runs: `rw run summary <run> [--fields apogee,max_velocity]`.
    Run {
        #[command(subcommand)]
        what: RunCmd,
    },
    /// Compare models or runs.
    Diff {
        #[command(subcommand)]
        what: DiffCmd,
    },
    /// Project history.
    History {
        #[command(subcommand)]
        what: HistoryCmd,
    },
    /// Motors (generic curves and lib/motors).
    Motor {
        #[command(subcommand)]
        what: MotorCmd,
    },
    /// Liquid engines (engines/<id>.rw.toml): design and blowdown.
    Engine {
        #[command(subcommand)]
        what: EngineCmd,
    },
    /// Imported CFD point datasets (CSV, spec R6.15).
    Cfd {
        #[command(subcommand)]
        what: CfdCmd,
    },
    /// The project library.
    Lib {
        #[command(subcommand)]
        what: LibCmd,
    },
    /// Import a file: `rw import ork <file.ork> [dir]` (replaces the model of
    /// the project, or creates a project in a directory that has none).
    Import {
        #[command(subcommand)]
        what: ImportCmd,
    },
    /// Export: `rw export ork|rasp|glb|stl|csv <path>` (STL in mm; csv needs --run).
    Export {
        format: String,
        path: String,
        #[arg(long)]
        config: Option<String>,
        /// Run ref for csv (`<run-id>`, `<sim>/<run-id>`, or a sim id: its latest run).
        #[arg(long)]
        run: Option<String>,
        /// Allow a path outside the project (default: it must stay inside).
        #[arg(long)]
        allow_outside: bool,
    },
    /// Published JSON Schemas: list names, or print one.
    Schema { name: Option<String> },
    /// Serve the project (--project <dir>) over MCP on stdio. The first
    /// instance owns the project and serves `.rw/sidecar.sock` (CLI
    /// forwarding); later instances relay their stdio to it (D4).
    Mcp {
        /// Started by the RocketWright app (the app owns the session; R6.1).
        #[arg(long)]
        app: bool,
        /// Do not serve `.rw/sidecar.sock` when owning the project. Later
        /// instances then cannot relay and refuse with RW-E007.
        #[arg(long)]
        no_socket: bool,
        /// Print the `tools/list` result as JSON and exit. Takes no lock and
        /// does not open the project.
        #[arg(long)]
        list_tools: bool,
    },
    /// Run one command by tool name with JSON arguments (forwarded to the
    /// live sidecar when one owns the project; D4). Prints the output JSON.
    Call {
        /// Step title.
        #[arg(long)]
        label: Option<String>,
        /// Command name, e.g. `model_patch`.
        tool: String,
        /// Arguments as a JSON object (default `{}`).
        args: Option<String>,
    },
}

#[derive(Subcommand)]
enum RunCmd {
    /// A run's summary (apogee, max velocity, time to apogee, ...) and its
    /// flight events, in display units. `--fields` with no list prints every
    /// field with its meaning.
    Summary {
        /// Run ref: `<sim>/<run-id>`, `<run-id>`, rw:run/<id>, or a sim id
        /// (its latest run).
        run: Option<String>,
        /// Comma-separated fields to print (`apogee,max_velocity,events`).
        #[arg(long, num_args = 0..=1, value_name = "LIST", long_help = cmd::sim::fields_help())]
        fields: Option<Option<String>>,
    },
}

#[derive(Subcommand)]
enum DiffCmd {
    /// Semantic model diff of two versions (live, step:<n>, rev:<NN>).
    Model { a: String, b: String },
    /// Compare a run with another run or an oracle golden.
    Run {
        a: String,
        b: Option<String>,
        /// Oracle golden JSON (tests/oracle/case1-generic.json).
        #[arg(long)]
        golden: Option<String>,
        /// `key=tol` (`apogee_m=3%`, `time_to_apogee_s=0.3 s`); repeatable.
        #[arg(long)]
        tol: Vec<String>,
    },
}

#[derive(Subcommand)]
enum HistoryCmd {
    Log {
        #[arg(long)]
        thread: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    Show {
        version: String,
    },
    Tag {
        name: String,
        version: Option<String>,
        /// Revision number (default: one above the highest).
        #[arg(long)]
        number: Option<u32>,
    },
    Compare {
        a: String,
        b: String,
        /// Also draw the compare profile (renders/<config>.profile.compare.png).
        #[arg(long)]
        visual: bool,
        /// Also print each component's mass and CG change and each aero
        /// term's CNa and CP change (which component a change came from).
        #[arg(long)]
        breakdown: bool,
    },
}

#[derive(Subcommand)]
enum ImportCmd {
    /// An OpenRocket .ork (zip, gzip, or XML).
    Ork {
        file: String,
        /// Target directory (default: --project, else the working directory).
        dir: Option<PathBuf>,
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum MotorCmd {
    Search {
        query: Option<String>,
        #[arg(long)]
        class: Option<String>,
        /// e.g. "18 mm".
        #[arg(long)]
        diameter: Option<String>,
        #[arg(long)]
        min_impulse: Option<String>,
        #[arg(long)]
        max_impulse: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    Show {
        id: String,
    },
    /// Copy a motor file (.eng, .rse) into lib/motors/ and record its sha256.
    Import {
        file: String,
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum EngineCmd {
    /// Size the chamber, nozzle, injector, feed, and tanks (engine_design).
    Design { id: String },
    /// Run the tank blowdown and write runs/engine.<id>/<run>/ (engine_simulate).
    Sim {
        id: String,
        /// Time limit, e.g. "10 s".
        #[arg(long)]
        duration: Option<String>,
    },
}

#[derive(Subcommand)]
enum CfdCmd {
    /// Import a CSV point dataset (one file, or a directory of
    /// <prefix>_t<seconds>.csv steps) into runs/cfd.<id>/<run>/ (cfd_import).
    Import {
        path: String,
        /// Dataset id (default: the file prefix before _t<s>).
        #[arg(long)]
        study: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum LibCmd {
    Search {
        query: Option<String>,
        /// component, material, preset, motor.
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    Show {
        id: String,
    },
}

fn call(opts: &Opts, label: Option<String>, tool: &str, args: Option<&str>) -> ExitCode {
    let args: serde_json::Value = match serde_json::from_str(args.unwrap_or("{}")) {
        Ok(v) => v,
        Err(e) => return cmd::fail(opts, &cmd::usage(format!("arguments are not JSON: {e}"))),
    };
    let root = match opts.root() {
        Ok(r) => r,
        Err(e) => return cmd::fail(opts, &e),
    };
    match rw_cli::forward::run_with(&root, tool, args, label, opts.snapshot_label.as_deref()) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => {
            // `call` always reports errors as JSON (scripts and tests read it).
            let json = Opts {
                json: true,
                ..opts.clone()
            };
            cmd::fail(&json, &e)
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let opts = Opts {
        json: cli.json,
        project: cli.project.clone(),
        snapshot_label: cli.snapshot_label.clone(),
        units: cli
            .units
            .as_deref()
            .and_then(rw_cli::display::UnitsMode::parse)
            .unwrap_or_default(),
    };
    let Some(c) = cli.cmd else {
        println!("{}", rw_cli::version_line());
        return ExitCode::SUCCESS;
    };
    let r = match c {
        Cmd::Mcp {
            app,
            no_socket,
            list_tools,
        } => {
            let Some(project) = opts.project.clone() else {
                return cmd::fail(&opts, &cmd::usage("rocketwright mcp needs --project <dir>"));
            };
            return rw_cli::mcp::main(rw_cli::mcp::McpOptions {
                project,
                app,
                socket: !no_socket,
                list_tools,
            });
        }
        Cmd::Call { label, tool, args } => return call(&opts, label, &tool, args.as_deref()),
        Cmd::Init {
            dir,
            template,
            name,
            dry_run,
        } => cmd::project::init(&opts, dir, template, name, dry_run),
        Cmd::Fmt { check, files } => cmd::project::fmt(&opts, check, files),
        Cmd::Validate { files } => cmd::project::validate(&opts, files),
        Cmd::Eval {
            path,
            config,
            variant,
            version,
        } => cmd::project::eval(&opts, path, config, variant, version),
        Cmd::Set {
            assignments,
            unset: true,
            dry_run,
            label,
        } => cmd::edit::unset(&opts, &assignments, dry_run, label),
        Cmd::Set {
            assignments,
            unset: false,
            dry_run,
            label,
        } => cmd::edit::set(&opts, &assignments, dry_run, label),
        Cmd::Add {
            id,
            component,
            dry_run,
        } => cmd::edit::add(&opts, &id, &component, dry_run),
        Cmd::Rm {
            id,
            recursive,
            dry_run,
        } => cmd::edit::rm(&opts, &id, recursive, dry_run),
        Cmd::Mv {
            id,
            to,
            at,
            offset,
            dry_run,
        } => cmd::edit::mv(&opts, &id, &to, at, offset, dry_run),
        Cmd::Check {
            strict,
            sim,
            config,
            variant,
            set,
        } => cmd::check::check(&opts, strict, sim, config, variant, &set),
        Cmd::Render {
            view,
            config,
            imgsize,
            explode,
            scheme,
            compare,
        } => cmd::check::render(
            &opts,
            &view,
            config,
            imgsize,
            cmd::check::Render3d {
                explode,
                scheme,
                compare,
            },
        ),
        Cmd::Sim { sim, config, force } => cmd::sim::sim(&opts, &sim, config, force),
        Cmd::Run { what } => match what {
            RunCmd::Summary { run, fields } => cmd::sim::run_summary(&opts, run, fields),
        },
        Cmd::Diff { what } => match what {
            DiffCmd::Model { a, b } => cmd::sim::diff_model(&opts, &a, &b),
            DiffCmd::Run { a, b, golden, tol } => cmd::sim::diff_run(&opts, &a, b, golden, &tol),
        },
        Cmd::History { what } => match what {
            HistoryCmd::Log { thread, limit } => cmd::history::log(&opts, thread, limit),
            HistoryCmd::Show { version } => cmd::history::show(&opts, &version),
            HistoryCmd::Tag {
                name,
                version,
                number,
            } => cmd::history::tag(&opts, &name, version, number),
            HistoryCmd::Compare {
                a,
                b,
                visual,
                breakdown,
            } => cmd::history::compare(&opts, &a, &b, visual, breakdown),
        },
        Cmd::Motor { what } => match what {
            MotorCmd::Search {
                query,
                class,
                diameter,
                min_impulse,
                max_impulse,
                limit,
            } => cmd::library::motor_search(
                &opts,
                query,
                class,
                diameter,
                min_impulse,
                max_impulse,
                limit,
            ),
            MotorCmd::Show { id } => cmd::library::motor_show(&opts, &id),
            MotorCmd::Import { file, dry_run } => cmd::motor::import(&opts, &file, dry_run),
        },
        Cmd::Engine { what } => match what {
            EngineCmd::Design { id } => cmd::engine::design(&opts, &id),
            EngineCmd::Sim { id, duration } => cmd::engine::sim(&opts, &id, duration),
        },
        Cmd::Cfd { what } => match what {
            CfdCmd::Import {
                path,
                study,
                dry_run,
            } => cmd::cfd::import(&opts, &path, study, dry_run),
        },
        Cmd::Lib { what } => match what {
            LibCmd::Search { query, kind, limit } => {
                cmd::library::lib_search(&opts, query, kind, limit)
            }
            LibCmd::Show { id } => cmd::library::lib_show(&opts, &id),
        },
        Cmd::Import { what } => match what {
            ImportCmd::Ork { file, dir, dry_run } => {
                cmd::interop::import_ork(&opts, &file, dir, dry_run)
            }
        },
        Cmd::Export {
            format,
            path,
            config,
            run,
            allow_outside,
        } => cmd::interop::export(&opts, &format, &path, config, run, allow_outside),
        Cmd::Schema { name } => cmd::project::schema(&opts, name),
    };
    cmd::finish(&opts, r)
}
