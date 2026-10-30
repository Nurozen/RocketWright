/** B14: a Lecturn thread's turn as the B4(b) driver's timeline events (`lecturn-transcript.ts`). */
import { describe, expect, it } from "vitest";
import { transcriptOf, turnEnd } from "../../../scripts/bar/live-smoke.ts";
import { bareTool, promptTurnOf, toolValue, type TranscriptProjection } from "../lecturn-transcript.ts";

const PROMPT = "Design a rocket";
const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

function projection(status: string): TranscriptProjection {
  return {
    runs: [
      { id: "r0", status: "completed" },
      { id: "r1", status },
    ],
    messages: [
      { id: "m0", runId: "r0", role: "user", text: "earlier" },
      { id: "m1", runId: "r1", role: "user", text: ` ${PROMPT} ` },
      { id: "m2", runId: "r1", role: "assistant", text: "Done." },
    ],
    turnItems: [
      { id: "i3", runId: "r1", nodeId: "n1", ordinal: 3, type: "dynamic_tool", status: "completed", toolName: "rw_simulate", input: { sim: "default" }, output: { result: { ...text({ job_id: "j" }), structuredContent: { job_id: "j", run_id: "abc" } } } },
      { id: "i1", runId: "r1", nodeId: "n1", ordinal: 1, type: "user_message", status: "completed", text: PROMPT },
      { id: "i2", runId: "r1", nodeId: "n1", ordinal: 2, type: "assistant_message", status: "completed", text: "Fitting a C6." },
      { id: "i4", runId: "r1", nodeId: "n1", ordinal: 4, type: "dynamic_tool", status: "failed", toolName: "mcp__lecturn__rw_export_file", input: { path: "x" }, output: { result: { ...text({ code: "denied" }), isError: true } } },
      { id: "i5", runId: "r1", nodeId: "n1", ordinal: 5, type: "dynamic_tool", status: "running", toolName: "rw_job_status", input: { job_id: "j" } },
      { id: "x1", runId: "r0", nodeId: "n0", ordinal: 1, type: "dynamic_tool", status: "completed", toolName: "rw_run_list", input: {} },
    ],
    runtimeRequests: [
      { id: "q1", nodeId: "n1", status: "resolved", decision: "decline", connectedAppTool: { toolName: "rw_export_file", reason: "Writes a file" } },
      { id: "q2", nodeId: "n1", status: "pending", connectedAppTool: { toolName: "rw_simulate", reason: null } },
      { id: "q3", nodeId: "n0", status: "resolved", decision: "accept", connectedAppTool: { toolName: "rw_render", reason: "old" } },
      { id: "q4", nodeId: "n1", status: "pending" },
    ],
  };
}

describe("promptTurnOf (lecturn-transcript.ts)", () => {
  it("maps the prompt's run to user, assistant, tool, approval and end events", () => {
    const t = promptTurnOf(projection("completed"), "th", PROMPT);
    expect(t?.turnId).toBe("r1");
    expect(t?.events).toEqual([
      { type: "user_message", turnId: "r1", text: ` ${PROMPT} `, mentions: [] },
      { type: "assistant_text", turnId: "r1", text: "Fitting a C6.", final: false },
      { type: "tool_call", turnId: "r1", callId: "i3", tool: "simulate", input: { sim: "default" } },
      { type: "tool_result", turnId: "r1", callId: "i3", isError: false, output: { job_id: "j", run_id: "abc" } },
      { type: "tool_call", turnId: "r1", callId: "i4", tool: "export_file", input: { path: "x" } },
      { type: "tool_result", turnId: "r1", callId: "i4", isError: true, output: { code: "denied" } },
      { type: "tool_call", turnId: "r1", callId: "i5", tool: "job_status", input: { job_id: "j" } },
      { type: "approval_request", turnId: "r1", request: { approvalId: "q1", threadId: "th", tool: "export_file", input: {}, reason: "Writes a file" } },
      { type: "approval_resolved", turnId: "r1", approvalId: "q1", decision: "reject" },
      { type: "approval_request", turnId: "r1", request: { approvalId: "q2", threadId: "th", tool: "simulate", input: {}, reason: "" } },
      { type: "turn_end", turnId: "r1", status: "complete" },
    ]);
    // The driver's transcript reads it as it read the old thread files.
    const tr = transcriptOf("th", t!.events, PROMPT);
    expect(tr.turn_status).toBe("complete");
    expect(tr.tool_calls.map((c) => [c.tool, c.isError])).toEqual([
      ["simulate", false],
      ["export_file", true],
      ["job_status", null],
    ]);
  });

  it("ends the turn only once the run settled, and maps interrupted and failed runs", () => {
    expect(turnEnd(promptTurnOf(projection("running"), "th", PROMPT)!.events)).toBeNull();
    expect(turnEnd(promptTurnOf(projection("cancelled"), "th", PROMPT)!.events)).toBe("interrupted");
    expect(turnEnd(promptTurnOf(projection("failed"), "th", PROMPT)!.events)).toBe("error");
  });

  it("is null without a user message carrying the prompt", () => {
    expect(promptTurnOf(projection("completed"), "th", "something else")).toBeNull();
  });

  it("strips Lecturn's and RocketWright's prefixes and reads results as saveAs does", () => {
    expect(bareTool("mcp__lecturn__rw_model_patch")).toBe("model_patch");
    expect(bareTool("lecturn.rw_engine_simulate")).toBe("engine_simulate");
    expect(bareTool(null)).toBe("?");
    expect(toolValue({ result: text({ a: 1 }) })).toEqual({ a: 1 });
    expect(toolValue({ result: { content: [{ type: "text", text: "plain" }] } })).toBe("plain");
    expect(toolValue(null)).toBeNull();
    // A card tool's result, in Lecturn's card envelope.
    expect(toolValue({ result: { content: [], structuredContent: { lecturnMcpApp: { resourceUri: "ui://rw/run-card" }, result: { structuredContent: { job_id: "j" } } } } })).toEqual({ job_id: "j" });
  });
});
