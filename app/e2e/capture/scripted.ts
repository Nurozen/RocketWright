/**
 * Live visual scenarios for the embedded pane (plan B13, spec W5.1): what an
 * imported bundle cannot show (settled history has no running card, no
 * pending approval and no composer chip) is staged with Lecturn's test-only
 * `scripted` provider (`LECTURN_TEST_PROVIDERS=1`, Lecturn A16) in the
 * imported thread.
 *
 * A scenario (`app/e2e/fixtures/scripted/<name>.json`) names the thread
 * (by its D30 title), the user message, the D22 script (`toolCall`,
 * `assistantText`, `saveAs`, `${name.path}`, `poll`, `hold`,
 * `expectApproval`), how many app approvals the harness answers Approve
 * (in order; the next one stays pending), the MCP Apps cards the turn's
 * completed calls draw (`cards`, in call order; the script's last call is
 * the one left pending) and the mention the host inserts afterwards.
 *
 * The page's checklist composition has to be in view in the pane without
 * scrolling (CPW1R3A): one tool row per call (no `poll`: each try is a row,
 * and the run card follows its job itself), one card per card tool, and a
 * height budget (`pane-budget.ts`) the scenario's turn fits.
 *
 * The harness (`runScenario`) acts as the user through an admin session
 * (`lecturn auth session issue --base-dir`, plan "Admin session for
 * harnesses"): it sets the thread to Supervised (`approval-required`) and
 * the scripted model, writes the script into the scripts file
 * (`LECTURN_SCRIPTED_PROVIDER_SCRIPTS`) under the turn's run ordinal, sends
 * the user message, then follows the thread's projection, approving the
 * first `approve` app approvals (`runtime-request.respond`), until one more
 * app approval is pending. A turn that ends early fails the scenario.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { lecturnRpc, readServerOrigin } from "../../apps/server/src/lecturn/appsRpc.ts";
import { REPO_ROOT } from "../bar/paths.ts";

export const SCENARIO_DIR = join(REPO_ROOT, "app/e2e/fixtures/scripted");
/** Lecturn's scripted model (`BAR_APP_MODEL`). */
export const SCRIPTED_MODEL = { instanceId: "scripted", model: "scripted" } as const;
/** Settings that enable the scripted provider instance (`<baseDir>/userdata/settings.json`, Lecturn `BAR_APP_SETTINGS`). */
export const SCRIPTED_SETTINGS = { providerInstances: { scripted: { driver: "scripted", enabled: true } } } as const;
const ADMIN_SCOPES = ["access:read", "access:write", "orchestration:read", "orchestration:operate"] as const;

export interface ScriptToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Lecturn's D22 step grammar (`scriptedScript.ts`). */
export type ScriptStep =
  | { toolCall: ScriptToolCall; saveAs?: string }
  | { assistantText: string }
  | { expectApproval: true }
  | { poll: { toolCall: ScriptToolCall; until: { path: string; equals: unknown }; maxTries?: number; intervalMs?: number }; saveAs?: string }
  | { hold: true | { until: string } };

/**
 * The MCP Apps card a completed call draws (`crates/rw-cli/src/mcp/resources.rs`
 * `UI_CARDS`): a run card (flight, engine, or a visual flow study's view
 * form), a step card, a render card.
 */
export type CardKind = "flight" | "engine" | "visual" | "step" | "render";
export const CARD_KINDS: readonly CardKind[] = ["flight", "engine", "visual", "step", "render"];
type CardFamily = "run" | "step" | "render";
const FAMILY: Record<CardKind, CardFamily> = { flight: "run", engine: "run", visual: "run", step: "step", render: "render" };
/** The card each card tool's result renders in (bare tool names; `UI_CARDS`). */
export const TOOL_CARDS: Readonly<Record<string, CardFamily>> = {
  simulate: "run",
  engine_simulate: "run",
  job_status: "run",
  run_diff: "run",
  component_add: "step",
  component_remove: "step",
  model_patch: "step",
  import_file: "step",
  history_restore: "step",
  history_show: "step",
  render: "render",
  history_compare: "render",
};
/** A tool's bare name (`rw_simulate`, `mcp__lecturn__rw_simulate`, the scripted provider's `lecturn.rw_simulate` → `simulate`). */
export const bareTool = (name: string): string => name.replace(/^(?:mcp__lecturn__|lecturn\.)/, "").replace(/^rw_/, "");

