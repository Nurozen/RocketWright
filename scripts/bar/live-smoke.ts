/**
 * B4(b) live smoke (spec S:198-199, plan M1.18 harness, M5.6 driver):
 * `RW_LIVE=1 make bar-live`. Non-gating until Q2: it uses the network and the
 * user's Claude credentials and never runs under `make check`.
 *
 * Without `RW_LIVE=1` it prints a skip line and writes nothing, so the
 * scoreboard shows B4(b) as `not-run`. With `RW_LIVE=1` it:
 *
 * 1. creates a fresh project with `rocketwright init --template minimum` under
 *    `/tmp` (short `.rw/sidecar.sock` path);
 * 2. starts the real Electron app on it (`app/e2e/b4b-live.ts`: Playwright
 *    `_electron`, the same launch as `b4a.spec.ts`) with the embedded Lecturn
 *    pane, whose agent is the user's installed provider (`--provider`) on
 *    their own login (B16; the old Claude-only engine was removed in B17);
 * 3. sends `B4B_PROMPT` through the pane (`EmbedSession.send`);
 * 4. plays the user for approvals: every gated prompt the pane shows is
 *    decided by `decideApproval` (approve only the tools this scenario needs,
 *    `B4B_APPROVABLE`; reject the rest), answered over Lecturn's admin
 *    session, and recorded;
 * 5. waits for the turn's end in the Lecturn thread (timeout 15 min, then
 *    Stop);
 * 6. reads the runs from the app state (RPC `project.subscribe` snapshot),
 *    picks the Complete run closest to 300 m (`pickRun`), opens the Results
 *    page (the run card's Open if the turn left one, else navigation), finds
 *    its row, and captures the chat pane and the Results page;
 * 7. closes the app and re-reads the run from the project files
 *    (`rocketwright call run_list` recomputes status from the files, I7;
 *    `runs/<sim>/<run>/summary.json` gives the apogee); the two must agree;
 * 8. applies `evaluateB4b` and writes `result.json` beside `transcript.json`,
 *    `tool-calls.json`, `approvals.json`, and the PNGs.
 *
 *   --out-dir <dir>  artifacts (default `<bar out>/live/b4b`); `result.json`
 *                    is also copied to `<bar out>/live/b4b/` for the scoreboard
 *   --out <file>     result path only (M1.18 flag; artifacts go beside it)
 *   --timeout-min n  turn timeout (default 15)
 *   --keep           keep the temp project
 *   --rehearse       no RW_LIVE, no network (B14): the same driver on the
 *                    embedded Lecturn pane, with Lecturn's scripted provider
 *                    replaying `app/e2e/fixtures/scripted/b4b.json` (D22)
 *                    in place of the agent; the
 *                    prompt goes through the pane's bridge and the turn is
 *                    read from the Lecturn thread (`app/e2e/b4b-live.ts`
 *                    `EmbedSession`). Default out `<bar out>/live/b4b-rehearsal`;
 *                    never copied to the scoreboard; the follow-up replays
 *                    `fixtures/scripted/b4b-followup.json`
 *   --provider p     B16: `claude` (CP-W2 step 1, default) or `codex` (step 2):
 *                    the Lecturn model new threads default to
 *                    (`PROVIDER_MODELS`; the provider's CLI must be on PATH
 *                    and logged in)
 *   --model i/m      B16: another Lecturn model selection (`<instance>/<model>`)
 *   --no-follow-up   B16: skip the follow-up below
 *   --no-mention     B16b: skip the mention step below
 *   --attach         B16, W-B2.4 (CP-W2 step 4): the live switch to a user
 *                    Lecturn server, the closed flow (Apps listing, a turn
 *                    from a Lecturn client with RocketWright closed,
 *                    reopen), the read-only fallback after a restart and
 *                    the re-copy ledger (`app/e2e/b4b-attach.ts`);
 *                    scripted turns only, so no RW_LIVE, provider or
 *                    network. Writes `attach-result.json` (default out
 *                    `<bar out>/live/attach`)
 *
 * B16 (W-B2): every thread runs in Supervised. After the B4(b) turn, the
 * follow-up (D14, decision 12) opens a temp copy of
 * `fixtures/research-vehicle` in a second launch and, in one thread: asks
 * for `rw_engine_simulate` of `demo` with no duration (one
 * `connectedAppTool` approval card with the D6 reason, approved; the run
 * completes and the engine run card renders with its thrust chart), then
 * the same call in Full access and in Auto (no card in either), then
 * `simulate mc=500` (`not_implemented`, no card). It lands in
 * `result.follow_up` and `follow-up/follow-up.json`, apart from the B4(b)
 * turn's ≤ 30 calls / ≤ 3 min.
 *
 * B16b (W-B2 step 3, `mention.ts`): before the app closes, the B4(b) thread
 * gets one more turn: `rw:c/fins` inserted from the viewport (the fins'
 * leader label, then its `@`), the span question, the span string from the
 * turn's own `rw_model_get` / `rw_design_check` result in the reply, and a
 * trusted click on the reply's `rw:c/fins` chip that must select the fins
 * (app selection state). `--rehearse` replays
 * `fixtures/scripted/b4b-mention.json` as the thread's run 2. It lands in
 * `result.mention` and `mention/mention.json`, apart from the B4(b) limits.
 *
 * Exit 0 after a run (report mode; the status is in result.json), 2 on bad
 * arguments.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonObject, JsonValue } from "../../app/packages/contracts/src/types.ts";
import type { ProjectInfo, ProjectSnapshot, ServerFrame } from "../../app/packages/contracts/src/rpc.ts";
import type { RunListEntry, RunListOut, RunStatus } from "../../app/packages/contracts/src/generated/types.ts";
import { barOutDir, REPO_ROOT, round, stableStringify } from "../../app/e2e/bar/paths.ts";
import type { CardFrameFacts } from "../../app/e2e/capture/pane-checks.ts";
import type { ApprovalCardView } from "../../app/e2e/embed.ts";
import { RUNTIME_MODE_LABEL, type ApprovalAnswerer, type ApprovalLogEntry, type ModelSelection, type ProviderRequestEntry, type RuntimeMode } from "./lecturn-admin.ts";
import type { ApprovalDecision, ApprovalRequest, TimelineEvent } from "./transcript-events.ts";
import { driveMention, isMentionSession, MENTION_REHEARSAL_FIXTURE, MENTION_TIMEOUT_MS, mentionNotRun, type MentionResult } from "./mention.ts";

/** The live prompt from spec S:198. */
export const B4B_PROMPT =
  "Design a rocket that reaches about 300 m on a C-class motor, check it, simulate it, and show me the results";
export const B4B_TARGET_APOGEE_M = 300;
export const B4B_TOLERANCE = 0.2;
export const B4B_TIMEOUT_MS = 15 * 60_000;
/** W-B2.1 / CP-W2 limits on the B4(b) turn (the follow-up and mention turns are recorded apart). */
export const B4B_MAX_TOOL_CALLS = 30;
export const B4B_MAX_TURN_S = 180;
/**
 * Gated tools this scenario may need, approved when the app asks: `simulate`
 * is conditional (a large Monte Carlo job prompts). Everything else gated
 * (imports, exports, network fetches, CFD) is not part of the scenario and is
 * rejected.
 */
