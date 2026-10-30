/**
 * M4.7 page 05 units on the real fixture: `fixtures/research-vehicle`
 * evaluated by rw-wasm (its `engines/demo.rw.toml` and the D10b
 * `demo-incomplete.rw.toml`), then the view model (refs, flow paths, the
 * selected connection, rail categories, missing inputs and input rows, the
 * diagram layout, Properties) and the procedural module (line routing, parts,
 * sizes from the feed graph and the sizing).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import * as THREE from "three/webgpu";
import { beforeAll, describe, expect, it } from "vitest";
import {
  allParts,
  categoryOfPart,
  categoryOfTarget,
  categoryTarget,
  connectionOf,
  diagramLayout,
  edgeRef,
  feedTarget,
  flowPaths,
  fmt,
  hiddenKey,
  hiddenParts,
  inputRows,
  missingInputs,
  nodeLabel,
  nodeRef,
  partsOfCategory,
  pickEngine,
  propertyGroups,
  refOfPart,
  sourceRefs,
  type Diagnostic,
  type EngineDesignOut,
  type EvalEngine,
} from "./model.ts";
import { aeroshellShape, buildLiquidScene, engineExitStation, layoutToBody, routeOf, tankProfile } from "./scene3d.ts";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));
const FIXTURE = join(REPO, "fixtures/research-vehicle");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let engines: Record<string, EvalEngine>;
const demo = () => engines["demo"]!;
const incomplete = () => engines["demo-incomplete"]!;

/** The check report's liquid diagnostics on the seeded fixture (`rw check --json`; RW-W102 is the motor's). */
const CHECK: Diagnostic[] = [
  { code: "RW-W210", severity: "warning", path: "/engines/demo-incomplete/fluid_model", message: "engine `demo-incomplete` has no fluid model" },
  { code: "RW-W211", severity: "warning", path: "/engines/demo-incomplete/feed/edge/0/bc", message: "feed edge 0 (tank_a → valve_a) has no boundary condition" },
  { code: "RW-W102", severity: "warning", path: "/c/motor_casing", message: "Liftoff thrust-to-weight is 3.07, below 5" },
] as Diagnostic[];

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  const files: Record<string, string> = {};
  for (const p of walk(FIXTURE)) if (/\.(toml)$/.test(p)) files[relative(FIXTURE, p).split("\\").join("/")] = readFileSync(p, "utf8");
  const model = rw.evalModel(files);
  engines = (model.engines ?? {}) as Record<string, EvalEngine>;
});

describe("refs and engines", () => {
  it("round-trips feed refs and viewport parts", () => {
    expect(feedTarget(nodeRef("demo", "tank_a"))).toEqual({ engine: "demo", kind: "node", id: "tank_a" });
    expect(feedTarget(edgeRef("demo", 3))).toEqual({ engine: "demo", kind: "edge", index: 3 });
    expect(feedTarget("rw:eng/demo")).toEqual({ engine: "demo", kind: "engine" });
    expect(feedTarget("rw:c/fins")).toBeNull();
    expect(feedTarget("rw:eng/demo/feed/edge/x")).toBeNull();
    expect(refOfPart("demo", "edge:2")).toBe("rw:eng/demo/feed/edge/2");
    expect(refOfPart("demo", "valve_b")).toBe("rw:eng/demo/feed/node/valve_b");
  });

  it("picks the engine from the selection, else the preferred one, else the first", () => {
    const ids = ["demo", "demo-incomplete"];
    expect(pickEngine(ids, [edgeRef("demo-incomplete", 0)], "demo")).toBe("demo-incomplete");
    expect(pickEngine(ids, ["rw:c/fins"], "demo-incomplete")).toBe("demo-incomplete");
    expect(pickEngine(ids, [], null)).toBe("demo");
    expect(pickEngine([], [], "demo")).toBeNull();
  });

  it("labels nodes in words", () => {
    expect(nodeLabel("tank_a")).toBe("Tank A");
    expect(nodeLabel("pt_c")).toBe("PT C");
    expect(nodeLabel("engine")).toBe("Engine");
  });

  it("the fixture evaluates both engines", () => {
    expect(Object.keys(engines).sort()).toEqual(["demo", "demo-incomplete"]);
    expect(incomplete().fluid_model ?? null).toBeNull();
    expect(incomplete().edges[0]!.bc ?? null).toBeNull();
  });
});

