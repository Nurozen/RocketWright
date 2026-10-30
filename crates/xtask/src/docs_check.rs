//! `cargo xtask docs-check`: the agent briefing tells the truth (plan M1.56).
//!
//! For each of `docs/agents/rocketwright-model.md` and `docs/agents/SKILL.md`:
//!
//! 1. **Generated blocks are current**: `cargo xtask diag-docs --check`.
//! 2. **Every command and flag mentioned exists.** Each `rw ...` /
//!    `rocketwright ...` mention (inline code spans, and command lines in any
//!    fenced block) is walked against the real CLI tree, read from
//!    `rocketwright --help` and every subcommand's `--help`: each subcommand
//!    must exist and each `--flag` / `-f` must be an option of that command.
//! 3. **Every fenced `rw` block runs with its stated exit code.** Blocks whose
//!    info string starts with `rw` run in order, one fresh temp project
//!    directory per document, with `rw` and `rocketwright` on `PATH` and
//!    `RW_OFFLINE=1`. Each line is one shell command (a trailing `\` joins
//!    lines; `#` lines are comments). A trailing `# exit N` states the expected
//!    exit code (default 0). `cd DIR` changes the working directory for the
//!    following commands. A block tagged `rw norun` is checked (step 2) but not
//!    run; use it only for commands that need the app (3D renders).
//! 4. **Tool names exist.** Rows of the table after `<!-- docs-check: tools -->`
//!    name sidecar MCP tools (`rocketwright schema` lists `tools/<name>.input`);
//!    rows after `<!-- docs-check: app-tools -->` name app broker tools (the
//!    name appears quoted in `app/apps/server/src`). A leading `rw_` (the
//!    Lecturn tool prefix) is stripped before either lookup.
//!
//! 5. **Run-summary fields exist.** Each `rw run summary <run> --fields a,b`
//!    mention names only fields listed in `rocketwright run summary --help`
//!    (after `Fields: `).
//!
//! Options: `--bin <rocketwright>` (default `$RW_BIN`, else
//! `cargo build -p rw-cli` and `<target>/debug/rocketwright`), `--root <repo>`,
//! `--keep` (keep the temp projects and print their paths).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// The documents checked, relative to the repo root.
pub const DOCS: &[&str] = &[crate::diag_docs::MODEL_MD, "docs/agents/SKILL.md"];

