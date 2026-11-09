/**
 * Patch ops for parts (`/c/<id>`). `SCHEMA_META` lists the part kinds and
 * anchors but carries no defaults or required flags, so the initial values
 * below are written against `schema/rocket.json` and the limits in
 * `crates/rw-model/src/components/`. Every kind must evaluate with no errors
 * as added (`parts.test.ts` applies each through WASM).
 */
import { type EvaluatedModel, type PatchOp, SCHEMA_META, type schema } from "@rw/contracts";
import { uniqueId } from "./ids.ts";

type Component = schema.Component;
export type PartKind = Component["type"];

type PartFields = { [K in PartKind]: Omit<Extract<Component, { type: K }>, "type"> };

/**
 * Sized as parts of one 54 mm airframe, so the first parts added to an empty
 * project fit each other. `od` is explicit on rings, bulkheads and blocks: left
 * out it follows the parent's bore, and a required `id` could then exceed it.
 * No `material`: a new project may define none, and an unknown name is an error.
 */
const PART_FIELDS: PartFields = {
  nose_cone: { shape: "ogive", length: "150 mm", od: "54 mm" },
  body_tube: { length: "300 mm", od: "54 mm", id: "51 mm" },
  transition: { shape: "conical", length: "60 mm", fore_od: "54 mm", aft_od: "38 mm" },
  trapezoidal_fin_set: { count: 3, root_chord: "100 mm", tip_chord: "50 mm", span: "50 mm", sweep: "30 mm", thickness: "3 mm" },
  elliptical_fin_set: { count: 3, root_chord: "100 mm", span: "50 mm", thickness: "3 mm" },
  // Root leading edge, up and along the tip, back down to the root trailing edge.
  freeform_fin_set: {
    count: 3,
    points: [
      ["0 mm", "0 mm"],
      ["30 mm", "50 mm"],
      ["80 mm", "50 mm"],
      ["100 mm", "0 mm"],
    ],
    thickness: "3 mm",
  },
  tube_fin_set: { count: 6, length: "100 mm", od: "24 mm", id: "23 mm" },
  inner_tube: { length: "100 mm", od: "31 mm", id: "29 mm" },
  coupler: { length: "60 mm", od: "51 mm", id: "48 mm" },
  centering_ring: { length: "5 mm", od: "51 mm", id: "31 mm" },
  bulkhead: { length: "5 mm", od: "51 mm" },
  engine_block: { length: "10 mm", od: "29 mm", id: "20 mm" },
  launch_lug: { length: "50 mm", od: "7 mm", id: "6 mm" },
  rail_button: { od: "12 mm", id: "6 mm", height: "10 mm" },
  parachute: { diameter: "450 mm", cd: 0.8, packed_length: "60 mm", packed_diameter: "40 mm" },
  streamer: { length: "600 mm", width: "50 mm", packed_length: "30 mm", packed_diameter: "18 mm" },
  shock_cord: { cord_length: "1 m", packed_length: "20 mm", packed_diameter: "15 mm" },
  mass_component: { mass: "50 g", length: "30 mm" },
  tank: { length: "200 mm", od: "46 mm", wall: "2 mm", end_cap: "hemispherical" },
};

/** Every part kind the model supports, in schema order. */
export const PART_KINDS = Object.keys(SCHEMA_META["Component"]?.variants ?? {}) as PartKind[];

/** A complete, valid part of `kind` with no placement. */
export function defaultPart(kind: PartKind): Component {
  return { type: kind, ...structuredClone(PART_FIELDS[kind]) } as Component;
}

export interface NewPart {
  kind: PartKind;
  /** Ids in use (`/c` keys). */
  taken: Iterable<string>;
  /** Parent anchor; absent only for the first body component. */
  attach?: schema.Attach;
  /** Display name; the id is built from it, or from the kind when absent. */
  name?: string;
}

export function addPartOps({ kind, taken, attach, name }: NewPart): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name ?? kind, taken, "part");
  const value = { ...defaultPart(kind), ...(attach !== undefined ? { attach } : {}), ...(name !== undefined ? { name } : {}) };
  return { id, ops: [{ op: "add", path: `/c/${id}`, value: value as never }] };
}

type Part = EvaluatedModel["components"][number];

const targetOf = (p: Part): string | null => p.attach?.to.split(".")[0] ?? null;

/**
 * Copies `sourceId` and everything attached to it, directly or not (the same
 * set `rw rm --recursive` removes: attach targets, not tree parents, so a ring
 * placed against a motor tube goes with the tube). Copies inside the set attach
 * to each other. The copy of the first body component has no such place to
 * sit, so it goes on its source's aft end.
 *
 * Throws when the source cannot be copied; the message is for the user.
 */
export function duplicatePartOps(components: readonly Part[], sourceId: string): { id: string; ids: Map<string, string>; ops: PatchOp[] } {
  const source = components.find((c) => c.id === sourceId);
  if (source === undefined) throw new Error(`No part with the id ${sourceId}.`);
  if (source.attach == null && source.shape.type === "nose_cone") {
    throw new Error("A nose cone leads the rocket, so a copy would have nowhere to attach.");
  }

  const subtree = [source];
  for (const part of subtree) {
    for (const c of components) if (targetOf(c) === part.id && !subtree.includes(c)) subtree.push(c);
  }

  const taken = new Set(components.map((c) => c.id));
  const ids = new Map<string, string>();
  for (const part of subtree) {
    const id = uniqueId(part.id, taken, "part");
    taken.add(id);
    ids.set(part.id, id);
  }

  const ops: PatchOp[] = [];
  for (const part of subtree) {
    const id = ids.get(part.id)!;
    ops.push({ op: "copy", from: `/c/${part.id}`, path: `/c/${id}` });
    // `.ork` provenance names one original part; two parts must not share it.
    ops.push({ op: "add", path: `/c/${id}/import`, value: null as never });
    if (part === source) continue;
    const [target, anchor] = part.attach!.to.split(".") as [string, string];
    ops.push({ op: "replace", path: `/c/${id}/attach/to`, value: `${ids.get(target)!}.${anchor}` });
  }
  const id = ids.get(sourceId)!;
  ops.push({ op: "add", path: `/c/${id}/name`, value: `${source.name} copy` });
  if (source.attach == null) ops.push({ op: "add", path: `/c/${id}/attach`, value: { to: `${sourceId}.aft` } as never });
  return { id, ids, ops };
}