export const B4B_APPROVABLE: readonly string[] = ["simulate"];
/** The project folder (`rw init`); the header shows it. */
export const B4B_PROJECT_NAME = "B4b live";
/** `--rehearse` (B14): Lecturn's scripted provider replays `app/e2e/fixtures/scripted/<this>.json` through the embedded pane (no network, no RW_LIVE). */
export const B4B_REHEARSAL_FIXTURE = "b4b";

/** What the live driver observes at the end of the turn. */
export interface B4bObservation {
  /** Computed run status (`Complete`, `Outdated`, …) of the chosen run, if any. */
  run_status: string | null;
  apogee_m: number | null;
  /** The run is shown on the Results page (04). */
  results_visible: boolean;
  sim?: string | null;
  run_id?: string | null;
}

export interface ApprovalRecord {
  approvalId: string;
  tool: string;
  input: JsonObject;
  reason: string;
  decision: ApprovalDecision;
  /** ms since the prompt was sent. */
  at_ms: number;
}

export interface ToolCallRecord {
  callId: string;
  tool: string;
  input: JsonObject;
  isError: boolean | null;
  output: JsonValue | null;
}

/**
 * The provider's own meta tools (Claude's deferred-tool loader and skills),
 * not RocketWright's. They still count against B4(b)'s ≤ 30 calls (the spec
 * counts tool calls); result.json lists them apart (CPW2A) so a run shows
 * how much of its budget went to loading tools.
 */
export const META_TOOLS: readonly string[] = ["ToolSearch", "Skill"];

/** A turn's record in result.json: every tool call counted, the meta tools also counted apart. */
export interface TurnRecord {
  status: string | null;
  /** All tool calls, meta tools included. */
  tool_calls: number;
  /** Of those, `META_TOOLS` calls (ToolSearch, Skill). */
  meta_tool_calls: number;
  /** The meta tool calls by name (only names that were called). */
  meta_tools: Record<string, number>;
  duration_s: number;
}

/** `TurnRecord` of a transcript (null: no turn). */
export function turnRecord(t: Transcript | null, duration_s: number): TurnRecord {
  const calls = t?.tool_calls ?? [];
  const meta_tools: Record<string, number> = {};
  for (const c of calls) if (META_TOOLS.includes(c.tool)) meta_tools[c.tool] = (meta_tools[c.tool] ?? 0) + 1;
  const meta_tool_calls = Object.values(meta_tools).reduce((a, b) => a + b, 0);
  return { status: t?.turn_status ?? null, tool_calls: calls.length, meta_tool_calls, meta_tools, duration_s };
}

export interface Transcript {
  threadId: string;
  prompt: string;
  turn_status: "complete" | "interrupted" | "error" | null;
  /** Ordered user/assistant/tool/approval/card entries of the prompt's turn. */
  entries: Array<
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string }
    | { kind: "tool_call"; callId: string; tool: string; input: JsonObject }
    | { kind: "tool_result"; callId: string; isError: boolean; output: JsonValue }
    | { kind: "approval"; approvalId: string; tool: string; decision: ApprovalDecision | null }
    | { kind: "result_card"; cardKind: string; ref: string; title: string }
    | { kind: "error"; message: string }
  >;
  tool_calls: ToolCallRecord[];
}

export interface B4bResult {
  status: "pass" | "red" | "not-run";
  reasons: string[];
  prompt: string;
  observation?: B4bObservation;
  /** Set when the run failed for an infrastructure reason (app, login, network), not the agent. */
  infra?: boolean;
  approvals?: ApprovalRecord[];
  turn?: TurnRecord;
  /** Provider approvals (shell commands, file edits) the harness declined during the B4(b) turn. */
  provider_requests?: ProviderRequestEntry[];
  /** The run as the app state and as the project files report it. */
  sources?: { app: B4bObservation | null; files: B4bObservation | null };
  results_via?: string | null;
  /** W-B2.1: the pane's complete flight run card with its chart (null: none rendered); absent when not checked. */
  run_card?: CardFrameFacts | null;
  /** `--rehearse`: driven by the stand-in, not the live agent; never feeds the scoreboard. */
  rehearsal?: boolean;
  /** B16: the Lecturn provider the turns ran on (CP-W2 step 1 Claude, step 2 Codex). */
  provider?: string;
  model?: ModelSelection;
  /** B16: the approval follow-up turn and the mode checks (D14, decision 12); not counted against B4(b)'s limits. */
  follow_up?: FollowUpResult;
  /** B16b: W-B2 step 3, the `rw:c/fins` mention, span question and chip click; not counted against B4(b)'s limits. */
  mention?: MentionResult;
  project?: string;
  artifacts?: string[];
}

/** Applies the B4(b) bar rule (S:199). */
export function evaluateB4b(o: B4bObservation): B4bResult {
  const reasons: string[] = [];
  if (o.run_status !== "Complete") reasons.push(`run status ${o.run_status ?? "absent"}, want Complete`);
  if (o.apogee_m === null || !Number.isFinite(o.apogee_m)) {
    reasons.push("no apogee");
  } else {
    const off = Math.abs(o.apogee_m - B4B_TARGET_APOGEE_M) / B4B_TARGET_APOGEE_M;
    if (off > B4B_TOLERANCE) {
      reasons.push(`apogee ${round(o.apogee_m, 1)} m is ${round(off * 100, 1)}% from ${B4B_TARGET_APOGEE_M} m (max ${B4B_TOLERANCE * 100}%)`);
    }
  }
  if (!o.results_visible) reasons.push("run not visible on the Results page");
  return { status: reasons.length === 0 ? "pass" : "red", reasons, prompt: B4B_PROMPT, observation: o };
}

export function defaultResultPath(): string {
  return join(barOutDir(), "live/b4b/result.json");
}

// ---- pure pieces (unit-tested offline) -------------------------------------------

/** The driver's answer to a gated prompt: approve only what the scenario needs. */
export function decideApproval(req: Pick<ApprovalRequest, "tool">, approvable: readonly string[] = B4B_APPROVABLE): ApprovalDecision {
  return approvable.includes(req.tool) ? "approve" : "reject";
}

const STATUS_LABEL: Record<RunStatus, string> = {
  complete: "Complete",
  outdated: "Outdated",
  running: "Running",
  failed: "Failed",
  not_run: "Not run",
};

export const statusLabel = (s: RunStatus | string): string => STATUS_LABEL[s as RunStatus] ?? s;

/**
 * The run B4(b) judges: among flight runs, the Complete one whose apogee is
 * closest to the target; with none Complete, the first run that exists
 * (so the reason names its status). `null` when no run was ever made.
 */
export function pickRun(list: RunListOut | null | undefined): B4bObservation | null {
  const runs = (list?.runs ?? []).filter((r) => r.kind === "flight" && typeof r.run_id === "string" && r.run_id !== "");
  const apogee = (r: RunListEntry): number | null => (typeof r.summary?.apogee_m === "number" && Number.isFinite(r.summary.apogee_m) ? r.summary.apogee_m : null);
  const complete = runs.filter((r) => r.status === "complete" && apogee(r) !== null);
  complete.sort((a, b) => Math.abs(apogee(a)! - B4B_TARGET_APOGEE_M) - Math.abs(apogee(b)! - B4B_TARGET_APOGEE_M));
  const r = complete[0] ?? runs[0];
  if (r === undefined) return null;
  return { run_status: statusLabel(r.status), apogee_m: apogee(r), results_visible: false, sim: r.sim, run_id: r.run_id ?? null };
}