pub fn main(args: &[String]) -> ExitCode {
    let mut root: Option<PathBuf> = None;
    let mut bin: Option<PathBuf> = std::env::var_os("RW_BIN").map(PathBuf::from);
    let mut keep = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" => root = it.next().map(PathBuf::from),
            "--bin" => bin = it.next().map(PathBuf::from),
            "--keep" => keep = true,
            other => {
                eprintln!("xtask docs-check: unknown argument `{other}`");
                eprintln!(
                    "usage: cargo xtask docs-check [--bin <rocketwright>] [--root <repo>] [--keep]"
                );
                return ExitCode::from(2);
            }
        }
    }
    let root = root.unwrap_or_else(crate::audit::repo_root);
    match run(&root, bin, keep) {
        Ok(errors) if errors.is_empty() => {
            println!("xtask docs-check: ok ({} documents)", DOCS.len());
            ExitCode::SUCCESS
        }
        Ok(errors) => {
            for e in &errors {
                eprintln!("docs-check: {e}");
            }
            eprintln!("xtask docs-check: {} problem(s)", errors.len());
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("xtask docs-check: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(root: &Path, bin: Option<PathBuf>, keep: bool) -> Result<Vec<String>, String> {
    let mut errors = Vec::new();

    let files = crate::diag_docs::expected(root)?;
    for s in crate::diag_docs::stale(root, &files) {
        errors.push(format!("{s} is stale: run `cargo xtask diag-docs`"));
    }

    let bin = match bin {
        Some(b) => b,
        None => build_bin(root)?,
    };
    let bin = bin
        .canonicalize()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    let cli = CliNode::load(&bin, &[])?;
    let tools = sidecar_tools(&bin)?;
    let fields = summary_fields(&bin)?;
    let app_src = root.join("app/apps/server/src");

    let base = std::env::temp_dir().join(format!("rw-docs-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let bindir = base.join("bin");
    std::fs::create_dir_all(&bindir).map_err(|e| format!("{}: {e}", bindir.display()))?;
    for name in ["rw", "rocketwright"] {
        symlink(&bin, &bindir.join(name))?;
    }

    for rel in DOCS {
        let path = root.join(rel);
        let md = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        for (line, cmd) in mentions(&md) {
            let words = shell_words(&cmd);
            if let Err(e) = cli.validate(&words) {
                errors.push(format!("{rel}:{line}: `{cmd}`: {e}"));
            }
            if let Err(e) = check_fields(&words, &fields) {
                errors.push(format!("{rel}:{line}: `{cmd}`: {e}"));
            }
        }
        for (line, name) in table_names(&md, "tools") {
            if !tools.contains(bare_tool_name(&name)) {
                errors.push(format!("{rel}:{line}: `{name}` is not a sidecar MCP tool"));
            }
        }
        for (line, name) in table_names(&md, "app-tools") {
            if !app_tool_exists(&app_src, bare_tool_name(&name)) {
                errors.push(format!("{rel}:{line}: `{name}` is not an app tool"));
            }
        }
        let stem = rel.rsplit('/').next().unwrap_or(rel).replace('.', "_");
        let dir = base.join(stem);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let blocks = blocks(&md);
        let ran = blocks.iter().filter(|b| b.run).count();
        errors.extend(
            run_blocks(&blocks, &dir, &bindir)
                .into_iter()
                .map(|e| format!("{rel}:{e}")),
        );
        println!(
            "docs-check: {rel}: ran {ran} rw blocks in {}",
            dir.display()
        );
    }
    if keep {
        println!("docs-check: kept {}", base.display());
    } else {
        let _ = std::fs::remove_dir_all(&base);
    }
    Ok(errors)
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(src, dst).map_err(|e| format!("{}: {e}", dst.display()))
}

#[cfg(not(unix))]
fn symlink(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::copy(src, dst)
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", dst.display()))
}

fn build_bin(root: &Path) -> Result<PathBuf, String> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let st = Command::new(cargo)
        .current_dir(root)
        .args(["build", "-q", "-p", "rw-cli", "--bin", "rocketwright"])
        .status()
        .map_err(|e| format!("cargo build: {e}"))?;
    if !st.success() {
        return Err("cargo build -p rw-cli failed".into());
    }
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .map(|t| if t.is_absolute() { t } else { root.join(t) })
        .unwrap_or_else(|| root.join("target"));
    Ok(target.join("debug").join("rocketwright"))
}

fn sidecar_tools(bin: &Path) -> Result<BTreeSet<String>, String> {
    let out = Command::new(bin)
        .arg("schema")
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().strip_prefix("tools/")?.strip_suffix(".input"))
        .map(str::to_string)
        .collect())
}

/// The `rw run summary --fields` names, from its `--help` (`Fields: a, b.`).
fn summary_fields(bin: &Path) -> Result<BTreeSet<String>, String> {
    let out = Command::new(bin)
        .args(["run", "summary", "--help"])
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    let help = String::from_utf8_lossy(&out.stdout);
    parse_fields(&help)
        .ok_or_else(|| "`rocketwright run summary --help` lists no `Fields: `".into())
}

/// The names after `Fields: ` up to the next period (help text may wrap).
pub fn parse_fields(help: &str) -> Option<BTreeSet<String>> {
    let flat = help.split_whitespace().collect::<Vec<_>>().join(" ");
    let rest = &flat[flat.find("Fields: ")? + "Fields: ".len()..];
    let list = &rest[..rest.find('.')?];
    Some(list.split(',').map(|f| f.trim().to_string()).collect())
}

/// `rw run summary <run> --fields a,b`: every name is a summary field. A
/// lone `--fields <word>` with no run before it may be the run, so only a
/// list with a comma is checked then; `<list>` placeholders are skipped.
pub fn check_fields(words: &[String], fields: &BTreeSet<String>) -> Result<(), String> {
    let w: Vec<&str> = words.iter().map(|x| clean(x)).collect();
    let Some(s) = w.windows(2).position(|p| p == ["run", "summary"]) else {
        return Ok(());
    };
    let rest = &w[s + 2..];
    let Some(i) = rest.iter().position(|x| *x == "--fields") else {
        return Ok(());
    };
    let Some(list) = rest
        .get(i + 1)
        .filter(|l| !l.starts_with('-') && !l.starts_with('<'))
    else {
        return Ok(());
    };
    let has_run = rest[..i].iter().any(|x| !x.starts_with('-'));
    if !has_run && !list.contains(',') {
        return Ok(());
    }
    let bad: Vec<&str> = list
        .split(',')
        .map(str::trim)
        .filter(|f| !f.is_empty() && !fields.contains(*f))
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(format!("unknown run summary field(s) {}", bad.join(", ")))
    }
}

