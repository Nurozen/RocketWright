/** U22: op builders, checked against the real core: a patch that applies here is one the sidecar accepts (I4). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvaluatedModel, JsonValue, PatchOp, schema } from "@rw/contracts";
import { applyPatch, SCHEMA_META } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { fromRwWasm, type PreviewCore } from "../wasm.ts";
import { deleteEngineOps, duplicateEngineOps, newEngineOps, renameEngineOps } from "./engines.ts";
import { ID_PATTERN, slugify, uniqueId } from "./ids.ts";
import { addMaterialOps, setMaterialOps } from "./materials.ts";
import { addPartOps, defaultPart, duplicatePartOps, PART_KINDS, type PartKind } from "./parts.ts";
import { deleteSimOps, duplicateSimOps, newSimOps, renameSimOps } from "./sims.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

function files(rel: string): Record<string, string> {
  const root = join(repo, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}

let core: Required<PreviewCore>;
let empty: Record<string, string>;
let minimum: Record<string, string>;

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  empty = files("templates/empty");
  minimum = files("templates/minimum");
});

const apply = (src: Record<string, string>, ops: readonly PatchOp[]) => core.applyAndCheck({ files: src, ops });

/**
 * Malformed-model errors (RW-E0xx: schema, units, attachment, geometry limits).
 * RW-E1xx are flight and clearance findings an unfinished rocket has by nature
 * (no motor, unstable, a 54 mm part in a narrower tube).
 */
const isModelError = (d: schema.Diagnostic) => d.severity === "error" && d.code.startsWith("RW-E0");

/** What the ops introduced beyond the source's own errors. */
function newErrors(src: Record<string, string>, ops: readonly PatchOp[]): string[] {
  const show = (ds: readonly schema.Diagnostic[]) => ds.filter(isModelError).map((d) => `${d.code} ${d.path}: ${d.message}`);
  const before = new Set(show(apply(src, []).check.diagnostics));
  return show(apply(src, ops).check.diagnostics).filter((e) => !before.has(e));
}

const ROOTS: PartKind[] = ["nose_cone", "body_tube", "transition"];
const SURFACE: PartKind[] = ["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set", "launch_lug", "rail_button"];
const attachFor = (kind: PartKind, body: string) => ({ to: `${body}.${ROOTS.includes(kind) ? "aft" : SURFACE.includes(kind) ? "outer" : "inner"}` });

describe("ids", () => {
  it.each([
    ['3" Body Tube', "part_3_body_tube"],
    ["Düse", "duse"],
    ["  Main   chute! ", "main_chute"],
    ["🚀", "part"],
    ["a".repeat(300), "a".repeat(64)],
  ])("slugify(%j)", (name, want) => {
    expect(slugify(name, "part")).toBe(want);
    expect(want).toMatch(ID_PATTERN);
  });

  it("numbers around taken ids", () => {
    expect(uniqueId("Body", ["body", "body_2"], "part")).toBe("body_3");
    expect(uniqueId("Body", [], "part")).toBe("body");
  });
});

