/**
 * Reading and writing a component field, nested ones included. Every write is
 * an id-keyed patch (I2). A dotted field writes its leaf, or the whole table
 * when the table is not there yet: never a leaf under an absent table, which
 * the model refuses, and never a table that would replace one it already has.
 */
import type { PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { isComponentField, toDisplay, toSource, type FieldGroup, type FieldSpec } from "../../ui/fields/index.ts";
import { fieldTarget, sourceHasTable, type SourceFilesLike, type SourceScalar } from "./source.ts";

type Comp = DeepReadonly<schema.EvalComponent>;

function evaluatedAt(c: Comp, parts: readonly string[]): unknown {
  const root: unknown = isComponentField(parts[0]!) ? c : c.shape;
  return parts.reduce<unknown>((cur, p) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined), root);
}

/** The evaluated value behind a field (SI number, enum text, bool, or null). */
export function evaluatedValue(c: Comp, key: string): number | string | boolean | null {
  const v = evaluatedAt(c, key.split("."));
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null;
}

/** The part has this nested table: in its sources, or in the evaluated model (a draft the mirror has not caught up with). */
export function tablePresent(files: SourceFilesLike, c: Comp, parts: readonly string[]): boolean {
  return sourceHasTable(files, c.id, parts) || evaluatedAt(c, parts) != null;
}

/** One op per distinct target (a shared param is written once); `null` clears the field. */
export function fieldWriteOps(comps: readonly Comp[], files: SourceFilesLike, f: FieldSpec, v: SourceScalar | null): PatchOp[] {
  const seen = new Set<string>();
  const ops: PatchOp[] = [];
  const parts = f.key.split(".");
  for (const c of comps) {
    const t = fieldTarget(files, c.id, f.key);
    if (seen.has(t.path)) continue;
    seen.add(t.path);
    if (v === null) {
      if (t.written !== undefined) ops.push({ op: "remove", path: t.path });
      continue;
    }
    const absent = t.param === null ? firstAbsent(files, c, parts) : -1;
    if (absent >= 0) {
      // Reached only by tables whose members are all optional (`override`, `appearance`):
      // the required ones have an Add button, which writes them whole.
      const value = parts.slice(absent + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), v);
      ops.push({ op: "add", path: `/c/${c.id}/${parts.slice(0, absent + 1).join("/")}`, value: value as never });
    } else {
      ops.push({ op: t.written === undefined && t.param === null ? "add" : "replace", path: t.path, value: v as never });
    }
  }
  return ops;
}

/** Index of the shallowest table on the path that does not exist yet, or -1. */
function firstAbsent(files: SourceFilesLike, c: Comp, parts: readonly string[]): number {
  for (let i = 1; i < parts.length; i++) {
    if (!tablePresent(files, c, parts.slice(0, i))) return i - 1;
  }
  return -1;
}

const FALLBACK_SIZE = 0.02;

/**
 * Required members of a group the part does not have yet, sized from the part
 * so the result is valid and fits: a shoulder narrower than the end it plugs
 * into (RW-E150 is the bore it must clear), a tab half the root chord and no
 * deeper than the wall until the user says so (RW-E153 is too deep).
 */
function groupDefaults(c: Comp, key: string, units: Units): Record<string, string | number> {
  const shape = c.shape as unknown as Record<string, unknown>;
  const num = (k: string): number => {
    const v = shape[k];
    return typeof v === "number" && v > 0 ? v : FALLBACK_SIZE;
  };
  const literal = (si: number) => toSource(Number(toDisplay(si, "length", units)), "length", units);
  if (key === "tab") return { height: literal(0), length: literal(num("root_chord") / 2) };
  const od = num(key === "fore_shoulder" ? "fore_od" : key === "aft_shoulder" ? "aft_od" : "od");
  return { length: literal(od), od: literal(od * 0.9) };
}

/** Adds a nested group, whole, to each selected part that lacks it. */
export function groupAddOps(comps: readonly Comp[], files: SourceFilesLike, group: FieldGroup, units: Units): PatchOp[] {
  return comps
    .filter((c) => !tablePresent(files, c, [group.key]))
    .map((c) => ({ op: "add", path: `/c/${c.id}/${group.key}`, value: groupDefaults(c, group.key, units) as never }));
}
