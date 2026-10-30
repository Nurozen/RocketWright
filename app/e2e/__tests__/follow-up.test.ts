/**
 * B16: the W-B2 follow-up turn and mode checks (`scripts/bar/live-smoke.ts`
 * `driveFollowUp` and its judges; D14, decision 12) against a fake embed
 * session that plays Lecturn: the Supervised approval card for
 * `rw_engine_simulate` with no duration, the Full-access and Auto turns with
 * no card, and `simulate mc=500` answering `not_implemented`. Also the
 * rehearsal fixture and the new arguments.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, TimelineEvent } from "../../../scripts/bar/transcript-events.ts";
import type { JsonObject } from "../../packages/contracts/src/types.ts";
import type { ApprovalAnswerer, ApprovalLogEntry, RuntimeMode } from "../../../scripts/bar/lecturn-admin.ts";
import {
  driveFollowUp,
  FOLLOW_UP_PROMPT,
  FOLLOW_UP_REASON,
  FOLLOW_UP_REHEARSAL_FIXTURE,
  isEmbedTurnSession,
  judgeApprovalTurn,
  judgeMcTurn,
  judgeNoCardTurn,
  MC_PROMPT,
  MODE_CHECK_PROMPTS,
  parseArgs,
  PROVIDER_MODELS,
  type B4bSession,
  type CheckTurn,
  type EmbedTurnSession,
  type FollowUpResult,
} from "../../../scripts/bar/live-smoke.ts";
import type { CardFrameFacts } from "../capture/pane-checks.ts";
import type { ApprovalCardView } from "../embed.ts";
import { loadTurnFixture } from "../embed.ts";

const ENGINE_CARD: CardFrameFacts = { kind: "engine", phase: "complete", layout: "narrow", chip: "Saved", title: "demo", stats: 3, points: 60 };

interface FakeTurn {
  id: string;
  prompt: string;
  mode: RuntimeMode;
  events: TimelineEvent[];
  pending: { id: string; toolName: string; reason: string } | null;
  finish: () => void;
}

/** Plays Lecturn and the agent for the four follow-up prompts. */
class FakeLecturnSession implements EmbedTurnSession {
  readonly projectDir = "/tmp/rv";
  threadId: string | null = null;
  mode: RuntimeMode = "approval-required";
  readonly turns: FakeTurn[] = [];
  seen: string[] = [];
  /** Knobs for the failure cases. */
  durationOnEngine: string | null = null;
  cardInFullAccess = false;
  engineCards: CardFrameFacts[] = [ENGINE_CARD];

  private start(prompt: string): void {
    const turnId = `r${this.turns.length + 1}`;
    const events: TimelineEvent[] = [{ type: "user_message", turnId, text: prompt, mentions: [] }];
    const t: FakeTurn = { id: turnId, prompt, mode: this.mode, events, pending: null, finish: () => undefined };
    this.turns.push(t);
    const end = (): void => void events.push({ type: "turn_end", turnId, status: "complete" });
    if (prompt === MC_PROMPT) {
      events.push({ type: "tool_call", turnId, callId: `${turnId}c`, tool: "simulate", input: { sim: "baseline", mc: 500 } });
      events.push({ type: "tool_result", turnId, callId: `${turnId}c`, isError: true, output: { code: "not_implemented", message: "simulate with mc > 1 (Monte Carlo)" } });
      return end();
    }
    const input: JsonObject = this.durationOnEngine === null ? { engine: "demo" } : { engine: "demo", duration: this.durationOnEngine };
    events.push({ type: "tool_call", turnId, callId: `${turnId}c`, tool: "engine_simulate", input });
    const ran = (): void => void events.push({ type: "tool_result", turnId, callId: `${turnId}c`, isError: false, output: { status: "complete", run_id: "e1" } });
    const gated = this.durationOnEngine === null && (this.mode === "approval-required" || (this.cardInFullAccess && this.mode === "full-access"));
    if (!gated) {
      ran();
      return end();
    }
    t.pending = { id: `${turnId}q`, toolName: "rw_engine_simulate", reason: FOLLOW_UP_REASON };
    this.seen.push(`Approve rw_engine_simulate | ${FOLLOW_UP_REASON}`);
    events.push({ type: "approval_request", turnId, request: { approvalId: t.pending.id, threadId: "th", tool: "engine_simulate", input: {}, reason: FOLLOW_UP_REASON } });
    t.finish = () => {
      events.push({ type: "approval_resolved", turnId, approvalId: `${turnId}q`, decision: "approve" });
      ran();
      end();
    };
  }

