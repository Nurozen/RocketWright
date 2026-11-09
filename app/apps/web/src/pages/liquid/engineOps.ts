/**
 * The liquid engine editor's model (R3.2): which design inputs it shows, how a
 * typed value becomes the source literal, and the patch ops that write it.
 * Pure, and no arithmetic on engine results: values come from the evaluated
 * model and the engine's own source file.
 *
 * The feed graph's structure is not here (nodes, lines and their geometry are
 * edited as a table of their own); each tank's volume, pressure and pressurant
 * are, because the Tanks card is where a person sets them.
 */
import type { PatchOp, schema } from "@rw/contracts";
import type { ThermoPair } from "@rw/rw-wasm";
import { THERMO_PAIRS } from "@rw/rw-wasm";
import { fileTable, type SourceScalar } from "../components/source.ts";
import { displayUnit, parseLiteral, toDisplay, toSource } from "../../ui/fields/index.ts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { fluidLabel, nodeLabel, type EngineDesignOut, type EvalEngine, type EvalFeedNode, FLUID_MODELS } from "./model.ts";

export const ENGINE_CARDS = ["Propellants", "Chamber", "Nozzle", "Injector"] as const;
export type EngineCard = (typeof ENGINE_CARDS)[number];

export interface EngineField {
  /** Dotted source path under the engine (`injector.cd`, `feed.node.tank_a.volume`). */
  key: string;
  label: string;
  kind: "number" | "enum";
  /** `x-unit-dimension`; a pinned symbol keeps the unit the engine is specified in (`pressure:bar`). Absent: a plain number. */
  dim?: string;
  step?: number;
  required?: boolean;
  options?: readonly string[];
  labels?: Readonly<Record<string, string>>;
  placeholder?: string | null;
  /** The value's evaluated reading (SI). Absent: the field shows what the source says. */
  read?: (e: DeepReadonly<schema.EvalEngine>) => number | string | null | undefined;
  /** Fields only one of which counts: writing this one removes the others, so the value typed is the value used. */
  supersedes?: readonly string[];
  doc?: string;
}

const FLUID_OPTIONS: readonly schema.FluidModel[] = ["single_phase_liquid", "two_phase_equilibrium"];
const INJECTOR_OPTIONS: readonly schema.InjectorType[] = ["impinging", "showerhead", "pintle", "swirl"];
/** `rw-liquid`'s gas table (`props.rs`). */
const PRESSURANTS = ["n2", "he", "air"] as const;
const PRESSURANT_LABELS: Readonly<Record<string, string>> = { n2: "Nitrogen", he: "Helium", air: "Air" };

