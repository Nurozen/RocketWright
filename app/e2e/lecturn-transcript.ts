/**
 * A Lecturn thread's turn as the old timeline events (B14): the B4(b)
 * driver (`scripts/bar/live-smoke.ts` `driveB4b`) reads the prompt's turn,
 * its tool calls, approvals and end from `TimelineEvent`s. With the
 * embedded pane the turn lives in Lecturn, so the embed session
 * (`b4b-live.ts`, `--rehearse`) reads the thread's projection through the
 * admin session (`capture/scripted.ts` `LecturnAdmin`) and maps it here.
 *
 * - The turn is the run of the latest user message whose text is the prompt.
 * - `assistant_message` items become `assistant_text`; `dynamic_tool` items
 *   become `tool_call` plus, once settled, `tool_result` (the tool's
 *   structured content, out of Lecturn's card envelope for card tools,
 *   else the lone text block as JSON). Tool names lose Lecturn's `mcp__lecturn__` (or `lecturn.`) and the `rw_` prefix.
 * - App approvals (`connectedAppTool` runtime requests) become
 *   `approval_request` and, once answered, `approval_resolved`.
 * - The run's status is the `turn_end`: completed → complete, interrupted
 *   or cancelled → interrupted, failed or rolled back → error.
 */
import type { ApprovalDecision, TimelineEvent } from "../../scripts/bar/transcript-events.ts";
import type { JsonObject, JsonValue } from "../packages/contracts/src/types.ts";

/** The slice of Lecturn's `OrchestrationV2ThreadProjection` this reads. */
export interface TranscriptProjection {
  runs: readonly { id: string; status: string }[];
  messages: readonly { id: string; runId: string | null; role: string; text: string; createdAt?: string }[];
  turnItems: readonly { id: string; runId: string | null; nodeId?: string | null; type: string; ordinal?: number; status: string; toolName?: string | null; text?: string; input?: unknown; output?: unknown }[];
  runtimeRequests: readonly {
    id: string;
    nodeId?: string;
    /** `command`, `file-change`, ... for the provider's own requests. */
    kind?: string;
    status: string;
    decision?: string;
    connectedAppTool?: { toolName: string; reason: string | null };
  }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `mcp__lecturn__rw_simulate` (Claude) / `lecturn.rw_simulate` (Codex, scripted) / `rw_simulate` → `simulate`. */
export const bareTool = (name: string | null | undefined): string => (name ?? "?").replace(/^(?:mcp__lecturn__|lecturn\.)/, "").replace(/^rw_/, "");

/** What the tool returned, as `saveAs` reads it (Lecturn `savedToolValue`). */
export function toolValue(output: unknown): JsonValue {
  const result = isObject(output) && "result" in output ? output["result"] : output;
  if (!isObject(result)) return (result ?? null) as JsonValue;
  const sc = result["structuredContent"];
  // A card tool's result comes in Lecturn's card envelope (`{lecturnMcpApp, result}`): the tool's own is inside.
  if (isObject(sc) && "lecturnMcpApp" in sc && "result" in sc) return toolValue(sc["result"]);
  if (sc !== undefined) return sc as JsonValue;
  const content = Array.isArray(result["content"]) ? result["content"] : [];
  const only: unknown = content.length === 1 ? content[0] : undefined;
  if (isObject(only) && only["type"] === "text" && typeof only["text"] === "string") {
    try {
      return JSON.parse(only["text"]) as JsonValue;
    } catch {
      return only["text"];
    }
  }
  return result as JsonValue;
}

function isErrorResult(item: { status: string; output?: unknown }): boolean {
  const result = isObject(item.output) && "result" in item.output ? item.output["result"] : item.output;
  return item.status === "failed" || (isObject(result) && result["isError"] === true);
}

const END: Record<string, "complete" | "interrupted" | "error"> = { completed: "complete", interrupted: "interrupted", cancelled: "interrupted", failed: "error", rolled_back: "error" };

const decisionOf = (d: string | undefined): ApprovalDecision | null => (d === undefined ? null : d.startsWith("accept") ? "approve" : "reject");

/** The prompt's turn in `threadId` as timeline events, or null when no user message carries the prompt. */
export function promptTurnOf(p: TranscriptProjection, threadId: string, prompt: string): { threadId: string; turnId: string; events: TimelineEvent[] } | null {
  const user = p.messages.filter((m) => m.role === "user" && m.runId !== null && m.text.trim() === prompt.trim()).at(-1);
  if (user === undefined || user.runId === null) return null;
  const turnId = user.runId;
  const events: TimelineEvent[] = [{ type: "user_message", turnId, text: user.text, mentions: [] }];
  const items = p.turnItems.filter((i) => i.runId === turnId).toSorted((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const nodes = new Set(items.map((i) => i.nodeId).filter((n): n is string => typeof n === "string"));
  for (const i of items) {
    if (i.type === "assistant_message" && typeof i.text === "string" && i.text !== "") events.push({ type: "assistant_text", turnId, text: i.text, final: false });
    else if (i.type === "dynamic_tool") {
      const input = (isObject(i.input) ? i.input : {}) as JsonObject;
      events.push({ type: "tool_call", turnId, callId: i.id, tool: bareTool(i.toolName), input });
      if (i.status === "completed" || i.status === "failed") events.push({ type: "tool_result", turnId, callId: i.id, isError: isErrorResult(i), output: i.output === undefined ? null : toolValue(i.output) });
    }
  }
  for (const r of p.runtimeRequests) {
    const app = r.connectedAppTool;
    if (app === undefined || (nodes.size > 0 && r.nodeId !== undefined && !nodes.has(r.nodeId))) continue;
    events.push({ type: "approval_request", turnId, request: { approvalId: r.id, threadId, tool: bareTool(app.toolName), input: {}, reason: app.reason ?? "" } });
    const decision = r.status === "resolved" ? decisionOf(r.decision) : null;
    if (decision !== null) events.push({ type: "approval_resolved", turnId, approvalId: r.id, decision });
  }
  const end = END[p.runs.find((r) => r.id === turnId)?.status ?? ""];
  if (end !== undefined) events.push({ type: "turn_end", turnId, status: end });
  return { threadId, turnId, events };
}
