/**
 * The bar harness's transcript record (B17): one agent turn as an ordered
 * list of events, which `app/e2e/lecturn-transcript.ts` builds from a Lecturn
 * thread's projection and the B4(b), follow-up and mention judges score.
 *
 * These were IF10's `TimelineEvent`, `ApprovalRequest` and `ApprovalDecision`
 * while the old chat engine wrote them to `.rw/threads/*.jsonl`. B17 removed
 * that engine and took them out of the app contracts; the harness keeps the
 * shape as its own record format, so the judges did not change.
 */
import type { ApiError, JsonObject, JsonValue, Mention, RwRef } from "../../app/packages/contracts/src/index.ts";

export type ApprovalDecision = "approve" | "reject";

/** A gated tool call that asked the user (a Lecturn app approval). */
export interface ApprovalRequest {
  approvalId: string;
  threadId: string;
  tool: string;
  input: JsonObject;
  reason: string;
}

/** One item of a turn, in order. */
export type TimelineEvent =
  | { type: "turn_start"; turnId: string }
  | { type: "user_message"; turnId: string; text: string; mentions: Mention[] }
  | { type: "assistant_text"; turnId: string; text: string; final: boolean }
  | { type: "tool_call"; turnId: string; callId: string; tool: string; input: JsonObject }
  | { type: "tool_result"; turnId: string; callId: string; isError: boolean; output: JsonValue; step?: string }
  | { type: "approval_request"; turnId: string; request: ApprovalRequest }
  | { type: "approval_resolved"; turnId: string; approvalId: string; decision: ApprovalDecision }
  | { type: "result_card"; turnId: string; kind: "step" | "run" | "render"; ref: RwRef; title: string }
  | { type: "turn_end"; turnId: string; status: "complete" | "interrupted" | "error" }
  | { type: "error"; turnId: string | null; error: ApiError };