/** The flat inputs, by card. The propellant pair has its own controls: its two selects move together. */
const FIELDS: Readonly<Record<EngineCard, readonly EngineField[]>> = {
  Propellants: [
    { key: "mixture_ratio", label: "Mixture ratio", kind: "number", step: 0.1, required: true, read: (e) => e.mixture_ratio },
    { key: "fluid_model", label: "Fluid model", kind: "enum", options: FLUID_OPTIONS, labels: FLUID_MODELS, placeholder: "Not selected", read: (e) => e.fluid_model ?? null },
  ],
  Chamber: [
    { key: "chamber_pressure", label: "Pressure", kind: "number", dim: "pressure:bar", step: 1, required: true, read: (e) => e.chamber_pressure },
    { key: "thrust", label: "Thrust", kind: "number", dim: "force:kN", step: 0.1, required: true, read: (e) => e.thrust },
    { key: "contraction_ratio", label: "Contraction ratio", kind: "number", step: 0.1, read: (e) => e.contraction_ratio ?? null },
    { key: "l_star", label: "Characteristic length", kind: "number", dim: "length:m", step: 0.05, read: (e) => e.l_star ?? null },
  ],
  Nozzle: [
    { key: "expansion_ratio", label: "Expansion ratio", kind: "number", step: 0.1, read: (e) => e.expansion_ratio ?? null, supersedes: ["exit_pressure"], doc: "Setting this clears Exit pressure: the engine uses one or the other." },
    { key: "exit_pressure", label: "Exit pressure", kind: "number", dim: "pressure:bar", step: 0.1, read: (e) => e.exit_pressure ?? null, supersedes: ["expansion_ratio"], doc: "Setting this clears Expansion ratio: the engine uses one or the other." },
  ],
  Injector: [
    { key: "injector.type", label: "Injector type", kind: "enum", required: true, options: INJECTOR_OPTIONS, placeholder: null, read: (e) => e.injector?.kind ?? null },
    // These two read the source: the evaluated drop is the fraction times chamber pressure, not what was typed.
    { key: "injector.pressure_drop_fraction", label: "Pressure drop fraction", kind: "number", step: 0.01, supersedes: ["injector.pressure_drop"], doc: "Setting this clears Pressure drop: the engine uses one or the other." },
    { key: "injector.pressure_drop", label: "Pressure drop", kind: "number", dim: "pressure:bar", step: 0.1, supersedes: ["injector.pressure_drop_fraction"], doc: "Setting this clears Pressure drop fraction: the engine uses one or the other." },
    { key: "injector.cd", label: "Discharge coefficient", kind: "number", step: 0.01, read: (e) => e.injector?.cd ?? null },
  ],
};

export function cardFields(card: EngineCard): readonly EngineField[] {
  return FIELDS[card];
}

const nodeOf = (e: DeepReadonly<schema.EvalEngine>, id: string): DeepReadonly<EvalFeedNode> | undefined => e.nodes[id];

/** One tank's fields, keyed by its feed node. */
export function tankFields(nodeId: string): EngineField[] {
  const base = `feed.node.${nodeId}`;
  return [
    { key: `${base}.volume`, label: "Volume", kind: "number", dim: "volume:L", step: 0.1, read: (e) => nodeOf(e, nodeId)?.volume ?? null },
    { key: `${base}.pressure`, label: "Pressure", kind: "number", dim: "pressure:bar", step: 1, read: (e) => nodeOf(e, nodeId)?.pressure ?? null },
    { key: `${base}.pressurant`, label: "Pressurant", kind: "enum", options: PRESSURANTS, labels: PRESSURANT_LABELS, placeholder: "Not selected", read: (e) => nodeOf(e, nodeId)?.pressurant ?? null },
  ];
}

/** The tank nodes of an engine, by id, with the heading each one's group carries. */
export function tankGroups(engine: EvalEngine): { id: string; heading: string }[] {
  return Object.keys(engine.nodes)
    .filter((id) => engine.nodes[id]?.kind === "tank")
    .sort()
    .map((id) => ({ id, heading: `${nodeLabel(id)} · ${fluidLabel(engine.nodes[id]?.fluid)}` }));
}

// ---- reading the source ---------------------------------------------------------------

export interface EngineSource {
  /** The field's text in the engine's file (a literal or `= expression`), or undefined when it is not written. */
  written(key: string): SourceScalar | undefined;
  /** The file writes this table (`injector`). */
  hasTable(key: string): boolean;
}

/** The engine's own source file, read on demand and per table once. */
export function engineSource(text: string | undefined): EngineSource {
  const tables = new Map<string, Record<string, SourceScalar> | null>();
  const table = (path: readonly string[]) => {
    const key = path.join(".");
    if (!tables.has(key)) tables.set(key, text === undefined ? null : fileTable(text, path));
    return tables.get(key) ?? null;
  };
  return {
    written: (key) => {
      const parts = key.split(".");
      return table(parts.slice(0, -1))?.[parts.at(-1)!];
    },
    hasTable: (key) => table(key.split(".")) !== null,
  };
}

// ---- values ----------------------------------------------------------------------------