/** The thread and turn that carry `prompt` as a user message (the latest such turn). */
export function findPromptTurn(threads: Map<string, TimelineEvent[]>, prompt: string): { threadId: string; turnId: string; events: TimelineEvent[] } | null {
  for (const [threadId, events] of threads) {
    const u = events.filter((e) => e.type === "user_message" && e.text.trim() === prompt.trim()).at(-1);
    if (u?.type !== "user_message") continue;
    const turnId = u.turnId;
    return { threadId, turnId, events: events.filter((e) => e.turnId === turnId) };
  }
  return null;
}

export function turnEnd(events: readonly TimelineEvent[]): "complete" | "interrupted" | "error" | null {
  const e = events.find((x) => x.type === "turn_end");
  return e?.type === "turn_end" ? e.status : null;
}

/** The approval request a prompt id belongs to, from the thread timeline. */
export function approvalRequest(events: readonly TimelineEvent[], approvalId: string): ApprovalRequest | null {
  for (const e of events) if (e.type === "approval_request" && e.request.approvalId === approvalId) return e.request;
  return null;
}

/** Normalizes the prompt's turn into a transcript and its tool calls. */
export function transcriptOf(threadId: string, events: readonly TimelineEvent[], prompt: string = B4B_PROMPT): Transcript {
  const entries: Transcript["entries"] = [];
  const calls = new Map<string, ToolCallRecord>();
  const decisions = new Map<string, ApprovalDecision>();
  for (const e of events) if (e.type === "approval_resolved") decisions.set(e.approvalId, e.decision);
  for (const e of events) {
    switch (e.type) {
      case "user_message":
        entries.push({ kind: "user", text: e.text });
        break;
      case "assistant_text":
        entries.push({ kind: "assistant", text: e.text });
        break;
      case "tool_call":
        entries.push({ kind: "tool_call", callId: e.callId, tool: e.tool, input: e.input });
        calls.set(e.callId, { callId: e.callId, tool: e.tool, input: e.input, isError: null, output: null });
        break;
      case "tool_result": {
        entries.push({ kind: "tool_result", callId: e.callId, isError: e.isError, output: e.output });
        const c = calls.get(e.callId);
        if (c !== undefined) Object.assign(c, { isError: e.isError, output: e.output });
        break;
      }
      case "approval_request":
        entries.push({ kind: "approval", approvalId: e.request.approvalId, tool: e.request.tool, decision: decisions.get(e.request.approvalId) ?? null });
        break;
      case "result_card":
        entries.push({ kind: "result_card", cardKind: e.kind, ref: e.ref, title: e.title });
        break;
      case "error":
        entries.push({ kind: "error", message: e.error.message });
        break;
      default:
        break;
    }
  }
  return { threadId, prompt, turn_status: turnEnd(events), entries, tool_calls: [...calls.values()] };
}

/** `"1,283"` → 1283; null for `—` or junk. */
export function parseShownNumber(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const n = Number(text.replace(/[,\s]/g, "").replace(/m$/, ""));
  return text.trim() === "" || !Number.isFinite(n) ? null : n;
}

/** The app state and the project files must report the same run (status and apogee within 0.5%). */
export function sourcesAgree(app: B4bObservation | null, files: B4bObservation | null): string[] {
  if (app === null || files === null) return [];
  const out: string[] = [];
  if (app.run_id !== files.run_id) out.push(`app run ${app.run_id ?? "none"} != files run ${files.run_id ?? "none"}`);
  if (app.run_status !== files.run_status) out.push(`app status ${app.run_status ?? "none"} != files status ${files.run_status ?? "none"}`);
  if (app.apogee_m !== null && files.apogee_m !== null && Math.abs(app.apogee_m - files.apogee_m) > 0.005 * Math.max(1, Math.abs(files.apogee_m))) {
    out.push(`app apogee ${app.apogee_m} m != files apogee ${files.apogee_m} m`);
  }
  return out;
}

/** Parent Claude Code session markers that a user's app never inherits (a nested-session env changes the CLI's behaviour). */
const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_(ENTRYPOINT|SESSION_.*|CHILD_SESSION|MESSAGING_.*|SSE_PORT|EXECPATH|EXPERIMENTAL_.*|DISABLE_ADAPTIVE_THINKING|NO_FLICKER))$/;

/**
 * The live app's env: the user's env minus Electron's node mode, test hooks
 * (I12), the offline flag, and the parent agent session's markers; plus the
 * sidecar binary.
 */
export function liveAppEnv(env: NodeJS.ProcessEnv, sidecarBin: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PARENT_SESSION_VARS.test(k)) out[k] = v;
  for (const k of ["ELECTRON_RUN_AS_NODE", "RW_TEST_HOOKS", "RW_OFFLINE"]) delete out[k];
  out["RW_SIDECAR_BIN"] = sidecarBin;
  return out;
}

// ---- RPC client (app state) ------------------------------------------------------

/** A minimal IF10 client over Node's global WebSocket: hello, then request/response by id; pushes are kept. */
export class RpcClient {
  readonly pushes: Array<Extract<ServerFrame, { kind: "push" }>> = [];
  private readonly ws: WebSocket;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private next = 1;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (m) => {
      const f = JSON.parse(String(m.data)) as ServerFrame;
      if (f.kind === "push") this.pushes.push(f);
      else if (f.kind === "response") {
        const w = this.waiting.get(f.id);
        this.waiting.delete(f.id);
        if (f.ok) w?.ok(f.result);
        else w?.fail(new Error(`${f.error.code}: ${f.error.message}`));
      }
    });
    ws.addEventListener("close", () => {
      for (const w of this.waiting.values()) w.fail(new Error("rpc closed"));
      this.waiting.clear();
    });
  }

  static connect(url: string, timeoutMs = 15_000): Promise<RpcClient> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => fail(new Error(`rpc hello timed out: ${url}`)), timeoutMs);
      const onHello = (m: MessageEvent): void => {
        const f = JSON.parse(String(m.data)) as ServerFrame;
        if (f.kind !== "hello") return;
        clearTimeout(timer);
        ws.removeEventListener("message", onHello);
        ok(client);
      };
      const client = new RpcClient(ws);
      ws.addEventListener("message", onHello);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        fail(new Error(`rpc connect failed: ${url}`));
      });
    });
  }

  call<T = JsonObject>(method: string, params: object): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    });
  }

  /** The open project whose dir is `dir` (paths compared after realpath: `/tmp` is `/private/tmp` on macOS). */
  async projectFor(dir: string): Promise<ProjectInfo> {
    const want = realpathSync(dir);
    const { projects } = await this.call<{ projects: ProjectInfo[] }>("project.list", {});
    const p = projects.find((x) => {
      try {
        return realpathSync(x.dir) === want;
      } catch {
        return false;
      }
    });
    if (p === undefined) throw new Error(`project ${dir} is not open (open: ${projects.map((x) => x.dir).join(", ")})`);
    return p;
  }

  /** The app's current run list (a fresh project snapshot). */
  async runs(projectId: string): Promise<RunListOut> {
    const { subscriptionId, snapshot } = await this.call<{ subscriptionId: string; snapshot: ProjectSnapshot }>("project.subscribe", { projectId });
    await this.call("project.unsubscribe", { subscriptionId });
    return snapshot.runs;
  }

  close(): void {
    this.ws.close();
  }
}

