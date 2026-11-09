/**
 * The pure half of the Materials panel: which density a part kind draws its
 * mass from, the form's validation, and the conversion between what a person
 * types and the source literals the model holds. Parts name materials by key,
 * and only the project's map is looked up, so a library material is copied in
 * before use (D15).
 */
import type { schema } from "@rw/contracts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { slugify } from "../../state/ops/ids.ts";
import { displayUnit, parseLiteral, toDisplay, toSource } from "../../ui/fields/index.ts";
import type { SourceScalar } from "./source.ts";

export type DensityKey = "density" | "surface_density" | "line_density";
type EvalMaterial = DeepReadonly<schema.EvalMaterial>;
type LibItem = DeepReadonly<schema.LibItem>;

export const DENSITY_FIELDS: readonly { key: DensityKey; label: string; dim: string; usedBy: string }[] = [
  { key: "density", label: "Density", dim: "density", usedBy: "Used by tubes, nose cones, fins and rings." },
  { key: "surface_density", label: "Surface density", dim: "area_density", usedBy: "Used by parachutes and streamers." },
  { key: "line_density", label: "Line density", dim: "line_density", usedBy: "Used by shock cords and shroud lines." },
];

/** What the model checks a part's material for (`density_kind` in `rw-model`); null when a part's mass is given directly. */
export function densityKeyFor(type: string): DensityKey | null {
  if (type === "parachute" || type === "streamer") return "surface_density";
  if (type === "shock_cord") return "line_density";
  return type === "mass_component" ? null : "density";
}

/**
 * The materials a part can pick. A value the part already holds stays listed
 * even when it has the wrong density, so the select shows the truth and the
 * check's message explains it.
 */
export function materialChoices(materials: Readonly<Record<string, EvalMaterial | undefined>>, key: DensityKey | null, current: string | null): string[] {
  const out = Object.keys(materials).filter((id) => key === null || materials[id]?.[key] != null);
  if (current !== null && !out.includes(current)) out.push(current);
  return out.sort();
}

/** The form's text, in display units. `id` is null until the material exists. */
export interface MaterialForm {
  id: string | null;
  name: string;
  values: Record<DensityKey, string>;
  /** The values the model holds, so a field left alone is never rewritten. */
  baseline: Record<DensityKey, string>;
  /** Tells a late answer which form it belongs to. */
  session: number;
}

export type FormErrors = Partial<Record<DensityKey | "name" | "form", string>>;

const NO_VALUES: Record<DensityKey, string> = { density: "", surface_density: "", line_density: "" };

export const displayName = (id: string): string => id.replace(/_/g, " ");

export function blankForm(session: number): MaterialForm {
  return { id: null, name: "", values: { ...NO_VALUES }, baseline: { ...NO_VALUES }, session };
}

function formOf(id: string, session: number, si: (key: DensityKey) => number | null | undefined, units: Units): MaterialForm {
  const values = { ...NO_VALUES };
  for (const f of DENSITY_FIELDS) values[f.key] = toDisplay(si(f.key), f.dim, units);
  return { id, name: displayName(id), values, baseline: { ...values }, session };
}

export function formFromEval(id: string, m: EvalMaterial, session: number, units: Units): MaterialForm {
  return formOf(id, session, (key) => m[key], units);
}

/** A form over source literals, for a library copy the evaluated model does not have yet. */
export function formFromLiterals(id: string, data: Readonly<Record<string, unknown>>, session: number, units: Units): MaterialForm {
  return formOf(id, session, (key) => parseLiteral(data[key] as SourceScalar | undefined), units);
}

/**
 * The key an existing material would move to, or null when the name still
 * means the same one. `displayName` is not reversible for a key the agent
 * wrote (`Al-6061`), so a name left as shown is never a rename.
 */
export function renamedTo(f: MaterialForm): string | null {
  if (f.id === null) return null;
  const name = f.name.trim();
  if (name === "" || name === displayName(f.id)) return null;
  const to = slugify(name, "material");
  return to === f.id ? null : to;
}

export function isDirty(f: MaterialForm): boolean {
  if (f.id === null && f.name.trim() !== "") return true;
  if (f.id !== null && (f.name.trim() === "" || renamedTo(f) !== null)) return true;
  return DENSITY_FIELDS.some((d) => f.values[d.key].trim() !== f.baseline[d.key].trim());
}

export function validateForm(f: MaterialForm, taken: ReadonlySet<string>): FormErrors {
  const errors: FormErrors = {};
  for (const d of DENSITY_FIELDS) {
    const text = f.values[d.key].trim();
    if (text === "") continue;
    const n = Number(text);
    if (!Number.isFinite(n)) errors[d.key] = `${d.label} needs a number.`;
    else if (n <= 0) errors[d.key] = `${d.label} must be greater than 0.`;
  }
  if (f.id === null && f.name.trim() !== "" && taken.has(slugify(f.name, "material"))) {
    errors.name = `This project already has a material called ${f.name.trim()}. Pick it in the list to edit it.`;
  }
  const renamed = renamedTo(f);
  if (renamed !== null && taken.has(renamed)) {
    errors.name = `This project already has a material called ${f.name.trim()}. Pick it in the list to edit it.`;
  }
  if (f.id !== null && f.name.trim() === "") errors.name = "A material needs a name.";
  if (f.id !== null && DENSITY_FIELDS.every((d) => f.values[d.key].trim() === "")) {
    errors.form = "A material needs at least one density.";
  }
  return errors;
}

/**
 * The material to write: `source` plus this form's densities. A field left
 * alone keeps its literal, so an expression or another spelling survives an
 * edit to its neighbour. Null when no density is left.
 */
export function buildMaterial(f: MaterialForm, source: Readonly<Record<string, SourceScalar>>, units: Units): schema.Material | null {
  const out: Record<string, SourceScalar> = { ...source };
  for (const d of DENSITY_FIELDS) {
    const text = f.values[d.key].trim();
    if (text === "") delete out[d.key];
    else if (text !== f.baseline[d.key].trim() || out[d.key] === undefined) out[d.key] = toSource(Number(text), d.dim, units);
  }
  return DENSITY_FIELDS.some((d) => out[d.key] !== undefined) ? (out as unknown as schema.Material) : null;
}

/** `1050 kg/m³`, each density the material defines. */
export function densitySummary(m: Readonly<Record<string, unknown>> | undefined, units: Units): string {
  if (m === undefined) return "";
  return DENSITY_FIELDS.flatMap((d) => {
    const v = m[d.key];
    const si = typeof v === "number" ? v : typeof v === "string" ? parseLiteral(v) : null;
    return si === null ? [] : [`${toDisplay(si, d.dim, units)} ${displayUnit(d.dim, units).unit}`];
  }).join(" · ");
}

/** The material's key in its library: `preset:<file>/materials/<key>` or `lib:<path>#<key>`. */
export function libraryKey(item: Pick<LibItem, "id">): string {
  const hash = item.id.lastIndexOf("#");
  if (hash !== -1) return item.id.slice(hash + 1);
  const marker = "/materials/";
  const at = item.id.lastIndexOf(marker);
  return at === -1 ? item.id : item.id.slice(at + marker.length);
}

const MATERIAL_KEYS = ["density", "surface_density", "line_density", "yield_strength", "doc"] as const;

/** A library item's `data` as a project material (D15). */
export function libraryMaterial(item: Pick<LibItem, "data">): schema.Material {
  const out: Record<string, unknown> = {};
  for (const k of MATERIAL_KEYS) {
    const v = item.data[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as schema.Material;
}
