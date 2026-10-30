/**
 * Compare marks (M2.7, R2.10 visual diff): removed red, changed amber, added
 * green, everything else dimmed. Pure helpers shared by the Compare view's
 * viewport and the `rocketwright-render` job (`rw render --compare`), so both
 * colour a part the same way from the same `CompareOut.marks`.
 */
import type { EvaluatedModel, schema } from "@rw/contracts";

export type MarkStatus = schema.MarkStatus;
export type MarkMap = Readonly<Record<string, MarkStatus>>;

/** Mark colours on the dark viewport (sRGB hex); the legend uses the same. */
export const MARK_COLORS: Record<MarkStatus, string> = {
  removed: "#e5534b",
  changed: "#e8a94a",
  added: "#4fb477",
};

/** Mark colours on the white headless canvas (`scheme: "check"`). */
export const MARK_COLORS_LIGHT: Record<MarkStatus, string> = {
  removed: "#d9453a",
  changed: "#d98e1f",
  added: "#2f9e5b",
};

/** Unmarked parts while marks are on: a flat grey at low opacity. */
export const DIM_COLOR = "#8a949a";
export const DIM_OPACITY = 0.14;
/** Unmarked parts on the white headless canvas. */
export const DIM_COLOR_LIGHT = "#d5dade";

export const MARK_ORDER: readonly MarkStatus[] = ["removed", "changed", "added"];

/** `CompareOut.marks` as id → status. */
export function markMap(marks: readonly Pick<schema.ComponentMark, "id" | "status">[]): Record<string, MarkStatus> {
  const out: Record<string, MarkStatus> = {};
  for (const m of marks) out[m.id] = m.status;
  return out;
}

/** Count per status, in legend order. */
export function markCounts(marks: MarkMap): Record<MarkStatus, number> {
  const out: Record<MarkStatus, number> = { removed: 0, changed: 0, added: 0 };
  for (const s of Object.values(marks)) out[s] += 1;
  return out;
}

/**
 * The model the compare viewport meshes: the New model plus each removed
 * component from the Old one (appended, so its station is the Old one's).
 * Tree links to removed parts are dropped from New parents; nothing else
 * changes, so the New parts mesh exactly as they do on their own.
 */
export function mergeForCompare(oldModel: EvaluatedModel, newModel: EvaluatedModel, marks: MarkMap): EvaluatedModel {
  const have = new Set(newModel.components.map((c) => c.id));
  const removed = oldModel.components.filter((c) => marks[c.id] === "removed" && !have.has(c.id));
  if (removed.length === 0) return newModel;
  return { ...newModel, components: [...newModel.components, ...removed.map((c) => ({ ...c, children: c.children.filter((k) => !have.has(k)) }))] };
}

/** A stable key of a compare scene (reloads the viewport when Old or New changes). */
export function compareKey(oldModel: EvaluatedModel | null, newModel: EvaluatedModel | null): string {
  return `${oldModel?.model_hash ?? "-"}>${newModel?.model_hash ?? "-"}`;
}