  async send(prompt: string): Promise<void> {
    this.threadId = "th";
    this.mode = "approval-required";
    this.seen = [];
    this.start(prompt);
  }
  async sendInThread(prompt: string): Promise<void> {
    this.start(prompt);
  }
  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    this.mode = mode;
  }
  async watchApprovalCards(): Promise<void> {
    this.seen = [];
  }
  async approvalCardsSeen(): Promise<string[]> {
    return [...this.seen];
  }
  async approvalCards(): Promise<ApprovalCardView[]> {
    const p = this.turns.at(-1)?.pending;
    return p ? [{ label: `Approve ${p.toolName}`, reason: p.reason, visible: true }] : [];
  }
  async runCards(): Promise<CardFrameFacts[]> {
    return this.engineCards;
  }
  async answerApprovals(o: { decide: (r: { toolName: string; reason: string | null }) => "accept" | "decline"; before?: (r: { id: string }) => Promise<void> }): Promise<ApprovalAnswerer> {
    const log: ApprovalLogEntry[] = [];
    const tick = async (): Promise<void> => {
      const t = this.turns.at(-1);
      const p = t?.pending;
      if (t === undefined || p === undefined || p === null) return;
      await o.before?.({ id: p.id });
      const decision = o.decide(p);
      log.push({ requestId: p.id, threadId: "th", toolName: p.toolName, reason: p.reason, decision, at_ms: 1 });
      t.pending = null;
      t.finish();
    };
    await tick();
    return { log, provider: [], errors: [], tick, stop: async () => undefined };
  }
  async promptTurn(prompt: string) {
    const t = this.turns.filter((x) => x.prompt === prompt).at(-1);
    return t === undefined ? null : { threadId: "th", turnId: t.id, events: [...t.events] };
  }
  async pendingApprovals(): Promise<string[]> {
    return [];
  }
  async respond(_id: string, _d: ApprovalDecision): Promise<void> {}
  async interrupt(): Promise<void> {}
  async appRuns() {
    return { model_hash: "h", runs: [] };
  }
  async showResults() {
    return { visible: false, via: null, row: null };
  }
  async screenshot(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

async function drive(s: FakeLecturnSession): Promise<FollowUpResult> {
  const dir = mkdtempSync("/tmp/rw-fu-");
  try {
    const r = await driveFollowUp(s, { outDir: dir, pollMs: 1, timeoutMs: 5_000 });
    expect(JSON.parse(readFileSync(join(dir, "follow-up.json"), "utf8"))).toMatchObject({ status: r.status });
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("driveFollowUp (D14, decision 12)", () => {
  it("passes: one approved card with the D6 reason, no card in Full access or Auto, mc=500 not_implemented", async () => {
    const s = new FakeLecturnSession();
    const r = await drive(s);
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe("pass");
    expect(r.checks.map((c) => [c.name, c.mode, c.status])).toEqual([
      ["approval", "approval-required", "pass"],
      ["full-access", "full-access", "pass"],
      ["auto", "auto", "pass"],
      ["mc500", "approval-required", "pass"],
    ]);
    expect(s.turns.map((t) => [t.prompt, t.mode])).toEqual([
      [FOLLOW_UP_PROMPT, "approval-required"],
      [MODE_CHECK_PROMPTS["full-access"], "full-access"],
      [MODE_CHECK_PROMPTS.auto, "auto"],
      [MC_PROMPT, "approval-required"],
    ]);
    const a = r.checks[0]!;
    expect(a.approvals.map((x) => [x.toolName, x.reason, x.decision])).toEqual([["rw_engine_simulate", FOLLOW_UP_REASON, "accept"]]);
    expect(a.card_shown).toEqual({ label: "Approve rw_engine_simulate", reason: FOLLOW_UP_REASON, visible: true });
    expect(a.engine_card).toEqual(ENGINE_CARD);
    // Recorded apart from B4(b)'s limits.
    expect(r.turn).toMatchObject({ status: "complete", tool_calls: 1 });
  });

  it("fails visibly when the agent sets a duration, a card shows in Full access, or no engine card renders", async () => {
    const withDuration = new FakeLecturnSession();
    withDuration.durationOnEngine = "30 s";
    const r1 = await drive(withDuration);
    expect(r1.status).toBe("red");
    expect(r1.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/approval: rw_engine_simulate was called with duration "30 s"/), "approval: 0 app approvals were answered, want 1"]));
    expect(r1.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^Full access: rw_engine_simulate was called with a duration/)]));
    const carded = new FakeLecturnSession();
    carded.cardInFullAccess = true;
    carded.engineCards = [{ ...ENGINE_CARD, points: 0 }];
    const r2 = await drive(carded);
    expect(r2.checks.find((c) => c.name === "full-access")?.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/1 app approvals were raised, want none/), expect.stringMatching(/the pane showed approval cards/)]));
    expect(r2.checks.find((c) => c.name === "auto")?.status).toBe("pass");
    expect(r2.checks[0]!.reasons).toEqual([expect.stringMatching(/no complete engine run card with its thrust chart/)]);
  });
});

