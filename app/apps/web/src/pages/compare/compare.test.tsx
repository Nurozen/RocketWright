/**
 * M2.7 Compare view units (no GPU, no server): the Old/New picker options
 * and defaults, refs → versions, metric rows with units and deltas, change
 * rows, the merged compare model, scene marks (colour and dimming), and the
 * view's static markup (pickers, legend, Revert, Close).
 */
import { readFileSync } from "node:fs";
import type { CompareOut, EvaluatedModel, ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { createAppStore } from "../../state/store.ts";
import type { DeepReadonly } from "../../state/types.ts";
import { glbModelHash } from "../../viewport/glb-source.ts";
import { DIM_COLOR, DIM_OPACITY, MARK_COLORS, markCounts, markMap, mergeForCompare } from "../../viewport/marks.ts";
import { AssemblyModel } from "../../viewport/scene.ts";
import { ComparePage } from "./ComparePage.tsx";
import { canRevertTo, changeRows, defaultCompare, editRows, fieldLabel, formatMetric, metricRows, versionLabel, versionOfRef, versionOptions } from "./model.ts";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

const repo = new URL("../../../../../../", import.meta.url);
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;
const glbBytes = readFileSync(new URL("app/apps/web/public/fixtures/contract-vehicle.glb", repo));

/** The mock project with steps 01-04 (the mock records only step 04). */
function snap(): DeepReadonly<ProjectSnapshot> {
  const s = mock.snapshot();
  const head = s.history.steps.at(-1)!;
  const titles = ["Initial concept", "Assembly layout", "Fin revision"];
  s.history.steps = [...titles.map((title, i) => ({ ...structuredClone(head), seq: i + 1, title })), head];
  return s as DeepReadonly<ProjectSnapshot>;
}

const CMP: CompareOut = {
  a: "step:2",
  b: "step:3",
  model: {
    a: "step:2",
    b: "step:3",
    added: [],
    removed: [],
    changed: [{ component: "params", path: "/params/fin_span/value", old: "90 mm", new: "100 mm", unit: "m", old_si: 0.09, new_si: 0.1 }],
  },
  metrics: [
    { key: "dims.fin_span", a: 0.32, b: 0.34, delta: 0.02, delta_pct: 6.25, unit: "m" },
    { key: "mass.liftoff", a: 1.2, b: 1.25, delta: 0.05, delta_pct: 4.1667, unit: "kg" },
    { key: "stability.liftoff", a: 1.5, b: 1.5, delta: 0, delta_pct: 0, unit: "cal" },
    { key: "aero.cna", a: 0, b: 0.2, delta: 0.2 },
    { key: "apogee_m", a: 400, b: 380, delta: -20, delta_pct: -5, unit: "m" },
  ],
  marks: [{ id: "fins", name: "Fins", status: "changed", fields: [{ path: "/shape/span", old: 0.09, new: 0.1, unit: "m" }, { path: "/shape/sweep_angle", old: 0.5, new: 0.6, unit: "rad" }] }],
};

describe("version pickers", () => {
  it("offers the current model, every step, revision, and run", () => {
    const s = snap();
    const opts = versionOptions(s);
    expect(opts[0]).toEqual({ value: "live", label: "Current model", group: "Current" });
    const steps = opts.filter((o) => o.group === "Steps");
    expect(steps.length).toBe(s.history.steps.length);
    expect(steps[0]!.label).toMatch(/^Step 01 · /);
    expect(opts.filter((o) => o.group === "Revisions").map((o) => o.value)).toEqual(s.history.revisions.map((r) => `rev:${r.number}`).sort());
    const runs = s.runs.runs.filter((r) => r.run_id != null);
    expect(opts.filter((o) => o.group === "Runs").map((o) => o.value)).toEqual(runs.map((r) => `run:${r.run_id}`));
  });

  it("labels versions and picks the default pair", () => {
    const s = snap();
    const head = Math.max(...s.history.steps.map((x) => x.seq));
    expect(versionLabel("step:3", s)).toBe("Step 03");
    expect(versionLabel("rev:7", s)).toBe("Rev 07");
    expect(versionLabel("live", s)).toBe("Current");
    const base = s.runs.runs.find((r) => r.sim === "baseline")!;
    expect(versionLabel(`run:${base.run_id}`, s)).toBe(`${base.sim_name} run`);
    expect(defaultCompare(s, null)).toEqual({ old: `step:${head - 1}`, new: `step:${head}` });
    expect(defaultCompare(s, "step:1")).toEqual({ old: "step:1", new: `step:${head}` });
    expect(defaultCompare(s, `step:${head}`)).toEqual({ old: `step:${head - 1}`, new: `step:${head}` });
    expect(defaultCompare(null, null)).toEqual({ old: "live", new: "live" });
  });

  it("maps chat refs to versions (a sim is its latest run)", () => {
    const s = snap();
    const base = s.runs.runs.find((r) => r.sim === "baseline" && r.superseded_by == null)!;
    expect(versionOfRef(s, "rw:sim/baseline")).toBe(`run:${base.run_id}`);
    expect(versionOfRef(s, "rw:run/abc123")).toBe("run:abc123");
    expect(versionOfRef(s, "rw:step/4")).toBe("step:4");
    expect(versionOfRef(s, "rw:rev/07")).toBe("rev:7");
    expect(versionOfRef(s, "rw:c/fins")).toBeNull();
    expect(canRevertTo("step:2") && canRevertTo("rev:7") && canRevertTo("run:abc")).toBe(true);
    expect(canRevertTo("live")).toBe(false);
  });
});

describe("metric and change rows", () => {
  it("formats metrics with units in the picked length unit and signed deltas", () => {
    const rows = metricRows(CMP, "mm");
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row("dims.fin_span")).toMatchObject({ label: "Fin span", old: "320 mm", new: "340 mm", delta: "+6.3%", tone: "up" });
    expect(row("mass.liftoff")).toMatchObject({ old: "1.2 kg", new: "1.25 kg", delta: "+4.2%" });
    expect(row("stability.liftoff")).toMatchObject({ old: "1.50 cal", delta: "0%", tone: "same" });
    expect(row("aero.cna")).toMatchObject({ label: "CNα", old: "0", new: "0.2", delta: "+0.2", tone: "up" });
    // Flight distances stay in metres whatever the length unit.
    expect(row("apogee_m")).toMatchObject({ label: "Apogee", old: "400 m", new: "380 m", delta: "−5.0%", tone: "down" });
    expect(metricRows(CMP, "in").find((r) => r.key === "dims.fin_span")!.old).toBe("12.6 in");
    expect(formatMetric(null, "m", "dims.length", "mm")).toBe("—");
  });

  it("lists changed components with their quantities, and the source edits as written", () => {
    const [fins] = changeRows(CMP, "mm");
    expect(fins).toMatchObject({ id: "fins", status: "changed" });
    expect(fins!.fields[0]).toEqual({ path: "/shape/span", label: "span", old: "90 mm", new: "100 mm" });
    expect(fins!.fields[1]!.old).toBe("28.6°");
    expect(fieldLabel("/attach/offset")).toBe("attach offset");
    expect(editRows(CMP)).toEqual([{ owner: "params", path: "/params/fin_span/value", old: "90 mm", new: "100 mm" }]);
  });
});

