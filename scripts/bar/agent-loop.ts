/**
 * B3 fresh-agent runner (spec B3, plan RL4; the formal run is M2.11):
 * `make bar-agent TASK=T1..T5`.
 *
 * Per task: a fresh Agent SDK agent with no repo, user, project, or MCP
 * context (`cwd` = a new `mktemp -d`, `settingSources: []`,
 * `strictMcpConfig: true`, no MCP servers, tools Bash/Read/Write/Edit) and
 * the kit's `bin/` first on PATH. The task's `setup` commands seed the working
 * directory first. Writes to `<bar out>/agent-loop/T<n>/`: `prompt.txt`,
 * `messages.jsonl` (raw SDK stream), `transcript.json` (normalized, with the
 * final `*.toml` texts),
 * `score.json` (`agent-loop-score.ts`), and `renders/`: every PNG the agent
 * rendered or Read (`pngArchive`), so critics see what the agent saw.
 *
 * Non-gating: it uses the network and the user's Claude credentials, never
 * runs under `make check`, and is a no-op unless `RW_LIVE=1`. Exit 0 after a
 * run (report mode), 1 when the kit is incomplete (fail loudly, D8) or a setup
 * command fails, 2 on bad arguments.
 *
 *   --task T1|T1..T5|T1,T3|all   (default all)
 *   --kit <dir>                  kit root (default kit.json `kit_root` in the repo)
 *   --out <dir>                  output root (default <bar out>/agent-loop)
 *   --score <transcript.json>    re-score a saved transcript; no agent, no RW_LIVE
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { barOutDir, REPO_ROOT, stableStringify } from "../../app/e2e/bar/paths.ts";
import { scoreTranscript, transcriptFromSdk, type Score, type TaskSpec, type ToolCall, type Transcript } from "./agent-loop-score.ts";

export const AGENT_LOOP_DIR = join(REPO_ROOT, "tests/agent-loop");
export const TASK_IDS = ["T1", "T2", "T3", "T4", "T5"] as const;

export interface Kit {
  kit_root: string;
  path: string[];
  binaries: string[];
  skill_doc: string;
  data: Record<string, string>;
  tools: string[];
  max_tool_calls: number;
  max_turns: number;
  env: Record<string, string>;
}

export function loadKit(file: string = join(AGENT_LOOP_DIR, "kit.json")): Kit {
  return JSON.parse(readFileSync(file, "utf8")) as Kit;
}

export function loadTask(id: string, dir: string = join(AGENT_LOOP_DIR, "tasks")): TaskSpec {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as TaskSpec;
}

/** `T1..T5`, `T2,T4`, `T3`, or `all` → task ids in order; null when malformed. */
export function parseTaskList(arg: string): string[] | null {
  if (arg === "all") return [...TASK_IDS];
  const range = /^T([1-5])\.\.T([1-5])$/.exec(arg);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    return a <= b ? TASK_IDS.slice(a - 1, b) : null;
  }
  const ids = arg.split(",").map((s) => s.trim());
  return ids.every((id) => (TASK_IDS as readonly string[]).includes(id)) ? ids : null;
}

/** Kit files that must exist; the missing ones, as absolute paths. */
export function missingKitFiles(kit: Kit, root: string): string[] {
  const need = [...kit.binaries, kit.skill_doc, ...Object.values(kit.data)].map((p) => join(root, p));
  return need.filter((p) => !existsSync(p));
}

/** Fills `{skill_doc}` and `{data:<key>}` with absolute kit paths. Throws on an unknown key. */
export function renderPrompt(task: TaskSpec, kit: Kit, root: string): string {
  return task.prompt.replace(/\{(skill_doc|data:([\w-]+))\}/g, (_, tag: string, key: string | undefined) => {
    if (tag === "skill_doc") return join(root, kit.skill_doc);
    const rel = key === undefined ? undefined : kit.data[key];
    if (rel === undefined) throw new Error(`task ${task.id}: unknown kit data key ${String(key)}`);
    return join(root, rel);
  });
}

/** The system dirs after the kit on the agent's PATH (no cargo, node, repo, or user bins). */
export const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Base variables the agent must not inherit: the builder's RocketWright, cargo, and Claude Code session state. */
const LEAKY_ENV = /^(RW_|CARGO|RUSTUP|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|ELECTRON_RUN_AS_NODE$)/;

