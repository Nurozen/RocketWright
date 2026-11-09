/**
 * B2-b live trials (U41, D24, D28): `RW_LIVE=1 make bar-b2-live`. Three trials
 * per path against a real provider, in the real Electron app, in sidecar mode
 * (the shipped path), each scored from its Lecturn transcript and tree diffs.
 * It uses the network and the user's provider login, so it never runs under
 * `make check`, and without `RW_LIVE=1` it prints a skip line and writes
 * nothing.
 *
 * Paths:
 * - `accept`: the bare prompt, the dialog accepted. `request` must be absent:
 *   no work is left, so the new thread stays empty.
 * - `cancel`: the bare prompt, the dialog cancelled. The agent reports it and
 *   stops, and nothing is created.
 * - `remaining`: the prompt that leaves work (D28: "empty", because the default
 *   template already has a nose), accepted. One `rw_project_new`, the new thread
 *   adds exactly one nose cone and changes nothing else, and the caller stops.
 *
 * Every trial gets its own temp Lecturn home and base dir, Electron profile,
 * Documents override, and caller project under `/tmp` (`isolationProblems`
 * refuses anything else before a launch). The Electron side is
 * `app/e2e/agent-project-live.ts`, loaded only in a live run.
 *
 * The scorer is pure and reads what the driver recorded, one `TrialRecord`
 * per trial. Tool outputs must come through `LecturnAdminSession.transcript`:
 * the plain projection stubs a dynamic tool's output (U06).
 *
 *   --self-test        scores the recorded transcripts in tests/bar/b2-live/
 *                      and planted faults; no RW_LIVE
 *   --score <path>     re-scores a saved TrialRecord, or a directory of them;
 *                      no RW_LIVE; prints the report, and writes it only to --out
 *   --out <file>       the report (default target/bar/usability/b2-live.json);
 *                      trial records go in `b2-live/` beside it
 *   --trials <n>       trials per path (default 3; fewer never passes the bar)
 *   --paths a,b        a subset of accept, cancel, remaining (never passes the bar)
 *   --provider p       claude (default) or codex
 *   --model i/m        another Lecturn model selection (`<instance>/<model>`)
 *   --timeout-min <n>  per trial (default 6)
 *   --keep             keep the temp projects
 *
 * Exit 0 after a run (report mode; the status is in the report), 2 on bad
 * arguments, 1 on a failed self-test.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { REPO_ROOT, stableStringify } from "../../app/e2e/bar/paths.ts";
import { bareTool, toolValue } from "../../app/e2e/lecturn-transcript.ts";
import type { FileChange } from "../../app/packages/contracts/src/generated/types.ts";
import type { ModelSelection, ProviderRequestEntry } from "./lecturn-admin.ts";
import { liveAppEnv, META_TOOLS, PROVIDER_MODELS } from "./live-smoke.ts";

export const LIVE_PATHS = ["accept", "cancel", "remaining"] as const;
export type LivePath = (typeof LIVE_PATHS)[number];

export const TRIALS_PER_PATH = 3;
export const TRIAL_TIMEOUT_MS = 6 * 60_000;
export const NEW_PROJECT = "solstice-rocket";
export const CALLER_PROJECT = "caller-rocket";
const BARE_PROMPT = "Create a new project called solstice-rocket";
export const PROMPTS: Record<LivePath, string> = {
  accept: BARE_PROMPT,
  cancel: BARE_PROMPT,
  remaining: "Create a new empty project called solstice-rocket and add a nose cone",
};
export const DEFAULT_REPORT = join(REPO_ROOT, "target/bar/usability/b2-live.json");
export const RECORDED_DIR = join(REPO_ROOT, "tests/bar/b2-live");

// ---- what the driver records -------------------------------------------------------

/** Relative path to `sha256:<hex>`, `link:<target>`, or `other` (a socket or the like). `.rw/` is never walked. */
export type TreeSnapshot = Record<string, string>;

export interface RecordedItem {
  id: string;
  runId: string | null;
  type: string;
  status: string;
  ordinal?: number;
  toolName?: string | null;
  text?: string;
  input?: unknown;
  output?: unknown;
  outputOmitted?: boolean;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  runs: readonly { id: string; status: string }[];
  messages: readonly { id: string; runId: string | null; role: string; text: string }[];
  turnItems: readonly RecordedItem[];
}

/** The evaluated model (`rw eval --json`'s `model`), as far as the scorer reads it. */
export type EvaluatedModel = Record<string, unknown>;

export interface TrialRecord {
  path: LivePath;
  trial: number;
  prompt: string;
  /** Why the trial could not be run or read (app, login, network); it says nothing about the agent. */
  infra?: string;
  timed_out: boolean;
  documents: string;
  /** Where the project belongs: `<documents>/RocketWright/solstice-rocket`. */
  target: string;
  caller_thread: string | null;
  /** Every live thread the app's Lecturn holds, by id. */
  threads: Record<string, ThreadRecord>;
  shell: { threads: readonly { id: string; projectId: string }[]; projects: readonly { id: string; workspaceRoot: string | null }[] };
  dialogs: readonly { message: string; detail: string; response: number | null }[];
  caller_tree: { before: TreeSnapshot; after: TreeSnapshot };
  /** Null: the folder does not exist. */
  target_tree: TreeSnapshot | null;
  target_model: EvaluatedModel | null;
  /** D24's reference: a separate `rw init` with the arguments the call used. Null on Cancel, or when the target is absent. */
  control: { template: string | null; files: readonly FileChange[]; tree: TreeSnapshot; model: EvaluatedModel } | null;
  control_error?: string;
  /** What the harness declined; recorded, not scored. */
  provider_requests: readonly ProviderRequestEntry[];
  app_approvals: readonly { threadId: string; requestId: string; tool: string }[];
  /** Where a recording came from, when it was not a live run. */
  note?: string;
}

