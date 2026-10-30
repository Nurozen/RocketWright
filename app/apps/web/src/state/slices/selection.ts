/** `selection`: one entity selection shared by every view (C §5.1, R6.3). */
import type { RwRef } from "@rw/contracts";
import type { SelectionSlice, SelectionSource, SliceCtx } from "../types.ts";

/** Ref kinds (S:73): component, config, sim, run, step, revision, thread, engine. */
export const REF_KINDS = ["c", "cfg", "sim", "run", "step", "rev", "thread", "eng"] as const;
export type RefKind = (typeof REF_KINDS)[number];

const REF_RE = /^rw:(c|cfg|sim|run|step|rev|thread|eng)\/([^\s#@/]+)(#[^\s@/]+)?(@[^\s/]+)?(\/\S*)?$/;

export interface ParsedRef {
  kind: RefKind;
  id: string;
  anchor?: string;
  version?: string;
  pointer?: string;
}

/** Parses `rw:<kind>/<id>[#anchor][@version][/pointer]`, or `null` when malformed. */
export function parseRef(ref: string): ParsedRef | null {
  const m = REF_RE.exec(ref);
  if (m === null) return null;
  const out: ParsedRef = { kind: m[1] as RefKind, id: m[2]! };
  if (m[3] !== undefined) out.anchor = m[3].slice(1);
  if (m[4] !== undefined) out.version = m[4].slice(1);
  if (m[5] !== undefined) out.pointer = m[5];
  return out;
}

export const componentRef = (id: string): RwRef => `rw:c/${id}`;

/** Component ids among `refs`. */
export function selectedComponentIds(refs: readonly RwRef[]): string[] {
  return refs.flatMap((r) => {
    const p = parseRef(r);
    return p?.kind === "c" ? [p.id] : [];
  });
}

export function createSelectionSlice(ctx: SliceCtx): SelectionSlice {
  return {
    refs: [],
    source: null,
    seq: 0,
    select(refs: readonly RwRef[], source: SelectionSource): void {
      const bad = refs.filter((r) => parseRef(r) === null);
      if (bad.length > 0) throw new Error(`select: malformed rw: ref ${bad.map((r) => JSON.stringify(r)).join(", ")}`);
      const next = [...new Set(refs)];
      const cur = ctx.get().selection;
      // An echo of the current selection (e.g. viewport re-emitting the tree's pick) is a no-op.
      if (next.length === cur.refs.length && next.every((r, i) => r === cur.refs[i])) return;
      ctx.patch("selection", { refs: next, source, seq: cur.seq + 1 });
    },
  };
}
