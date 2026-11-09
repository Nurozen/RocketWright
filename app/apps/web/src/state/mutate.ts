/**
 * `mutate`: one direct edit (add a part, delete a sim), committed at once.
 * Form edits use the draft slice instead. An open draft is settled first:
 * left open, this edit's own commit would read as another writer and mark the
 * draft stale (`slices/project.ts`).
 */
import type { MutationOut, PatchOp } from "@rw/contracts";
import type { SliceCtx } from "./types.ts";

export function mirrorHash(ctx: Pick<SliceCtx, "get">): string | null {
  const snap = ctx.get().project.snapshot;
  return snap?.evaluated?.model_hash ?? snap?.files.model_hash ?? null;
}

/**
 * A write answered; its push comes a moment later. Until then the mirror (and
 * its history) is the model before this write, so anything that needs the
 * state after it waits for `to`.
 */
export function noteLanded(ctx: Pick<SliceCtx, "get" | "landed">, hash: string): void {
  const from = mirrorHash(ctx);
  // Its push beat the answer: the mirror already shows this write, and no later push would clear the wait.
  if (from === hash) {
    ctx.landed = null;
    return;
  }
  // A write before this one has not been pushed yet: its push is on the way here too.
  const earlier = ctx.landed !== null && (ctx.landed.from === from || ctx.landed.through.includes(from ?? "")) ? [...ctx.landed.through, ctx.landed.to] : [];
  ctx.landed = { from, to: hash, through: earlier };
}

async function settleDraft(ctx: SliceCtx): Promise<void> {
  const draft = ctx.get().draft;
  if (draft.ops.length === 0) return;
  // Saving ops built on a model that has since changed is the user's call, not a side effect.
  if (draft.stale) throw new Error("The model changed under your unsaved edit. Save or discard that edit first.");
  await draft.commit();
}

export function createMutate(ctx: SliceCtx) {
  return async function mutate(ops: readonly PatchOp[], label?: string): Promise<MutationOut | null> {
    if (ops.length === 0) return null;
    const { client, projectId } = ctx.conn();
    await settleDraft(ctx);
    const out = await client.call("model.patch", label === undefined ? { projectId, ops: [...ops] } : { projectId, ops: [...ops], label });
    noteLanded(ctx, out.model_hash);
    return out;
  };
}

/**
 * Deletes a part and everything attached to it. `component.remove`, not a
 * patch, because the sidecar also drops the motor and deploy entries of every
 * removed part, all in one history step.
 */
export function createRemoveComponent(ctx: SliceCtx) {
  return async function removeComponent(id: string, label: string): Promise<MutationOut> {
    const { client, projectId } = ctx.conn();
    await settleDraft(ctx);
    const out = await client.call("component.remove", { projectId, id, recursive: true, label });
    noteLanded(ctx, out.model_hash);
    return out;
  };
}
