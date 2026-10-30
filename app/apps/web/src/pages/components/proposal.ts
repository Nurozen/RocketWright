/**
 * The proposal a component shows on page 02 (concept 02: the new geometry in
 * teal over a dashed amber ghost of the previous revision, a Changed fields
 * card, Modified status, Revert change):
 *
 * - An open draft that changes the component: the draft preview against the
 *   committed model (Revert = discard the draft).
 * - Otherwise the latest history step that changed it: the step's model diff
 *   (`history.compare`, keyed by id with source values) reversed onto the
 *   current sources and evaluated by rw-wasm is the ghost; those reverse ops
 *   are exactly what Revert change commits, so the ghost always shows what
 *   Revert would restore.
 *
 * Pure apart from the injected `compare` (RPC) and `apply` (rw-wasm, I4).
 */
import type { CheckReport, CompareOut, EvaluatedModel, PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { editorFields, fieldLabel, type FieldSpec } from "./fields.ts";

type Model = DeepReadonly<EvaluatedModel>;
type Comp = DeepReadonly<schema.EvalComponent>;

export interface ChangedField {
  key: string;
  label: string;
  dim?: string;
  /** SI numbers (quantities) or display text. */
  old: number | string | null;
  new: number | string | null;
}

export interface Proposal {
  kind: "draft" | "step";
  /** The step that made the change (`kind: "step"`). */
  step: number | null;
  stepTitle: string | null;
  /** The model before the change (the ghost) and its static check. */
  base: Model;
  baseCheck: DeepReadonly<CheckReport> | null;
  fields: ChangedField[];
  /** Ops that undo the change on the current sources (`kind: "step"`). */
  revertOps: PatchOp[];
}

/** What locates a component's geometry and mass (a change in any of these is a change to the part). */
export function componentKey(c: Comp | undefined): string {
  if (c === undefined) return "";
  return JSON.stringify([c.shape, c.x_fore, c.x_aft, c.radial, c.roll, c.override ?? null, c.material ?? null, c.appearance ?? null, c.instances.length]);
}

export function componentDiffers(a: Model | null | undefined, b: Model | null | undefined, id: string): boolean {
  if (a == null || b == null) return false;
  const ca = a.components.find((c) => c.id === id);
  const cb = b.components.find((c) => c.id === id);
  if (ca === undefined || cb === undefined) return false;
  return componentKey(ca) !== componentKey(cb);
}

/** Reverse of a model diff's field changes (RFC 6902 on the id-keyed model). */
export function reverseOps(changed: readonly DeepReadonly<schema.FieldChange>[]): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const c of changed) {
    if (c.old === undefined || c.old === null) ops.push({ op: "remove", path: c.path });
    else if (c.new === undefined || c.new === null) ops.push({ op: "add", path: c.path, value: c.old as never });
    else ops.push({ op: "replace", path: c.path, value: c.old as never });
  }
  return ops;
}

function shapeValue(c: Comp, key: string): number | string | null {
  const parts = key.split(".");
  if (parts[0] === "override") {
    const v = (c.override as Record<string, unknown> | null | undefined)?.[parts[1]!];
    return typeof v === "number" ? v : null;
  }
  if (parts[0] === "appearance") return c.appearance?.preset ?? null;
  if (key === "material") return c.material ?? null;
  const v = (c.shape as Record<string, unknown>)[key];
  return typeof v === "number" || typeof v === "string" ? v : null;
}

/** Editor fields whose evaluated value differs between `base` and `cur` (old → new). */
export function changedFields(base: Comp | undefined, cur: Comp | undefined): ChangedField[] {
  if (base === undefined || cur === undefined) return [];
  const specs: FieldSpec[] = editorFields(cur.shape.type);
  const out: ChangedField[] = [];
  for (const f of specs) {
    const a = shapeValue(base, f.key);
    const b = shapeValue(cur, f.key);
    const same = typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)) : a === b;
    if (same) continue;
    out.push({ key: f.key, label: f.label, ...(f.dim !== undefined ? { dim: f.dim } : {}), old: a, new: b });
  }
  if (out.length === 0 && (base.x_fore !== cur.x_fore || base.x_aft !== cur.x_aft)) {
    out.push({ key: "x_fore", label: fieldLabel("position"), dim: "length", old: base.x_fore, new: cur.x_fore });
  }
  return out;
}

export interface ProposalDeps {
  /** `history.compare(a, b)` (cached by the caller). */
  compare(a: string, b: string): Promise<CompareOut | DeepReadonly<CompareOut>>;
  /** rw-wasm `apply_and_eval` on the current sources. */
  apply(ops: readonly PatchOp[]): { evaluated: EvaluatedModel; check: CheckReport };
}

export interface ProposalInput {
  id: string;
  current: Model;
  steps: readonly { seq: number; title: string }[];
  /** How far back to look (steps). */
  maxSteps?: number;
}

/**
 * The latest step (head first) whose reverse changes component `id`, with its
 * ghost model and the reverse ops that touch the component. `null` when no
 * step in reach changed it (or the component was added by the change).
 */
export async function findStepProposal(input: ProposalInput, deps: ProposalDeps): Promise<Proposal | null> {
  const seqs = [...input.steps].sort((a, b) => b.seq - a.seq);
  const limit = input.maxSteps ?? 24;
  for (const st of seqs.slice(0, limit)) {
    if (st.seq <= 1) break;
    let diff: CompareOut | DeepReadonly<CompareOut>;
    try {
      diff = await deps.compare(`step:${st.seq - 1}`, `step:${st.seq}`);
    } catch {
      continue;
    }
    if (diff.model.added.includes(input.id)) return null;
    const ops = reverseOps(diff.model.changed);
    if (ops.length === 0) continue;
    let prev: { evaluated: EvaluatedModel; check: CheckReport };
    try {
      prev = deps.apply(ops);
    } catch {
      continue;
    }
    if (!componentDiffers(prev.evaluated, input.current, input.id)) continue;
    // Only the reverse ops that touch this component (others in the step are unrelated).
    const relevant = ops.filter((op) => {
      try {
        return componentDiffers(deps.apply([op]).evaluated, input.current, input.id);
      } catch {
        return false;
      }
    });
    const revertOps = relevant.length > 0 ? relevant : ops;
    const ghost = relevant.length > 0 && relevant.length < ops.length ? deps.apply(relevant) : prev;
    const base = ghost.evaluated;
    return {
      kind: "step",
      step: st.seq,
      stepTitle: st.title,
      base,
      baseCheck: ghost.check,
      fields: changedFields(
        base.components.find((c) => c.id === input.id),
        input.current.components.find((c) => c.id === input.id),
      ),
      revertOps,
    };
  }
  return null;
}

/** A draft that changes component `id`, as a proposal against the committed model. */
export function draftProposal(id: string, committed: Model | null, committedCheck: DeepReadonly<CheckReport> | null, preview: Model | null): Proposal | null {
  if (committed === null || preview === null || !componentDiffers(committed, preview, id)) return null;
  return {
    kind: "draft",
    step: null,
    stepTitle: null,
    base: committed,
    baseCheck: committedCheck,
    fields: changedFields(
      committed.components.find((c) => c.id === id),
      preview.components.find((c) => c.id === id),
    ),
    revertOps: [],
  };
}