/** What the field holds: its evaluated value, or the source's when it has no evaluated reading. */
export function fieldValue(f: EngineField, engine: EvalEngine, source: EngineSource): number | string | null {
  if (f.read !== undefined) return f.read(engine) ?? null;
  const written = source.written(f.key);
  if (written === undefined || typeof written === "boolean") return null;
  return f.kind === "number" ? parseLiteral(written) : written;
}

/** The text a number field shows, in its display unit. */
export function displayNumber(f: EngineField, value: number | string | null, units: Units): string {
  return typeof value === "number" ? toDisplay(value, f.dim, units) : "";
}

export function fieldUnit(f: EngineField, units: Units): string {
  return displayUnit(f.dim, units).unit;
}

/** What the field says about its value, when the source holds a formula a typed number would replace. */
export function isExpression(f: EngineField, source: EngineSource): boolean {
  const w = source.written(f.key);
  return typeof w === "string" && w.trimStart().startsWith("=");
}

export type ParsedField = { error: string; value?: undefined } | { error?: undefined; value: SourceScalar | null };

/** A typed value to the source literal; `null` clears an optional field. */
export function parseFieldText(f: EngineField, text: string, units: Units): ParsedField {
  const t = text.trim();
  if (t === "") return f.required === true ? { error: `${f.label} needs a value.` } : { value: null };
  if (t.startsWith("=")) return t.length > 1 ? { value: t } : { error: `${f.label} needs a formula after =.` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: `${f.label} needs a number.` };
  if (n <= 0) return { error: `${f.label} must be greater than 0.` };
  return { value: toSource(n, f.dim, units) };
}

// ---- writes ----------------------------------------------------------------------------

const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const pathOf = (engineId: string, key: string) => `/engines/${pointer(engineId)}/${key.split(".").map(pointer).join("/")}`;

/** The ops of one field's new value; empty when there is nothing to do (clearing a value that is not written). */
export function fieldOps(engineId: string, f: EngineField, value: SourceScalar | null, source: EngineSource): PatchOp[] {
  const path = pathOf(engineId, f.key);
  const written = source.written(f.key) !== undefined;
  if (value === null) return written ? [{ op: "remove", path }] : [];
  const ops: PatchOp[] = [{ op: written ? "replace" : "add", path, value: value as never }];
  for (const other of f.supersedes ?? []) {
    if (source.written(other) !== undefined) ops.push({ op: "remove", path: pathOf(engineId, other) });
  }
  return ops;
}

/** Adds the injector table with the one member the schema requires; the rest report as missing inputs. */
export function addInjectorOps(engineId: string): PatchOp[] {
  return [{ op: "add", path: pathOf(engineId, "injector"), value: { type: "impinging" } as never }];
}

// ---- propellants -----------------------------------------------------------------------

export interface PropellantChoice {
  oxidizers: readonly string[];
  fuels: readonly string[];
}

const pairOf = (p: ThermoPair): [string, string] => p.split("-") as [string, string];

function oxidizersOfPairs(): string[] {
  return [...new Set(THERMO_PAIRS.map((p) => pairOf(p)[0]))];
}

export function fuelsFor(oxidizer: string): string[] {
  return THERMO_PAIRS.filter((p) => pairOf(p)[0] === oxidizer).map((p) => pairOf(p)[1]);
}

/**
 * Only the pairs with shipped tables are offered (R3.2). A pair the source
 * already holds outside them stays selectable, so opening its engine changes nothing.
 */
export function propellantChoice(oxidizer: string, fuel: string): PropellantChoice {
  const oxidizers = oxidizersOfPairs();
  const fuels = fuelsFor(oxidizer);
  return {
    oxidizers: oxidizers.includes(oxidizer) ? oxidizers : [...oxidizers, oxidizer],
    fuels: fuels.includes(fuel) ? fuels : [...fuels, fuel],
  };
}

