/**
 * The pure half of the Simulation conditions sheet (R2.5): which fields it
 * shows, how a person's text converts to the source literals a sim file holds,
 * and the patch that writes them. A field left alone keeps its literal, so an
 * expression or another spelling survives an edit to its neighbour. The table
 * a sim file lacks is written whole with its required key, because the model
 * refuses a leaf under an absent table.
 */
import type { PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { displayUnit, toDisplay, toSource } from "../../ui/fields/index.ts";
import { fileTable } from "../components/source.ts";

type EvalSim = DeepReadonly<schema.EvalSim>;
type Diagnostic = DeepReadonly<schema.Diagnostic>;

export type SimSection = "launch" | "wind" | "atmosphere" | "integrator";
export type SimGroup = "Launch" | "Site" | "Wind" | "Atmosphere" | "Solver";

/** Headings in the sheet's order. */
export const SIM_GROUPS: readonly SimGroup[] = ["Launch", "Site", "Wind", "Atmosphere", "Solver"];

interface FieldBase {
  /** `<section>.<leaf>` of the sim file. */
  key: string;
  label: string;
  group: SimGroup;
  /** The engine's own explanation, in the field's tooltip. */
  title?: string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  /** `x-unit-dimension`, pinned to one unit; the percent field has none. */
  dim: string;
  step: number;
  /** Text shown as a percentage, written as a fraction (the source's turbulence). */
  percent?: boolean;
  /** Blank is refused: the table needs this key. */
  required?: boolean;
  /** The evaluated value in SI (angles in radians), or a fraction for `percent`. */
  read: (s: EvalSim) => number;
}

export interface ChoiceField extends FieldBase {
  kind: "choice";
  options: readonly string[];
  labels: Readonly<Record<string, string>>;
  read: (s: EvalSim) => string;
}

export type SimField = NumberField | ChoiceField;

const RAD = Math.PI / 180;
/** The evaluated conditions state angles in degrees; a field's display unit converts from radians. */
const rad = (deg: number): number => deg * RAD;

export const SIM_FIELDS: readonly SimField[] = [
  { key: "launch.rail_length", label: "Rail length", group: "Launch", kind: "number", dim: "length:m", step: 0.1, required: true, read: (s) => s.conditions.rail_length_m },
  { key: "launch.rod_angle", label: "Rail angle", group: "Launch", kind: "number", dim: "angle:deg", step: 1, title: "Tilt from vertical", read: (s) => rad(s.conditions.rod_angle_deg) },
  { key: "launch.rod_direction", label: "Rail direction", group: "Launch", kind: "number", dim: "angle:deg", step: 1, title: "Azimuth, clockwise from north", read: (s) => rad(s.conditions.rod_direction_deg) },
  { key: "launch.latitude", label: "Latitude", group: "Site", kind: "number", dim: "angle:deg", step: 0.1, read: (s) => rad(s.conditions.latitude_deg) },
  { key: "launch.longitude", label: "Longitude", group: "Site", kind: "number", dim: "angle:deg", step: 0.1, read: (s) => rad(s.conditions.longitude_deg) },
  { key: "launch.altitude", label: "Elevation", group: "Site", kind: "number", dim: "length:m", step: 1, read: (s) => s.conditions.site_altitude_m },
  { key: "wind.speed", label: "Speed", group: "Wind", kind: "number", dim: "velocity", step: 0.1, required: true, read: (s) => s.conditions.wind_speed_ms },
  { key: "wind.direction", label: "Direction", group: "Wind", kind: "number", dim: "angle:deg", step: 1, title: "Where the wind blows from, clockwise from north", read: (s) => rad(s.conditions.wind_direction_deg) },
  { key: "wind.turbulence", label: "Turbulence", group: "Wind", kind: "number", dim: "dimensionless", step: 1, percent: true, read: (s) => s.conditions.wind_turbulence },
  { key: "atmosphere.base_temperature", label: "Temperature", group: "Atmosphere", kind: "number", dim: "temperature", step: 1, title: "Sea-level base temperature", read: (s) => s.conditions.base_temperature_k },
  { key: "atmosphere.base_pressure", label: "Pressure", group: "Atmosphere", kind: "number", dim: "pressure:hPa", step: 1, title: "Sea-level base pressure", read: (s) => s.conditions.base_pressure_pa },
  { key: "atmosphere.model", label: "Model", group: "Atmosphere", kind: "choice", options: ["ussa1976", "isa_custom"], labels: { ussa1976: "USSA 1976", isa_custom: "ISA (custom base)" }, read: (s) => s.conditions.atmosphere },
  { key: "integrator.dt", label: "Time step", group: "Solver", kind: "number", dim: "time:s", step: 0.01, title: "Fixed step (RK4), or the initial and largest step (adaptive)", read: (s) => s.conditions.time_step_s },
  { key: "integrator.max_time", label: "Max time", group: "Solver", kind: "number", dim: "time:s", step: 1, title: "Longest flight the solver will simulate", read: (s) => s.max_time },
  { key: "integrator.method", label: "Integrator", group: "Solver", kind: "choice", options: ["dp54", "rk4"], labels: { dp54: "Adaptive (DP54)", rk4: "Fixed step (RK4)" }, read: (s) => s.conditions.integrator },
];

const UNITS = "m" as const;

/** The unit shown beside a number. */
export const fieldUnit = (f: NumberField): string => (f.percent === true ? "%" : displayUnit(f.dim, UNITS).unit);

/** USSA 1976 fixes its own base state, so these two do nothing under it. */
export const appliesToModel = (key: string, model: string): boolean => model !== "ussa1976" || (key !== "atmosphere.base_temperature" && key !== "atmosphere.base_pressure");

const sectionOf = (f: SimField): SimSection => f.key.split(".")[0] as SimSection;
const leafOf = (f: SimField): string => f.key.split(".")[1]!;

/** The sections a sim file writes on every Save, and the key each one needs. */
const SECTIONS: readonly { section: SimSection; required: string; always: boolean }[] = [
  { section: "launch", required: "rail_length", always: true },
  { section: "wind", required: "speed", always: true },
  { section: "atmosphere", required: "model", always: true },
  // Absent means the engine's solver defaults; only an edit writes it.
  { section: "integrator", required: "method", always: false },
];

export interface SimForm {
  sim: string;
  values: Record<string, string>;
  /** What the model holds, so a field left alone is never rewritten. */
  baseline: Record<string, string>;
  /** Configuration the sim flies. */
  config: string;
  baseConfig: string;
}

function shown(f: SimField, s: EvalSim): string {
  const v = f.read(s);
  if (f.kind === "choice") return v as string;
  if (f.percent === true) return String(Number(((v as number) * 100).toPrecision(10)));
  return toDisplay(v as number, f.dim, UNITS);
}

export function formFromSim(s: EvalSim): SimForm {
  const values: Record<string, string> = {};
  for (const f of SIM_FIELDS) values[f.key] = shown(f, s);
  return { sim: s.id, values, baseline: { ...values }, config: s.config, baseConfig: s.config };
}

const dirtyKeys = (f: SimForm): string[] => SIM_FIELDS.filter((d) => (f.values[d.key] ?? "").trim() !== (f.baseline[d.key] ?? "").trim()).map((d) => d.key);

export const isFormDirty = (f: SimForm): boolean => dirtyKeys(f).length > 0 || f.config !== f.baseConfig;

/** Why each field's text cannot be saved. */
export function validateForm(f: SimForm): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const d of SIM_FIELDS) {
    if (d.kind !== "number") continue;
    const text = (f.values[d.key] ?? "").trim();
    if (text === "") {
      if (d.required === true) errors[d.key] = `${d.label} needs a number.`;
    } else if (!Number.isFinite(Number(text))) errors[d.key] = `${d.label} needs a number.`;
  }
  return errors;
}

