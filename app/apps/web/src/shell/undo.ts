/**
 * Undo/redo over the design history (02.shell.undo-redo). There is no
 * separate undo stack: the position is derived from the history steps
 * alone, and moving it is an ordinary `history_restore` (a new step whose
 * tree equals an earlier one, D3).
 *
 * Walking the steps oldest first builds an editor-style line of states:
 * an ordinary step drops every state after the current one and appends
 * itself; a restore step (tool `history_restore`, default title
 * `Restore step:N` / `Restore rev:NN`) to a state on the line only moves the
 * position there. So undo = restore the state before the position, redo =
 * restore the state after it, and a new edit after an undo clears redo.
 * Pure.
 */
import type { HistoryStep, Revision } from "@rw/contracts";
import type { DeepReadonly } from "../state/index.ts";

type Step = Pick<DeepReadonly<HistoryStep>, "seq" | "title"> & { tool?: string | null | undefined };
type Rev = Pick<DeepReadonly<Revision>, "number" | "step">;

export interface UndoState {
  /** The step whose state the workspace shows (a restore step maps to the step it restored). */
  shown: number | null;
  /** Restore target for undo / redo (step seqs), or null when there is nothing to move to. */
  undo: number | null;
  redo: number | null;
}

/** The version a restore step restored (`Restore step:3` → 3), else null. */
export function restoreTarget(step: Step, revisions: readonly Rev[] = []): number | null {
  if (step.tool !== "history_restore") return null;
  const m = /^Restore (step|rev):(\d+)$/.exec(step.title.trim());
  if (m === null) return null;
  const n = Number(m[2]);
  if (m[1] === "step") return n;
  return revisions.find((r) => r.number === n)?.step ?? null;
}

/** Human title of a step (`Restore step:3` → `Restored Step 03`); other titles unchanged. */
export function stepTitle(step: Step): string {
  const m = /^Restore (step|rev):(\d+)$/.exec(step.title.trim());
  if (step.tool !== "history_restore" || m === null) return step.title;
  return `Restored ${m[1] === "step" ? "Step" : "Rev"} ${m[2]!.padStart(2, "0")}`;
}

/**
 * The state a step stands for: itself, or for a restore step the (canonical)
 * step it restored (`Restore step:4` after step 6 stands for step 4).
 */
export function canonicalStep(steps: readonly Step[], revisions: readonly Rev[], seq: number): number {
  const canon = new Map<number, number>();
  for (const st of [...steps].sort((a, b) => a.seq - b.seq)) {
    const t = restoreTarget(st, revisions);
    canon.set(st.seq, t !== null ? (canon.get(t) ?? t) : st.seq);
    if (st.seq === seq) break;
  }
  return canon.get(seq) ?? seq;
}

export function undoState(steps: readonly Step[], revisions: readonly Rev[] = []): UndoState {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const canon = new Map<number, number>();
  let line: number[] = [];
  let at = -1;
  for (const st of sorted) {
    const t = restoreTarget(st, revisions);
    const c = t !== null ? canon.get(t) : undefined;
    if (c !== undefined) {
      canon.set(st.seq, c);
      const j = line.lastIndexOf(c);
      if (j >= 0) {
        at = j;
        continue;
      }
      // A restore of a state no longer on the line (an abandoned branch): a new state.
      line = [...line.slice(0, at + 1), c];
      at = line.length - 1;
      continue;
    }
    canon.set(st.seq, st.seq);
    line = [...line.slice(0, at + 1), st.seq];
    at = line.length - 1;
  }
  if (at < 0) return { shown: null, undo: null, redo: null };
  return { shown: line[at]!, undo: at > 0 ? line[at - 1]! : null, redo: at < line.length - 1 ? line[at + 1]! : null };
}

/** The shortcut an undo/redo key event means, or null (text fields keep their own undo). */
export function undoKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">): "undo" | "redo" | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = el?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
  return null;
}