/** The pair a change of one select leaves: a fuel the new oxidizer has no table with moves to its first. */
export function nextPair(current: { oxidizer: string; fuel: string }, change: { oxidizer?: string; fuel?: string }): { oxidizer: string; fuel: string } {
  const oxidizer = change.oxidizer ?? current.oxidizer;
  const fuel = change.fuel ?? current.fuel;
  const fuels = fuelsFor(oxidizer);
  return { oxidizer, fuel: fuels.length === 0 || fuels.includes(fuel) ? fuel : fuels[0]! };
}

/** The label of a propellant id in a select; one outside the shipped tables says so. */
export function propellantLabels(ids: readonly string[]): Record<string, string> {
  const shipped = new Set(THERMO_PAIRS.flatMap((p) => pairOf(p)));
  return Object.fromEntries(ids.map((id) => [id, shipped.has(id) ? fluidLabel(id) : `${fluidLabel(id)} (not tabulated)`]));
}

/**
 * The new pair, and the tanks that held the old propellants: the design finds
 * each tank by `fluid`, so a tank left on the old propellant would fail.
 * Only values the file writes change; a tank taking its fluid from a component is that component's.
 */
export function propellantOps(engineId: string, engine: EvalEngine, source: EngineSource, next: { oxidizer: string; fuel: string }): PatchOp[] {
  const ops: PatchOp[] = [{ op: "replace", path: pathOf(engineId, "propellants"), value: next as never }];
  const swap = (id: SourceScalar | undefined): string | null => (id === engine.oxidizer ? next.oxidizer : id === engine.fuel ? next.fuel : null);
  for (const id of Object.keys(engine.nodes).sort()) {
    if (engine.nodes[id]?.kind !== "tank") continue;
    for (const key of [`feed.node.${id}.fluid`, `feed.node.${id}.tank.fill.propellant`]) {
      const written = source.written(key);
      const to = swap(written);
      if (written !== undefined && to !== null && to !== written) ops.push({ op: "replace", path: pathOf(engineId, key), value: to as never });
    }
  }
  return ops;
}

// ---- names, and the design's freshness -------------------------------------------------

export function nextEngineName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let i = names.length + 1; ; i++) if (!taken.has(`engine ${i}`)) return `Engine ${i}`;
}

export function copyEngineName(name: string, names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  const base = `${name} copy`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/**
 * What a design was computed from. The evaluated engine alone determines the
 * design (`liquid.rs` caches on it), so an edit elsewhere in the rocket does
 * not read as a modified engine, and the key survives a part or sim edit.
 */
export function designKey(id: string, engine: EvalEngine): string {
  return `${id}@${JSON.stringify(engine)}`;
}

/** What `mirrorAt` needs of the store (tests pass a small stand-in). */
export interface MirrorStore {
  getState(): { project: { snapshot: { evaluated: { model_hash: string } | null } | null } };
  subscribe(listener: () => void): () => void;
}

/** How long a write may take to reach the mirror before the caller goes on anyway. */
export const MIRROR_WAIT_MS = 2_000;

/**
 * Resolves once the mirror holds a write's model (`model.patch` answers before
 * the snapshot push reaches this window), or after a short wait: another
 * writer may have moved the model past that hash, and nothing should hang on it.
 */
export function mirrorAt(store: MirrorStore, hash: string | null, waitMs = MIRROR_WAIT_MS): Promise<void> {
  const reached = () => hash === null || store.getState().project.snapshot?.evaluated?.model_hash === hash;
  if (reached()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };
    const unsubscribe = store.subscribe(() => {
      if (reached()) done();
    });
    const timer = setTimeout(done, waitMs);
  });
}

export interface DesignEntry {
  key: string;
  state: "loading" | "ready" | "error";
  out: EngineDesignOut | null;
  error?: string;
  /** The request this entry belongs to (the newest wins). */
  seq: number;
}

/** The engine has changed since this result was computed, and the page should say so. */
export function isModified(entry: DesignEntry | null | undefined, engineId: string, engine: EvalEngine): boolean {
  if (entry === null || entry === undefined || entry.state === "loading") return false;
  return entry.key !== designKey(engineId, engine);
}
