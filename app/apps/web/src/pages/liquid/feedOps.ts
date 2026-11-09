/**
 * The feed graph as an editable table (R3.2): the fields of its nodes and
 * connections, and the patch ops that add, rename and remove them. Pure, like
 * `engineOps.ts`, and values come from the evaluated model.
 *
 * Connections are array elements, so their paths carry an index; every op that
 * removes elements goes from the end, which keeps the earlier indices valid.
 */
import type { EvaluatedModel, PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { uniqueId } from "../../state/ops/ids.ts";
import { pathOf, type EngineField, type EngineSource } from "./engineOps.ts";
import { bcLabel, fluidLabel, nodeLabel, type EvalEngine } from "./model.ts";

export const NODE_KINDS: readonly schema.FeedNodeKind[] = ["tank", "valve", "line", "engine", "sensor"];
export const NODE_KIND_LABELS: Readonly<Record<schema.FeedNodeKind, string>> = { tank: "Tank", valve: "Valve", line: "Line", engine: "Engine", sensor: "Sensor" };

const END_CAPS: readonly schema.EndCap[] = ["flat", "hemispherical", "ellipsoidal"];
const END_CAP_LABELS: Readonly<Record<string, string>> = { flat: "Flat", hemispherical: "Hemispherical", ellipsoidal: "Ellipsoidal" };
const BOUNDARY_CONDITIONS: readonly schema.EdgeBc[] = ["open", "closed", "check_valve", "orifice"];
const BOUNDARY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(BOUNDARY_CONDITIONS.map((b) => [b, bcLabel(b)]));
const PRESSURANTS = ["n2", "he", "air"] as const;
const PRESSURANT_LABELS: Readonly<Record<string, string>> = { n2: "Nitrogen", he: "Helium", air: "Air" };

const POSITION = "length:mm";
const STATION_DOC = "Where the node sits along the vehicle, from the nose tip.";
const RADIAL_DOC = "Signed offset from the axis in the layout plane; it places the node in the 3D view.";

/** What the node fields choose from, outside the engine itself. */
export interface FeedChoices {
  materials: readonly string[];
  tankComponents: readonly string[];
}

export function feedChoices(model: DeepReadonly<Pick<EvaluatedModel, "materials" | "components">> | null): FeedChoices {
  if (model === null) return { materials: [], tankComponents: [] };
  return { materials: Object.keys(model.materials).sort(), tankComponents: model.components.filter((c) => c.shape.type === "tank").map((c) => c.id) };
}

/** The choices, plus a value the file already holds outside them, so opening an engine changes nothing. */
const withCurrent = (options: readonly string[], current: string | null | undefined): readonly string[] => (current == null || current === "" || options.includes(current) ? options : [...options, current]);

const nodeIds = (engine: EvalEngine): string[] => Object.keys(engine.nodes).sort();
const labelsOf = (ids: readonly string[], label: (id: string) => string): Record<string, string> => Object.fromEntries(ids.map((id) => [id, label(id)]));

// ---- node fields -----------------------------------------------------------------------

export function kindField(id: string): EngineField {
  return { key: `feed.node.${id}.kind`, label: "Kind", kind: "enum", required: true, options: NODE_KINDS, labels: NODE_KIND_LABELS, placeholder: null, read: (e) => e.nodes[id]?.kind ?? null };
}

/**
 * Every input of a node but its id and kind. Each kind shows its own, and a
 * value the file writes for another kind still shows, so it can be seen and
 * cleared. A tank's volume, pressure and pressurant are on the Tanks card.
 */
export function nodeFields(engine: EvalEngine, id: string, source: EngineSource, choices: FeedChoices): EngineField[] {
  const base = `feed.node.${id}`;
  const node = engine.nodes[id];
  const kind = node?.kind;
  const shown = (kinds: readonly schema.FeedNodeKind[], key: string) => (kind !== undefined && kinds.includes(kind)) || source.written(`${base}.${key}`) !== undefined;
  const out: EngineField[] = [
    { key: `${base}.station`, label: "Station", kind: "number", dim: POSITION, step: 1, signed: true, read: (e) => e.nodes[id]?.station ?? null, doc: STATION_DOC },
    { key: `${base}.radial`, label: "Radial offset", kind: "number", dim: POSITION, step: 1, signed: true, read: (e) => e.nodes[id]?.radial ?? null, doc: RADIAL_DOC },
  ];
  if (shown(["valve"], "flow_area")) out.push({ key: `${base}.flow_area`, label: "Flow area", kind: "number", dim: "area", step: 0.01, read: (e) => e.nodes[id]?.flow_area ?? null, doc: "Left empty, the design sizes the valve." });
  if (shown(["valve"], "cd")) out.push({ key: `${base}.cd`, label: "Discharge coefficient", kind: "number", step: 0.01, read: (e) => e.nodes[id]?.cd ?? null });
  if (shown([], "volume")) out.push({ key: `${base}.volume`, label: "Volume", kind: "number", dim: "volume:L", step: 0.1, read: (e) => e.nodes[id]?.volume ?? null });
  if (shown([], "pressure")) out.push({ key: `${base}.pressure`, label: "Pressure", kind: "number", dim: "pressure:bar", step: 1, read: (e) => e.nodes[id]?.pressure ?? null });
  if (shown([], "pressurant")) out.push({ key: `${base}.pressurant`, label: "Pressurant", kind: "enum", options: PRESSURANTS, labels: PRESSURANT_LABELS, placeholder: "Not selected", read: (e) => e.nodes[id]?.pressurant ?? null });
  if (shown(["tank"], "fluid")) {
    const fluids = withCurrent([engine.oxidizer, engine.fuel], node?.fluid);
    out.push({ key: `${base}.fluid`, label: "Fluid", kind: "enum", options: fluids, labels: labelsOf(fluids, fluidLabel), placeholder: "Not selected", read: (e) => e.nodes[id]?.fluid ?? null, doc: "The design finds each tank by this propellant." });
  }
  if (shown(["tank"], "pressurant_mass")) out.push({ key: `${base}.pressurant_mass`, label: "Pressurant mass", kind: "number", dim: "mass", step: 1, read: (e) => e.nodes[id]?.pressurant_mass ?? null });
  if (shown(["tank"], "component")) {
    const components = withCurrent(choices.tankComponents, node?.component);
    out.push({
      key: `${base}.component`,
      label: "Tank part",
      kind: "enum",
      options: components,
      placeholder: "Not selected",
      read: (e) => e.nodes[id]?.component ?? null,
      supersedes: [`${base}.tank`, `${base}.material`],
      doc: "A tank part of the rocket supplies this tank's geometry. Choosing one clears the geometry on this node.",
    });
  }
  if (source.hasTable(`${base}.tank`)) out.push(...inlineTankFields(id, engine, source, choices));
  else if (shown([], "material")) out.push(materialField(id, written(source, `${base}.material`), choices));
  return out;
}

const written = (source: EngineSource, key: string): string | undefined => {
  const value = source.written(key);
  return typeof value === "string" ? value : undefined;
};

function materialField(id: string, current: string | undefined, choices: FeedChoices): EngineField {
  const materials = withCurrent(choices.materials, current);
  return { key: `feed.node.${id}.material`, label: "Material", kind: "enum", options: materials, placeholder: "Not selected", doc: "Wall material of the tank on this node, for its mass and hoop stress." };
}

function inlineTankFields(id: string, engine: EvalEngine, source: EngineSource, choices: FeedChoices): EngineField[] {
  const base = `feed.node.${id}.tank`;
  const fields: EngineField[] = [
    { key: `${base}.length`, label: "Tank length", kind: "number", dim: POSITION, step: 1, required: true, read: (e) => e.nodes[id]?.tank?.length ?? null },
    { key: `${base}.od`, label: "Outer diameter", kind: "number", dim: POSITION, step: 1, required: true, read: (e) => e.nodes[id]?.tank?.od ?? null },
    { key: `${base}.wall`, label: "Wall thickness", kind: "number", dim: POSITION, step: 0.1, required: true, read: (e) => e.nodes[id]?.tank?.wall ?? null },
    { key: `${base}.end_cap`, label: "End cap", kind: "enum", required: true, options: END_CAPS, labels: END_CAP_LABELS, placeholder: null, read: (e) => e.nodes[id]?.tank?.end_cap ?? null },
    materialField(id, written(source, `feed.node.${id}.material`), choices),
  ];
  if (source.hasTable(`${base}.fill`)) {
    const propellants = withCurrent([engine.oxidizer, engine.fuel], written(source, `${base}.fill.propellant`));
    fields.push(
      { key: `${base}.fill.propellant`, label: "Fill propellant", kind: "enum", required: true, options: propellants, labels: labelsOf(propellants, fluidLabel), placeholder: null },
      { key: `${base}.fill.fraction`, label: "Fill fraction", kind: "number", step: 0.01, supersedes: [`${base}.fill.volume`], doc: "Setting this clears Fill volume: the tank uses one or the other." },
      { key: `${base}.fill.volume`, label: "Fill volume", kind: "number", dim: "volume:L", step: 0.1, supersedes: [`${base}.fill.fraction`], doc: "Setting this clears Fill fraction: the tank uses one or the other." },
    );
  }
  return fields;
}

// ---- connection fields -----------------------------------------------------------------

export function edgeFields(engine: EvalEngine, index: number): EngineField[] {
  const base = `feed.edge.${index}`;
  const edge = engine.edges[index];
  const ids = nodeIds(engine);
  const end = (key: "from" | "to", label: string): EngineField => {
    const options = withCurrent(ids, edge?.[key]);
    return { key: `${base}.${key}`, label, kind: "enum", required: true, options, labels: labelsOf(options, nodeLabel), placeholder: null, present: true, read: (e) => e.edges[index]?.[key] ?? null };
  };
  return [
    end("from", "From"),
    end("to", "To"),
    { key: `${base}.diameter`, label: "Diameter", kind: "number", dim: POSITION, step: 0.5, present: edge?.diameter != null, read: (e) => e.edges[index]?.diameter ?? null },
    { key: `${base}.length`, label: "Length", kind: "number", dim: "length:m", step: 0.01, present: edge?.length != null, read: (e) => e.edges[index]?.length ?? null },
    { key: `${base}.bc`, label: "Boundary condition", kind: "enum", options: BOUNDARY_CONDITIONS, labels: BOUNDARY_LABELS, placeholder: "Not selected", present: edge?.bc != null, read: (e) => e.edges[index]?.bc ?? null },
  ];
}

/** A routing point's inputs. Depth reads 0 when the file leaves it out, so 0 shows as not set. */
export function waypointFields(engine: EvalEngine, edge: number, point: number): EngineField[] {
  const base = `feed.edge.${edge}.waypoints.${point}`;
  const at = (e: DeepReadonly<schema.EvalEngine>) => e.edges[edge]?.waypoints?.[point];
  return [
    { key: `${base}.station`, label: "Station", kind: "number", dim: POSITION, step: 1, required: true, signed: true, present: true, read: (e) => at(e)?.station ?? null, doc: STATION_DOC },
    { key: `${base}.radial`, label: "Radial offset", kind: "number", dim: POSITION, step: 1, required: true, signed: true, present: true, read: (e) => at(e)?.radial ?? null, doc: RADIAL_DOC },
    { key: `${base}.depth`, label: "Depth", kind: "number", dim: POSITION, step: 1, signed: true, present: (engine.edges[edge]?.waypoints?.[point]?.depth ?? 0) !== 0, read: (e) => at(e)?.depth || null, doc: "Offset out of the layout plane." },
  ];
}

// ---- structure -------------------------------------------------------------------------

const feedPath = (engineId: string, rest: string) => `${pathOf(engineId, "feed")}/${rest}`;

/** `feed` is optional, and a new engine has none until its first node. */
const hasFeed = (engine: EvalEngine, source: EngineSource) => source.hasTable("feed") || Object.keys(engine.nodes).length > 0 || engine.edges.length > 0;

export function addNodeOps(engineId: string, kind: schema.FeedNodeKind, engine: EvalEngine, source: EngineSource): { id: string; ops: PatchOp[] } {
  const id = uniqueId(kind, Object.keys(engine.nodes), "node");
  const value = { kind };
  if (hasFeed(engine, source)) return { id, ops: [{ op: "add", path: feedPath(engineId, `node/${id}`), value: value as never }] };
  return { id, ops: [{ op: "add", path: pathOf(engineId, "feed"), value: { node: { [id]: value }, edge: [] } as never }] };
}

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Why this text cannot name the node; null when it can. */
export function nodeIdProblem(text: string, id: string, engine: EvalEngine): string | null {
  const next = text.trim();
  if (next === "") return "Give the node an id.";
  if (!ID_PATTERN.test(next)) return "Use lowercase letters, digits and underscores, starting with a letter.";
  return next !== id && engine.nodes[next] !== undefined ? `${next} is already a node of this engine.` : null;
}

type SimsOf = DeepReadonly<Pick<EvaluatedModel, "sims">>;

/** The visual studies of this engine that show this tank. */
function studiesShowing(model: SimsOf | null, engineId: string, id: string) {
  return Object.values(model?.sims ?? {}).filter((s) => s?.visual_flow?.engine === engineId && s.visual_flow.tank === id);
}

/** The id everywhere it is written: the node, its connections, and the studies that show it. */
export function renameNodeOps(engineId: string, id: string, next: string, engine: EvalEngine, model: SimsOf | null): PatchOp[] {
  const ops: PatchOp[] = [{ op: "move", from: feedPath(engineId, `node/${id}`), path: feedPath(engineId, `node/${next}`) }];
  engine.edges.forEach((e, i) => {
    if (e.from === id) ops.push({ op: "replace", path: feedPath(engineId, `edge/${i}/from`), value: next as never });
    if (e.to === id) ops.push({ op: "replace", path: feedPath(engineId, `edge/${i}/to`), value: next as never });
  });
  for (const sim of studiesShowing(model, engineId, id)) ops.push({ op: "replace", path: `/sims/${sim!.id}/visual_flow/tank`, value: next as never });
  return ops;
}

/** What removing a node takes with it. */
export function nodeRemovalScope(id: string, engine: EvalEngine, engineId: string, model: SimsOf | null): { edges: number[]; studies: number } {
  const edges = engine.edges.flatMap((e, i) => (e.from === id || e.to === id ? [i] : []));
  return { edges, studies: studiesShowing(model, engineId, id).length };
}

/** The node, the connections that end at it, and a study's pointer at it (the study falls back to the oxidizer tank). */
export function removeNodeOps(engineId: string, id: string, engine: EvalEngine, model: SimsOf | null): PatchOp[] {
  const { edges } = nodeRemovalScope(id, engine, engineId, model);
  const ops: PatchOp[] = edges.reverse().map((i) => ({ op: "remove", path: feedPath(engineId, `edge/${i}`) }));
  ops.push({ op: "remove", path: feedPath(engineId, `node/${id}`) });
  for (const sim of studiesShowing(model, engineId, id)) ops.push({ op: "remove", path: `/sims/${sim!.id}/visual_flow/tank` });
  return ops;
}

/** A connection needs two nodes to join; null until there are two. It runs toward the engine node when there is one. */
export function addEdgeOps(engineId: string, engine: EvalEngine): PatchOp[] | null {
  const ids = nodeIds(engine);
  if (ids.length < 2) return null;
  const to = ids.find((id) => engine.nodes[id]?.kind === "engine") ?? ids[1]!;
  const from = ids.find((id) => id !== to)!;
  return [{ op: "add", path: feedPath(engineId, "edge/-"), value: { from, to } as never }];
}

export function removeEdgeOps(engineId: string, index: number): PatchOp[] {
  return [{ op: "remove", path: feedPath(engineId, `edge/${index}`) }];
}

const millimetres = (si: number | null | undefined): string => `${Math.round((si ?? 0) * 1e6) / 1e3} mm`;

/** A new routing point starts where the connection's last one is (or its first node), to be moved from there. */
export function addWaypointOps(engineId: string, engine: EvalEngine, index: number): PatchOp[] {
  const edge = engine.edges[index];
  const points = edge?.waypoints ?? [];
  const last = points.at(-1);
  const start = edge === undefined ? undefined : engine.nodes[edge.from];
  const value = { station: millimetres(last?.station ?? start?.station), radial: millimetres(last?.radial ?? start?.radial) };
  // An edge with no routing has no `waypoints` member to append to.
  return points.length > 0 ? [{ op: "add", path: feedPath(engineId, `edge/${index}/waypoints/-`), value: value as never }] : [{ op: "add", path: feedPath(engineId, `edge/${index}/waypoints`), value: [value] as never }];
}

export function removeWaypointOps(engineId: string, engine: EvalEngine, edge: number, point: number): PatchOp[] {
  // The last point goes with its member: the schema treats no routing as an absent list.
  if ((engine.edges[edge]?.waypoints?.length ?? 0) <= 1) return [{ op: "remove", path: feedPath(engineId, `edge/${edge}/waypoints`) }];
  return [{ op: "remove", path: feedPath(engineId, `edge/${edge}/waypoints/${point}`) }];
}

// ---- a tank's geometry -----------------------------------------------------------------

/** Tank geometry's members are all required, so it starts from a plausible tank the person then sizes. */
export function addInlineTankOps(engineId: string, id: string): PatchOp[] {
  return [{ op: "add", path: pathOf(engineId, `feed.node.${id}.tank`), value: { length: "300 mm", od: "100 mm", wall: "3 mm", end_cap: "hemispherical" } as never }];
}

/** The fill names its propellant; how much is the person's to give, and the engine reports it missing until then. */
export function addFillOps(engineId: string, id: string, engine: EvalEngine): PatchOp[] {
  return [{ op: "add", path: pathOf(engineId, `feed.node.${id}.tank.fill`), value: { propellant: engine.nodes[id]?.fluid ?? engine.oxidizer } as never }];
}

/** What a tank node still lacks, so the row can offer to add it. */
export function tankGeometryState(id: string, source: EngineSource): { inline: boolean; fill: boolean; component: boolean } {
  return { inline: source.hasTable(`feed.node.${id}.tank`), fill: source.hasTable(`feed.node.${id}.tank.fill`), component: source.written(`feed.node.${id}.component`) !== undefined };
}
