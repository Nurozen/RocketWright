/**
 * Run series (`series.csv`, fetched over HTTP at `SERIES_PATH`, never copied
 * over RPC; G §4.2). One header row of column names, then one row per `dt`
 * plus exact event rows. Column order and units follow `rw_sim::SERIES_COLUMNS`
 * (SI: m, m/s, m/s², s, kg, N; stability in calibers).
 */
import type { schema } from "@rw/contracts";

export type Series = schema.Series;
export type DimKind = schema.DimKind;

/** `rw_sim::SERIES_COLUMNS`: the standard columns and their dimensions. */
export const SERIES_DIMS: Readonly<Record<string, DimKind>> = Object.freeze({
  t: "time",
  altitude: "length",
  x: "length",
  y: "length",
  vz: "velocity",
  speed: "velocity",
  accel: "acceleration",
  mach: "dimensionless",
  aoa: "angle",
  stability: "dimensionless",
  thrust: "force",
  mass: "mass",
  cg: "length",
  cp: "length",
  cd: "dimensionless",
});

/** Parses `series.csv`. Unknown columns are kept as dimensionless; blank cells become NaN. */
export function parseSeriesCsv(text: string): Series {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("#"));
  const head = lines.shift();
  if (head === undefined) throw new Error("series.csv: empty");
  const names = head.split(",").map((s) => s.trim());
  if (names[0] !== "t") throw new Error(`series.csv: first column must be t, got ${names[0] ?? ""}`);
  const rows = lines.map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== names.length) throw new Error(`series.csv row ${i + 2}: ${cells.length} cells, expected ${names.length}`);
    return cells.map((c) => (c.trim() === "" ? Number.NaN : Number(c)));
  });
  return { dt: inferDt(rows), columns: names.map((name) => ({ name, dim: SERIES_DIMS[name] ?? "dimensionless" })), rows };
}

/** The most common positive step between consecutive times (event rows are off-grid). */
function inferDt(rows: readonly number[][]): number {
  const counts = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i]![0]! - rows[i - 1]![0]!;
    if (!(d > 0)) continue;
    const key = d.toPrecision(6);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let dt = 0;
  for (const [k, n] of counts) {
    if (n > best) [best, dt] = [n, Number(k)];
  }
  return dt;
}

/** One column as numbers, or `null` when the series lacks it. */
export function seriesColumn(series: Series, name: string): number[] | null {
  const i = series.columns.findIndex((c) => c.name === name);
  if (i < 0) return null;
  return series.rows.map((r) => r[i] ?? Number.NaN);
}

/** Serializes a series back to CSV (inverse of `parseSeriesCsv` for finite values). */
export function seriesToCsv(series: Series): string {
  const head = series.columns.map((c) => c.name).join(",");
  return [head, ...series.rows.map((r) => r.map(fmtCell).join(","))].join("\n") + "\n";
}

function fmtCell(v: number): string {
  return Number.isFinite(v) ? String(v) : "";
}
