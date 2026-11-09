/**
 * Reading and writing a component field, nested ones included. Every write is
 * an id-keyed patch (I2). A dotted field writes its leaf, or the whole table
 * when the table is not there yet: never a leaf under an absent table, which
 * the model refuses, and never a table that would replace one it already has.
 */
import type { PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { isComponentField, parseLiteral, toDisplay, toSource, type FieldGroup, type FieldSpec } from "../../ui/fields/index.ts";
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

/** A typed `= expression`, kept as the model will read it. */
export function isFormula(v: SourceScalar | null): v is string {
  return typeof v === "string" && v.trimStart().startsWith("=");
}

/** Tube kinds whose bore is given by `id` or `thickness`; `id` wins when both are written (`crates/rw-model/src/shape.rs`). */
const BORED_KINDS: ReadonlySet<string> = new Set(["body_tube", "inner_tube", "coupler", "launch_lug", "tube_fin_set"]);

/** The bore field a write to `thickness` or `id` must clear, so the value typed is the value that counts. */
function supersededBy(c: Comp, key: string): string | null {
  if (!BORED_KINDS.has(c.shape.type)) return null;
  return key === "thickness" ? "id" : key === "id" ? "thickness" : null;
}

/**
 * What a field shows. The evaluated model answers first; a field it does not
 * carry (`attach.spin`, `instances.*`, a tube's `thickness`) comes from the
 * source as written. `attach.at` and the finish preset read only the source:
 * evaluation fills in a default a person did not choose.
 */
export function fieldValue(c: Comp, files: SourceFilesLike, f: FieldSpec): number | string | boolean | null {
  // The override's CG evaluates to a station on the rocket, not the distance from the part's fore end that a person types.
  const sourceOnly = f.key === "attach.at" || f.key === "finish" || f.key === "override.cg";
  const evaluated = sourceOnly ? null : evaluatedValue(c, f.key);
  if (evaluated !== null) return evaluated;
  const written = fieldTarget(files, c.id, f.key).written;
  if (written !== undefined) return f.kind === "quantity" ? parseLiteral(written) : written;
  if (f.key === "thickness" && BORED_KINDS.has(c.shape.type)) {
    const { od, id } = c.shape as unknown as { od?: unknown; id?: unknown };
    if (typeof od === "number" && typeof id === "number") return (od - id) / 2;
  }
  return null;
}

/** The part has this nested table: in its sources, or in the evaluated model (a draft the mirror has not caught up with). */
export function tablePresent(files: SourceFilesLike, c: Comp, parts: readonly string[]): boolean {
  // An array (`instances`) is evaluated whether or not the source has the table.
  const seen = evaluatedAt(c, parts);
  return sourceHasTable(files, c.id, parts) || (seen != null && !Array.isArray(seen));
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
    if (t.param !== null && isFormula(v)) {
      // A formula belongs to this field and replaces its link; written into the shared value it would refer to itself.
      const own = `/c/${c.id}/${parts.join("/")}`;
      seen.delete(t.path);
      seen.add(own);
      ops.push({ op: "replace", path: own, value: v as never });
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
    const other = supersededBy(c, f.key);
    if (other !== null && fieldTarget(files, c.id, other).written !== undefined) {
      // The part's own field, not what a `= params.x` there resolves to: the parameter is still in use, and removing its value is refused.
      const stale = `/c/${c.id}/${other}`;
      if (!seen.has(stale)) {
        seen.add(stale);
        ops.push({ op: "remove", path: stale });
      }
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
/** A painted finish, in metres: where a custom roughness starts when the part has none. */
const DEFAULT_ROUGHNESS = 60e-6;

/**
 * Required members of a group the part does not have yet, sized from the part
 * so the result is valid and fits: a shoulder narrower than the end it plugs
 * into (RW-E150 is the bore it must clear), a tab half the root chord and no
 * deeper than the wall until the user says so (RW-E153 is too deep).
 */
function groupDefaults(c: Comp, key: string, units: Units): Record<string, string | number | boolean> {
  const shape = c.shape as unknown as Record<string, unknown>;
  const num = (k: string): number => {
    const v = shape[k];
    return typeof v === "number" && v > 0 ? v : FALLBACK_SIZE;
  };
  const literal = (si: number) => toSource(Number(toDisplay(si, "length", units)), "length", units);
  if (key === "instances") return { count: 2, pattern: "radial" };
  if (key === "joint") return { type: "friction" };
  if (key === "fill") return { propellant: "n2o" };
  if (key === "finish") return { roughness: toSource(Number(toDisplay(c.roughness ?? DEFAULT_ROUGHNESS, "length:um", units)), "length:um", units) };
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
