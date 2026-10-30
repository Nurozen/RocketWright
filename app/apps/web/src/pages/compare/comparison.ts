/**
 * Two runs compared (concept 04; the Compare view): `2 runs · Same environment`.
 * Environment equality comes from the runs' own manifests (`run_list`
 * `conditions_hash`, the JCS hash of site, atmosphere, wind, rail, and
 * integrator), never from the current sim files, so an edited sim does not
 * make two old runs look comparable. Pure over the project mirror.
 */
import type { Mention, ProjectSnapshot, RunListOut, RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import { rowKey } from "../../state/slices/runs.ts";
import type { DeepReadonly } from "../../state/types.ts";

type RunListEntry = DeepReadonly<RunListOut["runs"][number]>;

export interface ComparedRun {
  ref: RwRef;
  label: string;
  /** The run index entry the ref resolves to (null: no such run in the mirror). */
  entry: RunListEntry | null;
  /** Run table row key (`rowKey`), when the run exists. */
  key: string | null;
}

/** `same`: every run has the same conditions hash; `different`: two differ; `unknown`: a run has no hash (not run yet, or missing). */
export type EnvironmentMatch = "same" | "different" | "unknown";

export interface RunComparisonView {
  runs: ComparedRun[];
  environment: EnvironmentMatch;
  /** `2 runs · Same environment`. */
  label: string;
}

/** The run index entry a run ref points at: a sim's latest run, or the run with that id. */
export function runEntryOf(snap: DeepReadonly<ProjectSnapshot> | null, ref: RwRef): RunListEntry | null {
  const p = parseRef(ref);
  if (!("ok" in p)) return null;
  const runs = snap?.runs.runs ?? [];
  if (p.ok.kind === "sim") return runs.find((r) => r.sim === p.ok.id && r.superseded_by == null) ?? null;
  if (p.ok.kind === "run") return runs.find((r) => r.run_id === p.ok.id) ?? null;
  return null;
}

/** Same, different, or unknown, from the runs' `conditions_hash`. */
export function environmentMatch(hashes: readonly (string | null | undefined)[]): EnvironmentMatch {
  if (hashes.length < 2 || hashes.some((h) => h == null || h === "")) return "unknown";
  return hashes.every((h) => h === hashes[0]) ? "same" : "different";
}

const ENV_TEXT: Record<EnvironmentMatch, string> = {
  same: "Same environment",
  different: "Different environments",
  unknown: "Environment not recorded",
};

export function runComparison(snap: DeepReadonly<ProjectSnapshot> | null, mentions: readonly Mention[]): RunComparisonView {
  const runs = mentions.map((m): ComparedRun => {
    const entry = runEntryOf(snap, m.ref);
    return { ref: m.ref, label: entry?.sim_name ?? m.label, entry, key: entry ? rowKey(entry) : null };
  });
  const environment = environmentMatch(runs.map((r) => (r.entry?.run_id != null ? r.entry.conditions_hash : null)));
  return { runs, environment, label: `${runs.length} runs · ${ENV_TEXT[environment]}` };
}
