/**
 * Schema-driven editor fields (M2.9, R2.11): the component-type parameter
 * schema (`schema/rocket.json`, the same JSON Schema the Rust types emit, I3)
 * plus its `x-` metadata (`SCHEMA_META`: `x-unit-dimension`, `x-ui-group`,
 * `x-expr`) decide which fields a component shows, on which editor tab, with
 * which unit, limits, and default. Display units follow the toolbar Units
 * (length) and fixed SI-friendly units for the rest (g, deg).
 */
import { SCHEMA_META } from "@rw/contracts";
import rocketSchema from "../../../../../../schema/rocket.json";
import type { Units } from "../../state/index.ts";
import { displayUnit, parseLiteral, toDisplay } from "./units.ts";

export const EDITOR_TABS = ["Geometry", "Material", "Appearance", "Mass override"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export type FieldKind = "quantity" | "integer" | "number" | "enum" | "bool";

export interface FieldSpec {
  /** Dotted source path under `c.<id>` (`span`, `override.mass`, `appearance.preset`). */
  key: string;
  label: string;
  tab: EditorTab;
  /** `x-ui-group` of the field (or of its type). */
  group: string;
  kind: FieldKind;
  /** `x-unit-dimension` (quantity fields). */
  dim?: string;
  /** Schema limits in SI (quantities) or plain numbers. */
  min?: number;
  max?: number;
  default?: number | string | boolean;
  options?: readonly string[];
  required: boolean;
  /** `x-expr`: accepts `=` expressions. */
  expr: boolean;
  doc?: string;
  /** The nested group this field lives in (`shoulder`); the key is then `<parent>.<leaf>`. */
  parent?: string;
}

/** A nested optional table a part edits as one unit: all of it exists, or only its Add button does. */
export interface FieldGroup {
  key: string;
  /** Visible heading, and the group's accessible name. */
  heading: string;
  /** The button that writes the whole group. */
  add: string;
  fields: FieldSpec[];
}

/** Nested tables the editor groups, by source key. Each one's required members are all fields it can render. */
const GROUP_HEADINGS: Record<string, string> = {
  shoulder: "Shoulder",
  fore_shoulder: "Fore shoulder",
  aft_shoulder: "Aft shoulder",
  tab: "Fin tab",
};

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  $ref?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
  "x-unit-dimension"?: string;
  "x-ui-group"?: string;
  "x-expr"?: boolean;
};

const DEFS = (rocketSchema as { $defs: Record<string, JsonSchema> }).$defs;

/** Whether `key` is stored on the component itself rather than its shape (`override`, `material`, `attach`). */
export function isComponentField(key: string): boolean {
  return DEFS["Component"]?.properties?.[key] !== undefined;
}

/** Field labels the plain humanized key would get wrong. */
const LABELS: Record<string, string> = {
  od: "Outer diameter",
  id: "Inner diameter",
  cd: "Drag coefficient",
  shape_param: "Shape parameter",
  line_count: "Shroud lines",
  line_length: "Line length",
  spill_hole: "Spill hole",
  fillet_radius: "Fillet radius",
  cross_section: "Cross section",
  "override.mass": "Mass",
  "override.cg": "CG override",
  "override.cd": "Drag override",
  "appearance.preset": "Appearance",
  motor_mount: "Motor mount",
};

const FIN_TYPES = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set"]);

export function fieldLabel(key: string, type?: string): string {
  if (key === "count" && type !== undefined && FIN_TYPES.has(type)) return "Fin count";
  if (key === "count") return "Count";
  const l = LABELS[key];
  if (l !== undefined) return l;
  const last = key.split(".").at(-1)!;
  return (LABELS[last] ?? last.replace(/_/g, " ")).replace(/^./, (c) => c.toUpperCase());
}

/** Resolves `$ref` / nullable `anyOf` wrappers to the field's own schema. */
function unwrap(s: JsonSchema): JsonSchema {
  if (s.$ref !== undefined) return { ...unwrap(DEFS[s.$ref.replace("#/$defs/", "")] ?? {}), ...withoutRef(s) };
  if (s.anyOf !== undefined) {
    const branches = s.anyOf.filter((b) => !(b.type === "null"));
    if (branches.length === 1) return { ...unwrap(branches[0]!), ...withoutAnyOf(s) };
    // A quantity: `string (pattern) | const 0`, with the x- metadata on the wrapper.
    return s;
  }
  return s;
}
const withoutRef = ({ $ref: _r, ...rest }: JsonSchema): JsonSchema => rest;
const withoutAnyOf = ({ anyOf: _a, ...rest }: JsonSchema): JsonSchema => rest;

