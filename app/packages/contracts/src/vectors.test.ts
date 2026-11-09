/**
 * Shared vectors (`schema/testdata/*.json`, written by `cargo xtask schema`):
 * the TS ref parser, patch applier, and containment checks must agree with the
 * Rust ones (M1.23, R2.1).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTAINMENT,
  SCHEMA_META,
  applyPatch,
  containmentAllowed,
  containmentCanBeRoot,
  containmentParents,
  formatRef,
  jsonEqual,
  parseRef,
  type JsonValue,
  type PatchOp,
  type schema,
} from "./index.ts";

function vectors<T>(name: string): T[] {
  const url = new URL(`../../../../schema/testdata/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { vectors: T[] }).vectors;
}

describe("refs.json", () => {
  const rows = vectors<{ input: string; ok?: object; err?: string }>("refs");
  it("has vectors", () => expect(rows.length).toBeGreaterThanOrEqual(20));
  for (const row of rows) {
    it(`${row.input}`, () => {
      const got = parseRef(row.input);
      if (row.ok !== undefined) {
        expect(got).toEqual({ ok: row.ok });
        if ("ok" in got) expect(formatRef(got.ok)).toBe(row.input);
      } else {
        expect(got).toEqual({ err: row.err });
      }
    });
  }
});

describe("patches.json", () => {
  const rows = vectors<{ name: string; doc: JsonValue; patch: PatchOp[]; ok?: JsonValue; err?: { op: number; kind: string } }>(
    "patches",
  );
  it("has vectors", () => expect(rows.length).toBeGreaterThanOrEqual(30));
  for (const row of rows) {
    it(`${row.name}`, () => {
      const before = structuredClone(row.doc);
      const got = applyPatch(row.doc, row.patch);
      expect(row.doc).toEqual(before);
      if (row.ok !== undefined) {
        if (!("ok" in got)) throw new Error(`${row.name}: ${JSON.stringify(got.err)}`);
        expect(jsonEqual(got.ok, row.ok)).toBe(true);
      } else {
        if (!("err" in got)) throw new Error(`${row.name}: expected an error`);
        expect({ op: got.err.op, kind: got.err.kind }).toEqual(row.err);
      }
    });
  }
});

describe("containment.json", () => {
  const rows = vectors<{
    child: schema.ComponentType;
    natural_kind: schema.AnchorKind;
    can_be_root: boolean;
    parents: Record<schema.AnchorKind, schema.ComponentType[]>;
  }>("containment");
  const anchorKinds: readonly schema.AnchorKind[] = ["axial", "inner", "surface"];

  it("covers every component kind the schema publishes, once", () => {
    expect(rows).toHaveLength(19);
    expect(rows.map((r) => r.child).toSorted()).toEqual(Object.keys(SCHEMA_META.Component?.variants ?? {}).toSorted());
    expect(CONTAINMENT.kinds).toEqual(rows.map((r) => r.child));
  });

  for (const row of rows) {
    it(`${row.child}`, () => {
      expect(Object.keys(row.parents).toSorted()).toEqual(anchorKinds);
      expect(CONTAINMENT.natural_kind[row.child]).toBe(row.natural_kind);
      expect(containmentCanBeRoot(row.child)).toBe(row.can_be_root);
      for (const kind of anchorKinds) {
        expect(containmentParents(row.child, kind)).toEqual(row.parents[kind]);
        for (const parent of CONTAINMENT.kinds) {
          expect(containmentAllowed(parent, row.child, kind), `${parent} > ${row.child} (${kind})`).toBe(
            row.parents[kind].includes(parent),
          );
        }
      }
    });
  }
});
