/**
 * M2.9 page 02 units: the source reader (param-linked fields), schema-driven
 * fields with units and limits, the profile frame and overlay (CG/CP,
 * dimensions, every fin of a set alike, the ghost), the proposal search over
 * history steps (reverse ops, Revert), and the per-thread history.
 */
import { readFileSync } from "node:fs";
import type { CheckReport, CompareOut, EvaluatedModel, PatchOp } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import { changeText } from "./AgentExtras.tsx";
import { partDiagnostics } from "./ComponentEditor.tsx";
import { editorFields, fromDisplay, limitsOf, parseLiteral, rangeError, sharedFields, tabsFor, toDisplay, toSource } from "./fields.ts";
import { planformLayout, planformOf } from "./PartProfile.tsx";
import { airframeJoints, finOutlines, fitFrame, hull, modelExtents, profileOverlay, projectBody, scaleLabel, toScreen } from "./profile-geometry.ts";
import { changedFields, componentDiffers, draftProposal, findStepProposal, reverseOps } from "./proposal.ts";
import { componentSource, fieldTarget, paramRef, paramSource } from "./source.ts";
import { agentSteps, embedThreadSteps, openThreadSteps } from "./thread-history.ts";
import { linkedSteps } from "../../embed/threads.ts";
import type { EmbedThread } from "@rw/contracts";

const repo = new URL("../../../../../../", import.meta.url);
const fixture = <T,>(name: string): T => (JSON.parse(readFileSync(new URL(`fixtures/contracts/${name}.json`, repo), "utf8")) as { payload: T }).payload;
const evaluated = fixture<EvaluatedModel>("evaluated-model");
const check = fixture<CheckReport>("check-report");

const FILES = {
  "rocket.rw.toml": [
    'name = "Test"',
    "[params.fin_span]",
    'value = "90 mm"',
    'min = "60 mm"',
    'max = "120 mm"',
    'step = "5 mm" # spinner',
    "[c.fins]",
    'type = "trapezoidal_fin_set"',
    "count = 4",
    'root_chord = "140 mm"',
    'span = "= params.fin_span"',
    'sweep = "= 0.5 * params.fin_span"',
    'attach = { to = "fin_can.aft", at = "root_te" }',
    'override = { mass = "20 g" }',
    "[c.nose]",
    'length = "150 mm"',
  ].join("\n"),
};

/** A copy of the fixture with the fin set changed. */
function withFins(m: EvaluatedModel, span: number, sweep: number): EvaluatedModel {
  const out = structuredClone(m);
  const f = out.components.find((c) => c.id === "fins")!;
  (f.shape as { span: number; sweep: number }).span = span;
  (f.shape as { span: number; sweep: number }).sweep = sweep;
  const rle = f.anchors.find((a) => a.name === "root_le")!;
  for (const a of f.anchors) {
    if (a.name === "tip_le") {
      a.x = rle.x + sweep;
      a.r = rle.r + span;
    }
    if (a.name === "tip_te") {
      a.x = rle.x + sweep + 0.06;
      a.r = rle.r + span;
    }
  }
  out.model_hash = `${m.model_hash}-${span}-${sweep}`;
  return out;
}

describe("source reader", () => {
  it("reads component scalars, inline tables, and params", () => {
    expect(componentSource(FILES, "fins")).toMatchObject({ type: "trapezoidal_fin_set", count: 4, root_chord: "140 mm", span: "= params.fin_span" });
    expect(paramSource(FILES, "fin_span")).toEqual({ name: "fin_span", value: "90 mm", min: "60 mm", max: "120 mm", step: "5 mm" });
    expect(paramSource(FILES, "nope")).toBeNull();
    expect(paramRef("= params.fin_span")).toBe("fin_span");
    expect(paramRef("= 0.5 * params.fin_span")).toBeNull();
  });

  it("targets the param a field references, else the field", () => {
    expect(fieldTarget(FILES, "fins", "span")).toMatchObject({ path: "/params/fin_span/value", expression: null });
    expect(fieldTarget(FILES, "fins", "span").param?.max).toBe("120 mm");
    expect(fieldTarget(FILES, "fins", "root_chord")).toMatchObject({ path: "/c/fins/root_chord", param: null, written: "140 mm" });
    expect(fieldTarget(FILES, "fins", "sweep")).toMatchObject({ path: "/c/fins/sweep", expression: "= 0.5 * params.fin_span" });
    expect(fieldTarget(FILES, "fins", "override.mass")).toMatchObject({ path: "/c/fins/override/mass", written: "20 g" });
    expect(fieldTarget(FILES, "fins", "thickness").written).toBeUndefined();
  });
});

