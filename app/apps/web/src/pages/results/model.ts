/**
 * Results page view model (M1.51, C §4.4). Pure functions over the app
 * state: run rows with computed status (I7, `statusOf` via `runRows`),
 * sorting, the Outdated banner, run details and assumptions, and the run
 * snapshot cards. Metric cells show only what a current (Complete) run proves.
 */
import type { HistoryListOut, RwRef, schema } from "@rw/contracts";
import { runRows, type RunRow } from "../../state/selectors.ts";
import { parseRef } from "../../state/slices/selection.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import { fmtNum } from "../../plots/quantities.ts";
import type { RunSummary } from "../../plots/events.ts";

type Conditions = schema.Conditions;
type Diagnostic = schema.Diagnostic;
type HistoryStep = schema.HistoryStep;

export type SeriesSlot = "a" | "b";

export interface ResultsRow extends RunRow {
  /** Summary shown in the metric cells (only for Complete runs). */
  metrics: RunSummary | null;
  /** Overlay slot (checkbox ticked): A teal, B sand. */
  series: SeriesSlot | null;
  /** The single selected run (rail and table highlight). */
  selected: boolean;
  /** Hidden with the rail eye toggle. */
  hidden: boolean;
}

export type SortKey = "name" | "status" | "apogee" | "maxSpeed" | "flightTime";
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

export const simRef = (sim: string): RwRef => `rw:sim/${sim}`;
export const runRef = (runId: string): RwRef => `rw:run/${runId}`;

/** What selecting a row selects: its sim (latest run), or the superseded run itself. */
export function rowRef(row: Pick<RunRow, "sim" | "entry">): RwRef {
  return row.entry.superseded_by != null && row.entry.run_id != null ? runRef(row.entry.run_id) : simRef(row.sim);
}

/** True when `refs` select this row's sim (its latest run) or the row's own run. */
export function isRowSelected(refs: readonly RwRef[], row: Pick<RunRow, "sim" | "entry">): boolean {
  return refs.some((r) => {
    const p = parseRef(r);
    if (p === null) return false;
    if (p.kind === "sim") return p.id === row.sim && row.entry.superseded_by == null;
    return p.kind === "run" && row.entry.run_id != null && p.id === row.entry.run_id;
  });
}

const STATUS_ORDER: Record<string, number> = { complete: 0, running: 1, queued: 1, outdated: 2, failed: 3, cancelled: 4, not_run: 5 };

function sortValue(row: ResultsRow, key: SortKey): number | string {
  switch (key) {
    case "name":
      return row.name.toLowerCase();
    case "status":
      return STATUS_ORDER[row.status.kind] ?? 9;
    case "apogee":
      return row.metrics?.apogee_m ?? Number.NEGATIVE_INFINITY;
    case "maxSpeed":
      return row.metrics?.max_velocity_ms ?? Number.NEGATIVE_INFINITY;
    case "flightTime":
      return row.metrics?.flight_time_s ?? Number.NEGATIVE_INFINITY;
  }
}

/** Stable sort; ties keep the run-index order. */
export function sortRows(rows: readonly ResultsRow[], sort: SortState | null): ResultsRow[] {
  if (sort === null) return [...rows];
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, ia], [b, ib]) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return ia - ib;
    })
    .map(([r]) => r);
}

/** Next sort state when a column header is clicked: ascending, descending, then off. */
export function nextSort(cur: SortState | null, key: SortKey): SortState | null {
  if (cur === null || cur.key !== key) return { key, dir: 1 };
  return cur.dir === 1 ? { key, dir: -1 } : null;
}

/** The run table rows, statuses computed against the current model hash. */
export function resultsRows(s: AppState, opts: { sort?: SortState | null; hidden?: readonly string[] } = {}): ResultsRow[] {
  const hidden = new Set(opts.hidden ?? []);
  const rows = runRows(s).map((r): ResultsRow => {
    const slot = s.runs.overlay.indexOf(r.key);
    return {
      ...r,
      metrics: r.status.kind === "complete" ? ((r.entry.summary ?? r.job?.summary ?? null) as RunSummary | null) : null,
      series: slot === 0 ? "a" : slot === 1 ? "b" : null,
      selected: isRowSelected(s.selection.refs, r),
      hidden: hidden.has(r.key),
    };
  });
  return sortRows(rows, opts.sort ?? null);
}