describe("part defaults", () => {
  const base = addPartOps({ kind: "nose_cone", taken: [] });
  const body = addPartOps({ kind: "body_tube", taken: ["nose_cone"], attach: { to: "nose_cone.base" } });

  it("covers all 19 kinds from the schema", () => {
    expect(PART_KINDS).toHaveLength(19);
    expect(new Set(PART_KINDS)).toEqual(new Set(Object.keys(SCHEMA_META["Component"]!.variants!)));
  });

  it("returns independent values", () => {
    const a = defaultPart("freeform_fin_set") as { points: unknown[] };
    a.points.length = 0;
    expect((defaultPart("freeform_fin_set") as { points: unknown[] }).points).toHaveLength(4);
  });

  it.each(ROOTS)("%s is valid as the first part of an empty project", (kind) => {
    const { id, ops } = addPartOps({ kind, taken: [] });
    const { evaluated } = apply(empty, ops);
    expect(evaluated.components.map((c) => c.id)).toEqual([id]);
    expect(newErrors(empty, ops)).toEqual([]);
  });

  it.each(PART_KINDS.filter((k) => k !== "nose_cone"))("%s is valid attached in an empty project", (kind) => {
    const added = addPartOps({ kind, taken: ["nose_cone", body.id], attach: attachFor(kind, body.id) });
    const ops = [...base.ops, ...body.ops, ...added.ops];
    const { evaluated } = apply(empty, ops);
    expect(evaluated.components.map((c) => c.id)).toContain(added.id);
    expect(newErrors(empty, ops)).toEqual([]);
  });

  it.each(PART_KINDS.filter((k) => k !== "nose_cone"))("%s stays well-formed on a much narrower airframe", (kind) => {
    const { ops } = addPartOps({ kind, taken: ["nose", "body", "fins", "mount", "streamer"], attach: attachFor(kind, "body") });
    expect(newErrors(minimum, ops)).toEqual([]);
  });

  it("names the id from the display name", () => {
    const { id, ops } = addPartOps({ kind: "body_tube", taken: [], name: "Upper Body" });
    expect(id).toBe("upper_body");
    expect(apply(empty, ops).evaluated.components[0]!.name).toBe("Upper Body");
  });
});

describe("duplicate subtree", () => {
  const components = () => apply(minimum, []).evaluated.components;

  it("copies a part and what attaches to it, re-pointed at the copies", () => {
    const { id, ids, ops } = duplicatePartOps(components(), "body");
    expect(id).toBe("body_2");
    expect(ids).toEqual(
      new Map([
        ["body", "body_2"],
        ["fins", "fins_2"],
        ["mount", "mount_2"],
        ["streamer", "streamer_2"],
      ]),
    );
    expect(newErrors(minimum, ops)).toEqual([]);
    const after = apply(minimum, ops).evaluated.components;
    const by = (x: string) => after.find((c) => c.id === x)!;
    expect(by("body_2").attach?.to).toBe("nose.base");
    expect(by("body_2").name).toBe("body copy");
    expect(by("fins_2").attach).toMatchObject({ to: "body_2.aft", at: "root_te" });
    expect(by("streamer_2").attach?.to).toBe("body_2.fore");
    expect(by("mount_2").attach).toMatchObject({ to: "body_2.aft", at: "aft" });
    // The originals are untouched.
    expect(by("fins").attach?.to).toBe("body.aft");
  });

  it("takes a part attached through a sibling's anchor with it", () => {
    const ring = addPartOps({ kind: "centering_ring", taken: ["ring"], name: "Ring", attach: { to: "mount.fore" } });
    const src = apply(minimum, ring.ops).evaluated.components;
    expect(src.find((c) => c.id === ring.id)!.parent).toBe("body");
    const dup = duplicatePartOps(src, "mount");
    expect([...dup.ids.keys()]).toEqual(["mount", ring.id]);
    const after = apply(minimum, [...ring.ops, ...dup.ops]).evaluated.components;
    expect(after.find((c) => c.id === `${ring.id}_2`)!.attach?.to).toBe("mount_2.fore");
  });

  it("puts the copy of a first body tube on its aft end", () => {
    const first = addPartOps({ kind: "body_tube", taken: [], name: "Tube" });
    const comps = apply(empty, first.ops).evaluated.components;
    const dup = duplicatePartOps(comps, "tube");
    expect(newErrors(empty, [...first.ops, ...dup.ops])).toEqual([]);
    expect(apply(empty, [...first.ops, ...dup.ops]).evaluated.components.find((c) => c.id === "tube_2")!.attach?.to).toBe("tube.aft");
  });

  it("refuses a leading nose cone", () => {
    expect(() => duplicatePartOps(components(), "nose")).toThrow(/nose cone/);
  });

  it("drops .ork provenance from the copy", () => {
    const parts = [{ id: "body", name: "body", shape: { type: "body_tube" }, attach: { to: "nose.base" } }] as unknown as EvaluatedModel["components"];
    const doc = { c: { body: { import: { uuid: "abc" } } } } as unknown as JsonValue;
    const out = applyPatch(doc, duplicatePartOps(parts, "body").ops);
    expect(out).toEqual({ ok: { c: { body: { import: { uuid: "abc" } }, body_2: { import: null, name: "body copy" } } } });
    // The null is written as an absent field: every other duplicate test here goes through the real core.
  });

  it("does not run away on an attach cycle", () => {
    const parts = [
      { id: "a", name: "a", attach: { to: "b.aft" }, shape: { type: "body_tube" } },
      { id: "b", name: "b", attach: { to: "a.aft" }, shape: { type: "body_tube" } },
    ] as unknown as EvaluatedModel["components"];
    expect([...duplicatePartOps(parts, "a").ids.keys()]).toEqual(["a", "b"]);
  });
});

