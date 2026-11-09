/**
 * `mutate`: one direct edit (add a part, delete a sim), committed at once.
 * Form edits use the draft slice instead. An open draft is settled first:
 * left open, this edit's own commit would read as another writer and mark the
 * draft stale (`slices/project.ts`).
 */
import type { MutationOut, PatchOp } from "@rw/contracts";
import type { SliceCtx } from "./types.ts";

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
    return client.call("model.patch", label === undefined ? { projectId, ops: [...ops] } : { projectId, ops: [...ops], label });
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
    return client.call("component.remove", { projectId, id, recursive: true, label });
  };
}