// ---- trees ------------------------------------------------------------------------

/** The folder's files, or null without it. `.rw/` is the app's own state, so it is never walked. */
export function snapshotTree(root: string): TreeSnapshot | null {
  if (!existsSync(root)) return null;
  const out: TreeSnapshot = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      if (rel === ".rw") continue;
      if (e.isDirectory()) walk(full);
      else if (e.isSymbolicLink()) out[rel] = `link:${readlinkSync(full)}`;
      else if (lstatSync(full).isFile()) out[rel] = `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      else out[rel] = "other";
    }
  };
  walk(root);
  return out;
}

/** `.rw/` and `artifacts/` are the two places a write is allowed (spec B2). */
function allowed(path: string): boolean {
  return path === ".rw" || path.startsWith(".rw/") || path === "artifacts" || path.startsWith("artifacts/");
}

export interface TreeChange {
  path: string;
  change: "added" | "changed" | "removed";
}

export function treeDiff(before: TreeSnapshot, after: TreeSnapshot): TreeChange[] {
  const out: TreeChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (allowed(path) || before[path] === after[path]) continue;
    out.push({ path, change: before[path] === undefined ? "added" : after[path] === undefined ? "removed" : "changed" });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---- isolation --------------------------------------------------------------------

const unprivate = (p: string): string => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
/** macOS's `/tmp` is `/private/tmp`, and the app and Lecturn report either. */
export const samePath = (a: string, b: string): boolean => unprivate(a) === unprivate(b);
const inside = (p: string, dir: string): boolean => unprivate(p) === unprivate(dir) || unprivate(p).startsWith(`${unprivate(dir)}/`);

/** Why this environment must not launch: nothing may reach `~/.lecturn` or the real Documents. */
export function isolationProblems(env: Readonly<Record<string, string | undefined>>, home: string = homedir(), temp: string = tmpdir()): string[] {
  const problems: string[] = [];
  const realLecturn = join(home, ".lecturn");
  const realDocuments = join(home, "Documents");
  for (const key of ["LECTURN_HOME", "RW_LECTURN_BASE_DIR", "RW_USER_DATA_DIR", "RW_DOCUMENTS_DIR"]) {
    const value = env[key];
    if (value === undefined || value === "") {
      problems.push(`${key} is not set`);
      continue;
    }
    if (inside(value, realLecturn)) problems.push(`${key} is inside ~/.lecturn: ${value}`);
    if (inside(value, realDocuments)) problems.push(`${key} is inside ~/Documents: ${value}`);
    if (!inside(value, "/tmp") && !inside(value, temp)) problems.push(`${key} is not a temp path: ${value}`);
  }
  return problems;
}

// ---- reading a transcript ---------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const canon = (v: unknown): string => stableStringify(v);
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(["dynamic_tool", "command_execution", "file_change", "file_search", "web_search"]);
/** Creating a project any way but the one tool, or opening one, is a second attempt at the same step. */
const OTHER_PROJECT_TOOLS: readonly string[] = ["project_create", "project_open"];
const SHELL_CREATE = /\b(?:rw|rocketwright)\s+(?:init\b|call\s+project_)/;
const CANCEL_REPORT = /cancel|declin|nothing was created|not created|wasn.t created|did not create|didn.t create/i;

/** The thread's turn items, run by run. */
function ordered(t: ThreadRecord): RecordedItem[] {
  const runOrder = new Map(t.runs.map((r, i) => [r.id, i]));
  const at = (i: RecordedItem): number => (i.runId === null ? -1 : (runOrder.get(i.runId) ?? -1));
  return [...t.turnItems].sort((a, b) => at(a) - at(b) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

const isProjectNew = (i: RecordedItem): boolean => i.type === "dynamic_tool" && bareTool(i.toolName) === "project_new";

export interface ProjectNewCall {
  args: Record<string, unknown>;
  isError: boolean;
  text: string;
  /** The tool's own result, when the record carries it. */
  value: unknown;
}

function callOf(i: RecordedItem): ProjectNewCall {
  const output = i.output;
  const result = isObject(output) && "result" in output ? output["result"] : output;
  const content = isObject(result) && Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
  return {
    args: isObject(i.input) ? i.input : {},
    isError: i.status === "failed" || (isObject(result) && result["isError"] === true),
    text: content.map((c) => (isObject(c) && typeof c["text"] === "string" ? c["text"] : "")).join("\n"),
    value: output === undefined ? null : toolValue(output),
  };
}

/** Every `rw_project_new` in every thread, the caller's first. */
export function projectNewCalls(r: Pick<TrialRecord, "threads" | "caller_thread">): ProjectNewCall[] {
  const threads = Object.values(r.threads).sort((a, b) => Number(b.id === r.caller_thread) - Number(a.id === r.caller_thread));
  return threads.flatMap((t) => ordered(t).filter(isProjectNew).map(callOf));
}

function toolName(i: RecordedItem): string {
  return i.type === "dynamic_tool" ? bareTool(i.toolName) : i.type;
}

/** The tools `t` used after its `rw_project_new`; a provider's own meta tools are not work. */
function toolsAfterCall(t: ThreadRecord): string[] {
  const items = ordered(t);
  const at = items.findIndex(isProjectNew);
  if (at === -1) return [];
  return items
    .slice(at + 1)
    .filter((i) => TOOL_ITEM_TYPES.has(i.type) && !META_TOOLS.includes(toolName(i)))
    .map(toolName);
}

function textAfterCall(t: ThreadRecord): string {
  const items = ordered(t);
  const at = items.findIndex(isProjectNew);
  const said = items
    .slice(at + 1)
    .filter((i) => i.type === "assistant_message")
    .map((i) => i.text ?? "")
    .join("\n");
  if (said.trim() !== "") return said;
  return t.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
}

/** D24: the files the new thread's own model edits reported. A dry run writes nothing, so it reports nothing. */
function editedFiles(t: ThreadRecord): string[] {
  const out = new Set<string>();
  for (const i of t.turnItems) {
    if (i.type !== "dynamic_tool" || i.status !== "completed" || i.output === undefined) continue;
    const v = toolValue(i.output);
    if (!isObject(v) || typeof v["model_hash"] !== "string" || !Array.isArray(v["files"]) || v["dry_run"] === true) continue;
    for (const f of v["files"]) if (isObject(f) && typeof f["path"] === "string") out.add(f["path"]);
  }
  return [...out];
}

// ---- the model rule (D24, D28) -----------------------------------------------------

/** Compared whole. The rest of the evaluated model follows from the parts: reference, diagnostics, the hash. */
const MODEL_KEYS: readonly string[] = ["schema", "name", "config", "params", "sims", "materials", "asserts", "report", "units"];
/** A stage's own fields, with those computed from its parts left out. */
const STAGE_COMPUTED: readonly string[] = ["first", "members", "x_fore", "x_aft"];
/** What the engine fills in for a stage the configuration does not mention. */
const DEFAULT_CONFIG_STAGE = { active: true, separation: "never", separation_delay: 0 };

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isObject) : []);
const without = (row: Row, keys: readonly string[]): Row => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

/**
 * What separates `after` from `base` beyond one added nose cone; empty when
 * nothing does. Strict by D24's words: a `[materials.*]` entry added for the
 * nose is another change, and the nose needs none (`material` is optional).
 */
export function modelProblems(base: EvaluatedModel, after: EvaluatedModel): string[] {
  const problems: string[] = [];
  const before = new Map(rows(base["components"]).map((c) => [c["id"], c]));
  const now = rows(after["components"]);
  const added = now.filter((c) => !before.has(c["id"]));
  for (const id of before.keys()) if (!now.some((c) => c["id"] === id)) problems.push(`component ${String(id)} was removed`);
  for (const c of now) if (before.has(c["id"]) && canon(before.get(c["id"])) !== canon(c)) problems.push(`component ${String(c["id"])} changed`);
  if (added.length !== 1) problems.push(`added ${added.length} components, want exactly one nose cone`);
  for (const c of added) if (!isObject(c["shape"]) || c["shape"]["type"] !== "nose_cone") problems.push(`added component ${String(c["id"])} is not a nose cone`);

  for (const key of MODEL_KEYS) if (canon(base[key]) !== canon(after[key])) problems.push(`${key} changed`);

  const stagesBefore = new Map(rows(base["stages"]).map((s) => [s["id"], s]));
  const newIds = new Set(added.map((c) => c["id"]));
  for (const id of stagesBefore.keys()) if (!rows(after["stages"]).some((s) => s["id"] === id)) problems.push(`stage ${String(id)} was removed`);
  for (const s of rows(after["stages"])) {
    const old = stagesBefore.get(s["id"]);
    if (old === undefined) {
      const members = s["members"];
      if (!Array.isArray(members) || !members.every((m) => newIds.has(m))) problems.push(`stage ${String(s["id"])} is new and holds more than the added part`);
    } else if (canon(without(old, STAGE_COMPUTED)) !== canon(without(s, STAGE_COMPUTED))) problems.push(`stage ${String(s["id"])} changed`);
  }

  const configsBefore = isObject(base["configs"]) ? base["configs"] : {};
  const configsAfter = isObject(after["configs"]) ? after["configs"] : {};
  for (const id of new Set([...Object.keys(configsBefore), ...Object.keys(configsAfter)])) {
    const was = configsBefore[id];
    const is = configsAfter[id];
    if (!isObject(was) || !isObject(is)) {
      problems.push(`configuration ${id} was added or removed`);
      continue;
    }
    if (canon(without(was, ["stages"])) !== canon(without(is, ["stages"]))) problems.push(`configuration ${id} changed`);
    const stages = new Map(rows(was["stages"]).map((s) => [s["stage"], s]));
    for (const s of rows(is["stages"])) {
      const old = stages.get(s["stage"]);
      const expected = old ?? { stage: s["stage"], ...DEFAULT_CONFIG_STAGE };
      if (canon(expected) !== canon(s)) problems.push(`configuration ${id}: stage ${String(s["stage"])} changed`);
    }
  }
  return problems;
}

// ---- scoring ----------------------------------------------------------------------

export interface TrialScore {
  path: LivePath;
  trial: number;
  status: "pass" | "red";
  reasons: string[];
  /** The harness or provider failed; the trial says nothing about the agent. */
  infra?: boolean;
  project_new_calls: number;
  dialogs: number;
  /** Files exempted from the tree diff, with why (D24). */
  exempt: string[];
}

function callerProblems(r: TrialRecord): string[] {
  return treeDiff(r.caller_tree.before, r.caller_tree.after).map((c) => `caller project: ${c.change} ${c.path}`);
}

/** D24: the accepted target against what `rw init` wrote, plus the new thread's edits when the model rule holds. */
function targetProblems(r: TrialRecord, edits: readonly string[]): { problems: string[]; exempt: string[] } {
  if (r.target_tree === null) return { problems: [`no project at ${r.target}`], exempt: [] };
  if (r.control === null) return { problems: [`no control project to compare with${r.control_error === undefined ? "" : `: ${r.control_error}`}`], exempt: [] };
  const problems: string[] = [];
  const exempt: string[] = [];
  const reported = new Set(r.control.files.map((f) => f.path));
  const tree = r.target_tree;
  for (const path of new Set([...Object.keys(tree), ...reported])) {
    if (allowed(path)) continue;
    if (edits.includes(path)) {
      exempt.push(`${path} (the new thread's edit)`);
    } else if (reported.has(path) && tree[path] !== undefined && tree[path] === r.control.tree[path]) {
      exempt.push(`${path} (rw init)`);
    } else if (reported.has(path) && tree[path] === undefined) {
      problems.push(`new project: removed ${path}`);
    } else if (reported.has(path)) {
      problems.push(`new project: changed ${path}, unlike what rw init writes`);
    } else {
      problems.push(`new project: added ${path}`);
    }
  }
  return { problems: problems.sort(), exempt: exempt.sort() };
}

