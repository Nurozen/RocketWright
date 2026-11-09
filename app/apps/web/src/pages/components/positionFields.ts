/**
 * What the Position tab offers: the anchors a part can attach to, each named
 * the way a person reads it ("Body tube: Middle"), and the part's own anchors.
 * Containment comes from the generated table, as in the Add part palette, so
 * the list holds only places the model accepts; a target the part already has
 * stays listed, so the select shows the truth and the check explains it.
 */
import { CONTAINMENT, containmentAllowed, type schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { removalSet } from "../assembly/partOps.ts";

type Comp = DeepReadonly<schema.EvalComponent>;
type ComponentType = schema.ComponentType;

const ANCHOR_WORDS: Readonly<Record<string, string>> = {
  fore: "Fore",
  aft: "Aft",
  mid: "Middle",
  inner: "Inside",
  outer: "Outside",
  base: "Base",
  tip: "Tip",
  top: "Top",
  attach: "Attach point",
  root_le: "Root leading edge",
  root_te: "Root trailing edge",
  tip_le: "Tip leading edge",
  tip_te: "Tip trailing edge",
  tab_fore: "Tab fore",
  tab_aft: "Tab aft",
  shoulder_fore: "Shoulder fore",
  shoulder_aft: "Shoulder aft",
  motor_retainer: "Motor retainer",
};

export function anchorLabel(name: string): string {
  const fin = /^fin(\d+)$/.exec(name);
  if (fin !== null) return `Fin ${fin[1]!}`;
  return ANCHOR_WORDS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export interface Choices {
  options: string[];
  labels: Record<string, string>;
}

/** Numbers the second and later uses of a label, so two parts with one name stay two choices. */
function distinct(entries: readonly (readonly [string, string])[]): Choices {
  const seen = new Map<string, number>();
  const labels: Record<string, string> = {};
  for (const [value, label] of entries) {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    labels[value] = n === 1 ? label : `${label} (${n})`;
  }
  return { options: entries.map(([v]) => v), labels };
}

/** Every anchor the selected parts can attach to: not themselves, nothing attached to them, nothing that cannot hold them. */
export function attachChoices(all: readonly Comp[], selected: readonly Comp[], current: string | null): Choices {
  const out = new Set(selected.flatMap((c) => removalSet(all, c.id)));
  const kinds = selected.map((c) => c.shape.type as ComponentType);
  const entries: (readonly [string, string])[] = [];
  for (const part of all) {
    if (out.has(part.id)) continue;
    if (!kinds.every((k) => containmentAllowed(part.shape.type as ComponentType, k, CONTAINMENT.natural_kind[k]))) continue;
    for (const a of part.anchors) entries.push([`${part.id}.${a.name}`, `${part.name}: ${anchorLabel(a.name)}`]);
  }
  if (current !== null && !entries.some(([v]) => v === current)) {
    const [id, anchor] = current.split(".") as [string, string | undefined];
    const name = all.find((c) => c.id === id)?.name ?? id;
    entries.push([current, anchor === undefined ? name : `${name}: ${anchorLabel(anchor)}`]);
  }
  return distinct(entries);
}

/** The part's own anchors, for `attach.at`. */
export function ownAnchorChoices(part: Comp): Choices {
  return distinct(part.anchors.map((a) => [a.name, anchorLabel(a.name)] as const));
}
