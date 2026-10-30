import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR, drift, generate } from "../scripts/gen.ts";
import { MCP_TOOL_CATALOG, SCHEMA_META, SCHEMA_REGISTRY, type CheckDelta, type schema } from "./index.ts";

describe("generated contracts (M1.6)", () => {
  it("src/generated matches schema/ (gen:check)", async () => {
    const files = await generate();
    expect(drift(files)).toEqual([]);
  }, 60_000);

  it("lists every published schema", () => {
    for (const e of SCHEMA_REGISTRY) expect(existsSync(join(SCHEMA_DIR, e.file)), e.file).toBe(true);
    const names = SCHEMA_REGISTRY.map((e) => e.name);
    for (const t of MCP_TOOL_CATALOG) {
      expect(names).toContain(t.input);
      expect(names).toContain(t.output);
    }
  });

  it("carries x- metadata for editors", () => {
    expect(SCHEMA_META.BodyTube?.fields?.od).toMatchObject({ unitDimension: "length", expr: true });
    expect(SCHEMA_META.Component?.variants?.body_tube?.ref).toBe("BodyTube");
    expect(SCHEMA_META.Component?.variants?.trapezoidal_fin_set?.anchors).toContain("root_le");
    expect(SCHEMA_META.Component?.fields?.attach?.uiGroup).toBe("Attachment");
  });

  it("types the contract payloads", () => {
    const delta: CheckDelta = {
      status: "clean",
      model_hash: "0".repeat(64),
      changed: { "stability.liftoff": [1.42, 1.18] },
      new_diagnostics: [],
      resolved_diagnostics: [],
    };
    const tube: schema.Component = { type: "body_tube", length: "300 mm", od: "54 mm", id: "52 mm" };
    // @ts-expect-error a bare number is not a dimensional value (R2.2); only 0 is
    const bad: schema.BodyTube = { length: "300 mm", od: 54 };
    expect(delta.status).toBe("clean");
    expect(tube.type).toBe("body_tube");
    expect(bad.od).toBe(54);
  });
});
