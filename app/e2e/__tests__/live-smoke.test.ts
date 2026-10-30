/**
 * M5.6: the B4(b) live driver, offline. The pure pieces (approval decision,
 * run pick, transcript, env, judge) on synthetic data, and the driver
 * plumbing end to end against the real app server and sidecar: a scripted
 * `B4bSession` stands in for the embedded pane and its agent (B17 removed
 * the old engine's stand-in provider), making the turn's model change and
 * run through the app's own RPC and reporting it as the turn's events, and
 * `driveB4b` → `filesRun` → `judge` must reach `pass` on the minimum
 * template flown on a C6 (about 283 m). No network, no Electron.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../packages/contracts/src/rpc.ts";
import type { JsonObject, JsonValue } from "../../packages/contracts/src/types.ts";
import type { RunListOut, SimulateOut } from "../../packages/contracts/src/generated/types.ts";
import type { ApprovalDecision, ApprovalRequest, TimelineEvent } from "../../../scripts/bar/transcript-events.ts";
import { AppServer } from "../../apps/server/src/rpc/AppServer.ts";
import {
  B4B_APPROVABLE,
  B4B_PROJECT_NAME,
  B4B_PROMPT,
  decideApproval,
  driveB4b,
  evaluateB4b,
  filesRun,
  findPromptTurn,
  judge,
  liveAppEnv,
  parseArgs,
  parseShownNumber,
  pickRun,
  RpcClient,
  sourcesAgree,
  transcriptOf,
  type B4bSession,
  type DriveOutcome,
  type ResultsView,
} from "../../../scripts/bar/live-smoke.ts";
import { sidecarBinary } from "../live.ts";

const entry = (status: RunListOut["runs"][number]["status"], run_id: string | null, apogee: number | null, sim = "default") =>
  ({ sim, sim_name: sim, config: "default", kind: "flight", status, run_id, ...(apogee === null ? {} : { summary: { apogee_m: apogee } }) }) as RunListOut["runs"][number];
const list = (...runs: RunListOut["runs"]): RunListOut => ({ model_hash: "h", runs });

describe("B4(b) pure pieces", () => {
  it("approves only the scenario's gated tools", () => {
    expect(B4B_APPROVABLE).toEqual(["simulate"]);
    expect(decideApproval({ tool: "simulate" })).toBe("approve");
    for (const t of ["export_file", "import_file", "cfd_import", "engine_simulate"]) expect(decideApproval({ tool: t })).toBe("reject");
  });

  it("picks the Complete run closest to 300 m, else the first run, else none", () => {
    expect(pickRun(list(entry("complete", "a", 150), entry("complete", "b", 290, "s2"), entry("outdated", "c", 300)))).toMatchObject({ run_id: "b", run_status: "Complete", apogee_m: 290, sim: "s2", results_visible: false });
    expect(pickRun(list(entry("not_run", null, null), entry("failed", "f", null)))).toMatchObject({ run_id: "f", run_status: "Failed", apogee_m: null });
    expect(pickRun(list(entry("not_run", null, null)))).toBeNull();
    expect(pickRun(null)).toBeNull();
  });

  it("finds the prompt's turn and folds it into a transcript with tool calls and approvals", () => {
    const req: ApprovalRequest = { approvalId: "ap1", threadId: "t1", tool: "export_file", input: { format: "glb", path: "x.glb" }, reason: "r" };
    const events: TimelineEvent[] = [
      { type: "turn_start", turnId: "old" },
      { type: "user_message", turnId: "old", text: "hello", mentions: [] },
      { type: "turn_end", turnId: "old", status: "complete" },
      { type: "turn_start", turnId: "u" },
      { type: "user_message", turnId: "u", text: B4B_PROMPT, mentions: [] },
      { type: "tool_call", turnId: "u", callId: "c1", tool: "simulate", input: { sim: "default" } },
      { type: "tool_result", turnId: "u", callId: "c1", isError: false, output: { job_id: "j" } },
      { type: "approval_request", turnId: "u", request: req },
      { type: "approval_resolved", turnId: "u", approvalId: "ap1", decision: "reject" },
      { type: "assistant_text", turnId: "u", text: "Done.", final: true },
    ];
    const threads = new Map([["t1", events]]);
    const turn = findPromptTurn(threads, B4B_PROMPT);
    expect(turn?.threadId).toBe("t1");
    expect(turn?.turnId).toBe("u");
    const t = transcriptOf("t1", turn!.events);
    expect(t.turn_status).toBeNull();
    expect(t.tool_calls).toEqual([{ callId: "c1", tool: "simulate", input: { sim: "default" }, isError: false, output: { job_id: "j" } }]);
    expect(t.entries.map((e) => e.kind)).toEqual(["user", "tool_call", "tool_result", "approval", "assistant"]);
    expect(t.entries.find((e) => e.kind === "approval")).toMatchObject({ tool: "export_file", decision: "reject" });
    expect(findPromptTurn(threads, "other")).toBeNull();
  });

  it("parses shown numbers and compares the app with the files", () => {
    expect(parseShownNumber("1,283")).toBe(1283);
    expect(parseShownNumber("283")).toBe(283);
    expect(parseShownNumber("—")).toBeNull();
    expect(parseShownNumber("")).toBeNull();
    const o = { run_status: "Complete", apogee_m: 283, results_visible: true, sim: "default", run_id: "a" };
    expect(sourcesAgree(o, { ...o, apogee_m: 283.5 })).toEqual([]);
    expect(sourcesAgree(o, { ...o, run_status: "Outdated" })).toHaveLength(1);
    expect(sourcesAgree(o, { ...o, apogee_m: 300 })).toHaveLength(1);
    expect(sourcesAgree(null, o)).toEqual([]);
  });

  it("gives the app the user's env minus test hooks, the offline flag and the parent session", () => {
    const env = liveAppEnv(
      { HOME: "/h", PATH: "/p", RW_OFFLINE: "1", RW_TEST_HOOKS: "1", ELECTRON_RUN_AS_NODE: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_AGENT_SDK_VERSION: "v", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1" },
      "/bin/rw",
    );
    expect(env).toEqual({ HOME: "/h", PATH: "/p", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_USE_BEDROCK: "1", RW_SIDECAR_BIN: "/bin/rw" });
  });

  it("parses its arguments", () => {
    expect(parseArgs(["--out-dir", "/tmp/o"])).toMatchObject({ outDir: "/tmp/o", resultPath: "/tmp/o/result.json", timeoutMs: 15 * 60_000 });
    expect(parseArgs(["--out", "/tmp/r.json", "--timeout-min", "2"])).toMatchObject({ outDir: "/tmp", resultPath: "/tmp/r.json", timeoutMs: 120_000 });
    expect(parseArgs(["--out"])).toBe("--out needs a path");
    expect(parseArgs(["--timeout-min", "0"])).toMatch(/positive/);
  });

  it("judges: the files decide the run, the UI decides visibility, the turn must complete", () => {
    const app = { run_status: "Complete", apogee_m: 283, results_visible: true, sim: "default", run_id: "a" };
    const d: DriveOutcome = {
      transcript: { threadId: "t", prompt: B4B_PROMPT, turn_status: "complete", entries: [], tool_calls: [] },
      approvals: [],
      timedOut: false,
      duration_s: 1,
      app,
      results: { visible: true, via: "reveal-card", row: null },
      artifacts: [],
      errors: [],
    };
    expect(judge(d, { ...app, results_visible: false })).toMatchObject({ status: "pass", reasons: [], results_via: "reveal-card" });
    expect(judge({ ...d, timedOut: true }, app).reasons[0]).toMatch(/did not finish within 15 min/);
    expect(judge({ ...d, transcript: { ...d.transcript!, turn_status: "error" } }, app).reasons[0]).toBe("turn ended error");
    expect(judge(d, { ...app, apogee_m: 400 }).status).toBe("red");
    expect(judge({ ...d, app: { ...app, results_visible: false } }, app).reasons).toContain("run not visible on the Results page");
    expect(judge({ ...d, app: null }, null).reasons).toContain("run status absent, want Complete");
    // W-B2.1: at most 30 tool calls and 3 min for the B4(b) turn.
    const call = { callId: "c", tool: "design_check", input: {}, output: null, isError: false };
    expect(judge({ ...d, transcript: { ...d.transcript!, tool_calls: Array.from({ length: 30 }, () => call) } }, app).status).toBe("pass");
    expect(judge({ ...d, transcript: { ...d.transcript!, tool_calls: Array.from({ length: 31 }, () => call) } }, app).reasons).toContain("31 tool calls (max 30)");
    expect(judge({ ...d, duration_s: 180.5 }, app).reasons).toContain("turn took 180.5 s (max 180 s)");
    // W-B2.1: with the pane's cards read, a complete flight run card with its chart.
    const card = { kind: "flight", phase: "complete", layout: "narrow", chip: "Saved", title: "Default run", stats: 3, points: 200 };
    expect(judge({ ...d, run_cards: [card] }, app)).toMatchObject({ status: "pass", run_card: card });
    expect(judge({ ...d, run_cards: [{ ...card, points: 0 }] }, app).reasons[0]).toMatch(/^no complete flight run card with its chart/);
    expect(judge(d, app)).not.toHaveProperty("run_card");
    // CPW2A: Claude's meta tools count against the 30, and are listed apart.
    const meta = (tool: string) => ({ ...call, tool });
    const mixed = judge({ ...d, transcript: { ...d.transcript!, tool_calls: [meta("ToolSearch"), call, meta("Skill"), meta("ToolSearch"), ...Array.from({ length: 27 }, () => call)] } }, app);
    expect(mixed.turn).toEqual({ status: "complete", tool_calls: 31, meta_tool_calls: 3, meta_tools: { ToolSearch: 2, Skill: 1 }, duration_s: 1 });
    expect(mixed.reasons).toContain("31 tool calls (max 30)");
    expect(judge(d, app).turn).toEqual({ status: "complete", tool_calls: 0, meta_tool_calls: 0, meta_tools: {}, duration_s: 1 });
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 241, results_visible: true }).status).toBe("pass");
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 239, results_visible: true }).status).toBe("red");
  });
});

const C6 = { op: "replace", path: "/configs/default/motors/mount/motor", value: "generic:RW_C6G" };

/**
 * Stands in for the embedded pane and its agent: on `send` it plays the
 * turn the B4(b) rehearsal scripts (`fixtures/scripted/b4b.json`): a C6 on
 * the minimum rocket, the design check, the default sim run to completion,
 * a run card, all through the app's own RPC (so the project files hold the
 * run), and keeps the turn as its events, as `EmbedSession.promptTurn`
 * reads them from the Lecturn thread. With `gatedExport` the turn first
 * asks for a gated export and waits for the driver's answer; a rejection
 * ends the turn as an error.
 */
