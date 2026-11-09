/** U47: catalog parts become valid parts, checked against the real core and the real catalog files. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PatchOp, schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { addPartOps } from "../../state/ops/parts.ts";
import { fromRwWasm, type PreviewCore } from "../../state/wasm.ts";
import { attachmentFor } from "./attach-targets.ts";
import { addPresetOps, needLabel, presetGeometryOps, presetInfo, presetKind } from "./presets.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

interface CatalogFile {
  materials: Record<string, schema.Material>;
  presets: { id: string; manufacturer: string; part_number: string; description: string; component: Record<string, unknown> }[];
}

/** The item `library.search` gives for a catalog entry (`crates/rw-project/src/presets.rs`). */
function libItem(file: CatalogFile, p: CatalogFile["presets"][number]): schema.LibItem {
  const c = p.component;
  const used = Object.fromEntries(["material", "line_material"].flatMap((k) => (typeof c[k] === "string" && file.materials[c[k]] !== undefined ? [[c[k], file.materials[c[k]]]] : [])));
  const needs = c["type"] === "parachute" ? ["cd", "packed_length", "packed_diameter"] : c["type"] === "streamer" ? ["packed_length", "packed_diameter"] : [];
  return { id: `preset:x/${p.id}`, kind: "preset", name: String(c["name"]), source: "", data: { ...c, preset: { manufacturer: p.manufacturer, part_number: p.part_number, description: p.description, materials: used, needs: needs.filter((k) => !(k in c)) } } };
}

function templateFiles(rel: string): Record<string, string> {
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

/** One entry per (file, kind): every catalog and every kind, without 3,449 evaluations. */
function sample(): schema.LibItem[] {
  const dir = join(repo, "lib/presets");
  const out: schema.LibItem[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as CatalogFile;
    const seen = new Set<unknown>();
    for (const p of file.presets) {
      if (seen.has(p.component["type"])) continue;
      seen.add(p.component["type"]);
      out.push(libItem(file, p));
    }
  }
  return out;
}

let core: Required<PreviewCore>;
let empty: Record<string, string>;

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  empty = templateFiles("templates/empty");
});

const estes = (over: Record<string, unknown> = {}, block: Record<string, unknown> = {}): schema.LibItem => ({
  id: "preset:estes/bt_20",
  kind: "preset",
  name: "Estes BT-20",
  source: "",
  data: { type: "body_tube", name: "Estes BT-20", length: "18 in", od: "0.736 in", id: "0.71 in", material: "paper", preset: { manufacturer: "Estes", part_number: "BT-20", description: "Tube", materials: { paper: { density: "800 kg/m^3" } }, needs: [], ...block }, ...over },
});