function literal(d: SimField, text: string): string | number {
  if (d.kind === "choice") return text;
  const n = Number(text);
  return d.percent === true ? Number((n / 100).toPrecision(10)) : toSource(n, d.dim, UNITS);
}

/**
 * The patch a Save makes. Rail, wind and atmosphere are always written, so
 * the sim file states them even when the person accepted every default (D23);
 * the solver only when it is edited.
 */
export function conditionsOps(f: SimForm, simFile: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const dirty = new Set(dirtyKeys(f));
  const base = `/sims/${f.sim}`;
  if (f.config !== f.baseConfig) ops.push({ op: "replace", path: `${base}/config`, value: f.config });
  for (const { section, required, always } of SECTIONS) {
    const fields = SIM_FIELDS.filter((d) => sectionOf(d) === section);
    const source = fileTable(simFile, [section]);
    if (source === null) {
      if (!always && !fields.some((d) => dirty.has(d.key))) continue;
      const value: Record<string, string | number> = {};
      for (const d of fields) {
        const text = (f.values[d.key] ?? "").trim();
        if (text !== "" && (leafOf(d) === required || dirty.has(d.key))) value[leafOf(d)] = literal(d, text);
      }
      ops.push({ op: "add", path: `${base}/${section}`, value: value as never });
      continue;
    }
    for (const d of fields) {
      if (!dirty.has(d.key)) continue;
      const leaf = leafOf(d);
      const path = `${base}/${section}/${leaf}`;
      const text = (f.values[d.key] ?? "").trim();
      if (text === "") {
        if (source[leaf] !== undefined) ops.push({ op: "remove", path });
      } else {
        ops.push({ op: source[leaf] === undefined ? "add" : "replace", path, value: literal(d, text) as never });
      }
    }
  }
  return ops;
}

/** The field a `/sims/<id>/<section>/<leaf>` diagnostic belongs to. */
export function fieldKeyOfPath(sim: string, path: string | null | undefined): string | null {
  const prefix = `/sims/${sim}/`;
  if (path == null || !path.startsWith(prefix)) return null;
  const key = path.slice(prefix.length).replace("/", ".");
  return SIM_FIELDS.some((d) => d.key === key) ? key : null;
}

export interface FieldProblems {
  fields: Record<string, string>;
  /** Errors on this sim no field shows. */
  other: string[];
}

/** Sorts a sim's error diagnostics onto its fields. */
export function fieldProblems(sim: string, diagnostics: readonly Diagnostic[]): FieldProblems {
  const out: FieldProblems = { fields: {}, other: [] };
  for (const d of diagnostics) {
    if (d.severity !== "error" || d.path == null || !d.path.startsWith(`/sims/${sim}/`)) continue;
    const key = fieldKeyOfPath(sim, d.path);
    if (key !== null) out.fields[key] ??= d.message;
    else out.other.push(d.message);
  }
  return out;
}

/** `Simulation 1`, the first number no sim has taken. */
export function nextSimName(sims: readonly { name: string }[]): string {
  const taken = new Set(sims.map((s) => s.name.toLowerCase()));
  for (let i = sims.length + 1; ; i++) if (!taken.has(`simulation ${i}`)) return `Simulation ${i}`;
}
