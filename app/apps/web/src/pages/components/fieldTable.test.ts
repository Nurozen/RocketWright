/**
 * U49's table: every field `schema/rocket.json` gives each of the 19 part kinds
 * has a control in the editor, or a reason here why it does not, and a value
 * entered through that control is accepted by the model and reads back.
 */
import { readFileSync } from "node:fs";
import { CONTAINMENT, type EvaluatedModel, type PatchOp, type schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import rocketSchema from "../../../../../../schema/rocket.json";
import { addPartOps, PART_KINDS, type PartKind } from "../../state/ops/parts.ts";
import { attachmentFor } from "../assembly/attach-targets.ts";
import { editorFields, fromDisplay, groupsOf, toSource, type FieldSpec } from "../../ui/fields/index.ts";
import { evaluatedValue, fieldWriteOps, groupAddOps } from "./fieldOps.ts";
import { attachChoices, ownAnchorChoices } from "./positionFields.ts";

type Comp = schema.EvalComponent;
type Json = { properties?: Record<string, Json>; $ref?: string; anyOf?: Json[] };

const repo = new URL("../../../../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), "utf8");
const DEFS = (rocketSchema as unknown as { $defs: Record<string, Json> }).$defs;
const META = (rocketSchema as unknown as { $defs: { Component: { oneOf: { $ref: string; properties: { type: { const: string } } }[] } } }).$defs.Component.oneOf;

/** Fields no control edits, each with why. */
const NOT_EDITED: Readonly<Record<string, string>> = {
  points: "the freeform outline has its own editor (FinOutlineEditor)",
  import: "provenance written by .ork import, never typed",
};

/** Tables whose members the editor shows as dotted keys. */
const TABLES = new Set(["shoulder", "fore_shoulder", "aft_shoulder", "tab", "fill"]);

function refTo(raw: Json): Json {
  if (raw.$ref !== undefined) return DEFS[raw.$ref.replace("#/$defs/", "")] ?? {};
  for (const branch of raw.anyOf ?? []) {
    const r = refTo(branch);
    if (r.properties !== undefined) return r;
  }
  return raw;
}

/** Every field the schema gives a kind, nested tables as dotted keys. */
function schemaFields(kind: string): string[] {
  const ref = META.find((v) => v.properties.type.const === kind)!.$ref.replace("#/$defs/", "");
  const out: string[] = [];
  for (const [key, raw] of Object.entries(DEFS[ref]?.properties ?? {})) {
    if (TABLES.has(key)) out.push(...Object.keys(refTo(raw).properties ?? {}).map((l) => `${key}.${l}`));
    else out.push(key);
  }
  const comp = DEFS["Component"]?.properties ?? {};
  for (const key of Object.keys(comp)) {
    if (key === "finish") out.push("finish", "finish.roughness");
    else if (["attach", "instances", "override", "appearance", "joint"].includes(key)) {
      out.push(...Object.keys(refTo(comp[key]!).properties ?? {}).map((l) => `${key}.${l}`));
    } else out.push(key);
  }
  return out;
}

describe("every schema field has a control", () => {
  it("covers all 19 kinds", () => {
    expect(PART_KINDS).toHaveLength(19);
    expect(CONTAINMENT.kinds.toSorted()).toEqual([...PART_KINDS].toSorted());
  });

  it.each(PART_KINDS)("%s", (kind) => {
    const controls = new Set(editorFields(kind).map((f) => f.key));
    const missing = schemaFields(kind).filter((k) => !controls.has(k) && NOT_EDITED[k] === undefined);
    expect(missing).toEqual([]);
  });

  it("names only real exclusions", () => {
    const real = new Set(PART_KINDS.flatMap(schemaFields));
    const stale = Object.keys(NOT_EDITED).filter((k) => !real.has(k));
    expect(stale).toEqual([]);
  });
});

/** The case 1 rocket, the only source the tests need. */
const FILES = { "rocket.rw.toml": read("fixtures/case1/rocket.rw.toml"), "rocketwright.toml": read("fixtures/case1/rocketwright.toml") };

type Applied = { evaluated: EvaluatedModel; check?: { diagnostics: { code: string; severity: string; path?: string | null; message: string }[] } };

describe("each field round-trips through the model", () => {
  let apply: (ops: readonly PatchOp[]) => Applied;

  beforeAll(async () => {
    const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
    apply = (ops) => rw.applyAndEval!({ files: FILES, ops }) as Applied;
  });

  const comp = (m: EvaluatedModel, id: string) => m.components.find((c) => c.id === id)!;

  /** The kind added to the case 1 rocket (or, for a kind only a rocket can start with, its own nose). */
  function placed(kind: PartKind): { id: string; ops: PatchOp[] } {
    const base = apply([]).evaluated;
    if (kind === "nose_cone") return { id: "nose", ops: [] };
    const parents = [comp(base, "body"), comp(base, "mmt")];
    const attach = parents.map((p) => attachmentFor(kind, p)).find((a) => a !== null);
    if (attach === undefined || attach === null) throw new Error(`nothing in case 1 can hold a ${kind}`);
    return addPartOps({ kind, taken: base.components.map((c) => c.id), attach });
  }

  /** A value the control would accept, and what the model should hold for it. */
  function sample(f: FieldSpec, c: Comp, m: EvaluatedModel): { value: string | number | boolean; si?: number } {
    if (f.key === "name") return { value: "Renamed" };
    if (f.key === "attach.to") return { value: attachChoices(m.components, [c], c.attach?.to ?? null).options[0] ?? "" };
    if (f.key === "attach.at") return { value: ownAnchorChoices(c).options[0]! };
    if (f.key === "material") return { value: Object.keys(m.materials)[0]! };
    if (f.key === "line_material") return { value: "elastic_cord" };
    if (f.key === "appearance.color") return { value: "#112233" };
    if (f.key === "fill.propellant") return { value: "n2o" };
    if (f.key === "instances.preset") return { value: "3-ring" };
    switch (f.kind) {
      case "quantity":
        return { value: toSource(3, f.dim, "mm"), si: fromDisplay(3, f.dim, "mm") };
      case "integer":
        return { value: f.key === "line_count" ? 6 : 2 };
      case "number":
        return { value: 0.5 };
      case "bool":
        return { value: true };
      case "enum":
        return { value: f.options?.[0] ?? "" };
      case "text":
        return { value: "text" };
    }
  }

  it.each(PART_KINDS)("%s", (kind) => {
    const { id, ops: added } = placed(kind);
    const before = apply(added).evaluated;
    const self = comp(before, id);
    for (const f of editorFields(kind)) {
      const { value, si } = sample(f, self, before);
      if (value === "") continue;
      // The first part of a rocket has no attachment, and the editor shows only Attach to for it.
      if (self.attach == null && f.key.startsWith("attach.") && f.key !== "attach.to") continue;
      const group = f.parent === undefined ? undefined : groupsOf(editorFields(kind)).find((g) => g.key === f.parent);
      // Groups are added first, whole, as the Add button does.
      const grouped = group === undefined ? added : [...added, ...groupAddOps([self], FILES, group, "mm")];
      const inGroup = comp(apply(grouped).evaluated, id);
      // The form renders a group's fields once the mirror has the table, so the writes see it there.
      const mirrored = group === undefined ? FILES : { ...FILES, "zz.rw.toml": `[c.${id}.${group.key}]\n` };
      const ops = [...grouped, ...fieldWriteOps([inGroup], mirrored, f, value)];
      const out = apply(ops);
      const refused = (out.check?.diagnostics ?? []).filter((d) => d.severity === "error" && (d.code === "RW-E001" || d.code === "RW-E002"));
      expect(refused, `${kind} ${f.key}`).toEqual([]);
      // `override.cg` evaluates to a station on the rocket; the source holds it from the part's fore end.
      const read = f.key === "override.cg" ? null : evaluatedValue(comp(out.evaluated, id), f.key);
      if (read !== null && si !== undefined) expect(read as number, `${kind} ${f.key}`).toBeCloseTo(si, 9);
      else if (read !== null) expect(read, `${kind} ${f.key}`).toBe(value);
    }
  });
});