describe("flow paths and the selected connection", () => {
  it("walks each tank to the engine (oxidizer, then fuel; sensor stubs excluded)", () => {
    expect(flowPaths(demo())).toEqual([
      { tank: "tank_a", role: "ox", nodes: ["tank_a", "valve_a", "engine"], edges: [0, 1] },
      { tank: "tank_b", role: "fuel", nodes: ["tank_b", "valve_b", "engine"], edges: [2, 3] },
    ]);
  });

  it("a line, a node, the engine, and a sensor each select their connection", () => {
    const e = demo();
    expect(connectionOf(e, { engine: "demo", kind: "edge", index: 0 })).toMatchObject({ from: ["tank_a"], to: ["engine"], edges: [0, 1], role: "ox" });
    expect(connectionOf(e, { engine: "demo", kind: "node", id: "valve_b" })).toMatchObject({ from: ["tank_b"], to: ["engine"], edges: [2, 3], role: "fuel" });
    expect(connectionOf(e, { engine: "demo", kind: "node", id: "engine" })).toMatchObject({ from: ["tank_a", "tank_b"], to: ["engine"], edges: [0, 1, 2, 3], role: null });
    expect(connectionOf(e, { engine: "demo", kind: "node", id: "pt_a" })).toMatchObject({ from: ["tank_a"], to: ["pt_a"], edges: [4] });
    expect(connectionOf(e, { engine: "demo", kind: "edge", index: 5 })).toMatchObject({ from: ["engine"], to: ["pt_c"], edges: [5] });
    expect(connectionOf(e, null)).toBeNull();
  });
});

describe("rail categories", () => {
  it("sorts every part into one category", () => {
    const e = demo();
    expect(allParts(e)).toEqual(["engine", "pt_a", "pt_c", "tank_a", "tank_b", "valve_a", "valve_b", "edge:0", "edge:1", "edge:2", "edge:3", "edge:4", "edge:5"]);
    expect(partsOfCategory(e, "storage")).toEqual(["tank_a", "tank_b"]);
    expect(partsOfCategory(e, "feed")).toEqual(["edge:0", "edge:1", "edge:2", "edge:3"]);
    expect(partsOfCategory(e, "valves")).toEqual(["valve_a", "valve_b"]);
    expect(partsOfCategory(e, "engine")).toEqual(["engine"]);
    expect(partsOfCategory(e, "sensors")).toEqual(["pt_a", "pt_c", "edge:4", "edge:5"]);
    expect(categoryOfPart(e, "edge:4")).toBe("sensors");
  });

  it("a row selects its first entity; the selection names its row; eyes hide whole categories", () => {
    const e = demo();
    expect(categoryTarget(e, "demo", "feed")).toBe(edgeRef("demo", 0));
    expect(categoryTarget(e, "demo", "storage")).toBe(nodeRef("demo", "tank_a"));
    expect(categoryTarget(e, "demo", "sensors")).toBe(nodeRef("demo", "pt_a"));
    expect(categoryOfTarget(e, { engine: "demo", kind: "edge", index: 1 })).toBe("feed");
    expect(categoryOfTarget(e, { engine: "demo", kind: "node", id: "tank_b" })).toBe("storage");
    expect(hiddenParts(e, [hiddenKey("valves"), "other"])).toEqual(["valve_a", "valve_b"]);
  });
});