function lastRunCompleted(t: ThreadRecord): boolean {
  return t.runs.at(-1)?.status === "completed";
}

function acceptedProblems(r: TrialRecord, call: ProjectNewCall, caller: ThreadRecord): { problems: string[]; fresh: ThreadRecord | undefined } {
  const problems: string[] = [];
  if (call.isError) problems.push(`rw_project_new failed: ${call.text}`);
  const value = isObject(call.value) ? call.value : {};
  const project = isObject(value["project"]) ? value["project"] : {};
  if (typeof project["dir"] !== "string" || !samePath(project["dir"], r.target)) problems.push(`the result names ${String(project["dir"])}, want ${r.target}`);
  const threadId = value["threadId"];
  if (typeof threadId !== "string") {
    problems.push("the result names no new thread");
    return { problems, fresh: undefined };
  }
  const fresh = r.threads[threadId];
  if (fresh === undefined) {
    problems.push(`new thread ${threadId} is not in Lecturn`);
    return { problems, fresh };
  }
  const root = r.shell.projects.find((p) => p.id === fresh.projectId)?.workspaceRoot ?? null;
  if (fresh.projectId === caller.projectId || root === null || !samePath(root, r.target)) problems.push(`new thread ${threadId} is not in the new project (its root is ${String(root)})`);
  return { problems, fresh };
}

