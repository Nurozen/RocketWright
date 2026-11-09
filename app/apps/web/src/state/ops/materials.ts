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