/// A tool name without the Lecturn `rw_` prefix (`rw_simulate` → `simulate`).
/// Docs name tools bare, but a prefixed name in a tools table is accepted too.
pub fn bare_tool_name(name: &str) -> &str {
    name.strip_prefix("rw_").unwrap_or(name)
}

fn app_tool_exists(dir: &Path, name: &str) -> bool {
    let needles = [
        format!("\"{name}\""),
        format!("'{name}'"),
        format!("`{name}`"),
    ];
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    rd.flatten().any(|e| {
        let p = e.path();
        if p.is_dir() {
            app_tool_exists(&p, name)
        } else if p.extension().is_some_and(|x| x == "ts") {
            std::fs::read_to_string(&p)
                .map(|t| needles.iter().any(|n| t.contains(n.as_str())))
                .unwrap_or(false)
        } else {
            false
        }
    })
}

// ---- the CLI tree ------------------------------------------------------------------

/// One command of the CLI, read from its `--help`.
#[derive(Debug, Default, Clone)]
pub struct CliNode {
    /// Long (`--strict`) and short (`-C`) options.
    pub flags: BTreeSet<String>,
    /// Options that take a value (`--view <VIEW>`).
    pub valued: BTreeSet<String>,
    pub subs: BTreeMap<String, CliNode>,
}

impl CliNode {
    /// Reads the tree under `path` (`[]` = the root) from `bin ... --help`.
    pub fn load(bin: &Path, path: &[String]) -> Result<CliNode, String> {
        let out = Command::new(bin)
            .args(path)
            .arg("--help")
            .output()
            .map_err(|e| format!("{}: {e}", bin.display()))?;
        if !out.status.success() {
            return Err(format!(
                "`rocketwright {} --help` exited {}",
                path.join(" "),
                out.status
            ));
        }
        let help = parse_help(&String::from_utf8_lossy(&out.stdout));
        let mut node = CliNode {
            flags: help.flags,
            valued: help.valued,
            subs: BTreeMap::new(),
        };
        for s in help.subs {
            if s == "help" {
                continue;
            }
            let mut p = path.to_vec();
            p.push(s.clone());
            node.subs.insert(s, CliNode::load(bin, &p)?);
        }
        Ok(node)
    }