/** One trial against the bar (spec B2, D24, D28). */
export function scoreTrial(r: TrialRecord): TrialScore {
  const base = { path: r.path, trial: r.trial, dialogs: r.dialogs.length, project_new_calls: projectNewCalls(r).length, exempt: [] as string[] };
  if (r.infra !== undefined) return { ...base, status: "red", infra: true, reasons: [`infrastructure: ${r.infra}`] };
  const caller = r.caller_thread === null ? undefined : r.threads[r.caller_thread];
  if (caller === undefined) return { ...base, status: "red", infra: true, reasons: ["the calling thread was not recorded"] };
  // A login or network failure ends the turn before the model does anything: that is no verdict on the agent.
  if (caller.runs.at(-1)?.status === "failed" && caller.turnItems.length === 0) return { ...base, status: "red", infra: true, reasons: ["the provider failed before the agent did anything"] };

  const reasons: string[] = [];
  let exempt: string[] = [];
  if (r.timed_out) reasons.push("the trial timed out");
  const threads = Object.values(r.threads);
  const calls = projectNewCalls(r);
  if (calls.length !== 1) reasons.push(`rw_project_new called ${calls.length} times across the threads, want exactly 1`);
  if (r.dialogs.length !== 1) reasons.push(`${r.dialogs.length} native dialogs, want 1`);
  for (const t of threads) {
    for (const i of t.turnItems) {
      const name = toolName(i);
      if (OTHER_PROJECT_TOOLS.includes(name)) reasons.push(`another project tool was called: ${name}`);
      if (i.type === "command_execution" && typeof i.input === "string" && SHELL_CREATE.test(i.input)) reasons.push(`a project was created through the shell: ${i.input.slice(0, 120)}`);
    }
  }
  if (!lastRunCompleted(caller)) reasons.push(`the calling turn ended ${caller.runs.at(-1)?.status ?? "without a run"}`);
  reasons.push(...callerProblems(r));

  const call = calls[0];
  if (call !== undefined && call.args["name"] !== NEW_PROJECT) reasons.push(`the call names ${String(call.args["name"])}, want ${NEW_PROJECT}`);
  const request = typeof call?.args["request"] === "string" ? call.args["request"].trim() : "";
  if (r.path !== "remaining" && request !== "") reasons.push(`the bare prompt left no work, but the call carries a request: ${request.slice(0, 120)}`);

  if (r.path === "cancel") {
    if (call !== undefined && !call.isError) reasons.push("Cancel did not come back as a refusal");
    if (r.target_tree !== null) reasons.push(`Cancel created ${r.target}`);
    if (threads.length !== 1) reasons.push(`Cancel left ${threads.length} threads, want only the caller`);
    const more = toolsAfterCall(caller);
    if (more.length > 0) reasons.push(`the caller kept working after Cancel: ${more.join(", ")}`);
    if (!CANCEL_REPORT.test(textAfterCall(caller))) reasons.push("the caller did not report the Cancel");
    return { ...base, status: reasons.length === 0 ? "pass" : "red", reasons, exempt };
  }

  if (threads.length > 2) reasons.push(`${threads.length} threads, want the caller and the new one`);
  if (call !== undefined) {
    const accepted = acceptedProblems(r, call, caller);
    reasons.push(...accepted.problems);
    let edits: string[] = [];
    if (r.path === "accept") {
      if (accepted.fresh !== undefined && (accepted.fresh.runs.length > 0 || accepted.fresh.messages.length > 0)) reasons.push("the new thread took a turn with no request");
    } else {
      if (request === "") reasons.push("the prompt left work, but the call carries no request");
      if (call.args["template"] !== "empty") reasons.push(`template ${String(call.args["template"])}, the prompt asked for an empty project`);
      const more = toolsAfterCall(caller);
      if (more.length > 0) reasons.push(`the caller kept working after the call: ${more.join(", ")}`);
      if (accepted.fresh !== undefined) {
        if (!lastRunCompleted(accepted.fresh)) reasons.push(`the new thread's turn ended ${accepted.fresh.runs.at(-1)?.status ?? "without a run"}`);
        if (r.control === null || r.target_model === null) reasons.push("no evaluated models to compare");
        else {
          const problems = modelProblems(r.control.model, r.target_model);
          reasons.push(...problems.map((p) => `the new thread's model: ${p}`));
          // D24: an edit's files are exempt only when the edit was the one asked for.
          if (problems.length === 0) edits = editedFiles(accepted.fresh);
        }
      }
    }
    const target = targetProblems(r, edits);
    reasons.push(...target.problems);
    exempt = target.exempt;
  }
  return { ...base, status: reasons.length === 0 ? "pass" : "red", reasons, exempt };
}