describe("schema-driven fields", () => {
  it("lists fin set fields by tab from the schema: required dimensions, then the count", () => {
    const f = editorFields("trapezoidal_fin_set");
    const geo = f.filter((x) => x.tab === "Geometry");
    expect(geo.slice(0, 6).map((x) => x.key)).toEqual(["root_chord", "tip_chord", "span", "sweep", "thickness", "count"]);
    expect(geo.find((x) => x.key === "count")).toMatchObject({ label: "Fin count", kind: "integer", min: 1, max: 8 });
    expect(geo.find((x) => x.key === "span")).toMatchObject({ kind: "quantity", dim: "length", expr: true, group: "Fins" });
    expect(geo.find((x) => x.key === "cross_section")).toMatchObject({ kind: "enum", options: ["square", "rounded", "airfoil"] });
    // Nested groups (the fin tab) stay out of the flat grid.
    expect(geo.some((x) => x.key === "tab")).toBe(false);
    expect(f.filter((x) => x.tab === "Mass override").map((x) => x.key)).toEqual(["override.mass", "override.cg"]);
    expect(f.find((x) => x.key === "override.mass")).toMatchObject({ dim: "mass" });
    expect(f.find((x) => x.key === "appearance.preset")?.options).toContain("composite_white");
    expect(editorFields("body_tube").filter((x) => x.tab === "Geometry").map((x) => x.label)).toEqual(expect.arrayContaining(["Length", "Outer diameter"]));
  });

  it("shows only Appearance for a mixed-kind selection", () => {
    expect(tabsFor(["trapezoidal_fin_set"])).toEqual(["Geometry", "Material", "Appearance", "Mass override"]);
    expect(tabsFor(["body_tube", "nose_cone"])).toEqual(["Appearance"]);
    expect(sharedFields(["body_tube", "nose_cone"]).map((f) => f.key)).toEqual(["appearance.preset"]);
    expect(sharedFields(["body_tube", "body_tube"]).length).toBe(editorFields("body_tube").length);
  });

  it("converts units for display and source", () => {
    expect(toDisplay(0.09, "length", "mm")).toBe("90");
    expect(toDisplay(0.09, "length", "in")).toBe("3.543");
    expect(toDisplay(0.02, "mass", "mm")).toBe("20");
    expect(toSource(95, "length", "mm")).toBe("95 mm");
    expect(toSource(3.5, "length", "in")).toBe("3.5 in");
    expect(toSource(4, undefined, "mm")).toBe(4);
    expect(fromDisplay(95, "length", "mm")).toBeCloseTo(0.095, 12);
    expect(parseLiteral("120 mm")).toBeCloseTo(0.12, 12);
    expect(parseLiteral("= params.x")).toBeNull();
  });

  it("takes limits from the referenced param, else the schema, and rejects out-of-range values", () => {
    const fins = editorFields("trapezoidal_fin_set");
    const span = fins.find((f) => f.key === "span")!;
    const lim = limitsOf(span, { min: "60 mm", max: "120 mm", step: "5 mm" }, "mm");
    expect(lim).toMatchObject({ source: "param", step: 5 });
    expect(lim.min).toBeCloseTo(0.06, 12);
    expect(rangeError(0.13, span, lim, "mm")).toBe("Span must be at most 120 mm.");
    expect(rangeError(0.05, span, lim, "mm")).toBe("Span must be at least 60 mm.");
    expect(rangeError(0.1, span, lim, "mm")).toBeNull();
    const count = fins.find((f) => f.key === "count")!;
    const cl = limitsOf(count, null, "mm");
    expect(rangeError(9, count, cl, "mm")).toBe("Fin count must be at most 8.");
    expect(rangeError(2.5, count, cl, "mm")).toBe("Fin count must be a whole number.");
    const root = fins.find((f) => f.key === "root_chord")!;
    expect(rangeError(-0.01, root, limitsOf(root, null, "mm"), "mm")).toBe("Root chord must be at least 0 mm.");
  });
});