describe("missing inputs and the inspector rows", () => {
  it("counts the engine's RW-W2xx diagnostics only", () => {
    expect(missingInputs(CHECK, "demo-incomplete").map((d) => d.code)).toEqual(["RW-W210", "RW-W211"]);
    expect(missingInputs(CHECK, "demo")).toEqual([]);
    expect(missingInputs(null, "demo")).toEqual([]);
  });

  it("flags the unset fluid model and boundary condition, and keeps analysis Not run", () => {
    const e = incomplete();
    const missing = missingInputs(CHECK, "demo-incomplete");
    const conn = connectionOf(e, { engine: "demo-incomplete", kind: "edge", index: 0 });
    const rows = inputRows(e, "demo-incomplete", missing, conn, { kind: "complete", summary: "x" });
    expect(rows.map((r) => [r.key, r.value, r.tone])).toEqual([
      ["fluid_model", "Not selected", "warn"],
      ["boundary_conditions", "Required", "warn"],
      ["analysis", "Not run", "info"],
    ]);
    expect(rows[1]!.diagnostic?.code).toBe("RW-W211");
    // The fuel path is complete.
    const fuel = inputRows(e, "demo-incomplete", missing, connectionOf(e, { engine: "demo-incomplete", kind: "edge", index: 2 }), { kind: "not_run" });
    expect(fuel[1]).toMatchObject({ value: "Open, Check valve", tone: "ok" });
  });

  it("the complete engine shows its inputs and the analysis state", () => {
    const rows = inputRows(demo(), "demo", [], null, { kind: "complete", summary: "8.49 s burn" });
    expect(rows.map((r) => [r.value, r.tone])).toEqual([
      ["Single-phase liquid", "ok"],
      ["Open, Check valve, Closed", "ok"],
      ["Complete · 8.49 s burn", "ok"],
    ]);
  });
});

describe("connectivity diagram", () => {
  it("lays tanks, valves, and the engine in flow columns with elbow lines", () => {
    const l = diagramLayout(demo());
    expect(l.nodes.map((n) => n.id)).toEqual(["tank_a", "valve_a", "tank_b", "valve_b", "engine"]);
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x("tank_a")).toBe(x("tank_b"));
    expect(x("tank_a")).toBeLessThan(x("valve_a"));
    expect(x("valve_a")).toBeLessThan(x("engine"));
    expect(l.nodes.find((n) => n.id === "tank_a")!.role).toBe("ox");
    expect(l.nodes.find((n) => n.id === "tank_b")!.role).toBe("fuel");
    expect(l.edges.map((e) => [e.index, e.role])).toEqual([
      [0, "ox"],
      [1, "ox"],
      [2, "fuel"],
      [3, "fuel"],
    ]);
    for (const e of l.edges) {
      // Elbows: every segment horizontal or vertical, ending on the next node's left edge.
      for (let i = 1; i < e.points.length; i++) {
        const [a, b] = [e.points[i - 1]!, e.points[i]!];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      }
      expect(e.points.at(-1)![0]).toBe(l.nodes.find((n) => n.id === e.to)!.x);
    }
  });
});

describe("Properties", () => {
  const out = (JSON.parse(readFileSync(join(REPO, "fixtures/contracts/tools/engine_design.output.json"), "utf8")) as { payload: EngineDesignOut }).payload;

  it("formats with fixed significant figures", () => {
    expect(fmt(221.153, 4)).toBe("221.2");
    expect(fmt(1554.14, 4)).toBe("1,554");
    expect(fmt(0.69163, 3)).toBe("0.692");
    expect(fmt(null)).toBe("—");
  });

  it("groups the computed performance and geometry from engine_design", () => {
    const groups = propertyGroups(out);
    const perf = groups.find((g) => g.id === "performance");
    if (out.performance) {
      expect(perf?.rows.find((r) => r.key === "isp_sl")?.value).toBe(fmt(out.performance.isp_sl));
      expect(perf?.rows.find((r) => r.key === "c_star")?.unit).toBe("m/s");
      expect(groups.find((g) => g.id === "geometry")?.rows.find((r) => r.key === "throat_diameter")?.value).toBe(fmt(out.performance.throat_diameter * 1000));
    }
    expect(propertyGroups(null)).toEqual([]);
    expect(propertyGroups({ engine: "x", missing_inputs: ["/engines/x/l_star"], diagnostics: [] })).toEqual([]);
  });

  it("cites SP-125 and CEA with the design's thermochemistry", () => {
    const refs = sourceRefs("table:n2o-ethanol");
    expect(refs.map((r) => r.id)).toEqual(["sp-125", "rp-1311", "tp-2002-211556"]);
    expect(refs[0]!.url).toBe("https://ntrs.nasa.gov/citations/19710019929");
    expect(refs[1]!.detail).toContain("tables n2o-ethanol");
    expect(sourceRefs("cea:native")[1]!.detail).toContain("native CEA");
  });
});