    /// Walks `words` (`rw`, then the arguments) through the tree.
    pub fn validate(&self, words: &[String]) -> Result<(), String> {
        let mut node = self;
        let mut path: Vec<&str> = Vec::new();
        let mut i = 1;
        let mut positional = false;
        while i < words.len() {
            let w = clean(&words[i]);
            i += 1;
            if w.is_empty() || w == "|" || w == "..." {
                continue;
            }
            if w.starts_with('-') && w.len() > 1 && !looks_numeric(w) {
                let name = w.split('=').next().unwrap_or(w);
                if !node.flags.contains(name) {
                    let cmd = if path.is_empty() {
                        "rw".to_string()
                    } else {
                        format!("rw {}", path.join(" "))
                    };
                    return Err(format!("`{cmd}` has no option `{name}`"));
                }
                if node.valued.contains(name) && !w.contains('=') {
                    i += 1;
                }
                continue;
            }
            if !positional && let Some(sub) = node.subs.get(w) {
                node = sub;
                path.push(w);
                continue;
            }
            if !node.subs.is_empty() && !positional {
                if w.starts_with('<') && w.ends_with('>') {
                    // `rw <command> --help`: a placeholder subcommand.
                    return Ok(());
                }
                let cmd = if path.is_empty() {
                    "rw".to_string()
                } else {
                    format!("rw {}", path.join(" "))
                };
                let known: Vec<&str> = node.subs.keys().map(String::as_str).collect();
                return Err(format!(
                    "`{cmd}` has no subcommand `{w}` (known: {})",
                    known.join(", ")
                ));
            }
            positional = true;
        }
        Ok(())
    }
}

/// Strips prose decoration: `[--strict]`, `(--json)`, trailing commas.
fn clean(w: &str) -> &str {
    w.trim_start_matches(['[', '('])
        .trim_end_matches([']', ')', ',', ';', ':'])
}

fn looks_numeric(w: &str) -> bool {
    w[1..].starts_with(|c: char| c.is_ascii_digit() || c == '.')
}

/// What a `--help` page declares.
#[derive(Debug, Default, PartialEq)]
pub struct Help {
    pub subs: Vec<String>,
    pub flags: BTreeSet<String>,
    pub valued: BTreeSet<String>,
}