describe("profile geometry", () => {
  const frame = fitFrame(modelExtents([evaluated]), 894, 458, "side");

  it("fits the model with one scale and maps stations linearly", () => {
    const [x0] = toScreen(frame, 0, 0);
    const [x1] = toScreen(frame, 0.84, 0);
    expect(x0).toBeGreaterThanOrEqual(30);
    expect(x1).toBeLessThanOrEqual(894 - 100);
    expect((x1 - x0) / 0.84).toBeCloseTo(frame.scale, 6);
    expect(projectBody([1, 2, 3], "side")).toEqual([1, 3]);
    expect(projectBody([1, 2, 3], "front")).toEqual([-2, 3]);
    expect(scaleLabel(frame)).toMatch(/^Scale: 1:\d/);
  });

  it("places CG forward of CP with the three dimension rows from the check", () => {
    const o = profileOverlay(evaluated, check, frame, "side", "fins", null);
    const cg = o.markers.find((m) => m.kind === "cg")!;
    const cp = o.markers.find((m) => m.kind === "cp")!;
    expect(cg.station).toBe(check.mass.cg);
    expect(cg.x).toBeLessThan(cp.x);
    expect(o.dims.map((d) => d.key)).toEqual(["nose-cg", "cg-cp", "overall"]);
    expect(o.dims.find((d) => d.key === "cg-cp")!.value).toBeCloseTo(check.aero.cp - check.mass.cg, 9);
    expect(o.dims.find((d) => d.key === "overall")!.value).toBe(check.dims.length);
    expect(o.stability).toBe(check.stability.liftoff);
  });

  it("draws every fin of a set alike (count = fin count) and the ghost of the previous fins", () => {
    const prev = withFins(evaluated, 0.12, 0.03);
    const o = profileOverlay(evaluated, check, frame, "side", "fins", prev);
    expect(o.fins).toHaveLength(4);
    const facing = o.fins.filter((f) => f.facing);
    expect(facing).toHaveLength(2);
    const height = (pts: [number, number][]) => Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    expect(height(facing[0]!.points)).toBeCloseTo(height(facing[1]!.points), 6);
    expect(o.ghost).toHaveLength(4);
    // The previous fins (span 120 mm) reach higher than the new ones (90 mm).
    expect(o.ghostTip![1]).toBeLessThan(o.finTip![1]);
    expect(finOutlines(evaluated.components.find((c) => c.id === "nose")!, frame, "side")).toEqual([]);
    expect(hull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])).toHaveLength(4);
  });

  it("draws seams between opaque airframe sections (a clear bay has its own rings)", () => {
    // nose | clear bay | airframe | fin can: only airframe/fin can is a seam between two opaque sections.
    const joints = airframeJoints(evaluated, frame, "side");
    expect(joints.map((j) => j.station)).toEqual([0.64]);
    const j = joints[0]!;
    expect(j.x).toBeCloseTo(toScreen(frame, 0.64, 0)[0], 9);
    expect(j.y1 - j.y0).toBeGreaterThan(0);
    const opaque = { ...evaluated, components: evaluated.components.map((c) => (c.id === "recovery_bay" ? { ...c, appearance: { preset: "composite_white" as const } } : c)) };
    expect(airframeJoints(opaque, frame, "side").map((x) => x.station)).toEqual([0.22, 0.34, 0.64]);
    expect(airframeJoints(evaluated, frame, "front")).toEqual([]);
    expect(profileOverlay(evaluated, check, frame, "side", null, null).joints).toHaveLength(1);
  });

  it("dimensions the fin planform preview", () => {
    const fins = evaluated.components.find((c) => c.id === "fins")!;
    const p = planformOf(fins)!;
    expect(p).toEqual({ rootChord: 0.14, tipChord: 0.06, span: 0.09, sweep: 0.045 });
    const L = planformLayout(p);
    expect(L.pts[0]![1]).toBe(L.yRoot);
    expect(L.pts[1]![1]).toBeCloseTo(L.yTip, 9);
    expect((L.pts[3]![0] - L.pts[0]![0]) / L.k).toBeCloseTo(0.14, 9);
  });
});