describe("procedural module", () => {
  it("routes feed lines square through their waypoints (page05-layout.md)", () => {
    const r = routeOf(demo(), 0)!.map((p) => [Number(p.station.toFixed(4)), Number(p.radial.toFixed(4))]);
    expect(r).toEqual([
      [0.36, -0.35],
      [0.36, -0.19],
      [0.175, -0.19],
      [0.175, -0.11],
      [0.39, -0.11],
    ]);
    for (let i = 0; i < demo().edges.length; i++) {
      const pts = routeOf(demo(), i)!;
      for (let k = 1; k < pts.length; k++) {
        const changed = [pts[k]!.station !== pts[k - 1]!.station, pts[k]!.radial !== pts[k - 1]!.radial].filter(Boolean).length;
        expect(changed, `edge ${i} segment ${k} is square`).toBe(1);
      }
    }
  });

  it("maps the layout to the body frame: radial across, aft down, depth toward the viewer", () => {
    expect(layoutToBody(0.42, -0.35, 0.1).toArray()).toEqual([-0.35, -0.1, -0.42]);
    const prof = tankProfile(0.4112, 0.0762, "hemispherical");
    expect(prof[0]!.x).toBeCloseTo(-0.2056, 6);
    expect(Math.max(...prof.map((p) => p.r))).toBeCloseTo(0.0762, 6);
  });

  it("builds one part per feed node and line, sized from the tanks and the sizing", () => {
    const sizing = {
      chamber_diameter: 0.0523,
      chamber_length: 0.3732,
      convergent_length: 0.0359,
      throat_diameter: 0.02616,
      nozzle_length: 0.0505,
      exit_diameter: 0.0523,
    } as schema.EngineSizing;
    const scene = buildLiquidScene(demo(), sizing);
    try {
      expect([...scene.model.parts.keys()].sort()).toEqual([...allParts(demo())].sort());
      expect(new Set(scene.report.map((r) => r.builder))).toEqual(new Set(["liquid-tank", "liquid-engine", "liquid-line", "liquid-valve", "liquid-sensor"]));
      const size = (id: string) => scene.model.partBounds(id)!.getSize(new THREE.Vector3());
      // Tank A lies across (world x), its computed 411 mm plus bosses; Tank B is the smaller tank.
      expect(size("tank_a").x).toBeGreaterThan(0.411);
      expect(size("tank_a").x).toBeLessThan(0.48);
      expect(size("tank_b").x).toBeLessThan(size("tank_a").x);
      // The engine hangs down (world -y) for its head, chamber, convergent, and nozzle.
      expect(size("engine").y).toBeGreaterThan(0.3732 + 0.0359 + 0.0505);
      const eng = scene.model.partBounds("engine")!;
      // The head (40 mm) plus the manifold blocks' purge tees on top.
      expect(eng.max.y).toBeGreaterThan(-0.42 + 0.038);
      expect(eng.max.y).toBeLessThan(-0.42 + 0.07);
      // The chamber wears its cooling jacket: wider than the computed liner.
      expect(size("engine").z).toBeGreaterThan(0.0523 + 0.02);
      scene.setGlow(["edge:0", "edge:1"]);
      // POL: every selected edge glows and shows through what hides it (Valve A to Engine runs behind the valve).
      const ghost = (i: number) => scene.model.body.getObjectByName(`rw-glow:edge:${i}`) as THREE.Mesh;
      const lines = demo().edges.map((_, i) => i).filter((i) => ghost(i) !== undefined);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.filter((i) => ghost(i).visible)).toEqual([0, 1]);
      const gm = ghost(0).material as THREE.Material;
      expect(gm.depthFunc).toBe(THREE.GreaterDepth);
      expect(gm.depthWrite).toBe(false);
      for (const i of [0, 1]) {
        const tube = scene.model.parts.get(`edge:${i}`)!.detail!.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
        expect(ghost(i).geometry).toBe(tube.geometry);
        expect((tube.material as THREE.MeshPhysicalNodeMaterial).emissiveIntensity).toBeGreaterThan(0);
        expect(ghost(i).userData["rwProvenance"]).toBe("visual");
        // Not a part mesh: never picked or outlined.
        expect(scene.model.parts.get(`edge:${i}`)!.meshes).not.toContain(ghost(i));
      }
      scene.setGlow([]);
      expect(lines.some((i) => ghost(i).visible)).toBe(false);
      scene.setGlow(["edge:0", "edge:1"]);
      // The engine hangs from the tanks: its thrust struts reach out toward both tank bands.
      expect(size("engine").x).toBeGreaterThan(0.2);
      // Aeroshell panels: decor (not parts), one per tank, framed with the parts and hidden with their tank.
      expect(scene.decor.children).toHaveLength(2);
      expect(scene.model.decor).toHaveLength(2);
      expect([...scene.model.parts.keys()].some((k) => k.startsWith("rw-aeroshell"))).toBe(false);
      scene.setHidden(["tank_a"]);
      expect(scene.decor.children.map((g) => g.visible)).toEqual([false, true]);
      scene.setHidden([]);
      expect(scene.decor.children.every((g) => g.visible)).toBe(true);
    } finally {
      scene.model.dispose();
    }
  });

  it("peels the aeroshell panels from under each tank toward the nozzle exit, opening outboard", () => {
    const sizing = { chamber_diameter: 0.0523, chamber_length: 0.3732, convergent_length: 0.0359, throat_diameter: 0.02616, nozzle_length: 0.0505, exit_diameter: 0.0523 } as schema.EngineSizing;
    const exit = engineExitStation(demo(), sizing)!;
    expect(exit).toBeCloseTo(0.42 + 0.3732 + 0.0359 + 0.0505, 6);
    const a = aeroshellShape({ tank: "tank_a", station: 0.36, radial: -0.35, radius: 0.0762, half: 0.2056 }, exit);
    const b = aeroshellShape({ tank: "tank_b", station: 0.36, radial: 0.35, radius: 0.05715, half: 0.15675 }, exit);
    // Tucked up under the tank (between its centre line and its bottom), reaching down toward the
    // nozzle exit: 1.2-2.6 radii below the tank, never past the exit.
    expect(a.top).toBeGreaterThan(0.36);
    expect(a.top).toBeLessThan(0.36 + 0.0762);
    expect(a.bottom).toBeLessThan(exit);
    expect(a.bottom - (0.36 + 0.0762)).toBeGreaterThanOrEqual(1.2 * 0.0762);
    expect(a.bottom - (0.36 + 0.0762)).toBeLessThanOrEqual(2.6 * 0.0762 + 0.012 + 1e-9);
    // Attached, not floating: the hinge line's top lies inside the tank's head.
    for (const [sh, t] of [
      [a, { radial: -0.35, radius: 0.0762, half: 0.2056 }],
      [b, { radial: 0.35, radius: 0.05715, half: 0.15675 }],
    ] as const) {
      const along = Math.max(0, Math.abs(sh.hinge - t.radial) - (t.half - t.radius));
      expect(Math.hypot(along, sh.top - 0.36)).toBeLessThan(t.radius);
    }
    // The doors open outboard on each side (mirror images), hinged inside the tank's outboard end.
    expect(Math.sign(a.open)).toBe(-1);
    expect(Math.sign(b.open)).toBe(1);
    expect(Math.abs(a.hinge)).toBeLessThan(0.35 + 0.2056);
    expect(Math.abs(b.hinge)).toBeLessThan(0.35 + 0.15675);
  });
});
