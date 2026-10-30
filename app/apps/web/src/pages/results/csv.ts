/**
 * Export CSV (C §4.4): the plotted runs' series in long format, one row per
 * sample with the run named in the first columns, so two runs with different
 * time grids stay exact. Units are SI as in `series.csv`.
 */
import type { Series } from "../../plots/series.ts";

export interface ExportRun {
  name: string;
  sim: string;
  runId: string;
  series: Series;
}

function quote(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const cell = (v: number): string => (Number.isFinite(v) ? String(v) : "");

/** Long-format CSV over the union of the runs' columns (missing columns are blank). */
export function exportRunsCsv(runs: readonly ExportRun[]): string {
  const columns: string[] = [];
  for (const r of runs) for (const c of r.series.columns) if (!columns.includes(c.name)) columns.push(c.name);
  const lines = [["run", "sim", "run_id", ...columns].join(",")];
  for (const r of runs) {
    const idx = columns.map((name) => r.series.columns.findIndex((c) => c.name === name));
    const prefix = [quote(r.name), quote(r.sim), quote(r.runId)].join(",");
    for (const row of r.series.rows) lines.push(`${prefix},${idx.map((i) => (i < 0 ? "" : cell(row[i] ?? Number.NaN))).join(",")}`);
  }
  return lines.join("\n") + "\n";
}

/** `results-baseline-higher_altitude.csv` */
export function exportFileName(runs: readonly Pick<ExportRun, "sim">[]): string {
  const part = runs.map((r) => r.sim.replace(/[^A-Za-z0-9_-]+/g, "_")).join("-");
  return `results${part ? `-${part}` : ""}.csv`;
}

/** Saves `text` as a download (browser and Electron renderer). */
export function downloadText(fileName: string, text: string, mime = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
