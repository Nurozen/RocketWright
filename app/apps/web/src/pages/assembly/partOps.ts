/**
 * Part operations for the tree menu, the inspector and the Delete key (R2.2).
 * The sets here decide what a delete takes with it and where a part can move,
 * so the dialog shows exactly what the sidecar will do.
 */
import type { PatchOp, schema } from "@rw/contracts";
import { OVERLAY_SELECTOR } from "../../embed/bridge.ts";
import { isEditableTarget } from "../../shell/undo.ts";
import { componentRef, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { duplicatePartOps, type PartKind } from "../../state/ops/parts.ts";
import { parseRef, selectedComponentIds } from "../../state/slices/selection.ts";
import { attachmentFor } from "./attach-targets.ts";
import { treeLabel, treeParent } from "./ComponentTree.tsx";

type Part = DeepReadonly<schema.EvalComponent>;
type State = ReturnType<AppStore["getState"]>;

const targetOf = (p: Part): string | null => p.attach?.to.split(".")[0] ?? null;

/**
 * `id` and every part attached to it, directly or not: what `component.remove`
 * with `recursive` deletes (attach targets, the same walk as the session's
 * `dependents`). `id` comes first.
 */
export function removalSet(components: readonly Part[], id: string): string[] {
  const out = [id];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const c of components) {
      if (seen.has(c.id) || targetOf(c) !== out[i]) continue;
      seen.add(c.id);
      out.push(c.id);
    }
  }
  return out;
}

/** The parts deleted along with `id`, in model order. */
export function attachedParts(components: readonly Part[], id: string): Part[] {
  const removed = new Set(removalSet(components, id));
  return components.filter((c) => c.id !== id && removed.has(c.id));
}

export interface MoveTarget {
  id: string;
  label: string;
  attach: schema.Attach;
}

/** Tree rows below `id`: nesting comes from `parent`, which can differ from the attach target. */
function treeDescendants(components: readonly Part[], id: string): Set<string> {
  const ids = new Set(components.map((c) => c.id));
  const parentOf = new Map(components.map((c) => [c.id, treeParent(c, ids)] as const));
  const out = new Set<string>();
  for (const c of components) {
    const walked = new Set<string>();
    for (let p = parentOf.get(c.id) ?? null; p !== null && !walked.has(p); p = parentOf.get(p) ?? null) {
      if (p === id) out.add(c.id);
      walked.add(p);
    }
  }
  return out;
}

/**
 * Where `id` can be re-attached: parts that can hold its kind, never itself or
 * anything below it (that would be a cycle), and not where it already is.
 */
export function moveTargets(components: readonly Part[], id: string): MoveTarget[] {
  const part = components.find((c) => c.id === id);
  if (part === undefined) return [];
  const excluded = new Set([...removalSet(components, id), ...treeDescendants(components, id)]);
  const current = targetOf(part);
  return components.flatMap((c) => {
    if (excluded.has(c.id) || c.id === current) return [];
    const attach = attachmentFor(part.shape.type as PartKind, c);
    return attach === null ? [] : [{ id: c.id, label: treeLabel(c), attach }];
  });
}

export function renameOps(id: string, name: string): PatchOp[] {
  return [{ op: "add", path: `/c/${id}/name`, value: name.trim() }];
}

const partsOf = (s: State): readonly Part[] => s.project.snapshot?.evaluated?.components ?? [];

/** Drops deleted parts from the selection and the hidden list. */
function forgetParts(store: AppStore, removed: readonly string[]): void {
  const s = store.getState();
  const gone = new Set(removed);
  const keep = s.selection.refs.filter((r) => {
    const p = parseRef(r);
    return p?.kind !== "c" || !gone.has(p.id);
  });
  if (keep.length !== s.selection.refs.length) s.selection.select(keep, "tree");
  for (const id of s.ui.hidden) if (gone.has(id)) s.ui.toggleHidden(id);
}

/** Deletes `id`, what is attached to it, and their motor and deploy entries, as one undoable step. */
export async function deletePart(store: AppStore, id: string): Promise<void> {
  const parts = partsOf(store.getState());
  const removed = removalSet(parts, id);
  const name = parts.find((c) => c.id === id)?.name ?? id;
  await store.getState().draft.removeComponent(id, `Delete ${name}`);
  forgetParts(store, removed);
}

export async function renamePart(store: AppStore, id: string, name: string): Promise<void> {
  const old = partsOf(store.getState()).find((c) => c.id === id)?.name ?? id;
  await store.getState().draft.mutate(renameOps(id, name), `Rename ${old}`);
}

/** Copies `id` and what is attached to it, and selects the copy. */
export async function duplicatePart(store: AppStore, id: string): Promise<void> {
  const parts = partsOf(store.getState());
  const { id: copy, ops } = duplicatePartOps(parts, id);
  await store.getState().draft.mutate(ops, `Duplicate ${parts.find((c) => c.id === id)?.name ?? id}`);
  store.getState().selection.select([componentRef(copy)], "tree");
}

export async function movePart(store: AppStore, id: string, target: MoveTarget): Promise<void> {
  const name = partsOf(store.getState()).find((c) => c.id === id)?.name ?? id;
  await store.getState().draft.mutate([{ op: "add", path: `/c/${id}/attach`, value: target.attach as never }], `Move ${name} to ${target.label}`);
}

/** macOS's delete key reports Backspace; the key labelled Delete elsewhere reports Delete. */
export function isPartDeleteKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">): boolean {
  if (e.key !== "Delete" && e.key !== "Backspace") return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return !isEditableTarget(e.target);
}

/** With a menu or dialog open, the key belongs to it. */
export function overlayOpen(doc: Pick<Document, "querySelector">): boolean {
  return doc.querySelector(OVERLAY_SELECTOR) !== null;
}

/** Pages whose rail shows the parts tree, so the selection is in view. */
const TREE_PAGES: ReadonlySet<string> = new Set(["assembly", "components", "configurations"]);

/**
 * The part the Delete key deletes, or null. Only the first selected part, the
 * one the inspector shows: one delete is one undo step.
 */
export function deleteKeyTarget(s: State): string | null {
  if (!TREE_PAGES.has(s.ui.page) || s.ui.compare !== null || s.project.connection !== "open") return null;
  const id = selectedComponentIds(s.selection.refs)[0];
  return id !== undefined && partsOf(s).some((c) => c.id === id) ? id : null;
}