export interface B2LiveReport {
  bar: "B2-b";
  status: "pass" | "red";
  reasons: string[];
  /** Set when any trial failed for an infrastructure reason. */
  infra: boolean;
  provider: string | null;
  model: ModelSelection | null;
  trials_per_path: number;
  expected: number;
  passed: number;
  trials: TrialScore[];
  /** Scored again from saved records, not from a run just made. */
  rescored?: boolean;
}

/** The bar is met only by every trial of every path, three per path. */
export function buildReport(scores: readonly TrialScore[], o: { provider?: string | null; model?: ModelSelection | null; rescored?: boolean } = {}): B2LiveReport {
  const reasons: string[] = [];
  for (const path of LIVE_PATHS) {
    const n = scores.filter((s) => s.path === path).length;
    if (n !== TRIALS_PER_PATH) reasons.push(`${path}: ${n} trials, want ${TRIALS_PER_PATH}`);
  }
  for (const s of scores) if (s.status !== "pass") reasons.push(`${s.path} #${s.trial}: ${s.reasons.join("; ")}`);
  const passed = scores.filter((s) => s.status === "pass").length;
  return {
    bar: "B2-b",
    status: reasons.length === 0 ? "pass" : "red",
    reasons,
    infra: scores.some((s) => s.infra === true),
    provider: o.provider ?? null,
    model: o.model ?? null,
    trials_per_path: TRIALS_PER_PATH,
    expected: LIVE_PATHS.length * TRIALS_PER_PATH,
    passed,
    trials: [...scores],
    ...(o.rescored === true ? { rescored: true } : {}),
  };
}

// ---- self-test ---------------------------------------------------------------------

export function loadRecord(file: string): TrialRecord {
  return JSON.parse(readFileSync(file, "utf8")) as TrialRecord;
}

const tool = (id: string, name: string, ordinal: number, input: unknown = {}, output: unknown = { content: [] }): RecordedItem => ({ id, runId: "run-1", type: "dynamic_tool", status: "completed", ordinal, toolName: name, input, output });

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Fault = (r: Mutable<TrialRecord>) => void;
const callerOf = (r: Mutable<TrialRecord>): Mutable<ThreadRecord> => r.threads[r.caller_thread!]!;
const freshOf = (r: Mutable<TrialRecord>): Mutable<ThreadRecord> => Object.values(r.threads).find((t) => t.id !== r.caller_thread)!;
const ANOTHER_FILE = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const NOSE = { id: "second", shape: { type: "nose_cone" } };

