/**
 * What the app does with the mounted embed (B12; D12, D21, D25), given its
 * `PaneBridge` (B10):
 * - `lecturn/navigate {ref}` → `openRef` (`state/navigation.ts`): `rw:c/<id>`
 *   selects and frames the part, `rw:run/<id>` opens Results, `rw:step/<n>`
 *   opens history at that step.
 * - `lecturn/thread.changed` / `lecturn/ready` → the rail's selected thread;
 *   a thread made in the guest without `appData` is bound to the current
 *   page (`setThreadAppData`, the D12 fallback).
 * - One `MENTION_EVENT` listener (the viewport's `@` on a part, the
 *   component tree): `insertMention {ref, label, iconUrl: part thumbnail}`.
 * - After each completed flight run, the thread that made it gets the
 *   idle-row subtitle `<config> / <apogee>` (Lecturn mobile shows it).
 * - Host context (`hostContext.ts`) while the pane is up.
 * - The per-page composer placeholder and `rw:` ref labels
 *   (`composerHints.ts`), when the pane's helper offers them.
 */
import type { EmbedThread, Mention, RwRef, schema } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import { MENTION_EVENT } from "./mention.ts";
import { openRef } from "../state/navigation.ts";
import type { RpcLike } from "../state/rpc.ts";
import type { AppStore } from "../state/store.ts";
import type { AppState } from "../state/types.ts";
import type { MentionParams, PaneBridge } from "./bridge.ts";
import { startComposerHints } from "./composerHints.ts";
import { startHostContext } from "./hostContext.ts";
import { appDataOf } from "./threads.ts";

type RunListEntry = schema.RunListEntry;

/** Lecturn's cap on a mention chip's `iconUrl` (`EmbedInsertMentionParams`). */
export const MENTION_ICON_MAX = 96 * 1024;

/** The `insertMention` params for a mention: a component's chip carries its part thumbnail when one is rendered and small enough. */
export function mentionParams(s: AppState, m: Pick<Mention, "ref" | "label">): MentionParams {
  const p = parseRef(m.ref);
  const thumb = "ok" in p && p.ok.kind === "c" ? s.thumbs.urls[p.ok.id] : undefined;
  return thumb !== undefined && thumb.length <= MENTION_ICON_MAX ? { ref: m.ref, label: m.label, iconUrl: thumb } : { ref: m.ref, label: m.label };
}

/** `<config> / <apogee>` of a completed flight run (≤ 80 chars), or null for runs without an apogee. */
export function runSubtitle(entry: { readonly config: string; readonly summary?: { readonly apogee_m?: number } | null }): string | null {
  const apogee = entry.summary?.apogee_m;
  if (typeof apogee !== "number" || !Number.isFinite(apogee)) return null;
  const tail = ` / ${apogee.toFixed(2)} m`;
  return `${entry.config.slice(0, 80 - tail.length)}${tail}`;
}

/**
 * The Lecturn thread a run that just completed belongs to: the shown thread
 * if a turn runs in it, else the one thread with a turn running, else the
 * shown one (the run was started from the window).
 */
export function runThread(threads: readonly EmbedThread[], activeThreadId: string | null): EmbedThread | undefined {
  const active = threads.find((t) => t.threadId === activeThreadId);
  if (active !== undefined && active.state !== "idle") return active;
  const busy = threads.filter((t) => t.state !== "idle");
  return busy.length === 1 ? busy[0] : active;
}

/** Completed runs of `runs` whose ids are not in `seen` (marked seen). */
export function newlyCompleted<R extends Pick<RunListEntry, "status" | "run_id">>(runs: readonly R[], seen: Set<string>): R[] {
  const out: R[] = [];
  for (const r of runs) {
    if (r.status !== "complete" || r.run_id == null || seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    out.push(r);
  }
  return out;
}

export interface WireOptions {
  /** The window the mention events come from (default `window`). */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  hostContextDelayMs?: number;
  onError?: (e: unknown) => void;
}

/** Wires the mounted pane for `projectId`; returns its stop. */
export function wirePane(store: AppStore, client: Pick<RpcLike, "call">, projectId: string, bridge: PaneBridge, opts: WireOptions = {}): () => void {
  const fail = (e: unknown): void => opts.onError?.(e);
  const offs: (() => void)[] = [];
  const mine = (): boolean => store.getState().project.projectId === projectId;

  // lecturn/navigate: only RocketWright's refs (the registration's refPrefixes).
  offs.push(
    bridge.on("lecturn/navigate", ({ ref }) => {
      if (!mine() || typeof ref !== "string" || !ref.startsWith("rw:") || !("ok" in parseRef(ref))) return;
      openRef(store, ref as RwRef).catch(fail);
    }),
  );

  // The shown thread, and the D12 fallback binding for guest-made threads.
  const bound = new Set<string>();
  const bindIfUnbound = (): void => {
    const s = store.getState();
    const id = s.chat.lecturn.activeThreadId;
    if (!mine() || id === null || bound.has(id)) return;
    const t = s.chat.lecturn.threads?.find((x) => x.threadId === id);
    if (t === undefined) return;
    bound.add(id);
    if (t.appData !== null) return;
    client.call("embed.setThreadAppData", { projectId, threadId: id, appData: appDataOf({ page: s.ui.page }) }).catch(fail);
  };
  const shown = ({ threadId }: { threadId: string | null }): void => {
    store.getState().chat.setLecturnThread(threadId);
    bindIfUnbound();
  };
  offs.push(bridge.on("lecturn/thread.changed", shown), bridge.on("lecturn/ready", shown));

  // One mention listener: the old composer is not mounted while the embed is the pane.
  const target = opts.target ?? globalThis.window;
  const onMention = (e: Event): void => {
    const m = (e as CustomEvent<Partial<Mention>>).detail;
    if (typeof m?.ref !== "string" || typeof m.label !== "string") return;
    bridge.insertMention(mentionParams(store.getState(), { ref: m.ref as RwRef, label: m.label }));
  };
  if (target !== undefined) {
    target.addEventListener(MENTION_EVENT, onMention);
    offs.push(() => target.removeEventListener(MENTION_EVENT, onMention));
  }

  // Run subtitles: runs already on disk when the pane comes up are not news.
  const seen = new Set<string>();
  const runsNow = () => store.getState().project.snapshot?.runs.runs ?? null;
  let seeded = false;
  const seed = (): void => {
    const runs = runsNow();
    if (runs === null) return;
    newlyCompleted(runs, seen);
    seeded = true;
  };
  seed();
  offs.push(
    store.subscribe((s, prev) => {
      if (s.chat.lecturn !== prev.chat.lecturn) bindIfUnbound();
      if (!mine() || s.project.snapshot?.runs === prev.project.snapshot?.runs) return;
      if (!seeded) return seed();
      const done = newlyCompleted(s.project.snapshot?.runs.runs ?? [], seen);
      for (const r of done) {
        const subtitle = runSubtitle(r);
        const t = runThread(s.chat.lecturn.threads ?? [], s.chat.lecturn.activeThreadId);
        if (subtitle === null || t === undefined) continue;
        client.call("embed.setThreadAppData", { projectId, threadId: t.threadId, appData: t.appData, subtitle }).catch(fail);
      }
    }),
  );

  offs.push(startComposerHints(store, bridge));
  offs.push(startHostContext(store, client, projectId, { ...(opts.hostContextDelayMs !== undefined ? { delayMs: opts.hostContextDelayMs } : {}), onError: fail }));

  return () => {
    for (const off of offs.splice(0)) off();
  };
}