/**
 * The child env: `process.env` spread (the SDK replaces it wholesale, and it
 * carries HOME for the local Claude login) minus RocketWright/cargo/Claude
 * session variables, then the kit env; PATH is only the kit bin dirs and the
 * system dirs, so the agent has the kit and nothing from the checkout.
 */
export function kitEnv(kit: Kit, root: string, base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !LEAKY_ENV.test(k)) env[k] = v;
  Object.assign(env, kit.env);
  env["PATH"] = [...kit.path.map((p) => join(root, p)), ...SYSTEM_PATH].join(delimiter);
  return env;
}

/** The subset of Agent SDK `Options` the runner sets (typed locally; the SDK lives in the bar-only @rw/bar-agent). */
export interface AgentLoopOptions {
  cwd: string;
  tools: string[];
  allowedTools: string[];
  mcpServers: Record<string, never>;
  strictMcpConfig: true;
  settingSources: [];
  permissionMode: "default";
  persistSession: false;
  maxTurns: number;
  env: Record<string, string>;
  model?: string;
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }>;
}

/** Fresh, isolated agent options for one task (I14 isolation; no settings, no MCP). */
export function buildAgentOptions(kit: Kit, root: string, cwd: string, base: NodeJS.ProcessEnv = process.env): AgentLoopOptions {
  const model = base["RW_AGENT_MODEL"];
  return {
    cwd,
    tools: [...kit.tools],
    allowedTools: [...kit.tools],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: "default",
    persistSession: false,
    maxTurns: kit.max_turns,
    env: kitEnv(kit, root, base),
    ...(model ? { model } : {}),
    // Every kit tool is allowed; nothing may block on a human.
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
  };
}

/** Relative file list of a working directory (skips `.rw/` and `.git/`). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".rw" || e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Final text of the `*.toml` project files (each at most 256 KiB). */
export function projectTexts(dir: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!f.endsWith(".toml")) continue;
    const p = join(dir, f);
    if (statSync(p).size <= 256 * 1024) out[f] = readFileSync(p, "utf8");
  }
  return out;
}

/** One file to archive: absolute source, destination relative to `<task out>/renders/`. */
export interface ArchivedFile {
  src: string;
  dest: string;
}

/**
 * Images the agent produced or looked at (B3 round 8): every file under a
 * `renders/` directory anywhere in the working directory (the project may sit
 * in a subdirectory) and every other `*.png` there, plus every PNG the agent
 * opened with Read, wherever it lives. Working-directory files keep their
 * relative path (a leading `renders/` dropped, as before); Read files from
 * outside go under `read/` by basename (`-2`, `-3`, … on a clash). Missing
 * files are skipped.
 */
export function pngArchive(cwd: string, files: readonly string[], calls: readonly ToolCall[]): ArchivedFile[] {
  const isPng = (p: string) => extname(p).toLowerCase() === ".png";
  const out: ArchivedFile[] = [];
  const seen = new Set<string>();
  const add = (src: string, dest: string) => {
    if (seen.has(src)) return;
    seen.add(src);
    out.push({ src, dest });
  };
  for (const f of files) {
    if (!isPng(f) && !f.split("/").slice(0, -1).includes("renders")) continue;
    add(join(cwd, f), f.startsWith("renders/") ? f.slice("renders/".length) : f);
  }
  const taken = new Set(out.map((a) => a.dest));
  for (const c of calls) {
    if (c.tool !== "Read") continue;
    const p = c.input["file_path"];
    if (typeof p !== "string" || !isPng(p)) continue;
    const src = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    if (seen.has(src) || !existsSync(src) || !statSync(src).isFile()) continue;
    const inside = relative(cwd, src);
    if (!inside.startsWith("..") && !isAbsolute(inside)) {
      add(src, inside.split("\\").join("/"));
      continue;
    }
    const stem = basename(src, extname(src));
    let dest = `read/${basename(src)}`;
    for (let k = 2; taken.has(dest); k++) dest = `read/${stem}-${k}${extname(src)}`;
    taken.add(dest);
    add(src, dest);
  }
  return out;
}

/** Copies `pngArchive` into `<outDir>/renders/`; returns the destinations (relative). */
export function archiveRenders(cwd: string, files: readonly string[], calls: readonly ToolCall[], outDir: string): string[] {
  const list = pngArchive(cwd, files, calls);
  for (const a of list) {
    const to = join(outDir, "renders", a.dest);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(a.src, to);
  }
  return list.map((a) => a.dest);
}

type QueryFn = (a: { prompt: string; options: AgentLoopOptions }) => AsyncIterable<unknown>;

