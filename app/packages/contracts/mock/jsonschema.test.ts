import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/types.ts";
import { loadFixtures } from "./fixtures.ts";
import { makeValidator, schemaMode } from "./harness.ts";
import { inferSchema, type Schema, Validator } from "./jsonschema.ts";
import { reg } from "./rpc-schema.ts";

// The shape schemars emits for a unit-carrying length (`{"od":"54 mm"}` passes, `{"od":54}` fails).
const LEN: Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.test/tube.json",
  type: "object",
  properties: { od: { $ref: "#/$defs/Length" }, kind: { enum: ["tube", "nose"] }, count: { type: "integer", minimum: 1 } },
  required: ["od"],
  additionalProperties: false,
  $defs: { Length: { type: "string", pattern: "^[-+0-9.eE]+ ?(mm|cm|m|in)$|^=", "x-unit-dimension": "length" } },
};

describe("mock jsonschema validator", () => {
  const v = new Validator();
  v.add(LEN);
  const errs = (x: JsonValue) => v.validate("https://example.test/tube.json", x);

  it("accepts and rejects per type, $ref, pattern, enum, additionalProperties", () => {
    expect(errs({ od: "54 mm" })).toEqual([]);
    expect(errs({ od: "= params.od", kind: "nose", count: 3 })).toEqual([]);
    expect(errs({ od: 54 })).not.toEqual([]);
    expect(errs({ od: "54 furlongs" })).not.toEqual([]);
    expect(errs({})).toEqual(["/: missing od"]);
    expect(errs({ od: "1 m", extra: true })).toEqual(["/extra: not allowed"]);
    expect(errs({ od: "1 m", kind: "fin" })).not.toEqual([]);
    expect(errs({ od: "1 m", count: 1.5 })).not.toEqual([]);
    expect(errs({ od: "1 m", count: 0 })).not.toEqual([]);
  });

  it("handles oneOf, anyOf, const, items, and length limits", () => {
    const s: Schema = {
      type: "array",
      maxItems: 2,
      items: { oneOf: [{ type: "object", properties: { t: { const: "a" } }, required: ["t"] }, { type: "string", maxLength: 3 }] },
    };
    expect(v.validate(s, [{ t: "a" }, "abc"])).toEqual([]);
    expect(v.validate(s, ["abcd"])).not.toEqual([]);
    expect(v.validate(s, [{ t: "b" }])).not.toEqual([]);
    expect(v.validate(s, ["a", "b", "c"])).not.toEqual([]);
    expect(v.validate({ anyOf: [{ type: "null" }, { type: "number" }] }, null)).toEqual([]);
    expect(v.validate({ anyOf: [{ type: "null" }, { type: "number" }] }, "x")).not.toEqual([]);
  });

  it("infers a structural schema from examples", () => {
    const s = inferSchema([{ a: 1, b: ["x"] }, { a: 2 }]);
    expect(v.validate(s, { a: 3, b: [] })).toEqual([]);
    expect(v.validate(s, { a: 3 })).toEqual([]);
    expect(v.validate(s, { a: "3" })).not.toEqual([]);
    expect(v.validate(s, { a: 3, c: 1 })).not.toEqual([]);
    expect(v.validate(s, { b: [1] })).not.toEqual([]);
  });

  it(`rejects a mistyped registry payload (${schemaMode})`, () => {
    const fx = loadFixtures();
    const rv = makeValidator(fx);
    const report = fx.payload<{ [k: string]: JsonValue }>("check-report");
    expect(rv.validate(reg("check-report"), report)).toEqual([]);
    expect(rv.validate(reg("check-report"), { ...report, model_hash: 5 })).not.toEqual([]);
    expect(rv.validate(reg("check-report"), { ...report, diagnostics: "none" })).not.toEqual([]);
    if (schemaMode === "generated") expect(rv.validate(reg("check-report"), { ...report, status: "fine" })).not.toEqual([]);
  });
});
