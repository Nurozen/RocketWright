/**
 * Where a new part can go: which existing parts can hold it, and at which of
 * their anchors. Containment comes from the generated `CONTAINMENT` table, the
 * same rules `crates/rw-model/src/containment.rs` enforces, so an added part
 * never fails on placement; the WASM test in `attach-targets.test.ts` holds the
 * two together. The palette picks only the parent and a sensible place on it;
 * the rest is the Position tab's job.
 */
import { CONTAINMENT, containmentAllowed, containmentCanBeRoot, containmentParents, type schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import type { PartKind } from "../../state/ops/parts.ts";

type Part = DeepReadonly<schema.EvalComponent>;

/** The containment a kind takes against the anchors the palette uses. */
const naturalKind = (kind: PartKind) => CONTAINMENT.natural_kind[kind];

/** Kinds that may be the first part of a rocket. A nose cone has no anchor to attach to, so it can only start one. */
export const ROOT_KINDS: readonly PartKind[] = CONTAINMENT.kinds.filter(containmentCanBeRoot);

/** Kinds the table lets hold another part, and the body kinds that stack end to end. */
const HOLDERS: ReadonlySet<string> = new Set(CONTAINMENT.kinds.flatMap((kind) => containmentParents(kind, naturalKind(kind))));
const BODY: ReadonlySet<string> = new Set(containmentParents("body_tube", naturalKind("body_tube")));

const FINS: ReadonlySet<string> = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set"]);
const LUGS: ReadonlySet<string> = new Set(["launch_lug", "rail_button"]);

/** Can `parent` hold `kind` at all? */
const canHold = (parent: PartKind, kind: PartKind): boolean => containmentAllowed(parent, kind, naturalKind(kind));

/** True when no part can hold `kind`, so it can only start the rocket. */
export const onlyStartsRocket = (kind: PartKind): boolean => containmentParents(kind, naturalKind(kind)).length === 0;

interface Placement {
  to: string;
  /** Own anchor set against it, when the mirrored default would be wrong. */
  at?: string;
}

/** Anchors to try on the parent, best first. */
function placements(kind: PartKind): readonly Placement[] {
  // Fins end flush with the tail; the default would hang them off the end.
  if (kind === "tube_fin_set") return [{ to: "aft", at: "aft" }, { to: "base", at: "aft" }];
  if (FINS.has(kind)) return [{ to: "aft", at: "root_te" }, { to: "base", at: "root_te" }];
  if (LUGS.has(kind)) return [{ to: "mid" }, { to: "aft" }, { to: "base" }];
  // A motor tube belongs at the tail.
  if (kind === "inner_tube") return [{ to: "aft", at: "aft" }, { to: "inner" }];
  if (kind === "body_tube" || kind === "transition") return [{ to: "aft" }, { to: "base" }];
  return [{ to: "inner" }];
}

/** Where `kind` attaches on `parent`, or null when `parent` cannot hold it. */
export function attachmentFor(kind: PartKind, parent: Part): schema.Attach | null {
  if (!canHold(parent.shape.type as PartKind, kind)) return null;
  const has = new Set(parent.anchors.map((a) => a.name));
  const place = placements(kind).find((p) => has.has(p.to));
  if (place === undefined) return null;
  return { to: `${parent.id}.${place.to}`, ...(place.at !== undefined ? { at: place.at } : {}) } as schema.Attach;
}

/** Parts the palette can attach to: any that can hold something. */
export function parentChoices(components: readonly Part[]): Part[] {
  return components.filter((c) => HOLDERS.has(c.shape.type));
}

/** The selected part when it can hold parts, else the last body part (the tail of the stack). */
export function defaultParent(components: readonly Part[], selected: readonly string[]): Part | null {
  const choices = parentChoices(components);
  return choices.find((c) => selected.includes(c.id)) ?? choices.filter((c) => BODY.has(c.shape.type)).at(-1) ?? choices[0] ?? null;
}