class ScriptedSession implements B4bSession {
  readonly projectDir: string;
  private readonly rpc: RpcClient;
  private readonly projectId: string;
  private readonly gatedExport: boolean;
  private readonly events: TimelineEvent[] = [];
  private pending: ApprovalRequest | null = null;
  private calls = 0;
  shots: string[] = [];

  constructor(projectDir: string, rpc: RpcClient, projectId: string, gatedExport: boolean) {
    this.projectDir = projectDir;
    this.rpc = rpc;
    this.projectId = projectId;
    this.gatedExport = gatedExport;
  }

  private emit(e: TimelineEvent): void {
    this.events.push(e);
  }

  /** One tool of the turn: its call, then its result from the app's RPC. */
  private async tool(tool: string, input: JsonObject, run: () => Promise<unknown>): Promise<unknown> {
    const callId = `c${++this.calls}`;
    this.emit({ type: "tool_call", turnId: "u", callId, tool, input });
    const out = await run();
    this.emit({ type: "tool_result", turnId: "u", callId, isError: false, output: out as JsonValue });
    return out;
  }

  async send(prompt: string): Promise<void> {
    this.emit({ type: "turn_start", turnId: "u" });
    this.emit({ type: "user_message", turnId: "u", text: prompt, mentions: [] });
    this.emit({ type: "assistant_text", turnId: "u", text: "Fitting a C6 to the minimum rocket, then checking and simulating.", final: false });
    if (this.gatedExport) {
      const input = { format: "glb", path: "exports/rocket.glb" };
      this.emit({ type: "tool_call", turnId: "u", callId: "c0", tool: "export_file", input });
      this.pending = { approvalId: "ap1", threadId: "t1", tool: "export_file", input, reason: "Writes exports/rocket.glb" };
      this.emit({ type: "approval_request", turnId: "u", request: this.pending });
      return;
    }
    await this.play();
  }