const turn = (events: TimelineEvent[], o: Partial<CheckTurn> = {}): CheckTurn => {
  const calls = events.filter((e): e is Extract<TimelineEvent, { type: "tool_call" }> => e.type === "tool_call");
  return {
    transcript: {
      threadId: "t",
      prompt: "p",
      turn_status: "complete",
      entries: [],
      tool_calls: calls.map((c) => {
        const r = events.find((e): e is Extract<TimelineEvent, { type: "tool_result" }> => e.type === "tool_result" && e.callId === c.callId);
        return { callId: c.callId, tool: c.tool, input: c.input, isError: r?.isError ?? null, output: r?.output ?? null };
      }),
    },
    timedOut: false,
    duration_s: 1,
    approvals: [],
    cards_seen: [],
    errors: [],
    ...o,
  };
};

describe("follow-up judges", () => {
  const call = (tool: string, input: JsonObject, isError: boolean, output: JsonObject): TimelineEvent[] => [
    { type: "tool_call", turnId: "r", callId: tool, tool, input },
    { type: "tool_result", turnId: "r", callId: tool, isError, output },
  ];
  const approved: ApprovalLogEntry = { requestId: "q", threadId: "t", toolName: "rw_engine_simulate", reason: FOLLOW_UP_REASON, decision: "accept", at_ms: 5 };
  const card: ApprovalCardView = { label: "Approve rw_engine_simulate", reason: FOLLOW_UP_REASON, visible: true };

  it("approval turn: needs the call without a duration, one approved request with the D6 reason, the card, and the engine card", () => {
    const ok = turn(call("engine_simulate", { engine: "demo", duration: null }, false, { status: "complete" }), { approvals: [approved] });
    expect(judgeApprovalTurn(ok, card, [ENGINE_CARD])).toEqual([]);
    expect(judgeApprovalTurn({ ...ok, approvals: [{ ...approved, reason: "Engine burn of 120 s (over 60 s)" }] }, card, [ENGINE_CARD])).toEqual([expect.stringMatching(/the reason was "Engine burn of 120 s \(over 60 s\)"/)]);
    expect(judgeApprovalTurn({ ...ok, approvals: [{ ...approved, decision: "decline" }] }, card, [ENGINE_CARD])).toEqual(["approval: the request was not approved"]);
    expect(judgeApprovalTurn(ok, null, [ENGINE_CARD])).toEqual([expect.stringMatching(/no approval card was on screen/)]);
    expect(judgeApprovalTurn(ok, { ...card, reason: "other" }, [ENGINE_CARD])).toEqual([expect.stringMatching(/reason line reads "other"/)]);
    const failed = turn(call("engine_simulate", { engine: "demo" }, true, { code: "approval_required" }), { approvals: [approved] });
    expect(judgeApprovalTurn(failed, card, [ENGINE_CARD])).toEqual([expect.stringMatching(/did not complete/)]);
    expect(judgeApprovalTurn(turn([]), card, [])).toEqual(expect.arrayContaining(["approval: rw_engine_simulate was never called", "approval: 0 app approvals were answered, want 1"]));
    expect(judgeApprovalTurn({ ...ok, timedOut: true }, card, [ENGINE_CARD])[0]).toMatch(/did not finish within 5 min/);
  });

  it("Full access and Auto: the gated call ran with no approval and no card", () => {
    const ok = turn(call("engine_simulate", { engine: "demo" }, false, { status: "complete" }));
    expect(judgeNoCardTurn(ok, "full-access")).toEqual([]);
    expect(judgeNoCardTurn({ ...ok, cards_seen: ["Approve rw_engine_simulate | r"] }, "auto")).toEqual([expect.stringMatching(/^Auto: the pane showed approval cards/)]);
    expect(judgeNoCardTurn({ ...ok, approvals: [approved] }, "auto")).toEqual(["Auto: 1 app approvals were raised, want none"]);
    expect(judgeNoCardTurn(turn([]), "full-access")).toEqual(["Full access: rw_engine_simulate was never called"]);
  });

  it("mc=500: not_implemented, no approval, no card", () => {
    const ok = turn(call("simulate", { sim: "baseline", mc: 500 }, true, { code: "not_implemented" }));
    expect(judgeMcTurn(ok)).toEqual([]);
    expect(judgeMcTurn(turn(call("simulate", { sim: "baseline", mc: "500" }, true, { code: "not_implemented" })))).toEqual([]);
    expect(judgeMcTurn(turn(call("simulate", { sim: "baseline" }, false, { job_id: "j" })))).toEqual(["mc500: rw_simulate was never called with mc 500"]);
    expect(judgeMcTurn(turn(call("simulate", { sim: "baseline", mc: 500 }, true, { code: "approval_required" })))).toEqual([expect.stringMatching(/did not return not_implemented/)]);
    expect(judgeMcTurn({ ...ok, cards_seen: ["x"] })).toEqual([expect.stringMatching(/showed approval cards/)]);
  });
});