describe("proposal", () => {
  const steps = [
    { seq: 1, title: "Initial concept" },
    { seq: 2, title: "Assembly layout" },
    { seq: 3, title: "Fin revision" },
    { seq: 4, title: "Flight runs" },
  ];
  const diff = (changed: CompareOut["model"]["changed"]): CompareOut => ({ a: "", b: "", model: { a: "", b: "", added: [], removed: [], changed }, metrics: [] });
  const DIFFS: Record<string, CompareOut> = {
    "step:3>step:4": diff([{ component: "sims", path: "/sims/baseline/launch/rail_length", old: "1.5 m", new: "2 m" }]),
    "step:2>step:3": diff([
      { component: "params", path: "/params/fin_span/value", old: "120 mm", new: "90 mm" },
      { component: "params", path: "/params/fin_sweep/value", old: "30 mm", new: "45 mm" },
    ]),
  };
  const apply = (ops: readonly PatchOp[]) => {
    const span = ops.some((o) => o.path === "/params/fin_span/value") ? 0.12 : 0.09;
    const sweep = ops.some((o) => o.path === "/params/fin_sweep/value") ? 0.03 : 0.045;
    return { evaluated: withFins(evaluated, span, sweep), check };
  };

  it("reverses a diff into patch ops", () => {
    expect(
      reverseOps([
        { component: "c", path: "/a", old: 1, new: 2 },
        { component: "c", path: "/b", new: 2 },
        { component: "c", path: "/c", old: 1 },
      ]),
    ).toEqual([
      { op: "replace", path: "/a", value: 1 },
      { op: "remove", path: "/b" },
      { op: "add", path: "/c", value: 1 },
    ]);
  });

  it("finds the latest step that changed the part, with its ghost, fields, and Revert ops", async () => {
    const asked: string[] = [];
    const p = await findStepProposal(
      { id: "fins", current: evaluated, steps },
      {
        compare: async (a, b) => {
          asked.push(`${a}>${b}`);
          return DIFFS[`${a}>${b}`] ?? diff([]);
        },
        apply,
      },
    );
    expect(asked).toEqual(["step:3>step:4", "step:2>step:3"]);
    expect(p).toMatchObject({ kind: "step", step: 3, stepTitle: "Fin revision" });
    expect(p!.revertOps).toEqual([
      { op: "replace", path: "/params/fin_span/value", value: "120 mm" },
      { op: "replace", path: "/params/fin_sweep/value", value: "30 mm" },
    ]);
    expect(p!.fields.map((f) => [f.key, f.old, f.new])).toEqual([
      ["span", 0.12, 0.09],
      ["sweep", 0.03, 0.045],
    ]);
    expect(changeText(p!.fields[0]!, "mm")).toBe("120 → 90 mm");
    // A part no step touched has no proposal.
    expect(await findStepProposal({ id: "nose", current: evaluated, steps }, { compare: async (a, b) => DIFFS[`${a}>${b}`] ?? diff([]), apply })).toBeNull();
  });

  it("treats an open draft that changes the part as the proposal", () => {
    const preview = withFins(evaluated, 0.1, 0.045);
    const d = draftProposal("fins", evaluated, check, preview)!;
    expect(d.kind).toBe("draft");
    expect(d.fields.map((f) => f.key)).toEqual(["span"]);
    expect(draftProposal("nose", evaluated, check, preview)).toBeNull();
    expect(componentDiffers(evaluated, preview, "fins")).toBe(true);
    expect(changedFields(evaluated.components[0], evaluated.components[0])).toEqual([]);
  });

  it("keeps validation messages on the part's paths and its params", () => {
    const diags = [
      { code: "RW-E101", severity: "error", path: "/c/fins/span", message: "span too large" },
      { code: "RW-E101", severity: "error", path: "/c/fins/span", message: "span too large" },
      { code: "RW-W001", severity: "warning", path: "/params/fin_span", message: "param" },
      { code: "RW-E050", severity: "error", path: "/c/nose/length", message: "nose" },
    ] as never;
    expect(partDiagnostics(diags, ["fins"], ["/params/fin_span/value"]).map((d) => d.message)).toEqual(["span too large", "param"]);
  });
});