export interface OutdatedBanner {
  sim: string;
  text: string;
  /** Outdated runs beyond the named one. */
  more: number;
}

/** The Outdated banner: shown while any run's model revision differs from the current one. */
export function outdatedBanner(rows: readonly ResultsRow[]): OutdatedBanner | null {
  const outdated = rows.filter((r) => r.status.kind === "outdated");
  const first = outdated[0];
  if (first === undefined) return null;
  return {
    sim: first.sim,
    text: first.status.reason ?? `${first.name} uses an outdated model. Rebuild to run this simulation.`,
    more: outdated.length - 1,
  };
}

/** Runs worth plotting first: the first two Complete runs (row keys). */
export function defaultOverlay(rows: readonly ResultsRow[]): string[] {
  return rows.filter((r) => r.status.kind === "complete").slice(0, 2).map((r) => r.key);
}

/** The run the details footer describes: the selected run, else series A, else the first Complete run. */
export function primaryRow(rows: readonly ResultsRow[]): ResultsRow | null {
  return rows.find((r) => r.selected && r.entry.run_id != null) ?? rows.find((r) => r.series === "a") ?? rows.find((r) => r.status.kind === "complete") ?? null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export interface ModelRevision {
  /** `Model Rev 07`, or `Step 04` when no revision is tagged yet, or `Model rev unknown`. */
  label: string;
  step: DeepReadonly<HistoryStep> | null;
  rev: number | null;
}

/** The design revision a run was made on: the newest history step with the run's model hash, and the revision tagged at or before it. */
export function modelRevision(history: DeepReadonly<HistoryListOut> | null | undefined, modelHash: string | null | undefined): ModelRevision {
  const steps = history?.steps ?? [];
  const step = modelHash == null ? undefined : [...steps].reverse().find((st) => st.model_hash === modelHash);
  if (step === undefined) return { label: "Model rev unknown", step: null, rev: null };
  const tagged = /^rev:(\d+)$/.exec(step.rev ?? "");
  const rev =
    tagged !== null
      ? Number(tagged[1])
      : (history?.revisions ?? []).filter((r) => r.step <= step.seq).reduce<number | null>((m, r) => (m === null || r.number > m ? r.number : m), null);
  return { label: rev === null ? `Step ${pad2(step.seq)}` : `Model Rev ${pad2(rev)}`, step, rev };
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const cardinal = (deg: number): string => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;

/** `calm (0 m/s, 15 °C)` or `wind 4.0 m/s from NW (12 °C)` (the footer's tooltip). */
export function environmentLabel(c: DeepReadonly<Conditions> | null | undefined): string {
  if (!c) return "unknown";
  const temp = `${fmtNum(c.base_temperature_k - 273.15)} °C`;
  if (c.wind_speed_ms < 0.5) return `calm (${fmtNum(c.wind_speed_ms)} m/s, ${temp})`;
  return `wind ${fmtNum(c.wind_speed_ms, 1)} m/s from ${cardinal(c.wind_direction_deg)} (${temp})`;
}

/** The footer's compact form: `calm, 15 °C` or `wind 3 m/s W, 15 °C` (wind to 0.1 m/s, trailing `.0` dropped). */
export function environmentShort(c: DeepReadonly<Conditions> | null | undefined): string {
  if (!c) return "unknown";
  const temp = `${fmtNum(c.base_temperature_k - 273.15)} °C`;
  if (c.wind_speed_ms < 0.5) return `calm, ${temp}`;
  const speed = fmtNum(c.wind_speed_ms, 1).replace(/\.0$/, "");
  return `wind ${speed} m/s ${cardinal(c.wind_direction_deg)}, ${temp}`;
}

const ATMOSPHERE: Record<string, string> = { ussa1976: "US Standard Atmosphere 1976", isa_custom: "ISA (custom base)" };

/** The assumptions behind a run, as short sentences from its conditions and tier. */
export function assumptionsOf(c: DeepReadonly<Conditions> | null | undefined, provenance: string | null | undefined): string[] {
  const out: string[] = [];
  if (provenance) out.push(provenance === "engineering" ? "Engineering result (tier 1 flight simulation)" : `${provenance} result: not an engineering number`);
  if (!c) return out;
  out.push(`Atmosphere: ${ATMOSPHERE[c.atmosphere] ?? c.atmosphere}, ${fmtNum(c.base_temperature_k - 273.15)} °C and ${fmtNum(c.base_pressure_pa / 100)} hPa at the site`);
  out.push(c.geodetic === "flat" ? "Flat earth, flat ground plane" : `Earth model: ${c.geodetic}`);
  const g = c.gravity;
  out.push(g == null || g.model === "wgs84" ? "Gravity: WGS84" : `Gravity: constant ${fmtNum(g.g_ms2, 3)} m/s²`);
  out.push(c.wind_speed_ms < 0.5 ? "No wind" : `Wind ${fmtNum(c.wind_speed_ms, 1)} m/s, turbulence ${fmtNum(c.wind_turbulence * 100)}%`);
  out.push(`Launch rail ${fmtNum(c.rail_length_m, 2)} m at ${fmtNum(c.rod_angle_deg, 1)}° from vertical${c.launch_into_wind ? ", into the wind" : ""}`);
  out.push(`Integrator ${c.integrator}, ${c.integrator === "rk4" ? "step" : "max step"} ${c.time_step_s} s`);
  return out;
}

export interface RunDetails {
  modelRev: string;
  /** Compact, for the footer (`wind 3 m/s W, 15 °C`). */
  environment: string;
  /** Spelled out, for the footer's tooltip (`wind 3.0 m/s from W (15 °C)`). */
  environmentFull: string;
  warnings: number;
  assumptions: string[];
}

/**
 * The run details footer. Conditions come from the evaluated sim (equal to
 * the run's for a Complete run); warnings from the run's own diagnostics when
 * loaded, else the current check report's warnings.
 */
export function runDetails(s: AppState, row: ResultsRow | null, diagnostics?: readonly Diagnostic[] | null): RunDetails {
  const snap = s.project.snapshot;
  const sim = row ? snap?.evaluated?.sims[row.sim] : undefined;
  const conditions = sim?.conditions ?? null;
  const diags = diagnostics ?? snap?.check?.diagnostics ?? [];
  return {
    modelRev: modelRevision(snap?.history, row?.entry.model_hash).label,
    environment: environmentShort(conditions),
    environmentFull: environmentLabel(conditions),
    warnings: diags.filter((d) => d.severity === "warning").length,
    assumptions: assumptionsOf(conditions, row?.entry.provenance),
  };
}

export interface RunSnapshot {
  key: string;
  sim: string;
  /** What clicking the card selects. */
  ref: RwRef;
  title: string;
  modelRev: string;
  when: string;
  series: SeriesSlot | null;
  color: string | null;
}

/** `Oct 15, 2026, 2:04 PM` (local time unless `timeZone` is given). */
export function fmtWhen(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** Snapshot cards for the history strip's second row: the overlaid runs (A then B), else every run with a result. */
export function runSnapshots(s: AppState, rows: readonly ResultsRow[], timeZone?: string): RunSnapshot[] {
  const overlaid = (["a", "b"] as const).flatMap((slot) => rows.filter((r) => r.series === slot));
  const pick = overlaid.length > 0 ? overlaid : rows.filter((r) => r.entry.run_id != null);
  return pick.map((r) => {
    const rev = modelRevision(s.project.snapshot?.history, r.entry.model_hash);
    return { key: r.key, sim: r.sim, ref: rowRef(r), title: `${r.name} run`, modelRev: rev.label, when: fmtWhen(rev.step?.ts, timeZone), series: r.series, color: r.color };
  });
}
