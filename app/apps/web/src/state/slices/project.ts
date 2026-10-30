/** `project`: the read-only mirror of the server's ProjectHost snapshot (IF10). */
import type { ProjectPatch, ProjectSnapshot, RwRef, SnapshotKey } from "@rw/contracts";
import { RpcCallError, type RpcLike } from "../rpc.ts";
import type { AppState, DeepReadonly, ProjectSlice, SliceCtx } from "../types.ts";
import { handshake, loadWasm } from "../wasm.ts";
import { onEmbedThreads, onLecturnSwitch } from "./chat.ts";
import { followRerun, rowKey } from "./runs.ts";

/** Freezes `v` and everything reachable from it (the mirror is never edited in place). */
export function deepFreeze<T>(v: T): DeepReadonly<T> {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v as DeepReadonly<T>;
}

const COMPONENT_REF = /^rw:c\/([^#@/]+)/;

export function createProjectSlice(ctx: SliceCtx): ProjectSlice {
  return {
    projectId: null,
    connection: "idle",
    hello: null,
    snapshot: null,
    subscriptionId: null,
    updatedAt: null,
    error: null,

    async connect(client: RpcLike, projectId: string): Promise<void> {
      ctx.get().project.disconnect();
      ctx.client = client;
      ctx.projectId = projectId;
      ctx.patch("project", { projectId, connection: "connecting", hello: client.hello, error: null });

      const mine = (sid: string): boolean => sid === ctx.get().project.subscriptionId;
      ctx.cleanup.push(
        client.on("project.snapshot", (p) => mine(p.subscriptionId) && applySnapshot(ctx, p.snapshot)),
        client.on("project.patch", (p) => mine(p.subscriptionId) && p.patch.projectId === projectId && applyPatch(ctx, p.patch)),
        // B12: the project's Lecturn threads feed the rail (title, age, busy); a live switch remaps the shown one (D25).
        client.on("embed.threads", (p) => p.projectId === projectId && onEmbedThreads(ctx, p.threads)),
        client.on("lecturn.status", (st) => onLecturnSwitch(ctx, st)),
        client.onClose((reason) => {
          if (ctx.client === client) ctx.patch("project", { connection: "closed", error: reason });
        }),
      );

      const wasm = loadWasm(client.hello.coreVersion, wrapLoad(ctx));
      try {
        const sub = await client.call("project.subscribe", { projectId });
        if (ctx.client !== client) return;
        ctx.patch("project", { subscriptionId: sub.subscriptionId, connection: "open" });
        applySnapshot(ctx, sub.snapshot);
      } catch (e) {
        if (ctx.client === client) ctx.patch("project", { connection: "error", error: message(e) });
        throw e;
      }
      const handle = await wasm;
      if (ctx.client !== client) return;
      // Prefer the sidecar's own version once the mirror reports it.
      const sidecarVersion = ctx.get().project.snapshot?.sidecar.version;
      const h = ctx.core !== null && sidecarVersion != null ? handshake(ctx.core, sidecarVersion) : handle;
      ctx.patch("draft", { engine: h.status });
    },

    disconnect(): void {
      const { client, projectId } = ctx;
      const sid = ctx.get().project.subscriptionId;
      for (const fn of ctx.cleanup.splice(0)) fn();
      if (client !== null && projectId !== null) {
        if (sid !== null) client.call("project.unsubscribe", { subscriptionId: sid }).catch(() => undefined);
      }
      ctx.client = null;
      ctx.projectId = null;
      if (ctx.get().project.connection !== "idle") {
        ctx.patch("project", { projectId: null, connection: "idle", hello: null, snapshot: null, subscriptionId: null, updatedAt: null, error: null });
      }
    },
  };
}

function wrapLoad(ctx: SliceCtx) {
  return async () => {
    ctx.patch("draft", { engine: { state: "loading" } });
    const core = await ctx.loadCore();
    ctx.core = core;
    return core;
  };
}

function message(e: unknown): string {
  return e instanceof RpcCallError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

/** Structural equality of two JSON values (the mirror holds JSON only). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && jsonEqual(ra[k], rb[k]));
}

/** `v` frozen, or `prev` itself when it already holds the same value (keeps identity for memoised selectors). */
function share(prev: unknown, v: unknown): unknown {
  return prev !== undefined && jsonEqual(prev, v) ? prev : deepFreeze(structuredClone(v));
}

/**
 * Replaces the whole mirror. Keys whose content did not change keep their
 * identity: the server pushes `project.snapshot` right after answering
 * `project.subscribe` with the same snapshot, so without sharing every key
 * would churn on connect (FLK2), and a resync would re-render every selector.
 */
export function applySnapshot(ctx: SliceCtx, snap: ProjectSnapshot): void {
  const prev = ctx.get().project.snapshot;
  let snapshot: DeepReadonly<ProjectSnapshot>;
  if (prev === null) {
    snapshot = deepFreeze(structuredClone(snap));
  } else {
    const old = prev as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    let same = Object.keys(old).length === Object.keys(snap).length;
    for (const [k, v] of Object.entries(snap)) {
      next[k] = share(old[k], v);
      same &&= next[k] === old[k];
    }
    snapshot = same ? prev : (Object.freeze(next) as unknown as DeepReadonly<ProjectSnapshot>);
  }
  ctx.patch("project", { snapshot, updatedAt: ctx.now() });
  afterMirrorChange(ctx, prev);
}

/** Replaces the keys present in `patch` (wholesale per key, IF10); unchanged keys keep identity. */
export function applyPatch(ctx: SliceCtx, patch: ProjectPatch): void {
  const prev = ctx.get().project.snapshot;
  if (prev === null) return;
  const next = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "projectId" || v === undefined) continue;
    next[k as SnapshotKey] = share(next[k], v);
  }
  ctx.patch("project", { snapshot: Object.freeze(next) as unknown as DeepReadonly<ProjectSnapshot>, updatedAt: ctx.now() });
  afterMirrorChange(ctx, prev);
}

/** Keeps dependent slices consistent with a new mirror. */
function afterMirrorChange(ctx: SliceCtx, prev: AppState["project"]["snapshot"]): void {
  const s = ctx.get();
  const snap = s.project.snapshot;
  if (snap === null) return;

  // Draft: another writer committed underneath unsaved edits.
  const hash = snap.evaluated?.model_hash ?? snap.files.model_hash;
  if (s.draft.ops.length > 0 && s.draft.baseHash !== null && s.draft.baseHash !== hash && !s.draft.stale) {
    ctx.patch("draft", { stale: true });
  }

  // Selection: drop component refs that no longer exist.
  if (snap.evaluated !== null && snap.evaluated !== prev?.evaluated) {
    const ids = new Set(snap.evaluated.components.map((c) => c.id));
    const kept = s.selection.refs.filter((r: RwRef) => {
      const m = COMPONENT_REF.exec(r);
      return m === null || ids.has(m[1]!);
    });
    if (kept.length !== s.selection.refs.length) ctx.patch("selection", (sel) => ({ refs: kept, seq: sel.seq + 1 }));
  }

  // Runs: drop overlay rows that vanished; a rerun of a plotted sim plots before/after.
  const keys = new Set(snap.runs.runs.map(rowKey));
  const kept = s.runs.overlay.filter((x) => keys.has(x));
  const overlay = followRerun(prev?.runs.runs ?? null, snap.runs.runs, kept) ?? kept;
  if (overlay.length !== s.runs.overlay.length || overlay.some((x, i) => x !== s.runs.overlay[i])) ctx.patch("runs", { overlay });

  // WASM: re-handshake when a restarted sidecar reports a different version.
  const v = snap.sidecar.version;
  if (ctx.core !== null && snap.sidecar.state === "ready" && v !== null && v !== prev?.sidecar.version) {
    ctx.patch("draft", { engine: handshake(ctx.core, v).status });
  }
}