function kindOf(s: JsonSchema): FieldKind | null {
  if (s["x-unit-dimension"] !== undefined) return s["x-unit-dimension"] === "dimensionless" ? "number" : "quantity";
  if (s.enum !== undefined) return "enum";
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null") : s.type !== undefined ? [s.type] : [];
  if (t.includes("integer")) return "integer";
  if (t.includes("number")) return "number";
  if (t.includes("boolean")) return "bool";
  return null;
}

function spec(key: string, raw: JsonSchema, tab: EditorTab, group: string, required: boolean, type: string): FieldSpec | null {
  const s = unwrap(raw);
  const kind = kindOf(s);
  if (kind === null) return null;
  const out: FieldSpec = { key, label: fieldLabel(key, type), tab, group, kind, required, expr: s["x-expr"] === true };
  if (s["x-unit-dimension"] !== undefined) out.dim = s["x-unit-dimension"];
  if (s.minimum !== undefined) out.min = s.minimum;
  if (s.maximum !== undefined) out.max = s.maximum;
  if (s.default !== undefined && (typeof s.default === "number" || typeof s.default === "string" || typeof s.default === "boolean")) out.default = s.default;
  if (s.enum !== undefined) out.options = s.enum;
  if (s.description !== undefined) out.doc = s.description;
  return out;
}

/** The generated type (`$defs` name) of a component kind. */
export function typeDef(type: string): string | null {
  return SCHEMA_META["Component"]?.variants?.[type]?.ref ?? null;
}

/**
 * Editor fields for a component kind, by tab. Geometry: the kind's own
 * scalar fields (required first, schema order; `count` last), then the fields
 * of its nested groups (`shoulder`, `tab`) with `parent` set; `groupsOf` frames
 * those. Material: `material`, `finish`. Appearance: the PBR preset. Mass
 * override: `override.mass`, `override.cg`.
 */
