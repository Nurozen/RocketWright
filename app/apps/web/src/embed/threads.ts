/**
 * The left rail's threads once Lecturn runs the chat (B12; D12, D21, D25).
 *
 * The rail keeps its look (`LeftRail.tsx`); only the data changes: the
 * project's Lecturn threads (`embed.threads` pushes, kept in
 * `chat.lecturn.threads`).
 * - Binding (R6.9, W3.5): a thread's `appData` is RocketWright's JSON,
 *   `{"page":<id>}` or `{"artifact":<rw: ref>}`. A thread without one (made in
 *   the guest) is listed on every page until the D12 fallback binds it.
 * - Identity (D25): Lecturn ids change on a live switch, so a rail entry is
 *   keyed by `workspaceRoot` plus the source thread (`copiedFrom.sourceThreadId`
 *   for a copy, D21): a sidecar thread and its copy on the user's server are
 *   one entry, and the selection and title survive the switch.
 *
 * Pure functions over plain data, plus the per-store pane bridge registry the
 * controller drives threads through.
 */
import { parseRef, type EmbedThread, type PageId, type RwRef, type ThreadBinding } from "@rw/contracts";
import type { PaneBridge } from "./bridge.ts";

/** One rail entry: a Lecturn thread (a copy and its sidecar original are one entry). */
export interface RailThread {
  /** Stable rail key: `workspaceRoot#sourceThreadId` in Lecturn mode, the thread id otherwise. */
  id: string;
  /** The thread to open now (the current server's id in Lecturn mode). */
  threadId: string;
  title: string;
  /** Unix ms of the last activity. */
  updatedAt: number;
  busy: boolean;
  /** Where the thread is bound; null when it has no binding yet (listed on every page). */
  binding: ThreadBinding | null;
  /** Lecturn's idle-row subtitle (`<config> / <apogee>`), when set. */
  subtitle?: string;
}

const PAGE_IDS: readonly PageId[] = ["assembly", "components", "configurations", "results", "liquid", "propulsion-sim"];
const isPageId = (v: string): v is PageId => (PAGE_IDS as readonly string[]).includes(v);

/** `{"page":…}` / `{"artifact":…}` appData, or null when absent or not RocketWright's. */
export function parseAppData(appData: string | null | undefined): ThreadBinding | null {
  if (typeof appData !== "string" || appData === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(appData);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as { page?: unknown; artifact?: unknown };
  if (typeof o.page === "string" && isPageId(o.page)) return { page: o.page };
  if (typeof o.artifact === "string" && "ok" in parseRef(o.artifact)) return { artifact: o.artifact as RwRef };
  return null;
}

/** Most step links an appData carries (it stays ≤ 1 KB). */
export const LINKED_STEPS_MAX = 64;

/**
 * The history steps a thread links through its appData (`"steps": [n, …]`):
 * the steps an imported thread's tool rows and step cards name
 * (`apps/server/src/lecturn/bundle.ts` `linkThreadSteps`), which
 * `HistoryStep.thread` cannot attribute because the history predates the
 * thread. Positive integers only, deduplicated, ascending; [] otherwise.
 */
export function linkedSteps(appData: string | null | undefined): number[] {
  if (typeof appData !== "string" || appData === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(appData);
  } catch {
    return [];
  }
  const steps = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(steps)) return [];
  const out = new Set<number>();
  for (const n of steps) if (typeof n === "number" && Number.isInteger(n) && n > 0 && out.size < LINKED_STEPS_MAX) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/** The appData string of a binding (≤ 1 KB: a page id or one ref). */
export function appDataOf(binding: ThreadBinding): string {
  return JSON.stringify("page" in binding ? { page: binding.page } : { artifact: binding.artifact });
}

/** The sidecar thread a copy came from, else the thread itself (D21). */
export function sourceThreadId(t: Pick<EmbedThread, "threadId" | "copiedFrom">): string {
  return t.copiedFrom?.sourceThreadId ?? t.threadId;
}

/** The rail key of a Lecturn thread: workspace root plus source thread (D25). */
export function railKey(t: Pick<EmbedThread, "workspaceRoot" | "threadId" | "copiedFrom">): string {
  return `${t.workspaceRoot}#${sourceThreadId(t)}`;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Which of two threads under one key the rail shows: the live one (not
 * `continuedIn`, i.e. not the read-only sidecar original of a copy), then the
 * newest.
 */
function better(a: EmbedThread, b: EmbedThread): EmbedThread {
  const ac = a.continuedIn !== undefined;
  const bc = b.continuedIn !== undefined;
  if (ac !== bc) return ac ? b : a;
  return ms(b.updatedAt) > ms(a.updatedAt) ? b : a;
}

/** Every Lecturn thread as one rail entry per source thread, newest first. */
export function embedRailThreads(threads: readonly EmbedThread[]): RailThread[] {
  const byKey = new Map<string, { shown: EmbedThread; updatedAt: number; busy: boolean }>();
  for (const t of threads) {
    const key = railKey(t);
    const prev = byKey.get(key);
    const busy = t.state !== "idle";
    if (prev === undefined) byKey.set(key, { shown: t, updatedAt: ms(t.updatedAt), busy });
    else byKey.set(key, { shown: better(prev.shown, t), updatedAt: Math.max(prev.updatedAt, ms(t.updatedAt)), busy: prev.busy || busy });
  }
  return [...byKey.entries()]
    .map(([id, { shown, updatedAt, busy }]): RailThread => {
      const out: RailThread = { id, threadId: shown.threadId, title: shown.title, updatedAt, busy, binding: parseAppData(shown.appData) };
      if (shown.subtitle !== null && shown.subtitle !== "") out.subtitle = shown.subtitle;
      return out;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
}

/** The page a binding lists on: its page, or the page its artifact lives on (`pageOf`, `state/entities.ts`). */
export function listedOn(binding: ThreadBinding | null, page: PageId, pageOf: (ref: RwRef) => PageId | null): boolean {
  if (binding === null) return true;
  return "page" in binding ? binding.page === page : pageOf(binding.artifact) === page;
}

/** The rail key the active Lecturn thread has in `threads`, else `fallback` (the key it had before a switch). */
export function activeRailKey(threads: readonly EmbedThread[] | null, activeThreadId: string | null, fallback: string | null): string | null {
  if (activeThreadId === null) return null;
  const t = threads?.find((x) => x.threadId === activeThreadId);
  return t !== undefined ? railKey(t) : fallback;
}

// ---- the pane bridge per store ------------------------------------------------------------

const panes = new WeakMap<object, PaneBridge>();

/** Registers (or, with null, drops) the mounted pane's bridge for `store` (`ConnectedShell`'s `onBridge`). */
export function setPane(store: object, bridge: PaneBridge | null): void {
  if (bridge === null) panes.delete(store);
  else panes.set(store, bridge);
}

/** The mounted pane's bridge for `store`, or null (not mounted yet). */
export function paneOf(store: object): PaneBridge | null {
  return panes.get(store) ?? null;
}