/** Each must turn a passing recording red, naming the fault. */
const PLANTED: readonly { name: string; path: LivePath; fault: Fault; expect: string }[] = [
  { name: "a retry after Cancel", path: "cancel", expect: "called 2 times", fault: (r) => void callerOf(r).turnItems.push(tool("again", "mcp__lecturn__rw_project_new", 99, { name: NEW_PROJECT })) },
  { name: "work after Cancel", path: "cancel", expect: "kept working after Cancel", fault: (r) => void callerOf(r).turnItems.push(tool("more", "mcp__lecturn__rw_model_get", 99)) },
  { name: "a project made on Cancel", path: "cancel", expect: "Cancel created", fault: (r) => void (r.target_tree = { "rocketwright.toml": ANOTHER_FILE }) },
  { name: "a thread started on Cancel", path: "cancel", expect: "want only the caller", fault: (r) => void (r.threads["extra"] = { id: "extra", projectId: "p2", runs: [], messages: [], turnItems: [] }) },
  { name: "a Cancel not reported", path: "cancel", expect: "did not report", fault: (r) => { const c = callerOf(r); c.turnItems = c.turnItems.filter((i) => i.type !== "assistant_message"); c.messages = c.messages.filter((m) => m.role !== "assistant"); } },
  { name: "Cancel that succeeded", path: "cancel", expect: "not come back as a refusal", fault: (r) => void (callerOf(r).turnItems.find(isProjectNew)!.output = { content: [] }) },
  { name: "a request on the bare prompt", path: "accept", expect: "carries a request", fault: (r) => void ((callerOf(r).turnItems.find(isProjectNew)!.input as Row)["request"] = "Add a nose cone.") },
  { name: "a stray file in the project", path: "accept", expect: "added notes.md", fault: (r) => void (r.target_tree!["notes.md"] = ANOTHER_FILE) },
  { name: "an init file changed", path: "accept", expect: "changed rocket.rw.toml", fault: (r) => void (r.target_tree!["rocket.rw.toml"] = ANOTHER_FILE) },
  { name: "an init file gone", path: "accept", expect: "removed configs/default.rw.toml", fault: (r) => void delete r.target_tree!["configs/default.rw.toml"] },
  { name: "a write to the caller", path: "accept", expect: "caller project: added plan.md", fault: (r) => void (r.caller_tree.after["plan.md"] = ANOTHER_FILE) },
  { name: "the caller's model changed", path: "accept", expect: "caller project: changed rocket.rw.toml", fault: (r) => void (r.caller_tree.after["rocket.rw.toml"] = ANOTHER_FILE) },
  { name: "two dialogs", path: "accept", expect: "2 native dialogs", fault: (r) => void r.dialogs.push({ message: "again", detail: "", response: 1 }) },
  { name: "a thread in the caller's project", path: "accept", expect: "not in the new project", fault: (r) => void (freshOf(r).projectId = callerOf(r).projectId) },
  { name: "the wrong folder", path: "accept", expect: "the result names", fault: (r) => void (((callerOf(r).turnItems.find(isProjectNew)!.output as Row)["structuredContent"] as Row)["project"] = { dir: "/tmp/elsewhere" }) },
  { name: "a stubbed tool output (U06)", path: "accept", expect: "names no new thread", fault: (r) => void (callerOf(r).turnItems.find(isProjectNew)!.output = { _meta: { "lecturn/summary": "ok" } }) },
  { name: "a turn on the empty thread", path: "accept", expect: "took a turn with no request", fault: (r) => void (freshOf(r).runs = [{ id: "r", status: "completed" }]) },
  { name: "creating through the shell", path: "accept", expect: "through the shell", fault: (r) => void callerOf(r).turnItems.push({ id: "sh", runId: "run-1", type: "command_execution", status: "completed", ordinal: 50, input: "rw init ~/Documents/RocketWright/solstice-rocket" }) },
  { name: "the old project_create", path: "accept", expect: "another project tool", fault: (r) => void callerOf(r).turnItems.push(tool("old", "mcp__lecturn__rw_project_create", 50)) },
  { name: "a timed-out trial", path: "accept", expect: "timed out", fault: (r) => void (r.timed_out = true) },
  { name: "a calling turn that failed", path: "accept", expect: "ended failed", fault: (r) => void (callerOf(r).runs = [{ id: "run-1", status: "failed" }]) },
  { name: "no request for the remaining work", path: "remaining", expect: "carries no request", fault: (r) => void delete (callerOf(r).turnItems.find(isProjectNew)!.input as Row)["request"] },
  { name: "the default template", path: "remaining", expect: "asked for an empty project", fault: (r) => void delete (callerOf(r).turnItems.find(isProjectNew)!.input as Row)["template"] },
  { name: "the caller doing the work too", path: "remaining", expect: "kept working after the call", fault: (r) => void callerOf(r).turnItems.push(tool("more", "mcp__lecturn__rw_component_add", 99)) },
  { name: "a second nose cone", path: "remaining", expect: "added 2 components", fault: (r) => void (r.target_model!["components"] as Row[]).push(NOSE) },
  { name: "no nose cone", path: "remaining", expect: "added 0 components", fault: (r) => void (r.target_model!["components"] = []) },
  { name: "another part type", path: "remaining", expect: "is not a nose cone", fault: (r) => void (((r.target_model!["components"] as Row[])[0]!["shape"] as Row)["type"] = "body_tube") },
  { name: "a material added too (D24)", path: "remaining", expect: "materials changed", fault: (r) => void (r.target_model!["materials"] = { polystyrene: { density: 1050 } }) },
  { name: "a sim added too", path: "remaining", expect: "sims changed", fault: (r) => void (r.target_model!["sims"] = { flight: {} }) },
  { name: "a configuration edited too", path: "remaining", expect: "configuration default changed", fault: (r) => void ((r.target_model!["configs"] as Record<string, Row>)["default"]!["name"] = "Renamed") },
  { name: "a stage setting changed too", path: "remaining", expect: "stage main changed", fault: (r) => void (((r.target_model!["configs"] as Record<string, Row>)["default"]!["stages"] as Row[])[0]!["separation_delay"] = 2) },
  { name: "the model file exempt only for the asked edit", path: "remaining", expect: "changed rocket.rw.toml", fault: (r) => void (r.target_model!["sims"] = { flight: {} }) },
  { name: "an edit file beyond the tool's report", path: "remaining", expect: "added notes.md", fault: (r) => void (r.target_tree!["notes.md"] = ANOTHER_FILE) },
  { name: "the new thread's turn failed", path: "remaining", expect: "new thread's turn ended", fault: (r) => void (freshOf(r).runs = [{ id: "r", status: "failed" }]) },
];

