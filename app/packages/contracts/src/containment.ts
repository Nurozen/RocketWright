/**
 * Placement checks over the generated `CONTAINMENT` table (R2.1). Mirrors
 * `crates/rw-model/src/containment.rs`; `schema/testdata/containment.json`
 * holds the two together.
 */
import { CONTAINMENT } from "./generated/containment.ts";
import type { AnchorKind, ComponentType } from "./generated/types.ts";

/** True when `child` may sit in `parent` with containment `kind`. */
export function containmentAllowed(parent: ComponentType, child: ComponentType, kind: AnchorKind): boolean {
  return CONTAINMENT.rules.some((r) => r.kind === kind && r.parents.includes(parent) && r.children.includes(child));
}

/** Every type that may hold `child` with containment `kind`, in component-type order. */
export function containmentParents(child: ComponentType, kind: AnchorKind): ComponentType[] {
  return CONTAINMENT.kinds.filter((parent) => containmentAllowed(parent, child, kind));
}

/** True when the type may be the first component. */
export function containmentCanBeRoot(kind: ComponentType): boolean {
  return CONTAINMENT.roots.includes(kind);
}
