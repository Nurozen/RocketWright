/**
 * `draft`: UI edits not yet committed. The WASM core previews them (a pure
 * function of the mirror plus the ops, I4) and the sidecar answers a dry run
 * with the CheckDelta. Only `commit()` writes, through `model.patch` (I1, I2).
 */
import type { CheckReport, EvaluatedModel, MutationOut, PatchOp } from "@rw/contracts";
import { createMutate, createRemoveComponent, mirrorHash, noteLanded } from "../mutate.ts";
import type { DeepReadonly, DraftSlice, SliceCtx } from "../types.ts";

/**
 * A later `replace` supersedes an earlier `replace` or `add` on the same path
 * (array appends `/-` never coalesce).
 */
export function coalesce(ops: readonly PatchOp[]): PatchOp[] {
  const out: PatchOp[] = [];
  for (const op of ops) {
    if (op.op === "replace" && !op.path.endsWith("/-")) {
      // Only when nothing else touched the path since (a remove in between keeps both).
      const i = out.findLastIndex((o) => o.path === op.path || ("from" in o && o.from === op.path));
      const prev = i >= 0 ? out[i]! : null;
      if (prev !== null && (prev.op === "replace" || prev.op === "add") && prev.path === op.path) {
        // Keep the earlier op kind: add-then-replace is still an add.
        out[i] = { ...out[i]!, value: op.value } as PatchOp;
        continue;
      }
    }
    out.push(op);
  }
  return out;
}

export const EMPTY_DRAFT = {
  ops: [] as PatchOp[],
  label: null,
  baseHash: null,
  stale: false,
  preview: null,
  previewCheck: null,
  previewDeferred: false,
  previewError: null,
  delta: null,
  pending: false,
  error: null,
} satisfies Partial<DraftSlice>;