export function editorFields(type: string): FieldSpec[] {
  const ref = typeDef(type);
  const def = ref !== null ? DEFS[ref] : undefined;
  const out: FieldSpec[] = [];
  if (def?.properties !== undefined) {
    const group = def["x-ui-group"] ?? SCHEMA_META[ref!]?.uiGroup ?? "Geometry";
    const req = new Set(def.required ?? []);
    const geo: FieldSpec[] = [];
    const nested: FieldSpec[] = [];
    for (const [key, raw] of Object.entries(def.properties)) {
      if (GROUP_HEADINGS[key] !== undefined) {
        const sub = unwrap(raw);
        const required = new Set(sub.required ?? []);
        for (const [leaf, rawLeaf] of Object.entries(sub.properties ?? {})) {
          const f = spec(`${key}.${leaf}`, rawLeaf, "Geometry", GROUP_HEADINGS[key]!, required.has(leaf), type);
          if (f !== null) nested.push({ ...f, parent: key });
        }
        continue;
      }
      if (raw["x-ui-group"] !== undefined && raw["x-ui-group"] !== group) continue; // groups the editor does not show yet (Packed, Motor)
      const f = spec(key, raw, "Geometry", group, req.has(key), type);
      if (f !== null) geo.push(f);
    }
    // Required fields first (schema order), counts after the dimensions (concept 02: Fin count last).
    const rank = (f: FieldSpec) => (f.required ? 0 : 2) + (f.kind === "integer" ? 1 : 0);
    out.push(...geo.map((f, i) => [f, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f), ...nested);
  }
  const comp = DEFS["Component"]?.properties ?? {};
  const finish = comp["finish"];
  out.push({ key: "material", label: "Material", tab: "Material", group: "Material", kind: "enum", required: false, expr: false });
  if (finish !== undefined) {
    const presets = DEFS["FinishPreset"]?.enum ?? [];
    out.push({ key: "finish", label: "Finish", tab: "Material", group: "Material", kind: "enum", options: presets, required: false, expr: false });
  }
  const appearance = DEFS["AppearancePreset"]?.enum ?? [];
  out.push({ key: "appearance.preset", label: "Appearance", tab: "Appearance", group: "Appearance", kind: "enum", options: appearance, required: false, expr: false });
  const ov = DEFS["Overrides"]?.properties ?? {};
  for (const k of ["mass", "cg"] as const) {
    const f = ov[k] !== undefined ? spec(`override.${k}`, ov[k]!, "Mass override", "Mass", false, type) : null;
    if (f !== null) out.push(f);
  }
  return out;
}

/** The nested groups among `fields`, in field order. */
export function groupsOf(fields: readonly FieldSpec[]): FieldGroup[] {
  const groups = new Map<string, FieldGroup>();
  for (const f of fields) {
    if (f.parent === undefined) continue;
    const heading = GROUP_HEADINGS[f.parent] ?? fieldLabel(f.parent);
    const group = groups.get(f.parent) ?? { key: f.parent, heading, add: `Add ${heading.toLowerCase()}`, fields: [] };
    group.fields.push(f);
    groups.set(f.parent, group);
  }
  return [...groups.values()];
}

/** The name a change to `f` goes by outside its group, where the group heading is not in sight. */
export function changeLabel(f: FieldSpec): string {
  if (f.parent === undefined) return f.label;
  return `${GROUP_HEADINGS[f.parent] ?? fieldLabel(f.parent)} ${f.label.toLowerCase()}`;
}

/** Tabs a selection can edit: a mixed-kind selection edits only Appearance (concepts.md §4.2). */
export function tabsFor(types: readonly string[]): EditorTab[] {
  if (types.length === 0) return [];
  return new Set(types).size > 1 ? ["Appearance"] : [...EDITOR_TABS];
}

/** Fields every selected kind shares (multi-select edits shared parameters). */
export function sharedFields(types: readonly string[]): FieldSpec[] {
  if (types.length === 0) return [];
  const [first, ...rest] = types;
  const mixed = rest.some((t) => t !== first);
  const fields = editorFields(first!);
  return mixed ? fields.filter((f) => f.tab === "Appearance") : fields;
}

export interface Limits {
  /** SI limits (quantities) or plain numbers. */
  min?: number;
  max?: number;
  /** Spinner step in display units. */
  step: number;
  /** Where the limits come from (shown in the validation message). */
  source: "schema" | "param" | "none";
}

/** Limits of a field: the param's `min`/`max`/`step` when the field references one, else the schema's. */
export function limitsOf(f: FieldSpec, param: { min?: string; max?: string; step?: string } | null, units: Units): Limits {
  const u = displayUnit(f.dim, units);
  const step = f.kind === "integer" ? 1 : (u.step ?? (u.unit === "mm" || u.unit === "g" || u.unit === "deg" ? 1 : u.unit === "cm" ? 0.1 : u.unit === "in" ? 0.05 : u.unit === "m" ? 0.001 : 0.01));
  if (param !== null) {
    const min = parseLiteral(param.min);
    const max = parseLiteral(param.max);
    const st = parseLiteral(param.step);
    const out: Limits = { step: st !== null ? trimStep(st * u.per) : step, source: "param" };
    if (min !== null) out.min = min;
    if (max !== null) out.max = max;
    return out;
  }
  const out: Limits = { step, source: f.min !== undefined || f.max !== undefined ? "schema" : "none" };
  if (f.min !== undefined) out.min = f.min;
  if (f.max !== undefined) out.max = f.max;
  // Physical sizes are never negative; an offset is a signed distance.
  if (out.min === undefined && f.kind === "quantity" && f.dim !== "angle" && f.key.split(".").at(-1) !== "offset") out.min = 0;
  return out;
}

const trimStep = (x: number) => Number(x.toPrecision(6));

/** Why `si` is out of range (null when it is fine), in display units. */
export function rangeError(si: number, f: FieldSpec, lim: Limits, units: Units): string | null {
  const u = displayUnit(f.dim, units);
  const show = (x: number) => `${toDisplay(x, f.dim, units)}${u.unit ? ` ${u.unit}` : ""}`;
  if (!Number.isFinite(si)) return `${f.label} needs a number.`;
  if (f.kind === "integer" && !Number.isInteger(si)) return `${f.label} must be a whole number.`;
  if (lim.min !== undefined && si < lim.min - 1e-12) return `${f.label} must be at least ${show(lim.min)}.`;
  if (lim.max !== undefined && si > lim.max + 1e-12) return `${f.label} must be at most ${show(lim.max)}.`;
  // A nested required field may legitimately be 0 (a fin tab with no height); the engine's checks judge it.
  if (lim.min === 0 && si === 0 && f.required && f.parent === undefined && f.kind === "quantity") return `${f.label} must be greater than 0.`;
  return null;
}