describe("thread history", () => {
  const steps = [1, 2, 3, 4].map((seq) => ({ seq, title: `S${seq}`, ts: `2026-10-1${seq}T10:00:00Z`, id: String(seq), origin: "cli", files: [], model_hash: "h", metrics: {} })) as never[];
  // The open Lecturn thread's steps (CPW1R3B), from the same history and current step as the strip.
  const lt = (threadId: string, extra: Partial<EmbedThread> = {}): EmbedThread => ({
    threadId,
    projectId: "lp",
    workspaceRoot: "/w",
    title: threadId,
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    historyRevision: 1,
    state: "idle",
    appData: '{"page":"components"}',
    subtitle: null,
    ...extra,
  });
  /** Step 03 made by thread `th` (its call context recorded the thread). */
  const made = steps.map((st, i) => (i === 2 ? { ...(st as object), thread: "th" } : st)) as never[];

  it("lists the thread's steps after their baseline, the newest current", () => {
    expect(embedThreadSteps(made, [lt("th")], "th").map((i) => [i.seq, i.baseline, i.current])).toEqual([
      [2, true, false],
      [3, false, true],
    ]);
    expect(embedThreadSteps(steps, [lt("th")], "th")).toEqual([]);
    expect(embedThreadSteps(made, [lt("th")], null)).toEqual([]);
  });

  it("agrees with the history strip's current step: done before it, current, later after it", () => {
    const linked = lt("th", { appData: '{"page":"components","steps":[1]}' });
    // The strip's current step (04) is newer than the thread's own (01): appended as current, 01 done.
    expect(embedThreadSteps(steps, [linked], "th", 4).map((i) => [i.seq, i.state, i.current])).toEqual([
      [1, "done", false],
      [4, "current", true],
    ]);
    // The strip moved back to 02: the thread's 03 is later, its baseline 02 current.
    expect(embedThreadSteps(made, [lt("th")], "th", 2).map((i) => [i.seq, i.state])).toEqual([
      [2, "current"],
      [3, "later"],
    ]);
    // An unknown current step: the newest listed step is current.
    expect(embedThreadSteps(made, [lt("th")], "th", 9).map((i) => i.state)).toEqual(["done", "current"]);
  });

  it("reads an imported thread's step links from its appData", () => {
    expect(linkedSteps('{"page":"components","steps":[3,1,3]}')).toEqual([1, 3]);
    expect(linkedSteps('{"page":"components","steps":[0,-1,2.5,"4",5]}')).toEqual([5]);
    expect(linkedSteps('{"page":"components"}')).toEqual([]);
    expect(linkedSteps("not json")).toEqual([]);
    expect(linkedSteps(null)).toEqual([]);
  });

  it("lists the open Lecturn thread's steps: attributed to it (or its sidecar original, D21) and linked by its appData", () => {
    const bySidecar = steps.map((st, i) => (i === 2 ? { ...(st as object), thread: "sidecar-th" } : st)) as never[];
    // A copy on the user's server: the history recorded the sidecar thread's id.
    const copy = lt("copy:env:sidecar-th", { copiedFrom: { appId: "a", sourceEnvironmentId: "env", sourceThreadId: "sidecar-th", copiedAt: "x", sourceHistoryRevision: 1 } });
    expect(embedThreadSteps(bySidecar, [copy, lt("other")], copy.threadId, 3).map((i) => [i.seq, i.state])).toEqual([
      [2, "done"],
      [3, "current"],
    ]);
    // An imported thread: its appData names step 03; the strip's current step 04 is appended current.
    const imported = lt("copy:rw-fixtures:fin", { appData: '{"page":"components","steps":[3]}' });
    expect(embedThreadSteps(steps, [imported], imported.threadId, 4).map((i) => [i.seq, i.baseline, i.state])).toEqual([
      [2, true, "done"],
      [3, false, "done"],
      [4, false, "current"],
    ]);
    // Another thread's steps and links are not this thread's.
    expect(embedThreadSteps(bySidecar, [lt("other", { appData: '{"steps":[1]}' }), lt("mine")], "mine", 4)).toEqual([]);
    expect(embedThreadSteps(steps, [imported], null, 4)).toEqual([]);
  });

  it("is the embed's open Lecturn thread, and empty while the embed is not the pane", () => {
    const imported = lt("copy:rw-fixtures:fin", { appData: '{"page":"components","steps":[3]}' });
    const chat = { lecturn: { embedded: true, threads: [imported], activeThreadId: imported.threadId, activeKey: null } };
    expect(openThreadSteps(steps, chat, 3).map((i) => [i.seq, i.current])).toEqual([
      [2, false],
      [3, true],
    ]);
    expect(openThreadSteps(steps, { lecturn: { ...chat.lecturn, embedded: false } }, 3)).toEqual([]);
  });

  it("counts as the agent's the steps with origin mcp and the open thread's own steps (not its baseline)", () => {
    const mixed = (made as object[]).map((st, i) => (i === 3 ? { ...st, origin: "mcp" } : st)) as never[];
    expect([...agentSteps(mixed, embedThreadSteps(mixed, [lt("th")], "th"))].sort()).toEqual([3, 4]);
    expect([...agentSteps(steps, [])]).toEqual([]);
  });
});