describe("addPresetOps", () => {
  it("strips the preset block and defines the part's materials first", () => {
    const { id, name, ops } = addPresetOps({ item: estes(), takenIds: [], takenNames: [], materials: [] });
    expect(ops[0]).toEqual({ op: "add", path: "/materials/paper", value: { density: "800 kg/m^3" } });
    expect(ops[1]!.path).toBe(`/c/${id}`);
    expect(name).toBe("Estes BT-20");
    expect((ops[1] as { value: Record<string, unknown> }).value).not.toHaveProperty("preset");
    expect((ops[1] as { value: Record<string, unknown> }).value).toMatchObject({ id: "0.71 in", material: "paper" });
  });

  it("keeps a material the project already defines", () => {
    const { ops } = addPresetOps({ item: estes(), takenIds: [], takenNames: [], materials: ["paper"] });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.path).toMatch(/^\/c\//);
  });

  it("numbers a repeated part and places it", () => {
    const { id, name, ops } = addPresetOps({ item: estes(), takenIds: ["estes_bt_20"], takenNames: ["Estes BT-20"], materials: ["paper"], attach: { to: "nose.base" } as schema.Attach });
    expect(name).toBe("Estes BT-20 2");
    expect(id).toBe("estes_bt_20_2");
    expect((ops[0] as { value: Record<string, unknown> }).value).toMatchObject({ name: "Estes BT-20 2", attach: { to: "nose.base" } });
  });

  it("fills what the catalog leaves out from the part's defaults", () => {
    const chute = estes({ type: "parachute", name: "Chute", diameter: "12 in" }, { needs: ["cd", "packed_length", "packed_diameter"] });
    const { ops } = addPresetOps({ item: chute, takenIds: [], takenNames: [], materials: ["paper"] });
    expect((ops[0] as { value: Record<string, unknown> }).value).toMatchObject({ cd: 0.8, packed_length: "60 mm", packed_diameter: "40 mm" });
  });

  it("refuses an item that is not a part", () => {
    expect(() => addPresetOps({ item: estes({ type: "not_a_part" }), takenIds: [], takenNames: [], materials: [] })).toThrow(/not a part/);
  });

  it("makes parts the core accepts, for every kind in every catalog", () => {
    const items = sample();
    expect(new Set(items.map((i) => i.data["type"])).size).toBe(10);
    const base: PatchOp[] = [...addPartOps({ kind: "nose_cone", taken: [] }).ops, ...addPartOps({ kind: "body_tube", taken: ["nose_cone"], attach: { to: "nose_cone.base" } as schema.Attach }).ops];
    const model = core.applyAndCheck({ files: empty, ops: base }).evaluated;
    const tube = model.components.find((c) => c.id === "body_tube")!;
    const nose = model.components.find((c) => c.id === "nose_cone")!;
    const failures: string[] = [];
    for (const item of items) {
      const kind = presetKind(item)!;
      // A nose cone preset can only start a rocket, so it goes on an empty one.
      const start = kind === "nose_cone";
      const attach = start ? null : attachmentFor(kind, tube) ?? attachmentFor(kind, nose);
      if (!start && attach === null) {
        failures.push(`${item.id}: no place`);
        continue;
      }
      const { ops } = addPresetOps({ item, takenIds: start ? [] : model.components.map((c) => c.id), takenNames: [], materials: [], ...(attach !== null ? { attach } : {}) });
      const out = core.applyAndCheck({ files: empty, ops: start ? ops : [...base, ...ops] });
      failures.push(...out.check.diagnostics.filter((d) => d.severity === "error" && /^RW-E0(0|1|2|3|5)/.test(d.code)).map((d) => `${item.id}: ${d.code} ${d.path}: ${d.message}`));
    }
    expect(failures).toEqual([]);
  });
});

describe("presetGeometryOps", () => {
  const tube = { id: "body", name: "Body", shape: { type: "body_tube" } } as never;

  it("writes geometry with add, so a field not yet written does not fail the patch", () => {
    const ops = presetGeometryOps(estes(), tube);
    expect(ops.map((o) => [o.op, o.path]).sort()).toEqual([["add", "/c/body/id"], ["add", "/c/body/length"], ["add", "/c/body/od"]]);
  });

  it("leaves the name, material and type alone", () => {
    const paths = presetGeometryOps(estes(), tube).map((o) => o.path);
    expect(paths).not.toContain("/c/body/name");
    expect(paths).not.toContain("/c/body/material");
    expect(paths).not.toContain("/c/body/preset");
  });
});

describe("presetInfo and needLabel", () => {
  it("reads the block", () => {
    expect(presetInfo(estes())).toMatchObject({ manufacturer: "Estes", partNumber: "BT-20", needs: [] });
  });
  it("reads a part with no block", () => {
    expect(presetInfo({ ...estes(), data: { type: "body_tube" } })).toMatchObject({ manufacturer: "", needs: [] });
  });
  it("names fields in words", () => {
    expect(needLabel("cd")).toBe("Cd");
    expect(needLabel("packed_length")).toBe("packed length");
  });
});