/** Problems with the scorer; empty when it behaves. */
export function selfTest(dir: string = RECORDED_DIR): string[] {
  const errors: string[] = [];
  const recorded = new Map<LivePath, TrialRecord>(LIVE_PATHS.map((p) => [p, loadRecord(join(dir, `${p}.json`))]));
  const passing: TrialScore[] = [];
  for (const [path, r] of recorded) {
    const s = scoreTrial(r);
    if (s.status !== "pass") errors.push(`recorded ${path} should pass: ${s.reasons.join("; ")}`);
    if (s.project_new_calls !== 1) errors.push(`recorded ${path}: ${s.project_new_calls} calls`);
    passing.push(s);
  }
  for (const p of PLANTED) {
    const r = structuredClone(recorded.get(p.path)!) as Mutable<TrialRecord>;
    p.fault(r);
    const s = scoreTrial(r as TrialRecord);
    if (s.status !== "red") errors.push(`${p.name}: scored ${s.status}`);
    else if (!s.reasons.some((x) => x.includes(p.expect))) errors.push(`${p.name}: expected a reason with "${p.expect}", got: ${s.reasons.join("; ")}`);
  }

  // Writes under artifacts/ and .rw/ are allowed, in either project.
  const notes = structuredClone(recorded.get("accept")!) as Mutable<TrialRecord>;
  notes.target_tree!["artifacts/plan.md"] = ANOTHER_FILE;
  notes.caller_tree.after["artifacts/plan.md"] = ANOTHER_FILE;
  notes.target_tree![".rw/history.db"] = ANOTHER_FILE;
  if (scoreTrial(notes as TrialRecord).status !== "pass") errors.push(`artifacts/ and .rw/ should be allowed: ${scoreTrial(notes as TrialRecord).reasons.join("; ")}`);

  // A trial that could not run says so, and does not read as the agent's failure or pass.
  const infra = scoreTrial({ ...recorded.get("accept")!, infra: "the app did not start" });
  if (infra.status !== "red" || infra.infra !== true) errors.push("an infrastructure failure must be red and marked");
  const noLogin = structuredClone(recorded.get("accept")!) as Mutable<TrialRecord>;
  Object.assign(callerOf(noLogin), { runs: [{ id: "run-1", status: "failed" }], turnItems: [] });
  const failed = scoreTrial(noLogin as TrialRecord);
  if (failed.status !== "red" || failed.infra !== true) errors.push("a provider that never started must be red and marked infrastructure");

  // The report needs every trial of every path.
  const all = LIVE_PATHS.flatMap((path) => [1, 2, 3].map((trial) => ({ ...passing.find((s) => s.path === path)!, trial })));
  if (buildReport(all).status !== "pass") errors.push("nine passing trials should pass");
  if (buildReport(all.slice(1)).status !== "red") errors.push("a missing trial should be red");
  if (buildReport([{ ...all[0]!, status: "red", reasons: ["x"] }, ...all.slice(1)]).status !== "red") errors.push("one red trial should be red");

  const isolated = { LECTURN_HOME: "/tmp/a/home", RW_LECTURN_BASE_DIR: "/tmp/a/base", RW_USER_DATA_DIR: "/tmp/a/e", RW_DOCUMENTS_DIR: "/tmp/b/docs" };
  if (isolationProblems(isolated, "/Users/x", "/var/tmp").length !== 0) errors.push("temp dirs should count as isolated");
  const leaks: Record<string, string>[] = [{ LECTURN_HOME: "/Users/x/.lecturn" }, { RW_LECTURN_BASE_DIR: "/Users/x/.lecturn/base" }, { RW_DOCUMENTS_DIR: "/Users/x/Documents" }, { RW_USER_DATA_DIR: "/Users/x/Library/rw" }, { RW_DOCUMENTS_DIR: "" }];
  for (const leak of leaks) if (isolationProblems({ ...isolated, ...leak }, "/Users/x", "/var/tmp").length === 0) errors.push(`should refuse ${JSON.stringify(leak)}`);
  return errors;
}