describe("follow-up plumbing", () => {
  it("the rehearsal fixture scripts the four turns in order", () => {
    const f = loadTurnFixture(FOLLOW_UP_REHEARSAL_FIXTURE);
    expect(f.prompt).toBe(FOLLOW_UP_PROMPT);
    expect(Object.keys(f.scripts)).toEqual(["1", "2", "3", "4"]);
    const calls = (k: string) => f.scripts[k]!.flatMap((s) => ("toolCall" in s ? [s.toolCall] : []));
    expect(f.scripts["1"]!.findIndex((s) => "expectApproval" in s)).toBeLessThan(f.scripts["1"]!.findIndex((s) => "toolCall" in s));
    for (const k of ["1", "2", "3"]) expect(calls(k)).toEqual([{ name: "rw_engine_simulate", arguments: { engine: "demo" } }]);
    expect(calls("4")).toEqual([{ name: "rw_simulate", arguments: { sim: "baseline", mc: 500 } }]);
  });

  it("parses --provider, --model, --no-follow-up and --attach", () => {
    expect(parseArgs([])).toMatchObject({ provider: "claude", model: null, followUp: true, attach: false });
    expect(parseArgs(["--provider", "codex", "--no-follow-up"])).toMatchObject({ provider: "codex", followUp: false });
    expect(parseArgs(["--model", "claudeAgent/claude-opus-x"])).toMatchObject({ model: { instanceId: "claudeAgent", model: "claude-opus-x" } });
    expect(parseArgs(["--provider", "gemini"])).toBe("--provider is claude or codex");
    expect(parseArgs(["--model", "nomodel"])).toBe("--model needs <instance>/<model>");
    expect(parseArgs(["--attach"])).toMatchObject({ attach: true, resultPath: expect.stringMatching(/live\/attach\/result\.json$/) });
    expect(PROVIDER_MODELS.claude.instanceId).toBe("claudeAgent");
    expect(PROVIDER_MODELS.codex.instanceId).toBe("codex");
  });

  it("tells a session with the embed's turn reach from one without", () => {
    expect(isEmbedTurnSession(new FakeLecturnSession())).toBe(true);
    expect(isEmbedTurnSession({ projectDir: "/x" } as unknown as B4bSession)).toBe(false);
  });
});
