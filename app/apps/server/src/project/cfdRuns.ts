/**
 * Imported CFD datasets on disk (M5.4): `runs/cfd.<id>/<run>/dataset.json`,
 * written by the sidecar's `cfd_import` (the server only reads them, I1).
 * One entry per dataset id: its newest run (by `dataset.json` mtime).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { schema } from "@rw/contracts";

const CFD_PREFIX = "cfd.";

function parse(text: string): schema.CfdDataset | null {
  try {
    const v = JSON.parse(text) as Partial<schema.CfdDataset>;
    if (typeof v.id !== "string" || typeof v.run_id !== "string" || typeof v.sim !== "string" || v.provenance !== "cfd" || !Array.isArray(v.times) || !Array.isArray(v.scalars)) return null;
    return v as schema.CfdDataset;
  } catch {
    return null;
  }
}

/** The project's imported CFD datasets, newest run per id, sorted by id. */
export function listCfdDatasets(projectDir: string): schema.CfdDataset[] {
  const runs = join(projectDir, "runs");
  if (!existsSync(runs)) return [];
  const out: schema.CfdDataset[] = [];
  for (const sim of readdirSync(runs).sort()) {
    if (!sim.startsWith(CFD_PREFIX)) continue;
    let best: { ds: schema.CfdDataset; mtime: number } | null = null;
    let ids: string[];
    try {
      ids = readdirSync(join(runs, sim));
    } catch {
      continue;
    }
    for (const runId of ids) {
      if (runId.startsWith(".")) continue;
      const file = join(runs, sim, runId, "dataset.json");
      if (!existsSync(file) || !existsSync(join(runs, sim, runId, "cfd.json"))) continue;
      const ds = parse(readFileSync(file, "utf8"));
      if (ds === null || ds.sim !== sim || ds.run_id !== runId) continue;
      const mtime = statSync(file).mtimeMs;
      if (best === null || mtime > best.mtime || (mtime === best.mtime && runId > best.ds.run_id)) best = { ds, mtime };
    }
    if (best !== null) out.push(best.ds);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
