/**
 * Shared vectors (`schema/testdata/*.json`, written by `cargo xtask schema`):
 * the TS ref parser and patch applier must agree with the Rust ones (M1.23).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatch, formatRef, jsonEqual, parseRef, type JsonValue, type PatchOp } from "./index.ts";

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