// ---- driver ------------------------------------------------------------------------

/** How the Results page came to show the run. */
export type ResultsVia = "already" | "reveal-card" | "navigate";

export interface ResultsView {
  visible: boolean;
  via: ResultsVia | null;
  /** The run's row as shown (status label, apogee text). */
  row: { sim: string; status: string; apogee_text: string } | null;
}

/** One live (or offline) app session, driven as a user would. */
export interface B4bSession {
  readonly projectDir: string;
  /** Types the prompt into the chat composer and sends it. */
  send(prompt: string): Promise<void>;
  /** Approval prompts the user can see now (ids). */
  pendingApprovals(): Promise<string[]>;
  /** Answers one prompt with the panel's button. */
  respond(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Stops the running turn (composer Stop). */
  interrupt(): Promise<void>;
  /** The app state's run list. */
  appRuns(): Promise<RunListOut>;
  /** Shows the run on the Results page: the reveal-run card if present, else navigation. */
  showResults(run: { sim: string; run_id: string; apogee_m: number | null }): Promise<ResultsView>;
  /** Writes a PNG; false if it could not. */
  screenshot(what: "chat-pane" | "results" | "window", file: string): Promise<boolean>;
  /** The prompt's turn as timeline events, from the Lecturn thread (B14). */
  promptTurn(prompt: string): Promise<ReturnType<typeof findPromptTurn>>;
  /** The run card frames the pane shows (the embed session); absent, the run card is not checked. */
  runCards?(): Promise<CardFrameFacts[]>;
  /**
   * Evidence only (CP-W2 r3): captures the pane page by page, top to bottom, into `dir`
   * (the bottom-only `chat-pane.png` misses the turn's earlier cards); returns the file names.
   */
  paneScrollShots?(dir: string): Promise<string[]>;
  close(): Promise<void>;
}

export interface DriveOptions {
  outDir: string;
  prompt?: string;
  timeoutMs?: number;
  pollMs?: number;
  approvable?: readonly string[];
  log?: (line: string) => void;
}

export interface DriveOutcome {
  transcript: Transcript | null;
  approvals: ApprovalRecord[];
  timedOut: boolean;
  duration_s: number;
  app: B4bObservation | null;
  results: ResultsView | null;
  /** The pane's run card frames after the turn (W-B2.1: a run card with its chart); absent without `runCards`. */
  run_cards?: CardFrameFacts[];
  artifacts: string[];
  errors: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sends the prompt, answers approvals, waits for the turn, then observes the
 * app state and the Results page. Never throws for an agent outcome; app
 * failures land in `errors`.
 */
export async function driveB4b(s: B4bSession, o: DriveOptions): Promise<DriveOutcome> {
  const prompt = o.prompt ?? B4B_PROMPT;
  const timeoutMs = o.timeoutMs ?? B4B_TIMEOUT_MS;
  const pollMs = o.pollMs ?? 1000;
  const log = o.log ?? (() => undefined);
  const approvals: ApprovalRecord[] = [];
  const answered = new Set<string>();
  const artifacts: string[] = [];
  const errors: string[] = [];
  mkdirSync(o.outDir, { recursive: true });

  const t0 = Date.now();
  await s.send(prompt);
  log(`sent prompt; waiting up to ${Math.round(timeoutMs / 60_000)} min for the turn`);
  let turn: ReturnType<typeof findPromptTurn> = null;
  let timedOut = false;
  let lastCalls = 0;
  const readTurn = (): Promise<ReturnType<typeof findPromptTurn>> => s.promptTurn(prompt);
  for (;;) {
    turn = await readTurn().catch((e: unknown) => {
      log(`reading the turn: ${e instanceof Error ? e.message : String(e)}`);
      return turn;
    });
    for (const id of await s.pendingApprovals()) {
      if (answered.has(id)) continue;
      const req = turn === null ? null : approvalRequest(turn.events, id);
      if (req === null) continue; // the thread line lands right after the panel; next tick
      const decision = decideApproval(req, o.approvable);
      answered.add(id);
      approvals.push({ approvalId: id, tool: req.tool, input: req.input, reason: req.reason, decision, at_ms: Date.now() - t0 });
      log(`approval ${req.tool}: ${decision}`);
      await s.respond(id, decision);
    }
    if (turn !== null) {
      const calls = turn.events.filter((e) => e.type === "tool_call").length;
      if (calls !== lastCalls) log(`tool calls: ${calls}`);
      lastCalls = calls;
      if (turnEnd(turn.events) !== null) break;
    }
    if (Date.now() - t0 > timeoutMs) {
      timedOut = true;
      log("turn timed out; stopping it");
      await s.interrupt().catch((e: unknown) => errors.push(`interrupt: ${String(e)}`));
      await sleep(2000);
      turn = await readTurn().catch(() => turn);
      break;
    }
    await sleep(pollMs);
  }
  const duration_s = round((Date.now() - t0) / 1000, 1);

  const transcript = turn === null ? null : transcriptOf(turn.threadId, turn.events, prompt);
  const write = (name: string, data: string): void => {
    writeFileSync(join(o.outDir, name), data);
    artifacts.push(name);
  };
  if (transcript !== null) {
    write("transcript.json", stableStringify(transcript));
    write("tool-calls.json", stableStringify(transcript.tool_calls));
  } else errors.push("no thread carries the prompt");
  write("approvals.json", stableStringify(approvals));

  const shot = async (what: "chat-pane" | "results" | "window", name: string): Promise<void> => {
    try {
      if (await s.screenshot(what, join(o.outDir, name))) artifacts.push(name);
    } catch (e) {
      errors.push(`screenshot ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await shot("chat-pane", "chat-pane.png");
  await shot("window", "window-after-turn.png");
  if (s.paneScrollShots) {
    try {
      const files = await s.paneScrollShots(join(o.outDir, "chat-pane-scroll"));
      artifacts.push(...files.map((f) => `chat-pane-scroll/${f}`));
      log(`captured the pane in ${files.length} pages`);
    } catch (e) {
      log(`chat-pane-scroll (evidence only): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let run_cards: CardFrameFacts[] | undefined;
  if (s.runCards) {
    try {
      run_cards = await s.runCards();
    } catch (e) {
      errors.push(`run cards: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let app: B4bObservation | null = null;
  try {
    app = pickRun(await s.appRuns());
  } catch (e) {
    errors.push(`app runs: ${e instanceof Error ? e.message : String(e)}`);
  }
  let results: ResultsView | null = null;
  if (app?.sim && app.run_id) {
    try {
      results = await s.showResults({ sim: app.sim, run_id: app.run_id, apogee_m: app.apogee_m });
      app = { ...app, results_visible: results.visible };
    } catch (e) {
      errors.push(`results page: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await shot("results", "results.png");
  return { transcript, approvals, timedOut, duration_s, app, results, ...(run_cards === undefined ? {} : { run_cards }), artifacts, errors };
}

// ---- W-B2 follow-up turn and mode checks (B16; D14, decision 12) -------------------

/** Lecturn provider instances for CP-W2 steps 1 (Claude) and 2 (Codex); `--model <instance>/<model>` overrides. */
export const PROVIDER_MODELS: Record<"claude" | "codex", ModelSelection> = {
  claude: { instanceId: "claudeAgent", model: "claude-fable-5-1" },
  codex: { instanceId: "codex", model: "gpt-6-astra" },
};
/** The CLI each provider's Lecturn adapter runs, logged in already (the sidecar never reads `~/.lecturn`). */
export const PROVIDER_CLIS: Record<"claude" | "codex", string> = { claude: "claude", codex: "codex" };

/** The liquid-engine fixture the follow-up turn runs on (copied to a temp dir): it has `engines/demo.rw.toml`. */
export const FOLLOW_UP_FIXTURE = join(REPO_ROOT, "fixtures/research-vehicle");
export const FOLLOW_UP_PROJECT_NAME = "Research vehicle";
/** `--rehearse`: Lecturn's scripted provider replays `app/e2e/fixtures/scripted/<this>.json` for the four follow-up turns. */
export const FOLLOW_UP_REHEARSAL_FIXTURE = "b4b-followup";
/** The approval follow-up (D14): one explicit prompt; the agent must omit the duration. */
export const FOLLOW_UP_PROMPT = "Simulate the demo engine with rw_engine_simulate. Do not pass a duration: leave it at the tool's default.";
/** The card's label: the tool's title since the CPW1R5A presentation (`Approve Simulate engine`), or its id. */
export const FOLLOW_UP_CARD_LABELS: readonly string[] = ["Approve Simulate engine", "Approve rw_engine_simulate"];
/** The D6 reason the card carries. */
export const FOLLOW_UP_REASON = "Burn duration not set · default 120 s";
/** The same gated call in Full access and in Auto: forwarded approved, never a card (decision 2). */
export const MODE_CHECK_PROMPTS: Record<"full-access" | "auto", string> = {
  "full-access": "Simulate the demo engine again with rw_engine_simulate, again without passing a duration.",
  auto: "Once more: simulate the demo engine with rw_engine_simulate and no duration.",
};
/** D6: `simulate` with mc > 100 is `not_implemented` at once, with no approval. */
export const MC_PROMPT = "Call rw_simulate once on the baseline sim with mc set to 500 (a 500-sample Monte Carlo) and report what it returns. Do not retry with other settings.";
export const FOLLOW_UP_TIMEOUT_MS = 5 * 60_000;

/** The embed session's extra reach for the follow-up turn (`app/e2e/b4b-live.ts` `EmbedSession`). */
export interface EmbedTurnSession extends B4bSession {
  readonly threadId: string | null;
  setRuntimeMode(mode: RuntimeMode): Promise<void>;
  /** A later prompt in the same thread (composer draft + Send). */
  sendInThread(prompt: string): Promise<void>;
  /** Clears and (re)starts the guest's record of approval cards. */
  watchApprovalCards(): Promise<void>;
  /** Cards recorded since the watch started (`Approve <tool> | <reason>`). */
  approvalCardsSeen(): Promise<string[]>;
  /** The approval cards on screen now. */
  approvalCards(): Promise<ApprovalCardView[]>;
  /** The run card frames the pane shows. */
  runCards(): Promise<CardFrameFacts[]>;
  answerApprovals(o: { decide: (r: { toolName: string; reason: string | null }) => "accept" | "decline"; before?: (r: { id: string }) => Promise<void> }): Promise<ApprovalAnswerer>;
  promptTurn(prompt: string): Promise<ReturnType<typeof findPromptTurn>>;
}

export function isEmbedTurnSession(s: B4bSession): s is EmbedTurnSession {
  return typeof (s as Partial<EmbedTurnSession>).setRuntimeMode === "function" && typeof (s as Partial<EmbedTurnSession>).answerApprovals === "function";
}

export type CheckName = "approval" | "full-access" | "auto" | "mc500";

/** One follow-up turn as observed. */
export interface CheckTurn {
  transcript: Transcript | null;
  timedOut: boolean;
  duration_s: number;
  /** App approvals answered over the admin session (`lecturn-admin.ts`). */
  approvals: ApprovalLogEntry[];
  /** Cards the guest showed during the turn. */
  cards_seen: string[];
  /** Provider approvals (not app approvals) the harness declined during the turn. */
  provider_requests?: ProviderRequestEntry[];
  errors: string[];
}

export interface CheckRecord extends CheckTurn {
  name: CheckName;
  mode: RuntimeMode;
  prompt: string;
  status: "pass" | "red";
  reasons: string[];
  /** `approval`: the card on screen when the request was answered. */
  card_shown?: ApprovalCardView | null;
  /** `approval`: the complete engine run card (with its thrust chart), if one rendered. */
  engine_card?: CardFrameFacts | null;
}

export interface FollowUpResult {
  status: "pass" | "red" | "not-run";
  reasons: string[];
  project?: string;
  /** The approval turn alone, recorded apart from B4(b)'s ≤ 30 calls / ≤ 3 min (decision 12). */
  turn?: TurnRecord;
  checks: CheckRecord[];
}

const noDuration = (input: JsonObject): boolean => input["duration"] === undefined || input["duration"] === null;
const callsOf = (t: CheckTurn, tool: string): ToolCallRecord[] => t.transcript?.tool_calls.filter((c) => c.tool === tool) ?? [];
const turnApprovals = (t: CheckTurn): number => Math.max(t.approvals.length, t.transcript?.entries.filter((e) => e.kind === "approval").length ?? 0);

function endReasons(t: CheckTurn, label: string): string[] {
  if (t.timedOut) return [`${label}: the turn did not finish within ${Math.round(FOLLOW_UP_TIMEOUT_MS / 60_000)} min`];
  if (t.transcript === null) return [`${label}: no turn carries the prompt`];
  return t.transcript.turn_status === "complete" ? [] : [`${label}: the turn ended ${t.transcript.turn_status ?? "without a turn_end"}`];
}

/** D14: rw_engine_simulate with no duration → one card with the D6 reason → approved → the run completes and its card renders with the thrust chart. */
export function judgeApprovalTurn(t: CheckTurn, shown: ApprovalCardView | null | undefined, engineCards: readonly CardFrameFacts[]): string[] {
  const out = endReasons(t, "approval");
  const calls = callsOf(t, "engine_simulate");
  if (calls.length === 0) out.push("approval: rw_engine_simulate was never called");
  else if (!noDuration(calls[0]!.input)) out.push(`approval: rw_engine_simulate was called with duration ${JSON.stringify(calls[0]!.input["duration"])}, so nothing needed approval`);
  if (t.approvals.length !== 1) out.push(`approval: ${t.approvals.length} app approvals were answered, want 1`);
  const a = t.approvals[0];
  if (a !== undefined) {
    if (a.toolName !== "rw_engine_simulate") out.push(`approval: the request was for ${a.toolName}, not rw_engine_simulate`);
    if (a.reason !== FOLLOW_UP_REASON) out.push(`approval: the reason was ${JSON.stringify(a.reason)}, want ${JSON.stringify(FOLLOW_UP_REASON)}`);
    if (a.decision !== "accept") out.push("approval: the request was not approved");
  }
  if (shown === null || shown === undefined) out.push("approval: no approval card was on screen in the pane when the request was answered");
  else {
    if (!FOLLOW_UP_CARD_LABELS.includes(shown.label)) out.push(`approval: the card reads ${JSON.stringify(shown.label)}`);
    if (!shown.reason.includes(FOLLOW_UP_REASON)) out.push(`approval: the card's reason line reads ${JSON.stringify(shown.reason)}`);
  }
  const last = calls.at(-1);
  if (last !== undefined && last.isError !== false) out.push(`approval: the approved rw_engine_simulate did not complete (${JSON.stringify(last.output)})`);
  if (!engineCards.some((c) => c.kind === "engine" && c.phase === "complete" && c.points >= 2)) out.push(`approval: no complete engine run card with its thrust chart (${JSON.stringify(engineCards.slice(-4))})`);
  return [...out, ...t.errors.map((e) => `approval: ${e}`)];
}

/** Decision 2: in Full access and Auto the same gated call runs with no approval and no card. */
export function judgeNoCardTurn(t: CheckTurn, mode: "full-access" | "auto"): string[] {
  const label = RUNTIME_MODE_LABEL[mode];
  const out = endReasons(t, label);
  const calls = callsOf(t, "engine_simulate");
  if (calls.length === 0) out.push(`${label}: rw_engine_simulate was never called`);
  else if (!noDuration(calls[0]!.input)) out.push(`${label}: rw_engine_simulate was called with a duration, so the gate was not exercised`);
  else if (calls[0]!.isError !== false) out.push(`${label}: rw_engine_simulate did not complete (${JSON.stringify(calls[0]!.output)})`);
  if (turnApprovals(t) > 0) out.push(`${label}: ${turnApprovals(t)} app approvals were raised, want none`);
  if (t.cards_seen.length > 0) out.push(`${label}: the pane showed approval cards ${JSON.stringify(t.cards_seen)}`);
  return [...out, ...t.errors.map((e) => `${label}: ${e}`)];
}

/** D6: `simulate` mc=500 answers `not_implemented` with no approval and no card. */
export function judgeMcTurn(t: CheckTurn): string[] {
  const out = endReasons(t, "mc500");
  const call = callsOf(t, "simulate").find((c) => Number(c.input["mc"]) === 500);
  if (call === undefined) out.push("mc500: rw_simulate was never called with mc 500");
  else if (call.isError !== true || !JSON.stringify(call.output ?? null).includes("not_implemented")) out.push(`mc500: rw_simulate mc=500 did not return not_implemented (${JSON.stringify(call.output)})`);
  if (turnApprovals(t) > 0) out.push(`mc500: ${turnApprovals(t)} app approvals were raised, want none`);
  if (t.cards_seen.length > 0) out.push(`mc500: the pane showed approval cards ${JSON.stringify(t.cards_seen)}`);
  return [...out, ...t.errors.map((e) => `mc500: ${e}`)];
}

/**
 * Runs one follow-up turn: mode, card watch, send, approvals answered as
 * `decide` says, wait for its end. `match` is the user message the turn
 * carries when it differs from the draft (B16b: Lecturn folds the strip's
 * chips into the sent text); the default is `prompt`.
 */
export async function checkTurn(
  s: EmbedTurnSession,
  o: { prompt: string; match?: string; mode: RuntimeMode; first: boolean; decide: (r: { toolName: string; reason: string | null }) => "accept" | "decline"; before?: (r: { id: string }) => Promise<void>; timeoutMs: number; pollMs: number; log: (line: string) => void },
): Promise<CheckTurn> {
  const errors: string[] = [];
  const match = o.match ?? o.prompt;
  const t0 = Date.now();
  // The first prompt opens the thread in Supervised (`EmbedSession.send`); later ones set their mode first.
  if (o.first) await s.send(o.prompt);
  else {
    await s.setRuntimeMode(o.mode);
    await s.watchApprovalCards();
    await s.sendInThread(o.prompt);
  }
  const answerer = await s.answerApprovals({ decide: o.decide, ...(o.before === undefined ? {} : { before: o.before }) });
  let turn: ReturnType<typeof findPromptTurn> = null;
  let timedOut = false;
  for (;;) {
    turn = await s.promptTurn(match).catch((e: unknown) => {
      o.log(`reading the turn: ${e instanceof Error ? e.message : String(e)}`);
      return turn;
    });
    if (turn !== null && turnEnd(turn.events) !== null) break;
    if (Date.now() - t0 > o.timeoutMs) {
      timedOut = true;
      await s.interrupt().catch((e: unknown) => errors.push(`interrupt: ${String(e)}`));
      await sleep(2000);
      turn = await s.promptTurn(match).catch(() => turn);
      break;
    }
    await answerer.tick();
    await sleep(o.pollMs);
  }
  await answerer.stop();
  const duration_s = round((Date.now() - t0) / 1000, 1);
  const cards_seen = await s.approvalCardsSeen().catch((e: unknown) => {
    errors.push(`reading the approval cards: ${String(e)}`);
    return [];
  });
  return { transcript: turn === null ? null : transcriptOf(turn.threadId, turn.events, match), timedOut, duration_s, approvals: answerer.log, ...(answerer.provider.length > 0 ? { provider_requests: answerer.provider } : {}), cards_seen, errors: [...errors, ...answerer.errors] };
}

/**
 * The W-B2 follow-up (D14, decision 12; after each of steps 1 and 2) on a
 * project opened on `fixtures/research-vehicle`: in one thread, the
 * Supervised approval turn, then the same gated call in Full access and in
 * Auto (no card in either, decision 2), then `simulate mc=500` in
 * Supervised (`not_implemented`, no card, D6). Recorded apart from the
 * B4(b) turn.
 */
export async function driveFollowUp(s: EmbedTurnSession, o: { outDir: string; timeoutMs?: number; pollMs?: number; log?: (line: string) => void }): Promise<FollowUpResult> {
  const log = o.log ?? (() => undefined);
  const base = { timeoutMs: o.timeoutMs ?? FOLLOW_UP_TIMEOUT_MS, pollMs: o.pollMs ?? 1000, log };
  const declineAll = () => "decline" as const;
  const checks: CheckRecord[] = [];
  mkdirSync(o.outDir, { recursive: true });

  const card: { shown: ApprovalCardView | null } = { shown: null };
  const approval = await checkTurn(s, {
    ...base,
    prompt: FOLLOW_UP_PROMPT,
    mode: "approval-required",
    first: true,
    decide: (r) => (r.toolName === "rw_engine_simulate" ? "accept" : "decline"),
    // The card must be on screen before the harness answers for the user.
    before: async () => {
      const end = Date.now() + 15_000;
      let last = "";
      while (card.shown === null && Date.now() < end) {
        const cards = await s.approvalCards().catch((e: unknown) => {
          last = `error: ${e instanceof Error ? e.message : String(e)}`;
          return [];
        });
        if (cards.length > 0) last = JSON.stringify(cards);
        card.shown = cards.find((c) => c.visible) ?? null;
        if (card.shown === null) await sleep(250);
      }
      if (card.shown === null) await s.screenshot("chat-pane", join(o.outDir, "approval-card-missing.png")).catch(() => false);
      log(`approval card: ${card.shown === null ? `none on screen (last read: ${last || "no cards"})` : `${card.shown.label} | ${card.shown.reason}`}`);
    },
  });
  const engineCards = await s.runCards().catch(() => []);
  const engine_card = engineCards.find((c) => c.kind === "engine" && c.phase === "complete") ?? null;
  const approvalReasons = judgeApprovalTurn(approval, card.shown, engineCards);
  checks.push({ ...approval, name: "approval", mode: "approval-required", prompt: FOLLOW_UP_PROMPT, status: approvalReasons.length === 0 ? "pass" : "red", reasons: approvalReasons, card_shown: card.shown, engine_card });
  try {
    if (await s.screenshot("chat-pane", join(o.outDir, "follow-up-pane.png"))) log("follow-up: captured the pane");
  } catch {
    /* the record says what happened */
  }

  for (const mode of ["full-access", "auto"] as const) {
    const t = await checkTurn(s, { ...base, prompt: MODE_CHECK_PROMPTS[mode], mode, first: false, decide: declineAll });
    const reasons = judgeNoCardTurn(t, mode);
    checks.push({ ...t, name: mode, mode, prompt: MODE_CHECK_PROMPTS[mode], status: reasons.length === 0 ? "pass" : "red", reasons });
  }
  const mc = await checkTurn(s, { ...base, prompt: MC_PROMPT, mode: "approval-required", first: false, decide: declineAll });
  const mcReasons = judgeMcTurn(mc);
  checks.push({ ...mc, name: "mc500", mode: "approval-required", prompt: MC_PROMPT, status: mcReasons.length === 0 ? "pass" : "red", reasons: mcReasons });

  const reasons = checks.flatMap((c) => c.reasons);
  const result: FollowUpResult = {
    status: reasons.length === 0 ? "pass" : "red",
    reasons,
    turn: turnRecord(approval.transcript, approval.duration_s),
    checks,
  };
  writeFileSync(join(o.outDir, "follow-up.json"), stableStringify(result));
  return result;
}

// ---- project files ---------------------------------------------------------------

/** The run as the project files report it: `rocketwright call run_list` (status from the files) + `summary.json`. */
export function filesRun(bin: string, projectDir: string, want: { sim: string; run_id: string } | null): B4bObservation | null {
  const out = execFileSync(bin, ["-C", projectDir, "call", "run_list", "{}"], { encoding: "utf8", env: { ...process.env, RW_OFFLINE: "1" } });
  const list = JSON.parse(out) as RunListOut;
  const picked = want === null ? pickRun(list) : (() => {
    const r = list.runs.find((x) => x.sim === want.sim && x.run_id === want.run_id);
    return r === undefined ? null : { run_status: statusLabel(r.status), apogee_m: null, results_visible: false, sim: r.sim, run_id: r.run_id ?? null };
  })();
  if (picked === null || !picked.sim || !picked.run_id) return picked;
  const summary = join(projectDir, "runs", picked.sim, picked.run_id, "summary.json");
  const apogee = existsSync(summary) ? (JSON.parse(readFileSync(summary, "utf8")) as { apogee_m?: number }).apogee_m : undefined;
  return { ...picked, apogee_m: typeof apogee === "number" ? apogee : null };
}

/** Folds the drive outcome and the files check into the bar result. */
export function judge(d: DriveOutcome, files: B4bObservation | null): B4bResult {
  const base = files ?? d.app;
  const obs: B4bObservation = base === null
    ? { run_status: null, apogee_m: null, results_visible: false, sim: null, run_id: null }
    : { ...base, results_visible: d.app?.results_visible === true && d.app.run_id === base.run_id };
  const r = evaluateB4b(obs);
  const reasons = [...r.reasons];
  if (d.timedOut) reasons.unshift(`turn did not finish within ${Math.round(B4B_TIMEOUT_MS / 60_000)} min`);
  else if (d.transcript?.turn_status !== "complete") reasons.unshift(`turn ended ${d.transcript?.turn_status ?? "without a turn_end"}`);
  const calls = d.transcript?.tool_calls.length ?? 0;
  if (calls > B4B_MAX_TOOL_CALLS) reasons.push(`${calls} tool calls (max ${B4B_MAX_TOOL_CALLS})`);
  if (!d.timedOut && d.duration_s > B4B_MAX_TURN_S) reasons.push(`turn took ${d.duration_s} s (max ${B4B_MAX_TURN_S} s)`);
  reasons.push(...sourcesAgree(d.app, files));
  // W-B2.1: a run card renders in the pane with its chart (a complete flight card with a plotted line).
  const runCard = d.run_cards?.find((c) => c.kind === "flight" && c.phase === "complete" && c.points >= 2) ?? null;
  if (d.run_cards !== undefined && runCard === null) reasons.push(`no complete flight run card with its chart in the pane (${JSON.stringify(d.run_cards.slice(-4))})`);
  reasons.push(...d.errors);
  return {
    ...r,
    status: reasons.length === 0 ? "pass" : "red",
    reasons,
    approvals: d.approvals,
    turn: turnRecord(d.transcript, d.duration_s),
    sources: { app: d.app, files },
    results_via: d.results?.via ?? null,
    ...(d.run_cards === undefined ? {} : { run_card: runCard }),
    artifacts: d.artifacts,
  };
}

// ---- main --------------------------------------------------------------------------

interface Args {
  outDir: string;
  resultPath: string;
  timeoutMs: number;
  keep: boolean;
  rehearse: boolean;
  /** B16 */
  provider: "claude" | "codex";
  model: ModelSelection | null;
  followUp: boolean;
  attach: boolean;
  /** B16b */
  mention: boolean;
}

export function parseArgs(argv: string[]): Args | string {
  const get = (name: string): string | undefined | null => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const out = get("out");
  const outDirArg = get("out-dir");
  const tmin = get("timeout-min");
  if (out === null) return "--out needs a path";
  if (outDirArg === null) return "--out-dir needs a path";
  if (tmin === null || (tmin !== undefined && !(Number(tmin) > 0))) return "--timeout-min needs a positive number";
  const provider = get("provider") ?? "claude";
  if (provider !== "claude" && provider !== "codex") return "--provider is claude or codex";
  const modelArg = get("model");
  const slash = modelArg?.indexOf("/") ?? -1;
  if (modelArg === null || (modelArg !== undefined && (slash <= 0 || slash === modelArg.length - 1))) return "--model needs <instance>/<model>";
  const model = modelArg === undefined ? null : { instanceId: modelArg.slice(0, slash), model: modelArg.slice(slash + 1) };
  const rehearse = argv.includes("--rehearse");
  const attach = argv.includes("--attach");
  const fallback = attach ? join(barOutDir(), "live/attach/result.json") : rehearse ? join(barOutDir(), "live/b4b-rehearsal/result.json") : defaultResultPath();
  const resultPath = resolve(out ?? (outDirArg !== undefined ? join(outDirArg, "result.json") : fallback));
  return {
    outDir: resolve(outDirArg ?? dirname(resultPath)),
    resultPath,
    timeoutMs: tmin === undefined ? B4B_TIMEOUT_MS : Number(tmin) * 60_000,
    keep: argv.includes("--keep"),
    rehearse,
    provider,
    model,
    followUp: !argv.includes("--no-follow-up"),
    attach,
    mention: !argv.includes("--no-mention"),
  };
}

function cargo(): string {
  const local = join(process.env["HOME"] ?? "", ".cargo/bin/cargo");
  return existsSync(local) ? local : "cargo";
}

/** `$RW_SIDECAR_BIN`, else the workspace debug build (built now if missing). */
function sidecar(): string {
  const pre = process.env["RW_SIDECAR_BIN"];
  if (pre !== undefined && pre !== "") return pre;
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  execFileSync(cargo(), ["build", "-q", "-p", "rw-cli", "--bin", "rocketwright"], { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
  const meta = JSON.parse(execFileSync(cargo(), ["metadata", "--no-deps", "--format-version", "1"], { cwd: REPO_ROOT, env, encoding: "utf8" })) as { target_directory: string };
  return join(meta.target_directory, "debug", "rocketwright");
}

function save(a: Args, result: B4bResult): void {
  mkdirSync(dirname(a.resultPath), { recursive: true });
  writeFileSync(a.resultPath, stableStringify(result));
  const board = defaultResultPath();
  if (!a.rehearse && resolve(board) !== a.resultPath) {
    mkdirSync(dirname(board), { recursive: true });
    copyFileSync(a.resultPath, board);
  }
  console.log(`bar-live: B4(b)${a.rehearse ? " rehearsal" : ""} ${result.status}${result.reasons.length ? ` (${result.reasons.join("; ")})` : ""} -> ${a.resultPath}`);
  const f = result.follow_up;
  if (f !== undefined) console.log(`bar-live: follow-up (approval, Full access, Auto, mc=500) ${f.status}${f.reasons.length ? ` (${f.reasons.join("; ")})` : ""}`);
  const m = result.mention;
  if (m !== undefined) console.log(`bar-live: mention (rw:c/fins span, chip click) ${m.status}${m.reasons.length ? ` (${m.reasons.join("; ")})` : ""}`);
}

/** The W-B2 follow-up on a temp copy of `fixtures/research-vehicle` (its own app launch; see `driveFollowUp`). */
async function followUp(a: Args, parent: string, appEnv: Record<string, string>, model: ModelSelection | undefined, log: (line: string) => void): Promise<FollowUpResult> {
  const projectDir = join(parent, FOLLOW_UP_PROJECT_NAME);
  cpSync(FOLLOW_UP_FIXTURE, projectDir, { recursive: true });
  const outDir = join(a.outDir, "follow-up");
  let session: B4bSession | undefined;
  try {
    const { launchB4bApp } = await import("../../app/e2e/b4b-live.ts");
    session = await launchB4bApp({ projectDir, env: appEnv, outDir, log, ...(a.rehearse ? { rehearse: FOLLOW_UP_REHEARSAL_FIXTURE } : model === undefined ? {} : { model }) });
    if (!isEmbedTurnSession(session)) return { status: "red", reasons: ["the follow-up needs the embedded Lecturn pane"], project: projectDir, checks: [] };
    return { ...(await driveFollowUp(session, { outDir, timeoutMs: Math.min(a.timeoutMs, FOLLOW_UP_TIMEOUT_MS), log })), project: projectDir };
  } catch (e) {
    return { status: "red", reasons: [`follow-up session failed: ${e instanceof Error ? e.message : String(e)}`], project: projectDir, checks: [] };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const a = parseArgs(argv);
  if (typeof a === "string") {
    console.error(`live-smoke: ${a}`);
    return 2;
  }
  if (env["RW_LIVE"] !== "1" && !a.rehearse && !a.attach) {
    console.log("bar-live: skipped (set RW_LIVE=1; uses the network and your Claude credentials; non-gating until Q2)");
    return 0;
  }
  mkdirSync(a.outDir, { recursive: true });
  const log = (line: string): void => console.log(`bar-live: ${line}`);
  const bin = sidecar();
  if (a.attach) {
    // W-B2.4 (B16): scripted turns only, no provider and no network.
    const { runAttach } = await import("../../app/e2e/b4b-attach.ts");
    const r = await runAttach({ env: liveAppEnv(env, bin), outDir: a.outDir, log, keep: a.keep });
    console.log(`bar-live: W-B2.4 attach ${r.status}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""} -> ${join(a.outDir, "attach-result.json")}`);
    return 0;
  }
  const model = a.rehearse ? undefined : (a.model ?? PROVIDER_MODELS[a.provider]);
  const parent = mkdtempSync("/tmp/rw-b4b-");
  const projectDir = join(parent, B4B_PROJECT_NAME);
  execFileSync(bin, ["init", "--template", "minimum", projectDir], { stdio: ["ignore", "ignore", "inherit"] });
  log(`project ${projectDir}`);

  let result: B4bResult;
  let session: B4bSession | undefined;
  try {
    // Loaded only here: Playwright resolves from app/e2e (the scoreboard imports this module without it).
    const { launchB4bApp } = await import("../../app/e2e/b4b-live.ts");
    const appEnv = liveAppEnv(env, bin);
    const rehearse = [B4B_REHEARSAL_FIXTURE, ...(a.mention ? [MENTION_REHEARSAL_FIXTURE] : [])];
    session = await launchB4bApp({ projectDir, env: appEnv, outDir: a.outDir, log, ...(a.rehearse ? { rehearse } : model === undefined ? {} : { model }) });
    const drive = await driveB4b(session, { outDir: a.outDir, timeoutMs: a.timeoutMs, log });
    // W-B2 step 3 (B16b): the B4(b) thread's next turn, before the app closes; recorded apart from B4(b).
    let mention: MentionResult | undefined;
    if (a.mention) {
      mention = isMentionSession(session)
        ? await driveMention(session, { outDir: join(a.outDir, "mention"), earlier: drive.transcript === null ? [] : [drive.transcript], timeoutMs: Math.min(a.timeoutMs, MENTION_TIMEOUT_MS), log }).catch(
            (e: unknown): MentionResult => ({ ...mentionNotRun(`mention: the step failed: ${e instanceof Error ? e.message : String(e)}`), status: "red" }),
          )
        : mentionNotRun("mention: needs the embedded Lecturn pane");
    }
    const want = drive.app?.sim && drive.app.run_id ? { sim: drive.app.sim, run_id: drive.app.run_id } : null;
    const declines = [...((session as Partial<{ providerDeclines: ProviderRequestEntry[] }>).providerDeclines ?? [])];
    const saveProj = (session as Partial<{ saveProjection(file: string): Promise<boolean> }>).saveProjection;
    if (saveProj !== undefined) await saveProj.call(session, join(a.outDir, "projection.json")).catch((e: unknown) => log(`projection: ${e instanceof Error ? e.message : String(e)}`));
    await session.close();
    session = undefined;
    let files: B4bObservation | null = null;
    // The closing app's sidecar may still hold the project socket for a moment (it drains): retry briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        files = filesRun(bin, projectDir, want);
        break;
      } catch (e) {
        if (attempt < 4) {
          await sleep(2000);
          continue;
        }
        drive.errors.push(`project files: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    result = judge(drive, files);
    if (declines.length > 0) result.provider_requests = declines;
    if (mention !== undefined) result.mention = mention;
    // The follow-up turn (D14, decision 12): its own launch, recorded apart from the B4(b) turn's limits.
    if (a.followUp) result.follow_up = await followUp(a, parent, appEnv, model, log);
  } catch (e) {
    result = {
      status: "red",
      infra: true,
      reasons: [`app session failed: ${e instanceof Error ? e.message : String(e)}`],
      prompt: B4B_PROMPT,
    };
  } finally {
    await session?.close().catch(() => undefined);
  }
  result.project = projectDir;
  if (a.rehearse) result.rehearsal = true;
  else {
    result.provider = a.provider;
    if (model !== undefined) result.model = model;
  }
  save(a, result);
  if (!a.keep) rmSync(parent, { recursive: true, force: true });
  return 0;
}

// No top-level await: `app/e2e/b4b-live.ts` imports this module back, and a
// pending top-level await here would deadlock that cycle.
if (import.meta.main) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