/// Parses clap's `--help` layout: a `Commands:` section (`  name  about`) and
/// an `Options:` section (`  -C, --project <PROJECT>  about`).
pub fn parse_help(text: &str) -> Help {
    let mut h = Help::default();
    let mut section = "";
    for line in text.lines() {
        if !line.starts_with(' ') {
            section = line.trim_end_matches(':');
            continue;
        }
        let t = line.trim_start();
        match section {
            "Commands" => {
                if let Some(name) = t.split_whitespace().next() {
                    h.subs.push(name.to_string());
                }
            }
            "Options" if t.starts_with('-') => {
                let spec = t.split("  ").next().unwrap_or(t);
                let takes = spec.contains('<');
                for part in spec.split([',', ' ']) {
                    let part = part.trim();
                    if part.starts_with('-') {
                        h.flags.insert(part.to_string());
                        if takes {
                            h.valued.insert(part.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    h
}

// ---- markdown -------------------------------------------------------------------

/// One command line of a fenced block.
#[derive(Debug, Clone, PartialEq)]
pub struct Cmd {
    pub line: usize,
    pub text: String,
    pub expect: i32,
}

/// One fenced block with an `rw` info string.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub line: usize,
    pub run: bool,
    pub cmds: Vec<Cmd>,
}

/// Numbered lines (1-based).
type Lines = Vec<(usize, String)>;

/// Fenced blocks: `(1-based line of the opening fence, info, body lines)`.
fn fences(md: &str) -> Vec<(usize, String, Lines)> {
    let mut out = Vec::new();
    let mut cur: Option<(usize, String, String, Lines)> = None;
    for (i, line) in md.lines().enumerate() {
        let n = i + 1;
        let t = line.trim_start();
        match &mut cur {
            None => {
                if let Some(rest) = t.strip_prefix("```") {
                    let ticks = "```".to_string()
                        + &rest.chars().take_while(|c| *c == '`').collect::<String>();
                    let info = rest.trim_start_matches('`').trim().to_string();
                    cur = Some((n, ticks, info, Vec::new()));
                }
            }
            Some((start, ticks, info, body)) => {
                if t.starts_with(ticks.as_str()) && t.trim_start_matches('`').trim().is_empty() {
                    out.push((*start, std::mem::take(info), std::mem::take(body)));
                    cur = None;
                } else {
                    body.push((n, line.to_string()));
                }
            }
        }
    }
    out
}

/// Joins `\` continuations; drops blank and `#` comment lines.
fn command_lines(body: &[(usize, String)]) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = Vec::new();
    let mut pending: Option<(usize, String)> = None;
    for (n, l) in body {
        let t = l.trim();
        let (start, mut acc) = pending.take().unwrap_or((*n, String::new()));
        if acc.is_empty() && (t.is_empty() || t.starts_with('#')) {
            continue;
        }
        if let Some(head) = t.strip_suffix('\\') {
            acc.push_str(head);
            acc.push(' ');
            pending = Some((start, acc));
        } else {
            acc.push_str(t);
            out.push((start, acc));
        }
    }
    if let Some(p) = pending {
        out.push(p);
    }
    out
}

/// The expected exit code from a trailing `# exit N` (default 0).
pub fn expected_exit(cmd: &str) -> i32 {
    cmd.rfind("# exit ")
        .and_then(|i| cmd[i + 7..].split_whitespace().next()?.parse().ok())
        .unwrap_or(0)
}

/// Every fenced block whose info string starts with `rw`.
pub fn blocks(md: &str) -> Vec<Block> {
    fences(md)
        .into_iter()
        .filter(|(_, info, _)| info.split_whitespace().next() == Some("rw"))
        .map(|(line, info, body)| Block {
            line,
            run: !info.split_whitespace().any(|w| w == "norun"),
            cmds: command_lines(&body)
                .into_iter()
                .map(|(n, text)| Cmd {
                    line: n,
                    expect: expected_exit(&text),
                    text,
                })
                .collect(),
        })
        .collect()
}

fn is_cli(cmd: &str) -> Option<String> {
    let c = cmd.trim().trim_start_matches("$ ");
    (c.starts_with("rw ") || c == "rw" || c.starts_with("rocketwright ")).then(|| c.to_string())
}

/// Every CLI mention: command lines in fenced blocks (any info string) and
/// inline code spans outside fences. `(line, command)`.
pub fn mentions(md: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut fenced = BTreeSet::new();
    for (start, _, body) in fences(md) {
        fenced.insert(start);
        for (n, _) in &body {
            fenced.insert(*n);
        }
        fenced.insert(body.last().map_or(start, |(n, _)| *n) + 1);
        for (n, l) in command_lines(&body) {
            // A command inside a shell pipeline or `&&` chain: check each part.
            for part in l.split(['|', ';']).flat_map(|p| p.split("&&")) {
                if let Some(c) = is_cli(part) {
                    out.push((n, c));
                }
            }
        }
    }
    for (i, line) in md.lines().enumerate() {
        let n = i + 1;
        if fenced.contains(&n) {
            continue;
        }
        let mut rest = line;
        while let Some(a) = rest.find('`') {
            let after = &rest[a + 1..];
            let Some(b) = after.find('`') else { break };
            if let Some(c) = is_cli(&after[..b]) {
                out.push((n, c));
            }
            rest = &after[b + 1..];
        }
    }
    out.sort();
    out
}

/// Names in the first column of the table after `<!-- docs-check: KIND -->`.
pub fn table_names(md: &str, kind: &str) -> Vec<(usize, String)> {
    let marker = format!("<!-- docs-check: {kind} -->");
    let mut out = Vec::new();
    let mut on = false;
    let mut seen_table = false;
    for (i, line) in md.lines().enumerate() {
        let t = line.trim();
        if t == marker {
            on = true;
            seen_table = false;
            continue;
        }
        if !on {
            continue;
        }
        if t.starts_with('|') {
            seen_table = true;
            let cell = t
                .trim_start_matches('|')
                .split('|')
                .next()
                .unwrap_or("")
                .trim();
            for name in cell.split('`').skip(1).step_by(2) {
                if !name.is_empty() {
                    out.push((i + 1, name.to_string()));
                }
            }
        } else if seen_table || !t.is_empty() {
            on = false;
        }
    }
    out
}

/// A small POSIX-ish word splitter (quotes, backslash escapes, `#` comments).
pub fn shell_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                has = true;
                for d in chars.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = chars.next() {
                    match d {
                        '"' => break,
                        '\\' => {
                            if let Some(e) = chars.next() {
                                cur.push(e);
                            }
                        }
                        _ => cur.push(d),
                    }
                }
            }
            '\\' => {
                has = true;
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            '#' if !has => break,
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            _ => {
                has = true;
                cur.push(c);
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

// ---- running blocks -----------------------------------------------------------------

/// Runs the blocks in order in `dir`; errors are `line: message`.
fn run_blocks(blocks: &[Block], dir: &Path, bindir: &Path) -> Vec<String> {
    let mut errors = Vec::new();
    let path = match std::env::var_os("PATH") {
        Some(p) => {
            let mut v = vec![bindir.to_path_buf()];
            v.extend(std::env::split_paths(&p));
            std::env::join_paths(v).unwrap_or(p)
        }
        None => bindir.as_os_str().to_owned(),
    };
    let mut cwd = dir.to_path_buf();
    for b in blocks.iter().filter(|b| b.run) {
        for c in &b.cmds {
            let words = shell_words(&c.text);
            if words.first().map(String::as_str) == Some("cd") {
                let target = words.get(1).map_or(dir.to_path_buf(), |w| cwd.join(w));
                match target.canonicalize() {
                    Ok(t) if t.starts_with(dir.canonicalize().unwrap_or(dir.to_path_buf())) => {
                        cwd = t;
                    }
                    _ => errors.push(format!(
                        "{}: `{}`: not a directory inside the temp project",
                        c.line, c.text
                    )),
                }
                continue;
            }
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(&c.text)
                .current_dir(&cwd)
                .env("PATH", &path)
                .env("RW_OFFLINE", "1")
                .env_remove("RW_TEST_HOOKS")
                .output();
            match out {
                Err(e) => errors.push(format!("{}: `{}`: {e}", c.line, c.text)),
                Ok(o) => {
                    let code = o.status.code().unwrap_or(-1);
                    if code != c.expect {
                        let tail = |b: &[u8]| {
                            let s = String::from_utf8_lossy(b);
                            let lines: Vec<&str> = s.lines().collect();
                            lines[lines.len().saturating_sub(8)..].join("\n    ")
                        };
                        errors.push(format!(
                            "{}: `{}` exited {code}, the doc says {}\n  stdout:\n    {}\n  stderr:\n    {}",
                            c.line,
                            c.text,
                            c.expect,
                            tail(&o.stdout),
                            tail(&o.stderr)
                        ));
                    }
                }
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELP: &str = "Do things\n\nUsage: rw [OPTIONS] [COMMAND]\n\nCommands:\n  check  The check\n  diff   Compare\n  help   Print this message\n\nOptions:\n      --json               Print JSON\n  -C, --project <PROJECT>  Project\n  -h, --help               Print help\n";

    fn tree() -> CliNode {
        let h = parse_help(HELP);
        assert_eq!(h.subs, ["check", "diff", "help"]);
        let mut root = CliNode {
            flags: h.flags,
            valued: h.valued,
            subs: BTreeMap::new(),
        };
        let leaf = |flags: &[&str], valued: &[&str]| CliNode {
            flags: flags.iter().map(|s| s.to_string()).collect(),
            valued: valued.iter().map(|s| s.to_string()).collect(),
            subs: BTreeMap::new(),
        };
        root.subs.insert(
            "check".into(),
            leaf(&["--strict", "--set", "-C"], &["--set", "-C"]),
        );
        let mut diff = leaf(&["--json"], &[]);
        diff.subs
            .insert("run".into(), leaf(&["--golden"], &["--golden"]));
        root.subs.insert("diff".into(), diff);
        root
    }

    fn v(s: &str) -> Result<(), String> {
        tree().validate(&shell_words(s))
    }

    #[test]
    fn bare_tool_name_strips_one_rw_prefix() {
        assert_eq!(bare_tool_name("rw_simulate"), "simulate");
        assert_eq!(bare_tool_name("simulate"), "simulate");
        assert_eq!(bare_tool_name("rw_rw_x"), "rw_x");
        assert_eq!(bare_tool_name("viewport_render"), "viewport_render");
    }

    #[test]
    fn help_parsing() {
        let h = parse_help(HELP);
        assert!(
            h.flags.contains("--json") && h.flags.contains("-C") && h.flags.contains("--project")
        );
        assert!(h.valued.contains("--project") && h.valued.contains("-C"));
        assert!(!h.valued.contains("--json"));
    }

    #[test]
    fn validation() {
        assert!(v("rw check --strict").is_ok());
        assert!(v("rw check [--strict]").is_ok());
        assert!(v("rw check --set c.fins.span=10mm --strict").is_ok());
        assert!(
            v("rw check --set check --strict").is_ok(),
            "value of --set is not a subcommand"
        );
        assert!(v("rw diff run a --golden g.json").is_ok());
        assert!(v("rw check --fast").unwrap_err().contains("--fast"));
        assert!(v("rw chek").unwrap_err().contains("no subcommand `chek`"));
        assert!(v("rw diff walk").unwrap_err().contains("rw diff"));
        assert!(v("rw diff run a --strict").is_err());
        assert!(v("rw check # exit 1").is_ok());
        assert!(v("rw <command> --help").is_ok());
    }

    #[test]
    fn words() {
        assert_eq!(
            shell_words(r#"rw set c.fins.span="30 mm" 'a b' x\ y # exit 1"#),
            ["rw", "set", "c.fins.span=30 mm", "a b", "x y"]
        );
        assert_eq!(
            shell_words("rw add a '{\"x\":1}'"),
            ["rw", "add", "a", "{\"x\":1}"]
        );
    }

    #[test]
    fn blocks_and_mentions() {
        let md = "Run `rw check --strict` now.\n\n```rw\n# a comment\nrw init\nrw check --strict  # exit 1\nrw set a=1 \\\n  b=2\n```\n\n```rw norun\nrw render --view iso\n```\n\n```toml\nx = 1\n```\n\n```sh\nrw check | head\n```\n";
        let b = blocks(md);
        assert_eq!(b.len(), 2);
        assert!(b[0].run && !b[1].run);
        assert_eq!(b[0].cmds.len(), 3);
        assert_eq!(b[0].cmds[1].expect, 1);
        assert_eq!(b[0].cmds[2].text, "rw set a=1  b=2");
        assert_eq!(b[0].cmds[2].line, 7);
        let m: Vec<String> = mentions(md).into_iter().map(|(_, c)| c).collect();
        assert!(m.contains(&"rw check --strict".to_string()));
        assert!(m.contains(&"rw render --view iso".to_string()));
        assert!(m.contains(&"rw check".to_string()));
        assert!(!m.iter().any(|c| c.contains("x = 1")));
    }

    #[test]
    fn summary_field_names() {
        let help = "Options:\n      --fields [<LIST>]  Comma-separated fields to print\n          (`apogee,events`). Fields: apogee, coast_time,\n          deploy_minus_apogee, events.\n";
        let f = parse_fields(help).unwrap();
        assert_eq!(f.len(), 4);
        assert!(f.contains("deploy_minus_apogee"));
        let c = |s: &str| check_fields(&shell_words(s), &f);
        assert!(c("rw run summary baseline --fields apogee,coast_time").is_ok());
        assert!(c("rw run summary baseline --fields").is_ok());
        assert!(
            c("rw run summary --fields baseline").is_ok(),
            "a lone run ref"
        );
        assert!(c("rw run summary b --fields <list>").is_ok());
        assert!(c("rw check --fields bogus").is_ok());
        assert!(
            c("rw run summary b --fields apogee,deploy_delta")
                .unwrap_err()
                .contains("deploy_delta")
        );
        assert!(c("rw run summary --fields apogee,nope").is_err());
    }

    #[test]
    fn tool_tables() {
        let md = "<!-- docs-check: tools -->\n\n| Tool | Use |\n|---|---|\n| `design_check` | check |\n| `simulate`, `job_status` | fly |\n\nafter `not_a_tool`\n";
        let names: Vec<String> = table_names(md, "tools")
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        assert_eq!(names, ["design_check", "simulate", "job_status"]);
    }
}