export interface VisualScenario {
  description: string;
  /** The bundle thread (D30 title) the turn runs in. */
  thread: string;
  runtimeMode: "approval-required";
  user: string;
  script: ScriptStep[];
  /** App approvals the harness approves, in order; the next one is left pending. */
  approve: number;
  /** The cards the turn's completed calls draw, in call order (each card tool's one card). */
  cards: CardKind[];
  /** What the host inserts once the turn parks on its approval (`insertMention`). */
  mention: { ref: string; label: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAVE_NAME = /^[A-Za-z_][\w-]*$/;

function toolCallProblems(v: unknown, at: string): string[] {
  if (!isObject(v)) return [`${at}: toolCall must be an object`];
  const out: string[] = [];
  if (typeof v["name"] !== "string" || v["name"] === "") out.push(`${at}: toolCall.name`);
  if (v["arguments"] !== undefined && !isObject(v["arguments"])) out.push(`${at}: toolCall.arguments must be an object`);
  for (const k of Object.keys(v)) if (k !== "name" && k !== "arguments") out.push(`${at}: unknown toolCall key ${k}`);
  return out;
}

/** Problems with a D22 script (the grammar Lecturn decodes; empty when valid). */
export function scriptProblems(script: unknown): string[] {
  if (!Array.isArray(script) || script.length === 0) return ["script: a non-empty array of steps"];
  return script.flatMap((step: unknown, i): string[] => {
    const at = `script[${i}]`;
    if (!isObject(step)) return [`${at}: not an object`];
    const keys = Object.keys(step).sort().join(",");
    const saveAs = step["saveAs"] === undefined || (typeof step["saveAs"] === "string" && SAVE_NAME.test(step["saveAs"])) ? [] : [`${at}: saveAs must match ${SAVE_NAME}`];
    if ("toolCall" in step) return keys === "toolCall" || keys === "saveAs,toolCall" ? [...toolCallProblems(step["toolCall"], at), ...saveAs] : [`${at}: toolCall takes only saveAs beside it`];
    if ("assistantText" in step) return keys === "assistantText" && typeof step["assistantText"] === "string" ? [] : [`${at}: assistantText must be a lone string`];
    if ("expectApproval" in step) return keys === "expectApproval" && step["expectApproval"] === true ? [] : [`${at}: expectApproval must be true`];
    if ("hold" in step) {
      const h = step["hold"];
      return keys === "hold" && (h === true || (isObject(h) && typeof h["until"] === "string")) ? [] : [`${at}: hold is true or {until: path}`];
    }
    if ("poll" in step) {
      const p = step["poll"];
      if (keys !== "poll" && keys !== "poll,saveAs") return [`${at}: poll takes only saveAs beside it`];
      if (!isObject(p)) return [`${at}: poll must be an object`];
      const out = [...toolCallProblems(p["toolCall"], `${at}.poll`), ...saveAs];
      const until = p["until"];
      if (!isObject(until) || typeof until["path"] !== "string" || !("equals" in until)) out.push(`${at}: poll.until is {path, equals}`);
      const tries = p["maxTries"];
      if (tries !== undefined && !(Number.isInteger(tries) && (tries as number) >= 1 && (tries as number) <= 1000)) out.push(`${at}: poll.maxTries in 1..1000`);
      const interval = p["intervalMs"];
      if (interval !== undefined && !(Number.isInteger(interval) && (interval as number) >= 0 && (interval as number) <= 60_000)) out.push(`${at}: poll.intervalMs in 0..60000`);
      return out;
    }
    return [`${at}: unknown step (${keys})`];
  });
}

/** Problems with a scenario file (empty when valid). */
export function scenarioProblems(v: unknown): string[] {
  if (!isObject(v)) return ["not an object"];
  const out: string[] = [];
  for (const k of ["description", "thread", "user"]) if (typeof v[k] !== "string" || v[k] === "") out.push(`${k}: a non-empty string`);
  if (v["runtimeMode"] !== "approval-required") out.push("runtimeMode: approval-required (Supervised)");
  if (!Number.isInteger(v["approve"]) || (v["approve"] as number) < 0) out.push("approve: a count ≥ 0");
  const cards = v["cards"];
  if (!Array.isArray(cards) || cards.length === 0 || !cards.every((c) => (CARD_KINDS as readonly unknown[]).includes(c))) out.push(`cards: a non-empty list of ${CARD_KINDS.join(", ")}`);
  const m = v["mention"];
  if (!isObject(m) || typeof m["ref"] !== "string" || !m["ref"].startsWith("rw:") || typeof m["label"] !== "string") out.push("mention: {ref: rw:…, label}");
  out.push(...scriptProblems(v["script"]));
  // The harness leaves exactly one approval pending: the script must raise more than it approves.
  const steps = Array.isArray(v["script"]) ? (v["script"] as unknown[]) : [];
  const expected = steps.filter((s) => isObject(s) && "expectApproval" in s).length;
  if (Number.isInteger(v["approve"]) && expected !== v["approve"]) out.push(`approve (${String(v["approve"])}) must equal the script's expectApproval steps (${expected})`);
  out.push(...compositionProblems(steps, Array.isArray(cards) ? (cards as CardKind[]) : []));
  return out;
}

/**
 * The pane composition rules (CPW1R3A): no `poll` (each try renders its own
 * tool row and card), the script ends on the call left pending, and every
 * other card tool's card is the next entry of `cards`, in order.
 */
function compositionProblems(steps: readonly unknown[], cards: readonly CardKind[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    if (isObject(s) && "poll" in s) out.push(`script[${i}]: poll renders one tool row (and card) per try; let the run card follow its job`);
  });
  const calls = steps.flatMap((s): string[] => (isObject(s) && isObject(s["toolCall"]) && typeof s["toolCall"]["name"] === "string" ? [s["toolCall"]["name"]] : []));
  const last = steps.at(-1);
  if (!(isObject(last) && "toolCall" in last)) out.push("script: ends with the call the harness leaves pending (a toolCall)");
  const drawn = calls.slice(0, -1).flatMap((n) => {
    const family = TOOL_CARDS[bareTool(n)];
    return family === undefined ? [] : [{ tool: n, family }];
  });
  if (drawn.length !== cards.length) out.push(`cards: the script's completed card tools draw ${drawn.length} cards (${drawn.map((d) => d.tool).join(", ")}), cards lists ${cards.length}`);
  drawn.forEach((d, i) => {
    const want = cards[i];
    if (want !== undefined && FAMILY[want] !== d.family) out.push(`cards[${i}]: ${d.tool} draws a ${d.family} card, not ${want}`);
  });
  return out;
}

export function loadScenario(name: string, dir = SCENARIO_DIR): VisualScenario {
  const v: unknown = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  const problems = scenarioProblems(v);
  if (problems.length > 0) throw new Error(`scripted/${name}.json:\n  ${problems.join("\n  ")}`);
  return v as VisualScenario;
}

// ---- the admin side ---------------------------------------------------------

/** The thread projection slice the harness reads (Lecturn `OrchestrationV2ThreadProjection`). */
export interface ProjectionLike {
  runs: { id: string; ordinal?: number; status: string }[];
  runtimeRequests: { id: string; status: string; connectedAppTool?: unknown }[];
  turnItems: { id: string; type: string; toolName?: string | null; status: string }[];
  messages: { role: string; text: string }[];
}

const ENDED_EARLY = new Set(["interrupted", "failed", "cancelled", "rolled_back"]);

export type ScenarioStep = { kind: "wait" } | { kind: "approve"; requestId: string } | { kind: "settled"; requestId: string } | { kind: "failed"; reason: string };

/**
 * What the harness does next, given the thread's projection and the
 * requests it already approved: approve the oldest pending app approval
 * while fewer than `approve` were approved, report `settled` once one more
 * is pending, fail when a run ended early.
 */
export function nextStep(p: ProjectionLike, approved: readonly string[], approve: number, ignoredRuns: ReadonlySet<string> = new Set()): ScenarioStep {
  const ended = p.runs.find((r) => !ignoredRuns.has(r.id) && ENDED_EARLY.has(r.status));
  if (ended !== undefined) return { kind: "failed", reason: `the scripted turn ended ${ended.status}` };
  const pending = p.runtimeRequests.filter((r) => r.status === "pending" && r.connectedAppTool !== undefined && !approved.includes(r.id));
  const first = pending[0];
  if (first === undefined) {
    const done = p.runs.find((r) => !ignoredRuns.has(r.id) && r.status === "completed");
    return done === undefined ? { kind: "wait" } : { kind: "failed", reason: "the scripted turn completed without leaving an approval pending" };
  }
  return approved.length < approve ? { kind: "approve", requestId: first.id } : { kind: "settled", requestId: first.id };
}

/** The scripts file entry for the thread's next turn (Lecturn keys it by run ordinal). */
export function scriptsFor(p: Pick<ProjectionLike, "runs">, script: ScriptStep[]): Record<string, ScriptStep[]> {
  const next = Math.max(p.runs.length, ...p.runs.map((r) => r.ordinal ?? 0)) + 1;
  return { [String(next)]: script };
}

/** `lecturn/dist/bin.mjs` of the vendored install. */
export function lecturnBin(): string {
  return createRequire(import.meta.url).resolve("lecturn/dist/bin.mjs");
}

/** A Node to run the Lecturn CLI with: `RW_NODE`, else this process (Electron as Node inside Electron main). */
function nodeCommand(env: NodeJS.ProcessEnv): { file: string; env: NodeJS.ProcessEnv } {
  const clean: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
  delete clean["LECTURN_HOME"];
  if (env["RW_NODE"]) return { file: env["RW_NODE"], env: clean };
  return { file: process.execPath, env: process.versions.electron === undefined ? clean : { ...clean, ELECTRON_RUN_AS_NODE: "1" } };
}

/** An admin bearer for the Lecturn server in `baseDir` (`auth session issue --token-only`). */
export async function issueAdminToken(baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const node = nodeCommand(env);
  const args = [lecturnBin(), "auth", "session", "issue", "--base-dir", baseDir, "--token-only", "--label", "rw-bar-scenario", ...ADMIN_SCOPES.flatMap((s) => ["--scope", s])];
  const { stdout } = await promisify(execFile)(node.file, args, { env: node.env, timeout: 60_000 });
  const token = stdout.trim().split(/\s+/).at(-1);
  if (!token) throw new Error("lecturn auth session issue printed no token");
  return token;
}

/**
 * A one-time browser pairing URL (`<origin>/pair#token=…`) for the Lecturn
 * server in `baseDir` (`auth pairing create --json --base-url`), with the
 * standard client scopes: what the user's own Lecturn web client pairs with.
 * Single use; never logged.
 */
export async function issuePairingUrl(baseDir: string, origin: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const node = nodeCommand(env);
  const args = [lecturnBin(), "auth", "pairing", "create", "--base-dir", baseDir, "--base-url", origin, "--label", "rw-bar-web-client", "--json"];
  const { stdout } = await promisify(execFile)(node.file, args, { env: node.env, timeout: 60_000 });
  const json = stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  const url = (JSON.parse(json) as { pairUrl?: unknown }).pairUrl;
  if (typeof url !== "string") throw new Error("lecturn auth pairing create printed no pairUrl");
  return url;
}

/** The orchestration calls the harness makes as the user. */
export class LecturnAdmin {
  readonly origin: string;
  protected readonly token: string;