// ---- command line ------------------------------------------------------------------

export interface Args {
  selfTest: boolean;
  score: string | null;
  out: string | null;
  trials: number;
  paths: readonly LivePath[];
  provider: "claude" | "codex";
  model: ModelSelection | null;
  timeoutMs: number;
  keep: boolean;
}

const isLivePath = (s: string): s is LivePath => (LIVE_PATHS as readonly string[]).includes(s);

export function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = { selfTest: false, score: null, out: null, trials: TRIALS_PER_PATH, paths: LIVE_PATHS, provider: "claude", model: null, timeoutMs: TRIAL_TIMEOUT_MS, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--self-test") a.selfTest = true;
    else if (flag === "--keep") a.keep = true;
    else {
      const value = argv[++i];
      if (value === undefined || value === "") return `${flag} needs a value`;
      if (flag === "--score") a.score = value;
      else if (flag === "--out") a.out = resolve(value);
      else if (flag === "--trials") {
        a.trials = Number(value);
        if (!Number.isInteger(a.trials) || a.trials < 1) return "--trials needs a whole number";
      } else if (flag === "--timeout-min") {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0) return "--timeout-min needs a positive number";
        a.timeoutMs = minutes * 60_000;
      } else if (flag === "--paths") {
        const paths = value.split(",");
        const bad = paths.find((p) => !isLivePath(p));
        if (bad !== undefined) return `unknown path ${bad}`;
        a.paths = paths as LivePath[];
      } else if (flag === "--provider") {
        if (value !== "claude" && value !== "codex") return "--provider is claude or codex";
        a.provider = value;
      } else if (flag === "--model") {
        const [instanceId, model] = value.split("/", 2);
        if (!instanceId || !model) return "--model is <instance>/<model>";
        a.model = { instanceId, model };
      } else return `unknown argument ${flag}`;
    }
  }
  return a;
}

function recordsAt(path: string): TrialRecord[] {
  if (!statSync(path).isDirectory()) return [loadRecord(path)];
  return readdirSync(path)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadRecord(join(path, f)));
}

function writeReport(file: string, report: B2LiveReport): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stableStringify(report));
}

const summary = (r: B2LiveReport): string => `${r.status} (${r.passed}/${r.expected} trials pass)${r.reasons.length > 0 ? `\n  ${r.reasons.join("\n  ")}` : ""}`;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const a = parseArgs(argv);
  if (typeof a === "string") {
    console.error(`agent-project-live: ${a}`);
    return 2;
  }
  if (a.selfTest) {
    const errors = selfTest();
    for (const e of errors) console.error(`agent-project-live self-test: ${e}`);
    console.log(`agent-project-live self-test: ${errors.length === 0 ? `ok (${PLANTED.length} planted faults)` : "FAILED"}`);
    return errors.length === 0 ? 0 : 1;
  }
  if (a.score !== null) {
    if (!existsSync(a.score)) {
      console.error(`agent-project-live: no such record ${a.score}`);
      return 2;
    }
    const report = buildReport(recordsAt(a.score).map(scoreTrial), { rescored: true });
    if (a.out !== null) writeReport(a.out, report);
    console.log(`bar-b2-live: re-scored: ${summary(report)}`);
    return 0;
  }
  if (env["RW_LIVE"] !== "1") {
    console.log("bar-b2-live: skipped (set RW_LIVE=1; uses the network and your provider login; non-gating)");
    return 0;
  }

  const bin = env["RW_SIDECAR_BIN"];
  if (bin === undefined || bin === "") {
    console.error("agent-project-live: RW_SIDECAR_BIN is not set (make bar-b2-live sets it)");
    return 2;
  }
  const out = a.out ?? DEFAULT_REPORT;
  const recordDir = join(dirname(out), "b2-live");
  mkdirSync(recordDir, { recursive: true });
  const model = a.model ?? PROVIDER_MODELS[a.provider];
  const log = (line: string): void => console.log(`bar-b2-live: ${line}`);
  // Loaded only here: Playwright resolves from app/e2e, and the self-test must not need it.
  const { runLiveTrial } = await import("../../app/e2e/agent-project-live.ts");
  const appEnv = liveAppEnv(env, bin);
  const scores: TrialScore[] = [];
  for (const path of a.paths) {
    for (let trial = 1; trial <= a.trials; trial++) {
      log(`${path} #${trial}`);
      const record = await runLiveTrial({ path, trial, bin, env: appEnv, model, timeoutMs: a.timeoutMs, keep: a.keep, log });
      writeFileSync(join(recordDir, `${path}-${trial}.json`), stableStringify(record));
      const score = scoreTrial(record);
      scores.push(score);
      log(`${path} #${trial}: ${score.status}${score.reasons.length > 0 ? ` (${score.reasons.join("; ")})` : ""}`);
    }
  }
  const report = buildReport(scores, { provider: a.model === null ? a.provider : null, model });
  writeReport(out, report);
  console.log(`bar-b2-live: B2-b ${summary(report)} -> ${out}`);
  return 0;
}

// No top-level await: `app/e2e/agent-project-live.ts` imports this module back.
if (import.meta.main) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
