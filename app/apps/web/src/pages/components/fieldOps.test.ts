/** U46 nested fields: the expression-safe source reader, reads and writes on dotted paths, and Add writing a whole, valid group. */
import { readFileSync } from "node:fs";
import type { EvaluatedModel, PatchOp, schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { describe, expect, it } from "vitest";
import { editorFields, groupsOf, rangeError, limitsOf, type FieldGroup, type FieldSpec } from "../../ui/fields/index.ts";
import { evaluatedValue, fieldValue, fieldWriteOps, groupAddOps, tablePresent } from "./fieldOps.ts";
import { fieldTarget, sourceHasTable, tableScalars } from "./source.ts";

const repo = new URL("../../../../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), "utf8");

type Comp = schema.EvalComponent;

const nose = (over: Record<string, unknown> = {}, shape: Record<string, unknown> = {}) =>
  ({ id: "nose", name: "Nose cone", shape: { type: "nose_cone", length: 0.1, od: 0.025, ...shape }, ...over }) as unknown as Comp;

const field = (type: string, key: string): FieldSpec => editorFields(type).find((f) => f.key === key)!;
const group = (type: string, key: string): FieldGroup => groupsOf(editorFields(type)).find((g) => g.key === key)!;

describe("thickness and the bore it replaces", () => {
  const tube = { id: "body", name: "Body", shape: { type: "body_tube", length: 0.3, od: 0.0248, id: 0.0241 } } as unknown as Comp;
  const FILES = { "rocket.rw.toml": ['[params.bore]', 'value = "24.1 mm"', "", "[c.body]", 'type = "body_tube"', 'length = "300 mm"', 'od = "24.8 mm"', 'id = "= params.bore"'].join("\n") };

  it("clears the tube's own id when the id is a parameter reference, and leaves the parameter's value alone", () => {
    const ops = fieldWriteOps([tube], FILES, field("body_tube", "thickness"), "0.4 mm");
    expect(ops).toContainEqual({ op: "remove", path: "/c/body/id" });
    expect(ops).not.toContainEqual({ op: "remove", path: "/params/bore/value" });
  });
});

describe("the source reader", () => {
  const FILES = {
    "rocket.rw.toml": [
      "[c.nose]",
      'attach = { to = "body.fore", offset = "= max(params.a, params.b)", note = "a, b } c" } # trailing, comment',
      'shoulder = { length = "20 mm", capped = true, inner = { deep = "1 mm" } }',
      "points = [",
      "  [0, 0],",
      "  [1, 1]",
      "]",
      'after = "kept"',
      "[c.fins.tab]",
      'height = "4 mm"',
      "[c.lug]",
      'finish.roughness = "60 um"',
    ].join("\n"),
  };

  it("keeps commas and braces inside an inline table's strings", () => {
    expect(tableScalars(FILES, ["c", "nose", "attach"])).toEqual({ to: "body.fore", offset: "= max(params.a, params.b)", note: "a, b } c" });
    expect(fieldTarget(FILES, "nose", "attach.offset").expression).toBe("= max(params.a, params.b)");
  });

  it("reads nested inline tables, header tables, and dotted keys by dotted path", () => {
    expect(fieldTarget(FILES, "nose", "shoulder.length")).toMatchObject({ path: "/c/nose/shoulder/length", written: "20 mm" });
    expect(fieldTarget(FILES, "nose", "shoulder.capped").written).toBe(true);
    expect(tableScalars(FILES, ["c", "nose", "shoulder", "inner"])).toEqual({ deep: "1 mm" });
    expect(fieldTarget(FILES, "fins", "tab.height").written).toBe("4 mm");
    expect(fieldTarget(FILES, "lug", "finish.roughness").written).toBe("60 um");
  });

  it("does not read a multi-line array's rows as headers", () => {
    expect(tableScalars(FILES, ["c", "nose"])).toMatchObject({ after: "kept" });
  });

  it("knows which tables a part has", () => {
    expect(sourceHasTable(FILES, "nose", ["shoulder"])).toBe(true);
    expect(sourceHasTable(FILES, "fins", ["tab"])).toBe(true);
    expect(sourceHasTable(FILES, "nose", ["tab"])).toBe(false);
  });
});

describe("reading nested fields", () => {
  it("walks into the shape or the component, and reads booleans", () => {
    const c = nose({ override: { mass: 0.02 } }, { shoulder: { length: 0.02, od: 0.023, thickness: 0.002, capped: true } });
    expect(evaluatedValue(c, "shoulder.length")).toBe(0.02);
    expect(evaluatedValue(c, "shoulder.capped")).toBe(true);
    expect(evaluatedValue(c, "override.mass")).toBe(0.02);
    expect(evaluatedValue(c, "shoulder.missing")).toBeNull();
  });
});

describe("writing nested fields", () => {
  const FILES = { "rocket.rw.toml": '[c.nose]\nlength = "100 mm"\n' };
  const written = { "rocket.rw.toml": '[c.nose]\nshoulder = { length = "20 mm", od = "23 mm" }\n' };

  it("writes a whole table only when it is absent", () => {
    const f = field("nose_cone", "override.mass");
    expect(fieldWriteOps([nose()], FILES, f, "20 g")).toEqual([{ op: "add", path: "/c/nose/override", value: { mass: "20 g" } }]);
    const present = { "rocket.rw.toml": '[c.nose]\noverride = { cg = "10 mm" }\n' };
    expect(fieldWriteOps([nose()], present, f, "20 g")).toEqual([{ op: "add", path: "/c/nose/override/mass", value: "20 g" }]);
  });

  it("writes the leaf of a group the shape has, keeping its siblings", () => {
    const f = field("nose_cone", "shoulder.length");
    expect(fieldWriteOps([nose()], written, f, "25 mm")).toEqual([{ op: "replace", path: "/c/nose/shoulder/length", value: "25 mm" }]);
  });

  it("still writes the leaf when only the draft has the group yet", () => {
    const f = field("nose_cone", "shoulder.length");
    const drafted = nose({}, { shoulder: { length: 0.02, od: 0.023, thickness: 0.002, capped: false } });
    expect(tablePresent(FILES, drafted, ["shoulder"])).toBe(true);
    expect(fieldWriteOps([drafted], FILES, f, "25 mm")).toEqual([{ op: "add", path: "/c/nose/shoulder/length", value: "25 mm" }]);
  });

  it("writes a shared parameter once and clears a written leaf", () => {
    const linked = { "rocket.rw.toml": '[params.len]\nvalue = "20 mm"\n[c.nose]\nshoulder = { length = "= params.len", od = "23 mm" }\n[c.nose2]\nshoulder = { length = "= params.len", od = "23 mm" }\n' };
    const f = field("nose_cone", "shoulder.length");
    expect(fieldWriteOps([nose(), nose({ id: "nose2" })], linked, f, "25 mm")).toEqual([{ op: "replace", path: "/params/len/value", value: "25 mm" }]);
    expect(fieldWriteOps([nose()], { "rocket.rw.toml": '[c.nose]\noverride = { mass = "20 g" }\n' }, field("nose_cone", "override.mass"), null)).toEqual([{ op: "remove", path: "/c/nose/override/mass" }]);
  });

  it("lets a tab be zero deep and its offset negative", () => {
    const h = field("trapezoidal_fin_set", "tab.height");
    const off = field("trapezoidal_fin_set", "tab.offset");
    expect(rangeError(0, h, limitsOf(h, null, "mm"), "mm")).toBeNull();
    expect(rangeError(-0.005, off, limitsOf(off, null, "mm"), "mm")).toBeNull();
    const length = field("nose_cone", "length");
    expect(rangeError(0, length, limitsOf(length, null, "mm"), "mm")).toBe("Length must be greater than 0.");
  });
});

describe("Add writes the whole group", () => {
  it("names the groups the way the e2e drive looks for them", () => {
    expect(group("nose_cone", "shoulder")).toMatchObject({ heading: "Shoulder", add: "Add shoulder" });
    expect(group("transition", "fore_shoulder")).toMatchObject({ heading: "Fore shoulder", add: "Add fore shoulder" });
    expect(group("trapezoidal_fin_set", "tab")).toMatchObject({ heading: "Fin tab", add: "Add fin tab" });
    expect(group("nose_cone", "shoulder").fields.map((f) => f.label)).toEqual(["Length", "Outer diameter", "Thickness", "Capped"]);
    expect(group("nose_cone", "shoulder").fields.find((f) => f.key === "shoulder.capped")?.kind).toBe("bool");
  });

  it("writes required members together, in the toolbar unit, sized from the part", () => {
    expect(groupAddOps([nose()], {}, group("nose_cone", "shoulder"), "mm")).toEqual([{ op: "add", path: "/c/nose/shoulder", value: { length: "25 mm", od: "22.5 mm" } }]);
    const fins = { id: "fins", name: "Fins", shape: { type: "trapezoidal_fin_set", root_chord: 0.06 } } as unknown as Comp;
    expect(groupAddOps([fins], {}, group("trapezoidal_fin_set", "tab"), "in")).toEqual([{ op: "add", path: "/c/fins/tab", value: { height: "0 in", length: "1.181 in" } }]);
    const transition = { id: "t", name: "T", shape: { type: "transition", fore_od: 0.04, aft_od: 0.05 } } as unknown as Comp;
    expect(groupAddOps([transition], {}, group("transition", "aft_shoulder"), "mm")).toEqual([{ op: "add", path: "/c/t/aft_shoulder", value: { length: "50 mm", od: "45 mm" } }]);
  });

  it("skips a part that already has the group", () => {
    const has = nose({}, { shoulder: { length: 0.02, od: 0.023, thickness: 0.002, capped: false } });
    expect(groupAddOps([has], {}, group("nose_cone", "shoulder"), "mm")).toEqual([]);
  });

  it("a Thickness edit on an id that names a parameter, and a typed formula, are accepted by the real engine", async () => {
    const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
    const rocket = read("templates/minimum/rocket.rw.toml").replace('id = "24.1 mm"', 'id = "= params.bore"');
    const files = { "rocket.rw.toml": `[params.bore]\nvalue = "24.1 mm"\n\n[params.scale]\nvalue = 2\n\n${rocket}`, "rocketwright.toml": read("templates/minimum/rocketwright.toml") };
    const apply = (ops: readonly PatchOp[]) => rw.applyAndEval!({ files, ops }) as { evaluated: EvaluatedModel };
    const before = apply([]);
    const part = (m: EvaluatedModel, id: string) => m.components.find((c) => c.id === id)!;
    const thickness = fieldWriteOps([part(before.evaluated, "body")], files, field("body_tube", "thickness"), "0.4 mm");
    expect((part(apply(thickness).evaluated, "body").shape as unknown as { od: number }).od).toBeCloseTo(0.0248, 6);

    const formula = fieldWriteOps([part(before.evaluated, "fins")], files, field("trapezoidal_fin_set", "span"), "= 20 mm * params.scale");
    expect((part(apply(formula).evaluated, "fins").shape as unknown as { span: number }).span).toBeCloseTo(0.04, 6);
  });

  it("is accepted by the real engine and adds no error, with siblings intact on a later edit", async () => {
    const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
    const rocket = read("fixtures/case1/rocket.rw.toml")
      .replace(/^shoulder = .*\n/m, "")
      .replace(/^tab = .*\n/m, "");
    const files = { "rocket.rw.toml": rocket, "rocketwright.toml": read("fixtures/case1/rocketwright.toml") };
    const apply = (ops: readonly PatchOp[]) => rw.applyAndEval!({ files, ops }) as { evaluated: EvaluatedModel; check?: { diagnostics: { code: string; severity: string; path?: string | null }[] } };
    const before = apply([]);
    const comp = (m: EvaluatedModel, id: string) => m.components.find((c) => c.id === id)!;
    expect(tablePresent(files, comp(before.evaluated, "nose"), ["shoulder"])).toBe(false);

    const ops = [
      ...groupAddOps([comp(before.evaluated, "nose")], files, group("nose_cone", "shoulder"), "mm"),
      ...groupAddOps([comp(before.evaluated, "fins")], files, group("trapezoidal_fin_set", "tab"), "mm"),
    ];
    const after = apply(ops);
    const shoulder = (comp(after.evaluated, "nose").shape as unknown as { shoulder: { length: number; od: number; capped: boolean } }).shoulder;
    expect(shoulder.length).toBeCloseTo(0.025, 9);
    expect(shoulder.od).toBeCloseTo(0.0225, 9);
    expect(shoulder.capped).toBe(false);
    expect((comp(after.evaluated, "fins").shape as unknown as { tab: { length: number } }).tab.length).toBeCloseTo(comp(before.evaluated, "fins").shape.type === "trapezoidal_fin_set" ? (comp(before.evaluated, "fins").shape as unknown as { root_chord: number }).root_chord / 2 : 0, 3);
    const errors = (after.check?.diagnostics ?? []).filter((d) => d.severity === "error" && /\/(shoulder|tab)/.test(d.path ?? ""));
    expect(errors).toEqual([]);

    // A later leaf edit lands inside the group, not over it.
    const edited = apply([...ops, ...fieldWriteOps([comp(after.evaluated, "nose")], files, field("nose_cone", "shoulder.capped"), true)]);
    const again = (comp(edited.evaluated, "nose").shape as unknown as { shoulder: { length: number; capped: boolean } }).shoulder;
    expect(again.capped).toBe(true);
    expect(again.length).toBeCloseTo(0.025, 9);
  });
});

describe("the bore of a tube", () => {
  const tube = { id: "body", name: "Body", shape: { type: "body_tube", length: 0.3, od: 0.025, id: 0.023 } } as unknown as Comp;
  const withId = { "rocket.rw.toml": '[c.body]\nid = "23 mm"\n' };
  const withThickness = { "rocket.rw.toml": '[c.body]\nthickness = "1 mm"\n' };

  it("clears the id when a thickness is typed, because the model reads the id first", () => {
    expect(fieldWriteOps([tube], withId, field("body_tube", "thickness"), "1 mm")).toEqual([
      { op: "add", path: "/c/body/thickness", value: "1 mm" },
      { op: "remove", path: "/c/body/id" },
    ]);
  });

  it("clears the thickness when an id is typed", () => {
    expect(fieldWriteOps([tube], withThickness, field("body_tube", "id"), "20 mm")).toEqual([
      { op: "add", path: "/c/body/id", value: "20 mm" },
      { op: "remove", path: "/c/body/thickness" },
    ]);
  });

  it("leaves another kind's id alone: a ring's id and thickness are not alternatives", () => {
    const ring = { id: "r", name: "R", shape: { type: "centering_ring", length: 0.002, od: 0.023, id: 0.019 } } as unknown as Comp;
    expect(fieldWriteOps([ring], { "rocket.rw.toml": '[c.r]\nthickness = "1 mm"\n' }, field("centering_ring", "id"), "19 mm")).toEqual([{ op: "add", path: "/c/r/id", value: "19 mm" }]);
  });

  it("shows the wall a bore implies when no thickness is written", () => {
    expect(fieldValue(tube, withId, field("body_tube", "thickness"))).toBeCloseTo(0.001, 9);
  });
});

describe("what a field shows", () => {
  it("reads a field the evaluated model does not carry from the source", () => {
    const part = { id: "lug", name: "Lug", shape: { type: "launch_lug" }, attach: { to: "body.mid", at: "fore", offset: 0 } } as unknown as Comp;
    const files = { "rocket.rw.toml": '[c.lug]\nattach = { to = "body.mid", spin = "19 deg" }\n' };
    expect(fieldValue(part, files, field("launch_lug", "attach.spin"))).toBeCloseTo((19 * Math.PI) / 180, 9);
  });

  it("does not take an anchor the model filled in for one a person chose", () => {
    const part = { id: "lug", name: "Lug", shape: { type: "launch_lug" }, attach: { to: "body.mid", at: "mid", offset: 0 } } as unknown as Comp;
    expect(fieldValue(part, { "rocket.rw.toml": '[c.lug]\nattach = { to = "body.mid" }\n' }, field("launch_lug", "attach.at"))).toBeNull();
  });
});

describe("groups the editor adds", () => {
  it("starts a custom finish at the part's own roughness, in micrometres", () => {
    const part = nose({ roughness: 0.00002 });
    expect(groupAddOps([part], {}, group("nose_cone", "finish"), "mm")).toEqual([{ op: "add", path: "/c/nose/finish", value: { roughness: "20 um" } }]);
  });

  it("writes instances and a joint whole, with their required members", () => {
    expect(groupAddOps([nose()], {}, group("nose_cone", "instances"), "mm")).toEqual([{ op: "add", path: "/c/nose/instances", value: { count: 2, pattern: "radial" } }]);
    expect(groupAddOps([nose()], {}, group("nose_cone", "joint"), "mm")).toEqual([{ op: "add", path: "/c/nose/joint", value: { type: "friction" } }]);
  });

  it("offers instances until the source has them: every part evaluates to at least one", () => {
    const part = nose({ instances: [{ x: 0, roll: 0 }] });
    expect(tablePresent({}, part, ["instances"])).toBe(false);
    expect(tablePresent({ "rocket.rw.toml": '[c.nose]\ninstances = { count = 2, pattern = "radial" }\n' }, part, ["instances"])).toBe(true);
  });
});