/** Loads `query` from the Agent SDK of the bar-only package `@rw/bar-agent` (B17: the app no longer depends on it). */
async function loadQuery(): Promise<QueryFn> {
  const req = createRequire(join(REPO_ROOT, "app/packages/bar-agent/package.json"));
  const mod = (await import(pathToFileURL(req.resolve("@anthropic-ai/claude-agent-sdk")).href)) as { query: QueryFn };
  return mod.query;
}

export function writeScore(transcript: Transcript, task: TaskSpec, outDir: string, maxCalls: number): Score {
  const score = scoreTranscript(transcript, task, maxCalls);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "transcript.json"), stableStringify(transcript));
  writeFileSync(join(outDir, "score.json"), stableStringify(score));
  return score;
}

async function runTask(id: string, kit: Kit, root: string, outRoot: string, env: NodeJS.ProcessEnv): Promise<number> {
  const task = loadTask(id);
  const prompt = renderPrompt(task, kit, root);
  const cwd = mkdtempSync(join(tmpdir(), `rw-b3-${id}-`));
  const childEnv = kitEnv(kit, root, env);
  for (const argv of task.setup) {
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env: childEnv, encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`bar-agent ${id}: setup \`${argv.join(" ")}\` failed (exit ${String(r.status)}): ${r.stderr || String(r.error ?? "")}`);
      return 1;
    }
  }
  const outDir = join(outRoot, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "prompt.txt"), prompt + "\n");
  const query = await loadQuery();
  const messages: unknown[] = [];
  const jsonl: string[] = [];
  try {
    for await (const m of query({ prompt, options: buildAgentOptions(kit, root, cwd, env) })) {
      messages.push(m);
      jsonl.push(JSON.stringify(m));
    }
  } catch (e) {
    console.error(`bar-agent ${id}: agent error: ${String(e)}`);
  }
  writeFileSync(join(outDir, "messages.jsonl"), jsonl.join("\n") + "\n");
  const files = listFiles(cwd);
  const transcript: Transcript = { ...transcriptFromSdk(id, prompt, messages, files), file_texts: projectTexts(cwd, files) };
  const archived = archiveRenders(cwd, files, transcript.calls, outDir);
  const score = writeScore(transcript, task, outDir, kit.max_tool_calls);
  console.log(`bar-agent ${id}: ${score.pass ? "pass" : "red"} (${score.tool_calls} tool calls)${score.reasons.length ? "\n  " + score.reasons.join("\n  ") : ""}`);
  console.log(`  workdir ${cwd}\n  -> ${outDir} (${archived.length} render file(s) archived)`);
  return 0;
}

function flag(argv: string[], name: string): string | undefined | null {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1] ?? null;
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const kit = loadKit();
  const scoreArg = flag(argv, "--score");
  if (scoreArg === null) return usage("--score needs a transcript.json");
  if (scoreArg !== undefined) {
    const file = resolve(scoreArg);
    const transcript = JSON.parse(readFileSync(file, "utf8")) as Transcript;
    const score = writeScore(transcript, loadTask(transcript.task), dirname(file), kit.max_tool_calls);
    console.log(stableStringify(score));
    return 0;
  }
  const taskArg = flag(argv, "--task");
  const ids = parseTaskList(taskArg === undefined || taskArg === "" ? "all" : (taskArg ?? ""));
  if (!ids) return usage(`bad --task ${String(taskArg)} (T1..T5, T2,T4, T3, all)`);
  const kitArg = flag(argv, "--kit");
  const outArg = flag(argv, "--out");
  if (kitArg === null || outArg === null) return usage("--kit and --out need a value");
  if (env["RW_LIVE"] !== "1") {
    console.log("bar-agent: skipped (set RW_LIVE=1; uses the network and your Claude credentials; non-gating)");
    return 0;
  }
  const root = resolve(REPO_ROOT, kitArg ?? kit.kit_root);
  const missing = missingKitFiles(kit, root);
  if (missing.length) {
    console.error(`bar-agent: kit incomplete (run \`make kit\`); missing:\n  ${missing.join("\n  ")}`);
    return 1;
  }
  const outRoot = resolve(outArg ?? join(barOutDir(), "agent-loop"));
  let code = 0;
  for (const id of ids) code = Math.max(code, await runTask(id, kit, root, outRoot, env));
  return code;
}

function usage(msg: string): number {
  console.error(`agent-loop: ${msg}`);
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
