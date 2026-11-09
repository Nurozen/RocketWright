/** Patch ops for simulations (`/sims/<id>`, one `sims/<id>.rw.toml` file each). */
import type { PatchOp, schema } from "@rw/contracts";
import { uniqueId } from "./ids.ts";

/** A flight sim of `config`; conditions left out take the engine defaults. */
export function newSimOps(name: string, config: string, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "sim");
  const value: schema.SimDoc = { name, config };
  return { id, ops: [{ op: "add", path: `/sims/${id}`, value: value as never }] };
}

/**
 * A visual flow study of `engine` on `config`. A scripted tilt needs no flight
 * to replay; duration, tilt, swing, period and tank take the engine defaults.
 */
export function newStudyOps(name: string, config: string, engine: string, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "study");
  const value: schema.SimDoc = { name, config, kind: "visual_flow", visual_flow: { engine, attitude: "scripted_tilt" } };
  return { id, ops: [{ op: "add", path: `/sims/${id}`, value: value as never }] };
}

export function nextStudyName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let i = names.length + 1; ; i++) if (!taken.has(`study ${i}`)) return `Study ${i}`;
}

/** A new, not-yet-run sim with the source's definition (runs stay with the source). */
export function duplicateSimOps(sourceId: string, name: string, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "sim");
  return {
    id,
    ops: [
      { op: "copy", from: `/sims/${sourceId}`, path: `/sims/${id}` },
      { op: "add", path: `/sims/${id}/name`, value: name },
    ],
  };
}

/** Renames in place: the id keeps `runs/<sim>/` attached. `add` because `name` is optional. */
export function renameSimOps(id: string, name: string): PatchOp[] {
  return [{ op: "add", path: `/sims/${id}/name`, value: name }];
}

export function deleteSimOps(id: string): PatchOp[] {
  return [{ op: "remove", path: `/sims/${id}` }];
}
