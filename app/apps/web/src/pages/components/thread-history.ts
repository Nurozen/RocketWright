/**
 * Per-thread design history (concept 02 agent pane, "Design history (this
 * thread)"): the steps the open Lecturn thread made (agent steps record
 * their thread) or links in its `appData`, after the step they started from
 * (the baseline), oldest first. Pure.
 *
 * Which step is current: without `current`, the newest listed step. With
 * `current` (the history strip's current step, FID-03-05), the list agrees
 * with the strip: that step is current (appended when it is newer than the
 * thread's own steps), steps before it are done, and steps after it (the
 * strip moved back) are later.
 */
import type { EmbedThread, HistoryStep } from "@rw/contracts";
import { linkedSteps, railKey, sourceThreadId } from "../../embed/threads.ts";
import type { DeepReadonly } from "../../state/index.ts";
import type { ChatSlice } from "../../state/types.ts";

export interface ThreadHistoryItem {
  seq: number;
  title: string;
  ts: string;
  /** The step before the thread's first step (what it started from). */
  baseline: boolean;
  current: boolean;
  /** Done (before the current step), the current step, or later than it. */
  state: "done" | "current" | "later";
}

/**
 * The list for the open Lecturn thread (embedded pane, B10/B12; D21):
 * the steps attributed to it (`HistoryStep.thread` is the Lecturn thread id
 * that made the call, so a copy's sidecar original and the copy count as one
 * thread, keyed like the rail), plus the steps its `appData` links
 * (`linkedSteps`: an imported thread's step cards, whose steps the history
 * cannot attribute). Titles, times and the current step still come from the
 * project's history, so the list never disagrees with the bottom strip.
 */
export function embedThreadSteps(
  steps: readonly DeepReadonly<HistoryStep>[],
  threads: readonly EmbedThread[],
  activeThreadId: string | null,
  current: number | null = null,
): ThreadHistoryItem[] {
  if (activeThreadId === null) return [];
  const active = threads.find((t) => t.threadId === activeThreadId);
  const group = active === undefined ? [] : threads.filter((t) => railKey(t) === railKey(active));
  const ids = new Set<string>([activeThreadId, ...group.flatMap((t) => [t.threadId, sourceThreadId(t)])]);
  const mine = new Set<number>();
  for (const s of steps) if (typeof s.thread === "string" && ids.has(s.thread)) mine.add(s.seq);
  for (const t of group) for (const n of linkedSteps(t.appData)) mine.add(n);
  return historyItems(steps, mine, current);
}

/** The thread's own steps (`mine`) after their baseline, with the current one marked (see the module note). */
function historyItems(steps: readonly DeepReadonly<HistoryStep>[], mine: ReadonlySet<number>, current: number | null): ThreadHistoryItem[] {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const own = sorted.filter((s) => mine.has(s.seq));
  if (own.length === 0) return [];
  const first = own[0]!.seq;
  const before = [...sorted].reverse().find((s) => s.seq < first);
  const items: ThreadHistoryItem[] = [];
  const item = (st: DeepReadonly<HistoryStep>, baseline: boolean): ThreadHistoryItem => ({ seq: st.seq, title: st.title, ts: st.ts, baseline, current: false, state: "done" });
  if (before !== undefined) items.push(item(before, true));
  for (const s of own) items.push(item(s, false));
  const cur = current !== null ? sorted.find((s) => s.seq === current) : undefined;
  if (cur === undefined) {
    items[items.length - 1]!.current = true;
    items[items.length - 1]!.state = "current";
    return items;
  }
  if (!items.some((it) => it.seq === cur.seq) && cur.seq > items[items.length - 1]!.seq) items.push(item(cur, false));
  for (const it of items) {
    it.current = it.seq === cur.seq;
    it.state = it.seq < cur.seq ? "done" : it.seq === cur.seq ? "current" : "later";
  }
  return items;
}

/**
 * The open thread's history for the pane strip: the embed's Lecturn thread
 * (`embedThreadSteps`), empty while the embed is not the pane. `current` is
 * the history strip's current step (`stripCurrentStep`), so both lists mark
 * the same step.
 */
export function openThreadSteps(steps: readonly DeepReadonly<HistoryStep>[], chat: Pick<ChatSlice, "lecturn">, current: number | null): ThreadHistoryItem[] {
  if (!chat.lecturn.embedded) return [];
  return embedThreadSteps(steps, chat.lecturn.threads ?? [], chat.lecturn.activeThreadId, current);
}

/**
 * Steps the agent made: every step with origin `mcp`, plus the steps the
 * open thread made or linked (its items after the baseline).
 */
export function agentSteps(steps: readonly DeepReadonly<HistoryStep>[], items: readonly ThreadHistoryItem[]): Set<number> {
  const out = new Set<number>();
  for (const s of steps) if (s.origin === "mcp") out.add(s.seq);
  for (const it of items) if (!it.baseline) out.add(it.seq);
  return out;
}
