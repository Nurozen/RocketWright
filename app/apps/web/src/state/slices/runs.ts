/** `runs`: run commands and the plot overlay; run rows are derived from the mirror (status computed, I7). */
import type { JobInfo, RunListOut } from "@rw/contracts";
import { statusOf, type StatusView } from "../status.ts";
import type { AppState, RunsSlice, SliceCtx } from "../types.ts";
import { SERIES_COLORS } from "../types.ts";

type RunListEntry = RunListOut["runs"][number];

export interface RunRow {
  /** Row identity: the sim id for its latest run, `<sim>@<run id>` for the run it superseded. */
  key: string;
  sim: string;
  name: string;
  entry: RunListEntry;
  job: JobInfo | null;
  status: StatusView;
  /** Series colour when overlaid (A teal, B sand). */
  color: string | null;
}

export function createRunsSlice(ctx: SliceCtx): RunsSlice {
  return {
    overlay: [],
    started: {},
    error: null,

    async run(sim, opts = {}) {
      const { client, projectId } = ctx.conn();
      try {
        const out = await client.call("sim.run", opts.force === true ? { projectId, sim, force: true } : { projectId, sim });
        ctx.patch("runs", (r) => ({ started: { ...r.started, [sim]: out }, error: null }));
        return out;
      } catch (e) {
        ctx.patch("runs", { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },

    async cancel(jobId) {
      const { client, projectId } = ctx.conn();
      return client.call("job.cancel", { projectId, jobId });
    },

    toggleOverlay(key) {
      ctx.patch("runs", (r) => {
        if (r.overlay.includes(key)) return { overlay: r.overlay.filter((x) => x !== key) };
        // At most two series: the oldest pick drops out.
        return { overlay: [...r.overlay, key].slice(-SERIES_COLORS.length) };
      });
    },
  };
}

/**
 * A run index entry's row key: the sim id for its latest run, `<sim>@<run id>`
 * for the earlier run `run_list` keeps beside it (`superseded_by`).
 */
export function rowKey(entry: { sim: string; run_id?: string | null; superseded_by?: string | null }): string {
  return entry.superseded_by != null ? `${entry.sim}@${entry.run_id ?? ""}` : entry.sim;
}

/**
 * After a rerun: when an overlaid sim's latest run replaced an earlier one
 * (a new `superseded_by` entry), plot the two as before/after. Returns the new
 * overlay, or null when nothing changed.
 */
export function followRerun(
  prev: readonly { sim: string; run_id?: string | null; superseded_by?: string | null }[] | null,
  next: readonly { sim: string; run_id?: string | null; superseded_by?: string | null }[],
  overlay: readonly string[],
): string[] | null {
  const before = new Set((prev ?? []).map(rowKey));
  for (const e of next) {
    if (e.superseded_by == null) continue;
    const key = rowKey(e);
    if (before.has(key) || overlay.includes(key) || !overlay.includes(e.sim)) continue;
    return [e.sim, key];
  }
  return null;
}

/** The Results run table: a row per sim (plus the run its latest replaced), status computed against the current model hash. */
export function runRows(s: AppState): RunRow[] {
  const snap = s.project.snapshot;
  if (snap === null) return [];
  const modelHash = snap.evaluated?.model_hash ?? snap.runs.model_hash;
  const jobs = snap.jobs as readonly JobInfo[];
  return (snap.runs.runs as readonly RunListEntry[]).map((entry) => {
    const key = rowKey(entry);
    const latest = entry.superseded_by == null;
    const job = latest
      ? (jobs.find((j) => entry.job_id != null && j.job_id === entry.job_id) ??
        jobs.find((j) => j.sim === entry.sim && (j.state === "queued" || j.state === "running")) ??
        null)
      : null;
    const i = s.runs.overlay.indexOf(key);
    return {
      key,
      sim: entry.sim,
      name: entry.sim_name,
      entry,
      job,
      status: statusOf({ kind: "run", run: entry, modelHash, job }),
      color: i >= 0 ? SERIES_COLORS[i]! : null,
    };
  });
}
