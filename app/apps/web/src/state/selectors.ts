/** Derived views over the store (pure; safe for `useAppState`). */
import type { CheckReport } from "@rw/contracts";
import { selectedComponentIds } from "./slices/selection.ts";
import { statusOf, type StatusView } from "./status.ts";
import type { AppState } from "./types.ts";

export { followRerun, rowKey, runRows, type RunRow } from "./slices/runs.ts";

/** The current model hash (evaluated, else files). */
export function modelHash(s: AppState): string | null {
  const snap = s.project.snapshot;
  return snap?.evaluated?.model_hash ?? snap?.files.model_hash ?? null;
}

/** Header `Check model` status. */
export function checkStatus(s: AppState): StatusView {
  return statusOf({ kind: "check", report: (s.project.snapshot?.check ?? null) as CheckReport | null, modelHash: modelHash(s), partCount: s.project.snapshot?.evaluated?.components.length });
}

/** The project evaluated and has no parts (R0.3a). False while the model is unknown: a broken model is not an empty one. */
export function hasNoParts(s: AppState): boolean {
  return s.project.snapshot?.evaluated?.components.length === 0;
}

/** Header save state: Modified while a draft is pending, else Saved. */
export function saveStatus(s: AppState): StatusView {
  return statusOf({ kind: "draft", ops: s.draft.ops });
}

export function selectedComponents(s: AppState): string[] {
  return selectedComponentIds(s.selection.refs);
}
