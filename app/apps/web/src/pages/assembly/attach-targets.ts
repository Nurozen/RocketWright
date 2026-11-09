/**
 * Where a new part can go: which existing parts can hold it, and at which of
 * their anchors. A strict subset of what `crates/rw-model/src/attach.rs` and
 * `containment.rs` accept, so an added part never fails on placement; the
 * WASM test in `attach-targets.test.ts` holds the two together. The palette
 * picks only the parent and a sensible place on it; the rest is the Position
 * tab's job.
 */
import type { schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import type { PartKind } from "../../state/ops/parts.ts";

type Part = DeepReadonly<schema.EvalComponent>;

/** Kinds that may be the first part of a rocket. A nose cone has no anchor to attach to, so it can only start one. */
export const ROOT_KINDS: readonly PartKind[] = ["nose_cone", "body_tube", "transition"];

const BODY: ReadonlySet<string> = new Set(ROOT_KINDS);
const CONTAINERS: ReadonlySet<string> = new Set([...ROOT_KINDS, "coupler", "inner_tube"]);
const FINS: ReadonlySet<string> = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set"]);
const LUGS: ReadonlySet<string> = new Set(["launch_lug", "rail_button"]);

/** `containment.rs` RULES: can `parent` hold `kind` at all? */
function canHold(parent: string, kind: PartKind): boolean {
  if (kind === "nose_cone") return false;
  if (kind === "body_tube" || kind === "transition" || FINS.has(kind) || LUGS.has(kind)) return BODY.has(parent);
  if (kind === "tank") return parent === "body_tube" || parent === "coupler";
  return CONTAINERS.has(parent);
}

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
  if (!canHold(parent.shape.type, kind)) return null;
  const has = new Set(parent.anchors.map((a) => a.name));
  const place = placements(kind).find((p) => has.has(p.to));
  if (place === undefined) return null;
  return { to: `${parent.id}.${place.to}`, ...(place.at !== undefined ? { at: place.at } : {}) } as schema.Attach;
}

/** Parts the palette can attach to: any that can hold something. */
export function parentChoices(components: readonly Part[]): Part[] {
  return components.filter((c) => CONTAINERS.has(c.shape.type));
}

/** The selected part when it can hold parts, else the last body part (the tail of the stack). */
export function defaultParent(components: readonly Part[], selected: readonly string[]): Part | null {
  const choices = parentChoices(components);
  return choices.find((c) => selected.includes(c.id)) ?? choices.filter((c) => BODY.has(c.shape.type)).at(-1) ?? choices[0] ?? null;
}