  private async play(): Promise<void> {
    const p = { projectId: this.projectId };
    await this.tool("model_patch", { ops: [C6], label: "C6 motor" }, () => this.rpc.call("model.patch", { ...p, ops: [C6], label: "C6 motor" }));
    await this.tool("design_check", {}, () => this.rpc.call("check.run", p));
    const sim = (await this.tool("simulate", { sim: "default" }, () => this.rpc.call("sim.run", { ...p, sim: "default" }))) as SimulateOut;
    for (let i = 0; i < 300; i++) {
      const runs = await this.tool("job_status", { job_id: sim.job_id ?? "" }, () => this.rpc.runs(this.projectId));
      if ((runs as RunListOut).runs.some((r) => r.sim === "default" && r.status === "complete")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.emit({ type: "result_card", turnId: "u", kind: "run", ref: `rw:run/${sim.run_id}`, title: "Default" });
    this.emit({ type: "assistant_text", turnId: "u", text: "Default is Complete.", final: true });
    this.emit({ type: "turn_end", turnId: "u", status: "complete" });
  }

  async promptTurn(prompt: string) {
    return findPromptTurn(new Map([["t1", this.events]]), prompt);
  }

  async pendingApprovals(): Promise<string[]> {
    return this.pending === null ? [] : [this.pending.approvalId];
  }

  async respond(approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.pending = null;
    this.emit({ type: "approval_resolved", turnId: "u", approvalId, decision });
    if (decision === "approve") return this.play();
    this.emit({ type: "tool_result", turnId: "u", callId: "c0", isError: true, output: { rejected: true } });
    this.emit({ type: "turn_end", turnId: "u", status: "error" });
  }

  async interrupt(): Promise<void> {
    this.emit({ type: "turn_end", turnId: "u", status: "interrupted" });
  }

  appRuns() {
    return this.rpc.runs(this.projectId);
  }

  /** "Results" = the turn left the run's card (its Open shows the run). */
  async showResults(run: { sim: string; run_id: string }): Promise<ResultsView> {
    const card = this.events.some((e) => e.type === "result_card" && e.kind === "run" && e.ref.includes(run.run_id));
    return { visible: card, via: card ? "reveal-card" : null, row: null };
  }

  async screenshot(what: string, file: string): Promise<boolean> {
    this.shots.push(what);
    writeFileSync(file, "png");
    return true;
  }

  async close(): Promise<void> {
    this.rpc.close();
  }
}

describe("B4(b) driver plumbing (scripted session, offline)", () => {
  let bin = "";
  let parent = "";
  const servers: AppServer[] = [];

  beforeAll(() => {
    bin = sidecarBinary();
    parent = mkdtempSync("/tmp/rw-b4bo-");
  }, 600_000);

  afterAll(async () => {
    for (const s of servers) await s.close();
    if (parent !== "") rmSync(parent, { recursive: true, force: true });
  });

  /** A fresh minimum project in a fresh app server, its turn played by `ScriptedSession`; returns the drive and the files check. */
  async function drive(name: string, gatedExport: boolean) {
    const projectDir = join(parent, name, B4B_PROJECT_NAME);
    execFileSync(bin, ["init", "--template", "minimum", projectDir], { stdio: "ignore" });
    const server = await AppServer.start({ bin, stderr: "ignore", testHooks: false, jobPollMs: 50 });
    servers.push(server);
    const rpc = await RpcClient.connect(server.rpcUrl);
    await rpc.call<{ project: ProjectInfo }>("project.open", { dir: projectDir });
    const session = new ScriptedSession(projectDir, rpc, (await rpc.projectFor(projectDir)).projectId, gatedExport);
    const outDir = join(parent, name, "out");
    const d = await driveB4b(session, { outDir, timeoutMs: 120_000, pollMs: 100 });
    await session.close();
    await server.close();
    const files = d.app?.sim && d.app.run_id ? filesRun(bin, projectDir, { sim: d.app.sim, run_id: d.app.run_id }) : filesRun(bin, projectDir, null);
    return { d, files, outDir, session };
  }

  it("drives the turn and judges pass from the app state and the project files", async () => {
    const { d, files, outDir, session } = await drive("pass", false);
    expect(d.errors).toEqual([]);
    expect(d.timedOut).toBe(false);
    expect(d.transcript?.turn_status).toBe("complete");
    expect([...new Set(d.transcript?.tool_calls.map((c) => c.tool))]).toEqual(["model_patch", "design_check", "simulate", "job_status"]); // job_status polls 1+ times
    expect(d.approvals).toEqual([]);
    expect(d.app).toMatchObject({ sim: "default", run_status: "Complete", results_visible: true });
    expect(d.app?.apogee_m).toBeGreaterThan(240);
    expect(d.app?.apogee_m).toBeLessThan(360);
    expect(session.shots).toEqual(["chat-pane", "window", "results"]);
    for (const f of ["transcript.json", "tool-calls.json", "approvals.json", "chat-pane.png", "results.png"]) {
      expect(existsSync(join(outDir, f)), f).toBe(true);
      expect(d.artifacts).toContain(f);
    }
    expect(files).toMatchObject({ run_id: d.app?.run_id, run_status: "Complete" });
    expect(files?.apogee_m).toBeCloseTo(d.app!.apogee_m!, 1);
    expect(judge(d, files)).toMatchObject({ status: "pass", reasons: [], prompt: B4B_PROMPT, results_via: "reveal-card", turn: { status: "complete" } });
  }, 300_000);

  it("records a rejected gated call and reports the turn that ended without a run", async () => {
    const { d, files, outDir } = await drive("reject", true);
    expect(d.approvals.map((a) => [a.tool, a.decision, a.input])).toEqual([["export_file", "reject", { format: "glb", path: "exports/rocket.glb" }]]);
    expect(JSON.parse(readFileSync(join(outDir, "approvals.json"), "utf8"))).toHaveLength(1);
    expect(d.transcript?.tool_calls).toEqual([expect.objectContaining({ tool: "export_file", isError: true, output: { rejected: true } })]);
    expect(d.transcript?.entries.find((e) => e.kind === "approval")).toMatchObject({ tool: "export_file", decision: "reject" });
    expect(files).toBeNull();
    const r = judge(d, files);
    expect(r.status).toBe("red");
    expect(r.reasons).toEqual(["turn ended error", "run status absent, want Complete", "no apogee", "run not visible on the Results page"]);
  }, 300_000);
});