export function createDraftSlice(ctx: SliceCtx): DraftSlice {
  /** Bumps on every edit/discard so late dry-run answers are dropped. */
  let gen = 0;
  /** The commit in flight: `mutate` can settle a draft while Save is still answering, and ops must not apply twice. */
  let inFlight: { ops: readonly PatchOp[]; done: Promise<MutationOut> } | null = null;
  /** Writes what was edited while `inFlight` was on its way, after it lands. */
  let queued: Promise<MutationOut> | null = null;

  /** Takes the written ops out of the draft; what was typed since stays open, based on the model it will now apply to. */
  const landed = (sent: readonly PatchOp[], hash: string): void => {
    const now = ctx.get().draft;
    noteLanded(ctx, hash);
    if (now.ops === sent) ctx.patch("draft", { ...EMPTY_DRAFT, ops: [] });
    else if (now.ops.length > 0) ctx.patch("draft", { ops: now.ops.filter((op) => !sent.includes(op)), baseHash: hash });
  };

  const send = async (): Promise<MutationOut> => {
    const { client, projectId } = ctx.conn();
    const d = ctx.get().draft;
    if (d.ops.length === 0) throw new Error("nothing to commit");
    const my = ++gen;
    ctx.patch("draft", { pending: true, error: null });
    ctx.draftWriting = true;
    const write = async (): Promise<MutationOut> => {
      try {
        const params = d.label === null ? { projectId, ops: d.ops } : { projectId, ops: d.ops, label: d.label };
        const out = await client.call("model.patch", params);
        landed(d.ops, out.model_hash);
        return out;
      } catch (e) {
        if (my === gen) ctx.patch("draft", { pending: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        ctx.draftWriting = false;
      }
    };
    const done = write().finally(() => {
      inFlight = null;
    });
    inFlight = { ops: d.ops, done };
    return done;
  };

  return {
    ...EMPTY_DRAFT,
    ops: [],
    engine: { state: "idle" },

    async edit(ops: PatchOp[], label?: string): Promise<void> {
      if (ops.length === 0) return;
      const { client, projectId } = ctx.conn();
      const s = ctx.get();
      const hash = mirrorHash(ctx);
      // The last commit has landed but its push has not: this draft starts on the commit's model, and the push must not read as another writer.
      const base = ctx.landed !== null && (ctx.landed.from === hash || ctx.landed.through.includes(hash ?? "")) ? ctx.landed.to : hash;
      const next = coalesce([...s.draft.ops, ...ops]);
      const my = ++gen;
      ctx.patch("draft", {
        ops: next,
        label: label ?? s.draft.label,
        baseHash: s.draft.ops.length === 0 ? base : s.draft.baseHash,
        pending: true,
        error: null,
        ...preview(ctx, next),
      });
      try {
        const out = await client.call("model.patch", { projectId, ops: next, dry_run: true });
        if (my === gen) ctx.patch("draft", { delta: out.delta, pending: false });
      } catch (e) {
        if (my === gen) ctx.patch("draft", { pending: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    discard(): void {
      gen++;
      ctx.patch("draft", { ...EMPTY_DRAFT, ops: [] });
    },

    commit(): Promise<MutationOut> {
      if (inFlight === null) return send();
      const sending = inFlight;
      // Nothing was edited since this write began: that write is the answer.
      if (ctx.get().draft.ops === sending.ops) return sending.done;
      // Edited since: the newer value needs a write of its own, after this one lands.
      if (queued === null) {
        const next = () => {
          queued = null;
          return ctx.get().draft.ops.length === 0 ? sending.done : send();
        };
        queued = sending.done.then(next, next);
      }
      return queued;
    },

    async settled(): Promise<string | null> {
      let last: string | null = null;
      // Each wait can start the queued write, so the loop re-reads both.
      for (let next = queued ?? inFlight?.done; next !== undefined; next = queued ?? inFlight?.done) {
        const out = await next.catch(() => null);
        if (out !== null) last = out.model_hash;
      }
      // Answered before anyone asked, push still on its way: that write is in history, and the mirror is about to say so.
      return ctx.landed?.to ?? last;
    },

    dryRun(ops: readonly PatchOp[]): Promise<MutationOut> {
      const { client, projectId } = ctx.conn();
      return client.call("model.patch", { projectId, ops: [...ops], dry_run: true });
    },

    mutate: createMutate(ctx),
    removeComponent: createRemoveComponent(ctx),
  };
}

/**
 * The preview core's check cannot be trusted for this rocket: it has no motor
 * files, so a `lib:` motor reads as "was not resolved", and a bare designation a
 * `lib/motors` file answers does too, though the sidecar resolved it. Only the
 * sidecar's dry run can check these (plan: `lib:` drafts defer to it).
 */
function motorNeedsSidecar(evaluated: EvaluatedModel, check: CheckReport, committed: DeepReadonly<CheckReport> | null | undefined): boolean {
  const config = evaluated.config == null ? undefined : evaluated.configs[evaluated.config];
  if (config?.motors.some((m) => m.motor?.startsWith("lib:") === true) === true) return true;
  if (committed == null) return false;
  const known = new Set(committed.diagnostics.filter((d) => d.code === "RW-W101").map((d) => d.path ?? ""));
  return check.diagnostics.some((d) => d.code === "RW-W101" && !known.has(d.path ?? ""));
}

/** Runs the WASM preview when a version-matched core with `applyAndEval` is loaded. */
function preview(ctx: SliceCtx, ops: PatchOp[]): Pick<DraftSlice, "preview" | "previewCheck" | "previewDeferred" | "previewError"> {
  const s = ctx.get();
  const core = ctx.core;
  const files = s.project.snapshot?.files.files;
  if (s.draft.engine.state !== "ready" || core === null || core.applyAndEval === undefined || files === undefined) {
    return { preview: null, previewCheck: null, previewDeferred: false, previewError: null };
  }
  try {
    const req = { files: files as Record<string, string>, ops };
    if (core.applyAndCheck !== undefined) {
      const d = core.applyAndCheck(req);
      const deferred = motorNeedsSidecar(d.evaluated, d.check, s.project.snapshot?.check);
      return { preview: d.evaluated, previewCheck: deferred ? null : d.check, previewDeferred: deferred, previewError: null };
    }
    return { preview: core.applyAndEval(req), previewCheck: null, previewDeferred: false, previewError: null };
  } catch (e) {
    return { preview: null, previewCheck: null, previewDeferred: false, previewError: e instanceof Error ? e.message : String(e) };
  }
}