describe("compare marks", () => {
  it("merges the removed parts of Old into New and counts marks", () => {
    const old = evaluated;
    const gone = old.components.at(-1)!;
    const nw: EvaluatedModel = { ...old, components: old.components.slice(0, -1) };
    const marks = markMap([
      { id: gone.id, status: "removed" },
      { id: old.components[0]!.id, status: "changed" },
    ]);
    const merged = mergeForCompare(old, nw, marks);
    expect(merged.components.map((c) => c.id)).toEqual(old.components.map((c) => c.id));
    expect(merged.model_hash).toBe(nw.model_hash);
    expect(mergeForCompare(old, old, {})).toBe(old);
    expect(markCounts(marks)).toEqual({ removed: 1, changed: 1, added: 0 });
  });

  it("colours marked parts, dims the rest, and restores the look", async () => {
    const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer;
    const gltf = await new GLTFLoader().parseAsync(ab, "");
    const meta = Object.fromEntries(evaluated.components.map((c) => [c.id, { name: c.name, appearance: c.appearance ?? null, parent: c.parent ?? null }]));
    const m = new AssemblyModel(gltf.scene, meta, glbModelHash(glbBytes));
    const ids = [...m.parts.keys()];
    const [changed, added, plain] = [ids[0]!, ids[1]!, ids[2]!];
    const color = (id: string) => `#${m.parts.get(id)!.materials[0]!.color.getHexString()}`;
    const before = color(plain);
    const opacity = (id: string) => m.parts.get(id)!.materials[0]!.opacity;
    const state = { explode: 0, hidden: [], showInternals: false, section: false };
    expect(m.setMarks({ [changed]: "changed", [added]: "added" })).toBe(true);
    m.apply(state);
    expect(color(changed)).toBe(MARK_COLORS.changed);
    expect(color(added)).toBe(MARK_COLORS.added);
    expect(color(plain)).toBe(DIM_COLOR);
    expect(opacity(plain)).toBe(DIM_OPACITY);
    expect(opacity(changed)).toBe(1);
    expect(m.markOf(changed)).toBe("changed");
    expect(m.setMarks({ [added]: "added", [changed]: "changed" })).toBe(false);
    m.setMarks(null);
    m.apply(state);
    expect(color(plain)).toBe(before);
    expect(m.markOf(changed)).toBeNull();
  });
});

describe("Compare view markup", () => {
  it("renders the Old/New pickers, legend, Revert, and Close for the selection", () => {
    const store = createAppStore();
    const s = snap();
    store.setState((st) => ({ project: { ...st.project, projectId: "research-vehicle", snapshot: s }, ui: { ...st.ui, compare: { old: "step:2", new: "step:3" } } }));
    // Server rendering reads the store's initial state (zustand's server snapshot).
    Object.assign(store, { getInitialState: () => store.getState() });
    const html = renderToStaticMarkup(<ComparePage store={store} client={null} glbDeps={{ loadWasm: async () => null, fetchFixture: async () => new Uint8Array() }} />);
    expect(html).toContain('data-testid="compare"');
    expect(html).toContain('data-state="loading"');
    expect(html).toMatch(/data-testid="compare\.old"[^>]*>/);
    expect(html).toContain("Step 02 → Step 03");
    for (const name of ["Removed", "Changed", "Added"]) expect(html).toContain(`</i>${name}</span>`);
    expect(html).toContain("Revert to Step 02");
    expect(html).toContain('data-testid="compare.close"');
    // No selection: nothing.
    store.getState().ui.setCompare(null);
    expect(renderToStaticMarkup(<ComparePage store={store} client={null} glbDeps={{ loadWasm: async () => null, fetchFixture: async () => new Uint8Array() }} />)).toBe("");
  });
});