  constructor(origin: string, token: string) {
    this.origin = origin;
    this.token = token;
  }

  static async open(baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<LecturnAdmin> {
    const origin = readServerOrigin(baseDir);
    if (origin === null) throw new Error(`no Lecturn server runs in ${baseDir}`);
    return new LecturnAdmin(origin, await issueAdminToken(baseDir, env));
  }

  /** One RPC call with the admin bearer (B16 `scripts/bar/lecturn-admin.ts` adds the Settings calls on it). */
  call(tag: string, payload: unknown): Promise<unknown> {
    return lecturnRpc(this.origin, this.token, tag, payload);
  }

  dispatch(command: Record<string, unknown>): Promise<unknown> {
    return this.call("orchestration.dispatchCommand", { commandId: `rw-bar:${randomUUID()}`, ...command });
  }

  async projection(threadId: string): Promise<ProjectionLike> {
    return (await lecturnRpc(this.origin, this.token, "orchestration.getThreadProjection", { threadId })) as ProjectionLike;
  }
}

export interface ScenarioRun {
  threadId: string;
  /** The app approvals the harness approved, then the one left pending. */
  approved: string[];
  pending: string;
  tools: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `scenario` in `threadId` until its last app approval is pending (see the module comment). */
export async function runScenario(o: { admin: LecturnAdmin; threadId: string; scenario: VisualScenario; scriptsFile: string; timeoutMs?: number; log?: (line: string) => void }): Promise<ScenarioRun> {
  const { admin, threadId, scenario } = o;
  const before = await admin.projection(threadId);
  const earlier = new Set(before.runs.map((r) => r.id));
  writeFileSync(o.scriptsFile, `${JSON.stringify(scriptsFor(before, scenario.script))}\n`);
  await admin.dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode: scenario.runtimeMode });
  await admin.dispatch({ type: "thread.model-selection.set", threadId, modelSelection: SCRIPTED_MODEL });
  await admin.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    threadId,
    messageId: `rw-bar-${randomUUID()}`,
    text: scenario.user,
    attachments: [],
    modelSelection: SCRIPTED_MODEL,
    dispatchMode: { type: "start_immediately" },
  });
  const approved: string[] = [];
  const deadline = Date.now() + (o.timeoutMs ?? 240_000);
  for (;;) {
    const p = await admin.projection(threadId);
    const step = nextStep(p, approved, scenario.approve, earlier);
    if (step.kind === "failed") throw new Error(`scenario ${scenario.thread}: ${step.reason}`);
    if (step.kind === "settled") {
      const tools = p.turnItems.filter((i) => i.type === "dynamic_tool").map((i) => `${i.toolName ?? "?"} ${i.status}`);
      return { threadId, approved, pending: step.requestId, tools };
    }
    if (step.kind === "approve") {
      o.log?.(`scenario ${scenario.thread}: approving ${step.requestId}`);
      await admin.dispatch({ type: "runtime-request.respond", threadId, requestId: step.requestId, decision: "accept" });
      approved.push(step.requestId);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`scenario ${scenario.thread}: no app approval pending after ${o.timeoutMs ?? 240_000} ms`);
    await sleep(250);
  }
}
