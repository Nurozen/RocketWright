/**
 * `draft`: UI edits not yet committed. The WASM core previews them (a pure
 * function of the mirror plus the ops, I4) and the sidecar answers a dry run
 * with the CheckDelta. Only `commit()` writes, through `model.patch` (I1, I2).
 */
import type { MutationOut, PatchOp } from "@rw/contracts";
import type { DraftSlice, SliceCtx } from "../types.ts";

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
  previewError: null,
  delta: null,
  pending: false,
  error: null,
} satisfies Partial<DraftSlice>;

export function createDraftSlice(ctx: SliceCtx): DraftSlice {
  /** Bumps on every edit/discard so late dry-run answers are dropped. */
  let gen = 0;

  return {
    ...EMPTY_DRAFT,
    ops: [],
    engine: { state: "idle" },

    async edit(ops: PatchOp[], label?: string): Promise<void> {
      if (ops.length === 0) return;
      const { client, projectId } = ctx.conn();
      const s = ctx.get();
      const snap = s.project.snapshot;
      const hash = snap?.evaluated?.model_hash ?? snap?.files.model_hash ?? null;
      const next = coalesce([...s.draft.ops, ...ops]);
      const my = ++gen;
      ctx.patch("draft", {
        ops: next,
        label: label ?? s.draft.label,
        baseHash: s.draft.ops.length === 0 ? hash : s.draft.baseHash,
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

    async commit(): Promise<MutationOut> {
      const { client, projectId } = ctx.conn();
      const d = ctx.get().draft;
      if (d.ops.length === 0) throw new Error("nothing to commit");
      const my = ++gen;
      ctx.patch("draft", { pending: true, error: null });
      try {
        const params = d.label === null ? { projectId, ops: d.ops } : { projectId, ops: d.ops, label: d.label };
        const out = await client.call("model.patch", params);
        if (my === gen) ctx.patch("draft", { ...EMPTY_DRAFT, ops: [] });
        return out;
      } catch (e) {
        if (my === gen) ctx.patch("draft", { pending: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };
}

/** Runs the WASM preview when a version-matched core with `applyAndEval` is loaded. */
function preview(ctx: SliceCtx, ops: PatchOp[]): Pick<DraftSlice, "preview" | "previewCheck" | "previewError"> {
  const s = ctx.get();
  const core = ctx.core;
  const files = s.project.snapshot?.files.files;
  if (s.draft.engine.state !== "ready" || core === null || core.applyAndEval === undefined || files === undefined) {
    return { preview: null, previewCheck: null, previewError: null };
  }
  try {
    const req = { files: files as Record<string, string>, ops };
    if (core.applyAndCheck !== undefined) {
      const d = core.applyAndCheck(req);
      return { preview: d.evaluated, previewCheck: d.check, previewError: null };
    }
    return { preview: core.applyAndEval(req), previewCheck: null, previewError: null };
  } catch (e) {
    return { preview: null, previewCheck: null, previewError: e instanceof Error ? e.message : String(e) };
  }
}
