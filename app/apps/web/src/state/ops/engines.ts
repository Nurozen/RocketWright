/** Patch ops for liquid engines (`/engines/<id>`, one `engines/<id>.rw.toml` file each). */
import type { EvaluatedModel, PatchOp, schema } from "@rw/contracts";
import type { DeepReadonly } from "../types.ts";
import { uniqueId } from "./ids.ts";

/** The schema's required inputs, on a shipped propellant pair; the rest report as missing inputs. */
export function newEngineOps(name: string, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "engine");
  const value: schema.EngineDoc = {
    name,
    propellants: { oxidizer: "n2o", fuel: "ethanol" },
    mixture_ratio: 4,
    chamber_pressure: "20 bar",
    thrust: "1.5 kN",
  };
  return { id, ops: [{ op: "add", path: `/engines/${id}`, value: value as never }] };
}

export function duplicateEngineOps(sourceId: string, name: string, taken: Iterable<string>): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, taken, "engine");
  return {
    id,
    ops: [
      { op: "copy", from: `/engines/${sourceId}`, path: `/engines/${id}` },
      { op: "add", path: `/engines/${id}/name`, value: name },
    ],
  };
}

/** `add` because `name` is optional. */
export function renameEngineOps(id: string, name: string): PatchOp[] {
  return [{ op: "add", path: `/engines/${id}/name`, value: name }];
}

/**
 * Removes the engine, every motor assignment that fires it, and the visual
 * studies of it (`visual_flow.engine` is required, so a study cannot outlive
 * its engine).
 */
export function deleteEngineOps(evaluated: DeepReadonly<Pick<EvaluatedModel, "configs" | "sims">>, id: string): PatchOp[] {
  const ops: PatchOp[] = [{ op: "remove", path: `/engines/${id}` }];
  for (const cfg of Object.values(evaluated.configs)) {
    for (const m of cfg?.motors ?? []) if (m.engine === id) ops.push({ op: "remove", path: `/configs/${cfg!.id}/motors/${m.mount}` });
  }
  for (const sim of Object.values(evaluated.sims)) {
    if (sim?.visual_flow?.engine === id) ops.push({ op: "remove", path: `/sims/${sim.id}` });
  }
  return ops;
}
