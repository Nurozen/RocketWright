/** Patch ops for project materials (`[materials.<id>]`). */
import type { PatchOp, schema } from "@rw/contracts";
import { uniqueId } from "./ids.ts";

/**
 * A new project material. Picking a library material goes through here too
 * (D15): parts name materials by key, and only the project's map is looked up.
 */
export function addMaterialOps(name: string, material: schema.Material, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "material");
  return { id, ops: [{ op: "add", path: `/materials/${id}`, value: material as never }] };
}

/** Replaces the entry whole, so a density kind the form cleared is gone. */
export function setMaterialOps(id: string, material: schema.Material): PatchOp[] {
  return [{ op: "replace", path: `/materials/${id}`, value: material as never }];
}

/** A material no part names (`MaterialsPanel` checks; an unknown name would be an error on the part). */
export function deleteMaterialOps(id: string): PatchOp[] {
  return [{ op: "remove", path: `/materials/${id}` }];
}

/** One step: the entry moves to its new key and every reference (`usePaths`, from `materialUses`) follows it. */
export function renameMaterialOps(from: string, to: string, material: schema.Material, usePaths: readonly string[]): PatchOp[] {
  return [{ op: "add", path: `/materials/${to}`, value: material as never }, { op: "remove", path: `/materials/${from}` }, ...usePaths.map((path): PatchOp => ({ op: "replace", path, value: to as never }))];
}
