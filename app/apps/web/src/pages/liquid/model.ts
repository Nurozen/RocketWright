/**
 * Page 05 (Propulsion > Liquid propulsion design, M4.7) view model. Pure:
 * the engine's evaluated feed graph (`EvaluatedModel.engines.<id>`, IF2), the
 * check report, and `engine_design` (IF8) become the rail categories, the
 * flow paths and the selected connection, the connectivity diagram layout,
 * the inspector's input rows, and the Properties tables.
 *
 * Selection refs (one entity model, C §5.1):
 * - a feed node: `rw:eng/<engine>/feed/node/<id>`
 * - a feed edge: `rw:eng/<engine>/feed/edge/<index>`
 * Viewport part ids: the node id for nodes, `edge:<index>` for lines.
 */
import type { RwRef, schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import type { IconName } from "../../shell/Icon.tsx";

export type EvalEngine = DeepReadonly<schema.EvalEngine>;
export type EvalFeedNode = DeepReadonly<schema.EvalFeedNode>;
export type EngineDesignOut = DeepReadonly<schema.EngineDesignOut>;
export type Diagnostic = DeepReadonly<schema.Diagnostic>;

// ---- refs and part ids ---------------------------------------------------------

export const nodeRef = (engine: string, id: string): RwRef => `rw:eng/${engine}/feed/node/${id}`;
export const edgeRef = (engine: string, index: number): RwRef => `rw:eng/${engine}/feed/edge/${index}`;
export const edgePart = (index: number): string => `edge:${index}`;

export type FeedTarget = { engine: string; kind: "engine" } | { engine: string; kind: "node"; id: string } | { engine: string; kind: "edge"; index: number };

const ENG_RE = /^rw:eng\/([^\s#@/]+)(?:\/feed\/(node|edge)\/([^\s/]+))?$/;

/** The engine entity a ref names, or null (not an engine ref). */
export function feedTarget(ref: string): FeedTarget | null {
  const m = ENG_RE.exec(ref);
  if (m === null) return null;
  const engine = m[1]!;
  if (m[2] === undefined) return { engine, kind: "engine" };
  if (m[2] === "node") return { engine, kind: "node", id: m[3]! };
  const index = Number(m[3]);
  return Number.isInteger(index) && index >= 0 ? { engine, kind: "edge", index } : null;
}

/** The viewport part of a target (`null` for the engine as a whole). */
export function partOfTarget(t: FeedTarget): string | null {
  return t.kind === "node" ? t.id : t.kind === "edge" ? edgePart(t.index) : null;
}

/** The ref of a viewport part (node id or `edge:<i>`). */
export function refOfPart(engine: string, part: string): RwRef {
  const m = /^edge:(\d+)$/.exec(part);
  return m ? edgeRef(engine, Number(m[1])) : nodeRef(engine, part);
}

// ---- engines -------------------------------------------------------------------

export function engineIds(engines: Readonly<Record<string, unknown>> | null | undefined): string[] {
  return Object.keys(engines ?? {}).sort();
}

/** The engine named by the selection, else `preferred` when it exists, else the first. */
export function pickEngine(ids: readonly string[], refs: readonly string[], preferred: string | null): string | null {
  for (const r of refs) {
    const t = feedTarget(r);
    if (t !== null && ids.includes(t.engine)) return t.engine;
  }
  if (preferred !== null && ids.includes(preferred)) return preferred;
  return ids[0] ?? null;
}

/** `tank_a` → `Tank A`, `pt_c` → `PT C`, `engine` → `Engine`. */
export function nodeLabel(id: string): string {
  return id
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function nodeIcon(kind: string | undefined): IconName {
  switch (kind) {
    case "tank":
      return "tank";
    case "valve":
      return "valve";
    case "engine":
      return "engine";
    case "sensor":
      return "sensor";
    default:
      return "line";
  }
}

const FLUIDS: Record<string, string> = { n2o: "N2O", lox: "LOX", ethanol: "Ethanol", ipa: "IPA", rp1: "RP-1", "rp-1": "RP-1", ch4: "Methane", h2o: "Water", n2: "N2", he: "Helium" };
export const fluidLabel = (f: string | null | undefined): string => (f == null || f === "" ? "—" : (FLUIDS[f.toLowerCase()] ?? f));

export type Role = "ox" | "fuel";

/** Oxidizer or fuel, from the node's fluid against the engine's propellants. */
export function roleOf(engine: EvalEngine, nodeId: string): Role | null {
  const f = engine.nodes[nodeId]?.fluid?.toLowerCase();
  if (f == null) return null;
  if (f === engine.oxidizer.toLowerCase()) return "ox";
  if (f === engine.fuel.toLowerCase()) return "fuel";
  return null;
}

// ---- flow paths and the selected connection -------------------------------------

export interface FlowPath {
  tank: string;
  role: Role | null;
  /** Nodes in flow order, tank first, engine last. */
  nodes: string[];
  edges: number[];
}

const kindOf = (engine: EvalEngine, id: string) => engine.nodes[id]?.kind;

/** Each tank's path to an engine node through open edges (closed stubs and sensors excluded), tanks by id. */
export function flowPaths(engine: EvalEngine): FlowPath[] {
  const out: FlowPath[] = [];
  const tanks = Object.keys(engine.nodes)
    .filter((id) => kindOf(engine, id) === "tank")
    .sort();
  for (const tank of tanks) {
    const walk = (at: string, nodes: string[], edges: number[]): FlowPath | null => {
      if (kindOf(engine, at) === "engine") return { tank, role: roleOf(engine, tank), nodes, edges };
      for (let i = 0; i < engine.edges.length; i++) {
        const e = engine.edges[i]!;
        if (e.from !== at || e.bc === "closed" || nodes.includes(e.to)) continue;
        const k = kindOf(engine, e.to);
        if (k === "sensor" || k === undefined) continue;
        const found = walk(e.to, [...nodes, e.to], [...edges, i]);
        if (found) return found;
      }
      return null;
    };
    const p = walk(tank, [tank], []);
    if (p) out.push(p);
  }
  return out;
}

export interface Connection {
  /** Start nodes (tanks for a flow path). */
  from: string[];
  /** End nodes (the engine for a flow path). */
  to: string[];
  /** Every edge and node on the connection (the 3D highlight). */
  edges: number[];
  nodes: string[];
  role: Role | null;
}

function joinPaths(paths: readonly FlowPath[]): Connection | null {
  if (paths.length === 0) return null;
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const roles = uniq(paths.map((p) => p.role));
  return {
    from: uniq(paths.map((p) => p.nodes[0]!)),
    to: uniq(paths.map((p) => p.nodes.at(-1)!)),
    edges: uniq(paths.flatMap((p) => p.edges)).sort((a, b) => a - b),
    nodes: uniq(paths.flatMap((p) => p.nodes)),
    role: roles.length === 1 ? (roles[0] ?? null) : null,
  };
}

/** The connection a selected node or edge belongs to (its flow path, or the edge itself off-path). */
export function connectionOf(engine: EvalEngine, target: FeedTarget | null, paths: readonly FlowPath[] = flowPaths(engine)): Connection | null {
  if (target === null) return null;
  if (target.kind === "engine") return joinPaths(paths);
  if (target.kind === "edge") {
    const on = paths.filter((p) => p.edges.includes(target.index));
    if (on.length > 0) return joinPaths(on);
    const e = engine.edges[target.index];
    return e ? { from: [e.from], to: [e.to], edges: [target.index], nodes: [e.from, e.to], role: roleOf(engine, e.from) } : null;
  }
  const on = paths.filter((p) => p.nodes.includes(target.id));
  if (on.length > 0) return joinPaths(on);
  // A sensor (or a node off every path): its own edges.
  const own = engine.edges.flatMap((e, i) => (e.from === target.id || e.to === target.id ? [i] : []));
  if (own.length === 0) return null;
  const e = engine.edges[own[0]!]!;
  return { from: [e.from], to: [e.to], edges: own, nodes: [...new Set(own.flatMap((i) => [engine.edges[i]!.from, engine.edges[i]!.to]))], role: null };
}

// ---- rail categories ---------------------------------------------------------------

export const CATEGORIES = [
  { id: "storage", label: "Propellant storage", icon: "tank" },
  { id: "feed", label: "Feed system", icon: "line" },
  { id: "valves", label: "Valves", icon: "valve" },
  { id: "engine", label: "Engine assembly", icon: "engine" },
  { id: "sensors", label: "Sensors", icon: "sensor" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** `ui.hidden` key of a category (the rail eye toggle). */
export const hiddenKey = (c: CategoryId): string => `liquid:${c}`;

export function categoryOfPart(engine: EvalEngine, part: string): CategoryId {
  const m = /^edge:(\d+)$/.exec(part);
  if (m) {
    const e = engine.edges[Number(m[1])];
    return e !== undefined && (kindOf(engine, e.to) === "sensor" || kindOf(engine, e.from) === "sensor") ? "sensors" : "feed";
  }
  switch (kindOf(engine, part)) {
    case "tank":
      return "storage";
    case "valve":
      return "valves";
    case "engine":
      return "engine";
    case "sensor":
      return "sensors";
    default:
      return "feed";
  }
}

/** Every viewport part of the engine: nodes by id, then edges. */
export function allParts(engine: EvalEngine): string[] {
  return [...Object.keys(engine.nodes).sort(), ...engine.edges.map((_, i) => edgePart(i))];
}

export function partsOfCategory(engine: EvalEngine, c: CategoryId): string[] {
  return allParts(engine).filter((p) => categoryOfPart(engine, p) === c);
}

/** Parts hidden by the rail eye toggles. */
export function hiddenParts(engine: EvalEngine, hidden: readonly string[]): string[] {
  return CATEGORIES.filter((c) => hidden.includes(hiddenKey(c.id))).flatMap((c) => partsOfCategory(engine, c.id));
}

/** The rail category of the selection (a flow-path edge or node reads as Feed system when an edge is selected). */
export function categoryOfTarget(engine: EvalEngine, t: FeedTarget | null): CategoryId | null {
  if (t === null) return null;
  if (t.kind === "engine") return "engine";
  return categoryOfPart(engine, t.kind === "edge" ? edgePart(t.index) : t.id);
}

/** What a rail row selects: its first entity (Feed system: the first flow path's first line). */
export function categoryTarget(engine: EvalEngine, engineId: string, c: CategoryId, paths: readonly FlowPath[] = flowPaths(engine)): RwRef | null {
  if (c === "feed") {
    const first = paths[0]?.edges[0];
    if (first !== undefined) return edgeRef(engineId, first);
  }
  const part = partsOfCategory(engine, c)[0];
  return part === undefined ? null : refOfPart(engineId, part);
}

// ---- missing inputs and the inspector's input rows --------------------------------

/** Liquid missing-input diagnostics (RW-W200-W249, I9) of one engine. */
export function missingInputs(diagnostics: readonly Diagnostic[] | null | undefined, engineId: string): Diagnostic[] {
  const prefix = `/engines/${engineId}/`;
  return (diagnostics ?? []).filter((d) => /^RW-W2[0-4]\d$/.test(d.code) && (d.path ?? "").startsWith(prefix));
}

export type InputTone = "warn" | "ok" | "info";

export interface InputRow {
  key: "fluid_model" | "boundary_conditions" | "analysis";
  label: string;
  value: string;
  tone: InputTone;
  /** The diagnostic behind a warning (code and hint for the tooltip). */
  diagnostic?: Diagnostic;
}

const FLUID_MODELS: Record<string, string> = { single_phase_liquid: "Single-phase liquid", two_phase_equilibrium: "Two-phase equilibrium" };
const BC_LABELS: Record<string, string> = { open: "Open", closed: "Closed", check_valve: "Check valve", orifice: "Orifice" };
export const bcLabel = (bc: string | null | undefined): string => (bc == null ? "Required" : (BC_LABELS[bc] ?? bc));

export type AnalysisState = { kind: "not_run" } | { kind: "running" } | { kind: "complete"; summary: string } | { kind: "failed"; message: string };

/** Fluid model, boundary conditions (of the selected connection, else the engine), and analysis. */
export function inputRows(engine: EvalEngine, engineId: string, missing: readonly Diagnostic[], connection: Connection | null, analysis: AnalysisState): InputRow[] {
  const fluidDiag = missing.find((d) => d.path === `/engines/${engineId}/fluid_model`);
  const fluid: InputRow = engine.fluid_model
    ? { key: "fluid_model", label: "Fluid model", value: FLUID_MODELS[engine.fluid_model] ?? engine.fluid_model, tone: "ok" }
    : { key: "fluid_model", label: "Fluid model", value: "Not selected", tone: "warn", ...(fluidDiag ? { diagnostic: fluidDiag } : {}) };
  const edges = connection?.edges ?? engine.edges.map((_, i) => i);
  const bcDiag = missing.find((d) => edges.some((i) => d.path === `/engines/${engineId}/feed/edge/${i}/bc`));
  const unset = edges.filter((i) => engine.edges[i]?.bc == null);
  const set = [...new Set(edges.map((i) => engine.edges[i]?.bc).filter((b): b is NonNullable<typeof b> => b != null))];
  const bc: InputRow =
    unset.length > 0
      ? { key: "boundary_conditions", label: "Boundary conditions", value: "Required", tone: "warn", ...(bcDiag ? { diagnostic: bcDiag } : {}) }
      : { key: "boundary_conditions", label: "Boundary conditions", value: set.map(bcLabel).join(", ") || "None", tone: "ok" };
  const a: InputRow =
    missing.length > 0 || analysis.kind === "not_run"
      ? { key: "analysis", label: "Analysis", value: "Not run", tone: "info" }
      : analysis.kind === "running"
        ? { key: "analysis", label: "Analysis", value: "Running…", tone: "info" }
        : analysis.kind === "failed"
          ? { key: "analysis", label: "Analysis", value: "Failed", tone: "warn" }
          : { key: "analysis", label: "Analysis", value: `Complete · ${analysis.summary}`, tone: "ok" };
  return [fluid, bc, a];
}

// ---- connectivity diagram ------------------------------------------------------------

export interface DiagramNode {
  id: string;
  label: string;
  icon: IconName;
  role: Role | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramEdge {
  index: number;
  from: string;
  to: string;
  role: Role | null;
  /** Elbow polyline (diagram px). */
  points: [number, number][];
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const NODE_W = 124;
const NODE_H = 58;
const ENGINE_H = 58;

/**
 * Columns by flow depth (tanks, then valves and lines, then the engine);
 * rows by flow path (oxidizer first). Sensors stay off the diagram (the rail
 * lists them). Edges are elbow connectors from the right edge of one node to
 * the left edge of the next, with their vertical run midway between columns.
 */
export function diagramLayout(engine: EvalEngine, paths: readonly FlowPath[] = flowPaths(engine), width = 520, height = 200): DiagramLayout {
  const ordered = [...paths].sort((a, b) => (a.role === b.role ? a.tank.localeCompare(b.tank) : a.role === "ox" ? -1 : b.role === "ox" ? 1 : 0));
  const cols = new Map<string, number>();
  for (const p of ordered) p.nodes.forEach((n, i) => cols.set(n, Math.max(cols.get(n) ?? 0, kindOf(engine, n) === "engine" ? Number.MAX_SAFE_INTEGER : i)));
  const engines = [...cols.keys()].filter((n) => kindOf(engine, n) === "engine");
  const depth = Math.max(1, ...[...cols.values()].filter((c) => c !== Number.MAX_SAFE_INTEGER).map((c) => c + 1));
  for (const n of engines) cols.set(n, depth);
  const ncol = depth + 1;
  const gap = ncol > 1 ? (width - NODE_W * ncol) / (ncol - 1) : 0;
  const colX = (c: number) => c * (NODE_W + gap);
  const rows = Math.max(1, ordered.length);
  const pitch = height / rows;
  const nodes = new Map<string, DiagramNode>();
  // Tank and line rows step down per path (tanks at the far left sit one half-row out, as in the concept).
  ordered.forEach((p, r) => {
    p.nodes.forEach((n, i) => {
      if (nodes.has(n) || kindOf(engine, n) === "engine") return;
      const yMid = pitch * (r + 0.5) + (i === 0 ? (r === 0 ? -pitch * 0.18 : pitch * 0.18) : 0);
      const node = engine.nodes[n];
      nodes.set(n, { id: n, label: nodeLabel(n), icon: nodeIcon(node?.kind), role: i === 0 ? p.role : null, x: colX(cols.get(n) ?? i), y: yMid - NODE_H / 2, w: NODE_W, h: NODE_H });
    });
  });
  for (const n of engines) nodes.set(n, { id: n, label: nodeLabel(n), icon: "engine", role: null, x: colX(depth), y: height / 2 - ENGINE_H / 2, w: NODE_W, h: ENGINE_H });
  const edges: DiagramEdge[] = [];
  for (const p of ordered) {
    for (const i of p.edges) {
      if (edges.some((e) => e.index === i)) continue;
      const e = engine.edges[i]!;
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      // Several lines into one node land at distinct heights (oxidizer above, fuel below).
      const into = p.role === "ox" ? -1 : p.role === "fuel" ? 1 : 0;
      const y2 = b.y + b.h / 2 + (kindOf(engine, e.to) === "engine" ? into * 10 : 0);
      const xm = (x1 + x2) / 2;
      edges.push({ index: i, from: e.from, to: e.to, role: p.role, points: y1 === y2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [xm, y1], [xm, y2], [x2, y2]] });
    }
  }
  return { width, height, nodes: [...nodes.values()], edges };
}

// ---- Properties ----------------------------------------------------------------------

export interface PropertyRow {
  key: string;
  label: string;
  value: string;
  unit: string;
}

export interface PropertyGroup {
  id: string;
  title: string;
  rows: PropertyRow[];
}

/** `v` with `sig` significant figures, grouped thousands, no trailing exponent. */
export function fmt(v: number | null | undefined, sig = 4): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(v))));
  return v.toLocaleString("en-US", { minimumFractionDigits: Math.min(digits, 6), maximumFractionDigits: Math.min(digits, 6) });
}

const G0 = 9.80665;

/** The computed performance and geometry tables (`engine_design`; SI → display units). */
export function propertyGroups(out: EngineDesignOut | null): PropertyGroup[] {
  if (out === null) return [];
  const s = out.design?.sizing ?? null;
  const p = out.performance ?? null;
  const groups: PropertyGroup[] = [];
  const row = (key: string, label: string, v: number | null | undefined, unit: string, sig = 4): PropertyRow => ({ key, label, value: fmt(v, sig), unit });
  if (p !== null || s !== null) {
    groups.push({
      id: "performance",
      title: "Performance",
      rows: [
        row("isp_sl", "Specific impulse (sea level)", p?.isp_sl ?? (s ? s.isp / G0 : null), "s"),
        row("isp_vac", "Specific impulse (vacuum)", p?.isp_vac ?? (s ? s.isp_vac / G0 : null), "s"),
        row("c_star", "Characteristic velocity c*", p?.c_star ?? s?.c_star, "m/s"),
        row("thrust", "Thrust (sea level)", p?.thrust ?? s?.thrust, "N"),
        ...(s ? [row("thrust_vac", "Thrust (vacuum)", s.thrust_vac, "N")] : []),
        ...(s ? [row("cf", "Thrust coefficient Cf", s.cf, "", 3)] : []),
        row("mdot", "Total mass flow", p?.mdot ?? s?.mdot, "kg/s", 3),
        row("mdot_ox", "Oxidizer mass flow", p?.mdot_ox ?? s?.mdot_ox, "kg/s", 3),
        row("mdot_fuel", "Fuel mass flow", p?.mdot_fuel ?? s?.mdot_fuel, "kg/s", 3),
        ...(s ? [row("mixture_ratio", "Mixture ratio O/F", s.mixture_ratio, "", 3)] : []),
        ...(s ? [row("chamber_pressure", "Chamber pressure", s.chamber_pressure / 1e5, "bar", 3)] : []),
        row("chamber_temperature", "Chamber temperature", p?.chamber_temperature ?? s?.chamber_temperature, "K"),
      ],
    });
  }
  if (s !== null || p !== null) {
    const mm = (v: number | null | undefined) => (v == null ? null : v * 1000);
    groups.push({
      id: "geometry",
      title: "Chamber and nozzle",
      rows: [
        row("throat_diameter", "Throat diameter", mm(s?.throat_diameter ?? p?.throat_diameter), "mm"),
        row("exit_diameter", "Exit diameter", mm(s?.exit_diameter ?? p?.exit_diameter), "mm"),
        row("chamber_diameter", "Chamber diameter", mm(s?.chamber_diameter ?? p?.chamber_diameter), "mm"),
        row("chamber_length", "Chamber length", mm(s?.chamber_length ?? p?.chamber_length), "mm"),
        ...(s
          ? [
              row("convergent_length", "Convergent length", mm(s.convergent_length), "mm"),
              row("nozzle_length", "Nozzle length", mm(s.nozzle_length), "mm"),
              row("throat_area", "Throat area", s.throat_area * 1e6, "mm²"),
              row("contraction_ratio", "Contraction ratio Ac/At", s.contraction_ratio, "", 3),
              row("l_star", "Characteristic length L*", s.l_star, "m", 3),
            ]
          : []),
        row("expansion_ratio", "Expansion ratio Ae/At", s?.expansion_ratio ?? p?.expansion_ratio, "", 3),
      ],
    });
  }
  const inj = out.design?.injector;
  if (inj) {
    groups.push({
      id: "injector",
      title: "Injector",
      rows: [
        row("injector_dp", "Pressure drop", inj.pressure_drop / 1e5, "bar", 3),
        row("injector_ox_area", "Oxidizer orifice area", inj.ox.area * 1e6, "mm²", 3),
        row("injector_fuel_area", "Fuel orifice area", inj.fuel.area * 1e6, "mm²", 3),
      ],
    });
  }
  for (const t of out.design?.tanks ?? []) {
    groups.push({
      id: `tank:${t.node}`,
      title: `${nodeLabel(t.node)} · ${fluidLabel(t.fluid)}`,
      rows: [
        row(`${t.node}.volume`, "Volume", t.volume * 1000, "L", 3),
        row(`${t.node}.propellant_mass`, "Propellant mass", t.propellant_mass, "kg", 3),
        row(`${t.node}.pressure`, "Initial pressure", t.pressure / 1e5, "bar", 3),
        row(`${t.node}.final_pressure`, "Final pressure", t.final_pressure / 1e5, "bar", 3),
        row(`${t.node}.hoop_sf`, "Hoop safety factor", t.hoop_safety_factor ?? null, "", 3),
      ],
    });
  }
  const b = out.design?.blowdown;
  if (b) {
    groups.push({
      id: "blowdown",
      title: "Blowdown",
      rows: [
        row("burn_time", "Burn time", b.burn_time, "s", 3),
        row("total_impulse", "Total impulse", b.total_impulse, "N·s"),
        row("average_thrust", "Average thrust", b.average_thrust, "N"),
        row("final_chamber_pressure", "Final chamber pressure", b.final_chamber_pressure / 1e5, "bar", 3),
      ],
    });
  }
  return groups;
}

// ---- source references -----------------------------------------------------------------

export interface SourceRef {
  id: string;
  title: string;
  detail: string;
  url: string;
}

/**
 * Literature behind the numbers on this page (`docs/dev/citations.toml`
 * `sp-125`; NOTICE.md NASA CEA). `thermo` is the design's provenance
 * (`table:n2o-ethanol` or `cea:native`).
 */
export function sourceRefs(thermo: string | null | undefined): SourceRef[] {
  return [
    {
      id: "sp-125",
      title: "NASA SP-125 · Design of Liquid Propellant Rocket Engines",
      detail: "Huzel and Huang, 1967: throat and chamber sizing (eq 1-34, 4-4), nozzle (4-7), injector (4-39, 4-40), tanks (8-1)",
      url: "https://ntrs.nasa.gov/citations/19710019929",
    },
    {
      id: "rp-1311",
      title: "NASA RP-1311 · Chemical Equilibrium with Applications (CEA)",
      detail: `Gordon and McBride, 1994: chamber and nozzle thermochemistry${thermo ? ` (${thermo.startsWith("table:") ? `tables ${thermo.slice(6)}` : "native CEA"})` : ""}`,
      url: "https://ntrs.nasa.gov/citations/19950013764",
    },
    {
      id: "tp-2002-211556",
      title: "NASA TP-2002-211556 · Thermodynamic data",
      detail: "McBride, Zehe, and Gordon, 2002: NASA Glenn coefficients for the species data",
      url: "https://ntrs.nasa.gov/citations/20020085330",
    },
  ];
}
