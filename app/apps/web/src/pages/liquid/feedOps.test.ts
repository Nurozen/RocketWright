/** U57: the feed graph table's fields and writes, on the real core and the research vehicle's demo engine. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PatchOp, schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { fromRwWasm, type PreviewCore } from "../../state/wasm.ts";
import type { Units } from "../../state/index.ts";
import { displayNumber, engineSource, fieldOps, fieldValue, isExpression, parseFieldText, type EngineField, type EngineSource } from "./engineOps.ts";
import {
  addEdgeOps,
  addFillOps,
  addInlineTankOps,
  addNodeOps,
  addWaypointOps,
  edgeFields,
  feedChoices,
  kindField,
  nodeFields,
  nodeIdProblem,
  nodeRemovalScope,
  removeEdgeOps,
  removeNodeOps,
  removeWaypointOps,
  renameNodeOps,
  tankGeometryState,
  waypointFields,
} from "./feedOps.ts";
import type { EvalEngine } from "./model.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

function projectFiles(rel: string): Record<string, string> {
  const root = join(repo, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else if (name.endsWith(".toml")) out[`${prefix}${name}`] = readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}

let core: Required<PreviewCore>;
let files: Record<string, string>;
let base: schema.EvaluatedModel;
let demo: EvalEngine;
let source: EngineSource;
const apply = (ops: readonly PatchOp[]) => core.applyAndCheck({ files, ops });
const engineOf = (ops: readonly PatchOp[], id = "demo") => apply(ops).evaluated.engines![id] as EvalEngine;
const feedErrors = (ops: readonly PatchOp[]) => apply(ops).check.diagnostics.filter((d: schema.Diagnostic) => d.severity === "error" && (d.path ?? "").includes("/feed"));

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  files = projectFiles("fixtures/research-vehicle");
  base = core.applyAndCheck({ files, ops: [] }).evaluated;
  demo = base.engines!["demo"] as EvalEngine;
  source = engineSource(files["engines/demo.rw.toml"]);
});

const choices = () => feedChoices(base);
const everyField = (): EngineField[] => [
  ...Object.keys(demo.nodes).flatMap((id) => [kindField(id), ...nodeFields(demo, id, source, choices())]),
  ...demo.edges.flatMap((e, i) => [...edgeFields(demo, i), ...(e.waypoints ?? []).flatMap((_, k) => waypointFields(demo, i, k))]),
];

describe("round trip of the demo engine", () => {
  it.each<Units>(["mm", "in"])("rewrites every field as shown (%s) with no semantic change", (units) => {
    const ops: PatchOp[] = [];
    for (const f of everyField()) {
      const value = fieldValue(f, demo, source);
      if (f.kind === "enum") {
        if (typeof value === "string") ops.push(...fieldOps("demo", f, value, source));
        continue;
      }
      const shown = displayNumber(f, value, units);
      if (shown === "") continue;
      const parsed = parseFieldText(f, shown, units);
      expect(parsed.error, f.key).toBeUndefined();
      ops.push(...fieldOps("demo", f, parsed.value!, source));
    }
    // Sanity: the table reaches the whole graph, not a corner of it.
    expect(ops.filter((o) => o.path.includes("/feed/edge/")).length).toBeGreaterThanOrEqual(6 * 4);
    expect(ops.some((o) => o.path.endsWith("/tank/fill/fraction"))).toBe(true);
    expect(ops.some((o) => o.path.includes("/waypoints/1/radial"))).toBe(true);
    const after = apply(ops);
    expect(after.evaluated.engines!["demo"]).toEqual(demo);
    expect(after.evaluated.model_hash).toBe(base.model_hash);
    expect(after.check.diagnostics.filter((d: schema.Diagnostic) => d.severity === "error")).toEqual(core.applyAndCheck({ files, ops: [] }).check.diagnostics.filter((d: schema.Diagnostic) => d.severity === "error"));
  });

  it("shows the fixture's own numbers", () => {
    const field = (key: string) => everyField().find((f) => f.key === key)!;
    const show = (key: string) => displayNumber(field(key), fieldValue(field(key), demo, source), "mm");
    expect(show("feed.node.tank_a.tank.length")).toBe("411.2");
    expect(show("feed.node.tank_a.tank.fill.fraction")).toBe("0.6");
    expect(show("feed.node.tank_a.radial")).toBe("-350");
    expect(show("feed.edge.0.diameter")).toBe("10");
    expect(show("feed.edge.0.length")).toBe("0.45");
    expect(show("feed.edge.0.waypoints.1.radial")).toBe("-110");
    expect(fieldValue(field("feed.edge.1.bc"), demo, source)).toBe("check_valve");
    expect(fieldValue(field("feed.edge.5.to"), demo, source)).toBe("pt_c");
    expect(fieldValue(field("feed.node.tank_a.material"), demo, source)).toBe("aluminium");
    expect(fieldValue(field("feed.node.tank_b.fluid"), demo, source)).toBe("ethanol");
  });

  it("offers a value the file holds outside the usual choices", () => {
    const f = nodeFields(demo, "tank_a", source, { materials: [], tankComponents: [] }).find((x) => x.key.endsWith(".material"))!;
    expect(f.options).toEqual(["aluminium"]);
  });
});

describe("the source reader", () => {
  it("reads each element of an array of tables by position", () => {
    expect(source.written("feed.edge.0.diameter")).toBe("10 mm");
    expect(source.written("feed.edge.5.bc")).toBe("closed");
    expect(source.written("feed.edge.6.bc")).toBeUndefined();
    expect(isExpression({ key: "feed.edge.0.diameter", label: "Diameter", kind: "number" }, engineSource('[[feed.edge]]\nfrom = "a"\nto = "b"\ndiameter = "= d * 2"\n'))).toBe(true);
  });
  it("keeps a multi-line array inside an element from reading as keys", () => {
    const text = engineSource('[[feed.edge]]\nfrom = "a"\nwaypoints = [\n  { station = "1 mm", radial = "2 mm" },\n]\n\n[[feed.edge]]\nfrom = "b"\n');
    expect(text.written("feed.edge.0.from")).toBe("a");
    expect(text.written("feed.edge.0.station")).toBeUndefined();
    expect(text.written("feed.edge.1.from")).toBe("b");
  });
});

describe("node writes", () => {
  it("writes each tank input through the table", () => {
    const fields = nodeFields(demo, "tank_a", source, choices());
    const f = (suffix: string) => fields.find((x) => x.key.endsWith(suffix))!;
    const ops = [...fieldOps("demo", f(".tank.length"), "500 mm", source), ...fieldOps("demo", f(".tank.fill.volume"), "3 L", source), ...fieldOps("demo", f(".radial"), "-200 mm", source)];
    expect(ops.map((o) => o.op)).toEqual(["replace", "add", "remove", "replace"]);
    const e = engineOf(ops);
    expect(e.nodes["tank_a"]!.tank!.length).toBeCloseTo(0.5);
    expect(e.nodes["tank_a"]!.tank!.fill_volume).toBeCloseTo(0.003);
    expect(e.nodes["tank_a"]!.radial).toBeCloseTo(-0.2);
  });
  it("accepts a zero or negative placement and refuses a zero length", () => {
    const fields = nodeFields(demo, "tank_a", source, choices());
    const radial = fields.find((x) => x.key.endsWith(".radial"))!;
    expect(parseFieldText(radial, "0", "mm")).toEqual({ value: "0 mm" });
    expect(parseFieldText(radial, "-4", "mm")).toEqual({ value: "-4 mm" });
    expect(parseFieldText(fields.find((x) => x.key.endsWith(".tank.wall"))!, "0", "mm").error).toMatch(/greater than 0/);
  });
  it("shows a valve its area and discharge coefficient, and hides them from a sensor", () => {
    const keys = (id: string) => nodeFields(demo, id, source, choices()).map((f) => f.key.split(".").at(-1));
    expect(keys("valve_a")).toEqual(["station", "radial", "flow_area", "cd"]);
    expect(keys("pt_a")).toEqual(["station", "radial"]);
  });
  it("still shows a value written for another kind, so it can be cleared", () => {
    const text = engineSource('[feed.node.s]\nkind = "sensor"\ncd = 0.5\n');
    const fields = nodeFields({ ...demo, nodes: { s: { kind: "sensor", cd: 0.5 } } }, "s", text, choices());
    expect(fields.map((f) => f.key)).toContain("feed.node.s.cd");
  });
  it("changes a node's kind in place", () => {
    const ops = fieldOps("demo", kindField("pt_a"), "line", source);
    expect(ops).toEqual([{ op: "replace", path: "/engines/demo/feed/node/pt_a/kind", value: "line" }]);
    expect(engineOf(ops).nodes["pt_a"]!.kind).toBe("line");
  });
  it("choosing a tank part clears the geometry on the node", () => {
    const f = nodeFields(demo, "tank_a", source, choices()).find((x) => x.key.endsWith(".component"))!;
    expect(fieldOps("demo", f, "some_tank", source)).toEqual([
      { op: "add", path: "/engines/demo/feed/node/tank_a/component", value: "some_tank" },
      { op: "remove", path: "/engines/demo/feed/node/tank_a/tank" },
      { op: "remove", path: "/engines/demo/feed/node/tank_a/material" },
    ]);
  });
  it("adds a tank's geometry and fill to a node that has neither, and they evaluate", () => {
    const added = addNodeOps("demo", "tank", demo, source);
    expect(added.id).toBe("tank");
    const empty = engineSource("[feed.node.tank]\nkind = \"tank\"\n");
    expect(tankGeometryState("tank", empty)).toEqual({ inline: false, fill: false, component: false });
    const geometry = [...added.ops, ...addInlineTankOps("demo", "tank")];
    const withTank = engineOf(geometry);
    expect(withTank.nodes["tank"]!.tank!.od).toBeCloseTo(0.1);
    const all = [...geometry, ...addFillOps("demo", "tank", withTank)];
    expect(engineOf(all).nodes["tank"]!.tank).not.toBeNull();
  });
});

describe("node ids", () => {
  it("takes an id the model accepts and refuses the rest", () => {
    expect(nodeIdProblem("tank_c", "tank_a", demo)).toBeNull();
    expect(nodeIdProblem("tank_a", "tank_a", demo)).toBeNull();
    expect(nodeIdProblem("", "tank_a", demo)).toMatch(/Give/);
    expect(nodeIdProblem("Tank C", "tank_a", demo)).toMatch(/lowercase/);
    expect(nodeIdProblem("9a", "tank_a", demo)).toMatch(/lowercase/);
    expect(nodeIdProblem("valve_a", "tank_a", demo)).toMatch(/already/);
  });
  it("renames a node, its connections and a study that shows it", () => {
    const study: PatchOp = { op: "add", path: "/sims/tank_motion/visual_flow/tank", value: "tank_a" as never };
    const model = apply([study]).evaluated;
    expect(model.sims["tank_motion"]!.visual_flow!.engine).toBe("demo");
    const ops = renameNodeOps("demo", "tank_a", "main_ox", demo, model);
    expect(ops[0]).toEqual({ op: "move", from: "/engines/demo/feed/node/tank_a", path: "/engines/demo/feed/node/main_ox" });
    const after = apply([study, ...ops]);
    const e = after.evaluated.engines!["demo"] as EvalEngine;
    expect(e.nodes["tank_a"]).toBeUndefined();
    expect(e.nodes["main_ox"]!.tank!.length).toBeCloseTo(0.4112);
    expect(e.edges.filter((x) => x.from === "main_ox").length).toBe(2);
    expect(after.evaluated.sims["tank_motion"]!.visual_flow!.tank).toBe("main_ox");
    expect(feedErrors([study, ...ops])).toEqual([]);
  });
});

describe("removing a node", () => {
  it("takes its connections, from the end so the indices hold", () => {
    expect(nodeRemovalScope("tank_a", demo, "demo", base).edges).toEqual([0, 4]);
    const ops = removeNodeOps("demo", "tank_a", demo, base);
    expect(ops.map((o) => o.path)).toEqual(["/engines/demo/feed/edge/4", "/engines/demo/feed/edge/0", "/engines/demo/feed/node/tank_a"]);
    const e = engineOf(ops);
    expect(e.nodes["tank_a"]).toBeUndefined();
    expect(e.edges).toHaveLength(4);
    expect(e.edges.some((x) => x.from === "tank_a" || x.to === "tank_a")).toBe(false);
  });
  it("clears a study's pointer at it, so the study still resolves", () => {
    const study: PatchOp = { op: "add", path: "/sims/tank_motion/visual_flow/tank", value: "tank_a" as never };
    const model = apply([study]).evaluated;
    expect(nodeRemovalScope("tank_a", demo, "demo", model).studies).toBe(1);
    const after = apply([study, ...removeNodeOps("demo", "tank_a", demo, model)]);
    expect(after.evaluated.sims["tank_motion"]!.visual_flow!.tank ?? null).toBeNull();
  });
});

describe("connection writes", () => {
  const field = (i: number, key: string) => edgeFields(demo, i).find((f) => f.key.endsWith(`.${key}`))!;
  it("writes each input of an edge", () => {
    const ops = [...fieldOps("demo", field(0, "diameter"), "12 mm", source), ...fieldOps("demo", field(0, "length"), "0.5 m", source), ...fieldOps("demo", field(0, "bc"), "orifice", source), ...fieldOps("demo", field(5, "from"), "tank_b", source)];
    expect(ops.every((o) => o.op === "replace")).toBe(true);
    const e = engineOf(ops);
    expect(e.edges[0]!.diameter).toBeCloseTo(0.012);
    expect(e.edges[0]!.length).toBeCloseTo(0.5);
    expect(e.edges[0]!.bc).toBe("orifice");
    expect(e.edges[5]!.from).toBe("tank_b");
  });
  it("clears an optional edge input, and adds it back", () => {
    const cleared = fieldOps("demo", field(0, "bc"), null, source);
    expect(cleared).toEqual([{ op: "remove", path: "/engines/demo/feed/edge/0/bc" }]);
    const e = engineOf(cleared);
    expect(e.edges[0]!.bc ?? null).toBeNull();
    const bare = edgeFields(e, 0).find((f) => f.key.endsWith(".bc"))!;
    expect(bare.present).toBe(false);
    expect(fieldOps("demo", bare, null, engineSource(undefined))).toEqual([]);
    expect(fieldOps("demo", bare, "open", engineSource(undefined))).toEqual([{ op: "add", path: "/engines/demo/feed/edge/0/bc", value: "open" }]);
  });
  it("keeps a node outside the graph selectable, so opening changes nothing", () => {
    const stale = { ...demo, edges: [{ ...demo.edges[0]!, from: "ghost" }] };
    expect(edgeFields(stale, 0)[0]!.options).toContain("ghost");
  });
  it("runs a new connection toward the engine node", () => {
    const ops = addEdgeOps("demo", demo)!;
    expect(ops).toEqual([{ op: "add", path: "/engines/demo/feed/edge/-", value: { from: "pt_a", to: "engine" } }]);
    expect(engineOf(ops).edges).toHaveLength(7);
  });
  it("wants two nodes", () => {
    expect(addEdgeOps("demo", { ...demo, nodes: { a: { kind: "tank" } } })).toBeNull();
  });
  it("removes one connection", () => {
    const e = engineOf(removeEdgeOps("demo", 2));
    expect(e.edges).toHaveLength(5);
    expect(e.edges[2]!.from).toBe("valve_b");
  });
  it("writes a waypoint in place, and depth appears and clears", () => {
    const fields = waypointFields(demo, 0, 1);
    const ops = [...fieldOps("demo", fields[0]!, "180 mm", source), ...fieldOps("demo", fields[2]!, "5 mm", source)];
    expect(ops.map((o) => o.op)).toEqual(["replace", "add"]);
    const e = engineOf(ops);
    expect(e.edges[0]!.waypoints![1]!.station).toBeCloseTo(0.18);
    expect(e.edges[0]!.waypoints![1]!.depth).toBeCloseTo(0.005);
    const set = waypointFields(e, 0, 1)[2]!;
    expect(fieldOps("demo", set, null, source)).toEqual([{ op: "remove", path: "/engines/demo/feed/edge/0/waypoints/1/depth" }]);
    expect(fieldValue(fields[2]!, demo, source)).toBeNull();
  });
  it("appends a waypoint where the last one is", () => {
    const e = engineOf(addWaypointOps("demo", demo, 0));
    expect(e.edges[0]!.waypoints).toHaveLength(3);
    expect(e.edges[0]!.waypoints![2]!.station).toBeCloseTo(demo.edges[0]!.waypoints![1]!.station);
  });
  it("gives an unrouted connection its first waypoint at its first node", () => {
    const ops = addWaypointOps("demo", demo, 4);
    expect(ops).toEqual([{ op: "add", path: "/engines/demo/feed/edge/4/waypoints", value: [{ station: "360 mm", radial: "-350 mm" }] }]);
    expect(engineOf(ops).edges[4]!.waypoints).toHaveLength(1);
  });
  it("removes a waypoint, and the list with its last one", () => {
    expect(engineOf(removeWaypointOps("demo", demo, 0, 0)).edges[0]!.waypoints).toHaveLength(1);
    const oneLeft = engineOf(removeWaypointOps("demo", demo, 0, 0));
    expect(removeWaypointOps("demo", oneLeft, 0, 0)).toEqual([{ op: "remove", path: "/engines/demo/feed/edge/0/waypoints" }]);
    expect(engineOf([...removeWaypointOps("demo", demo, 0, 0), ...removeWaypointOps("demo", oneLeft, 0, 0)]).edges[0]!.waypoints ?? []).toEqual([]);
  });
});

describe("building a graph from nothing", () => {
  const bare: PatchOp = { op: "add", path: "/engines/fresh", value: { name: "Fresh", propellants: { oxidizer: "n2o", fuel: "ethanol" }, mixture_ratio: 4, chamber_pressure: "20 bar", thrust: "1.5 kN" } as never };
  it("creates the feed on the first node, then appends", () => {
    const empty = engineOf([bare], "fresh");
    const noFeed = engineSource('name = "Fresh"\n');
    const first = addNodeOps("fresh", "tank", empty, noFeed);
    expect(first.ops[0]!.path).toBe("/engines/fresh/feed");
    const one = engineOf([bare, ...first.ops], "fresh");
    expect(Object.keys(one.nodes)).toEqual(["tank"]);
    const second = addNodeOps("fresh", "engine", one, engineSource('[feed.node.tank]\nkind = "tank"\n'));
    expect(second.ops[0]!.path).toBe("/engines/fresh/feed/node/engine");
    const two = engineOf([bare, ...first.ops, ...second.ops], "fresh");
    expect(addEdgeOps("fresh", two)).toEqual([{ op: "add", path: "/engines/fresh/feed/edge/-", value: { from: "tank", to: "engine" } }]);
    const three = engineOf([bare, ...first.ops, ...second.ops, ...addEdgeOps("fresh", two)!], "fresh");
    expect(three.edges).toEqual([expect.objectContaining({ from: "tank", to: "engine" })]);
  });
});