describe("sims", () => {
  it("creates, duplicates, renames and deletes", () => {
    const { id, ops } = newSimOps("High Wind", "default", []);
    expect(id).toBe("high_wind");
    expect(apply(empty, ops).evaluated.sims[id]).toMatchObject({ name: "High Wind", config: "default" });
    expect(newErrors(empty, ops)).toEqual([]);

    const dup = duplicateSimOps(id, "High Wind", [id]);
    expect(dup.id).toBe("high_wind_2");
    const all = [...ops, ...dup.ops, ...renameSimOps(id, "Gusty")];
    const sims = apply(empty, all).evaluated.sims;
    expect(sims["high_wind_2"]!.name).toBe("High Wind");
    expect(sims[id]!.name).toBe("Gusty");
    expect(apply(empty, [...all, ...deleteSimOps(id)]).evaluated.sims[id]).toBeUndefined();
  });
});

describe("materials", () => {
  it("adds and replaces whole entries", () => {
    const { id, ops } = addMaterialOps("Carbon Fiber", { density: "1600 kg/m^3" }, []);
    expect(id).toBe("carbon_fiber");
    expect(apply(empty, ops).evaluated.materials[id]).toBeDefined();
    const next = apply(empty, [...ops, ...setMaterialOps(id, { surface_density: "67 g/m^2" })]).evaluated.materials[id]!;
    expect(next.density ?? null).toBeNull();
    expect(next.surface_density).toBeCloseTo(0.067);
  });
});

describe("engines", () => {
  it("creates a valid engine, then duplicates and renames it", () => {
    const { id, ops } = newEngineOps("Main Engine", []);
    expect(id).toBe("main_engine");
    expect(newErrors(empty, ops)).toEqual([]);
    const dup = duplicateEngineOps(id, "Main Engine", [id]);
    const all = [...ops, ...dup.ops, ...renameEngineOps(id, "Sustainer")];
    expect(apply(empty, all).evaluated.engines![id]!.name).toBe("Sustainer");
    expect(apply(empty, all).evaluated.engines!["main_engine_2"]!.name).toBe("Main Engine");
  });

  it("delete leaves the sample project valid", () => {
    const sample = files("templates/sample");
    const before = apply(sample, []).evaluated;
    expect(before.engines?.["demo"]).toBeDefined();
    const ops = deleteEngineOps(before, "demo");
    expect(ops.some((o) => o.path.startsWith("/sims/") || o.path.startsWith("/configs/"))).toBe(true);
    expect(newErrors(sample, ops)).toEqual([]);
    expect(apply(sample, ops).evaluated.engines?.["demo"]).toBeUndefined();
  });

  it("delete also clears what fires it and studies of it", () => {
    const evaluated = {
      configs: { a: { id: "a", motors: [{ mount: "m1", engine: "e" }, { mount: "m2", motor: "generic:RW_C6G" }] }, b: { id: "b", motors: [{ mount: "m1", engine: "other" }] } },
      sims: { flight: { id: "flight" }, study: { id: "study", visual_flow: { engine: "e" } } },
    } as unknown as EvaluatedModel;
    expect(deleteEngineOps(evaluated, "e")).toEqual([
      { op: "remove", path: "/engines/e" },
      { op: "remove", path: "/configs/a/motors/m1" },
      { op: "remove", path: "/sims/study" },
    ]);
  });
});
