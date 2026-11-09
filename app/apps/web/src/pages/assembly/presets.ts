/**
 * Catalog parts (R2.1). `library.search` returns a preset as source-form part
 * fields plus a `preset` block that is not a part field; a preset becomes a
 * part only with that block removed, the materials it uses defined in the
 * project (parts name materials by key, and only the project's map is looked
 * up), and any field a catalog does not record filled in.
 */
import type { PatchOp, schema } from "@rw/contracts";
import { type DeepReadonly } from "../../state/index.ts";
import { uniqueId } from "../../state/ops/ids.ts";
import { defaultPart, PART_KINDS, uniquePartName, type PartKind } from "../../state/ops/parts.ts";
import { editorFields } from "../../ui/fields/index.ts";

type Part = DeepReadonly<schema.EvalComponent>;
type LibItem = DeepReadonly<schema.LibItem>;

export interface PresetInfo {
  manufacturer: string;
  partNumber: string;
  description: string;
  /** The materials the part uses, by the key its fields name. */
  materials: Readonly<Record<string, schema.Material>>;
  /** Required fields the catalog does not record. */
  needs: readonly string[];
}

/** The part kind of a preset, or null if the item is not a part. */
export function presetKind(item: LibItem): PartKind | null {
  const type = item.data["type"];
  return typeof type === "string" && (PART_KINDS as readonly string[]).includes(type) ? (type as PartKind) : null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function presetInfo(item: LibItem): PresetInfo {
  const block = (item.data["preset"] ?? {}) as Record<string, unknown>;
  return {
    manufacturer: text(block["manufacturer"]),
    partNumber: text(block["part_number"]),
    description: text(block["description"]),
    materials: (block["materials"] ?? {}) as Record<string, schema.Material>,
    needs: Array.isArray(block["needs"]) ? block["needs"].filter((n): n is string => typeof n === "string") : [],
  };
}

export interface NewPreset {
  item: LibItem;
  /** Part ids in use (`/c` keys). */
  takenIds: Iterable<string>;
  /** Part names in use. */
  takenNames: Iterable<string>;
  /** Material keys the project already defines; those keep the project's definition. */
  materials: Iterable<string>;
  /** Parent anchor; absent only for the first body component. */
  attach?: schema.Attach;
}

/** The patch that adds `item` as a new part: its materials first, then the part. */
export function addPresetOps({ item, takenIds, takenNames, materials, attach }: NewPreset): { id: string; name: string; ops: PatchOp[] } {
  const kind = presetKind(item);
  if (kind === null) throw new Error(`${item.name} is not a part.`);
  const { preset: _block, ...fields } = item.data;
  const info = presetInfo(item);
  const defaults = defaultPart(kind) as unknown as Record<string, unknown>;
  const needed = Object.fromEntries(info.needs.map((key) => [key, defaults[key]]));
  const name = uniquePartName(item.name, takenNames);
  const id = uniqueId(name, takenIds, "part");
  const defined = new Set(materials);
  const ops: PatchOp[] = Object.entries(info.materials)
    .filter(([key]) => !defined.has(key))
    .map(([key, material]) => ({ op: "add", path: `/materials/${key}`, value: material as never }));
  const value = { ...fields, ...needed, name, ...(attach !== undefined ? { attach } : {}) };
  ops.push({ op: "add", path: `/c/${id}`, value: value as never });
  return { id, name, ops };
}

/** `add`, not `replace`: a field the part does not have written yet would otherwise fail the whole patch. */
export function presetGeometryOps(item: LibItem, part: Part): PatchOp[] {
  const keys = new Set(editorFields(part.shape.type).filter((f) => f.tab === "Geometry").map((f) => f.key.split(".")[0]!));
  return Object.entries(item.data)
    .filter(([key, value]) => keys.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => ({ op: "add", path: `/c/${part.id}/${key}`, value: value as never }));
}

/** A field a preset leaves for the user, in the words the row shows. */
export const needLabel = (key: string): string => (key === "cd" ? "Cd" : key.replace(/_/g, " "));
