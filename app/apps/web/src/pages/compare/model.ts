/**
 * Compare view model (M2.7, R2.10): the Old/New pickers over steps, named
 * revisions, runs, and the current model; the metric table with units; the
 * per-component change list (the marks' evaluated quantities) and the source
 * edits. Pure over the project mirror and a `CompareOut`, so it tests
 * without a server.
 */
import type { CompareOut, ProjectSnapshot, RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import type { CompareSelection, DeepReadonly, Units } from "../../state/index.ts";
import { formatLength, formatMass } from "../assembly/inspector-model.ts";
import type { MarkStatus } from "../../viewport/marks.ts";

type Snap = DeepReadonly<ProjectSnapshot> | null;
type Cmp = DeepReadonly<CompareOut>;

export type VersionGroup = "Current" | "Steps" | "Revisions" | "Runs";

export interface VersionOption {
  /** History version (`live`, `step:3`, `rev:7`, `run:<id>`). */
  value: string;
  label: string;
  group: VersionGroup;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const DASH = "—";

/** A run version (`run:<id>`). */
export const isRunVersion = (v: string): boolean => v.startsWith("run:");

/** History versions `history.restore` accepts from the Compare view (Old). */
export const canRevertTo = (v: string): boolean => /^(step|rev):\d+$/.test(v) || isRunVersion(v);

function runs(snap: Snap) {
  return (snap?.runs.runs ?? []).filter((r) => r.run_id != null);
}

/** Every version the pickers offer: current, steps (oldest first), revisions, runs. */
export function versionOptions(snap: Snap): VersionOption[] {
  const out: VersionOption[] = [{ value: "live", label: "Current model", group: "Current" }];
  const steps = [...(snap?.history.steps ?? [])].sort((a, b) => a.seq - b.seq);
  for (const s of steps) out.push({ value: `step:${s.seq}`, label: `Step ${pad(s.seq)} · ${s.title}`, group: "Steps" });
  const revs = [...(snap?.history.revisions ?? [])].sort((a, b) => a.number - b.number);
  for (const r of revs) out.push({ value: `rev:${r.number}`, label: `Rev ${pad(r.number)} · ${r.name}`, group: "Revisions" });
  for (const r of runs(snap)) {
    const tag = r.status === "outdated" ? " (Outdated)" : r.superseded_by != null ? " (earlier)" : "";
    out.push({ value: `run:${r.run_id}`, label: `${r.sim_name} run${tag}`, group: "Runs" });
  }
  return out;
}

/** Short label of a version (`Step 02`, `Rev 07`, `Baseline run`, `Current`). */
export function versionLabel(v: string, snap: Snap): string {
  if (v === "live") return "Current";
  const step = /^step:(\d+)$/.exec(v);
  if (step) return `Step ${pad(Number(step[1]))}`;
  const rev = /^rev:(\d+)$/.exec(v);
  if (rev) return `Rev ${pad(Number(rev[1]))}`;
  if (isRunVersion(v)) {
    const r = runs(snap).find((x) => x.run_id === v.slice(4));
    return r ? `${r.sim_name} run` : `Run ${v.slice(4, 12)}`;
  }
  return v;
}

/** The latest step (`step:N`), or `live` without history. */
export function headVersion(snap: Snap): string {
  const steps = snap?.history.steps ?? [];
  const head = steps.reduce<number | null>((m, s) => (m === null || s.seq > m ? s.seq : m), null);
  return head === null ? "live" : `step:${head}`;
}

/**
 * The strip's Compare: the selected step (or the one before the latest)
 * against the latest step.
 */
export function defaultCompare(snap: Snap, selectedStep: string | null): CompareSelection {
  const next = headVersion(snap);
  const seqs = [...(snap?.history.steps ?? [])].map((s) => s.seq).sort((a, b) => a - b);
  if (selectedStep !== null && selectedStep !== next && seqs.some((n) => `step:${n}` === selectedStep)) return { old: selectedStep, new: next };
  const prev = seqs.length >= 2 ? seqs[seqs.length - 2]! : seqs[0];
  return { old: prev === undefined ? "live" : `step:${prev}`, new: next };
}

/** The version a chat ref stands for (`rw:sim/<id>` = that sim's latest run), or null. */
export function versionOfRef(snap: Snap, ref: RwRef): string | null {
  const p = parseRef(ref);
  if (!("ok" in p)) return null;
  const { kind, id } = p.ok;
  if (kind === "step" && /^\d+$/.test(id)) return `step:${Number(id)}`;
  if (kind === "rev" && /^\d+$/.test(id)) return `rev:${Number(id)}`;
  if (kind === "run") return `run:${id}`;
  if (kind === "sim") {
    const r = runs(snap).find((x) => x.sim === id && x.superseded_by == null);
    return r?.run_id != null ? `run:${r.run_id}` : null;
  }
  return null;
}

// ---- metrics ------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  apogee_m: "Apogee",
  max_velocity_ms: "Max speed",
  max_accel_ms2: "Max acceleration",
  max_mach: "Max Mach",
  time_to_apogee_s: "Time to apogee",
  flight_time_s: "Flight time",
  rail_exit_velocity_ms: "Rail exit speed",
  deployment_velocity_ms: "Deployment speed",
  landing_velocity_ms: "Landing speed",
  min_stability_cal: "Min stability in flight",
  burnout_time_s: "Burnout time",
  burnout_altitude_m: "Burnout altitude",
  optimum_delay_s: "Optimum delay",
  drift_m: "Drift",
  "dims.length": "Length",
  "dims.max_diameter": "Max diameter",
  "dims.fin_span": "Fin span",
  "mass.dry": "Dry mass",
  "mass.liftoff": "Liftoff mass",
  "mass.burnout": "Burnout mass",
  "mass.propellant": "Propellant",
  "mass.cg": "CG",
  "mass.cg_burnout": "CG at burnout",
  "aero.cp": "CP",
  "aero.cna": "CNα",
  "aero.cd": "CD",
  "stability.liftoff": "Stability",
  "stability.burnout": "Stability at burnout",
  "stability.min": "Min stability",
};

export const metricLabel = (key: string): string => METRIC_LABELS[key] ?? key;

const sig = (v: number, n = 3): string => {
  const s = Number(v.toPrecision(n)).toString();
  return s.includes("e") ? v.toFixed(2) : s;
};

/** Model dimensions follow the units picker; flight distances stay in metres. */
const isModelLength = (key: string): boolean => /^(dims|mass|aero)\./.test(key);

/** A metric value with its unit (`412 m`, `92.4 mm`, `1.62 cal`, `0.054 kg`). */
export function formatMetric(v: number | null | undefined, unit: string | null | undefined, key: string, units: Units): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (unit === "m" && isModelLength(key)) return formatLength(v, units);
  if (unit === "kg") return formatMass(v);
  if (unit === "cal") return `${v.toFixed(2)} cal`;
  if (unit === "m" || unit === "s") return `${sig(v, 4)} ${unit}`;
  if (unit) return `${sig(v)} ${unit}`;
  return sig(v);
}

export type DeltaTone = "up" | "down" | "same" | "none";

export interface MetricRowView {
  key: string;
  label: string;
  old: string;
  new: string;
  delta: string;
  tone: DeltaTone;
}

/** `+8.2%` (or a signed absolute change when the old value is zero). */
export function formatDelta(r: Cmp["metrics"][number], units: Units): { text: string; tone: DeltaTone } {
  if (r.delta == null || !Number.isFinite(r.delta)) return { text: DASH, tone: "none" };
  const tol = 1e-9 * Math.max(Math.abs(r.a ?? 0), Math.abs(r.b ?? 0), 1e-12);
  if (Math.abs(r.delta) <= tol) return { text: "0%", tone: "same" };
  const tone: DeltaTone = r.delta > 0 ? "up" : "down";
  if (r.delta_pct != null && Number.isFinite(r.delta_pct)) {
    const p = r.delta_pct;
    const text = Math.abs(p) < 0.05 ? (p > 0 ? "+<0.1%" : "−<0.1%") : `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
    return { text, tone };
  }
  const abs = formatMetric(Math.abs(r.delta), r.unit, r.key, units);
  return { text: `${r.delta > 0 ? "+" : "−"}${abs}`, tone };
}

/** The metric table rows, in the sidecar's order (flight metrics first for two runs). */
export function metricRows(cmp: Cmp | null, units: Units): MetricRowView[] {
  return (cmp?.metrics ?? []).map((r) => {
    const d = formatDelta(r, units);
    return {
      key: r.key,
      label: metricLabel(r.key),
      old: formatMetric(r.a, r.unit, r.key, units),
      new: formatMetric(r.b, r.unit, r.key, units),
      delta: d.text,
      tone: d.tone,
    };
  });
}

// ---- changes ------------------------------------------------------------------------

export interface FieldRowView {
  path: string;
  label: string;
  old: string;
  new: string;
}

export interface ChangeRowView {
  id: string;
  name: string;
  status: MarkStatus;
  fields: FieldRowView[];
}

/** `/shape/root_chord` → `root chord`; `/instances/0/offset/2` → `instances 0 offset 2`. */
export function fieldLabel(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && p !== "shape");
  return parts.join(" ").replaceAll("_", " ") || path;
}

function formatQuantity(v: number | null | undefined, unit: string | null | undefined, units: Units): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (unit === "m") return formatLength(v, units);
  if (unit === "kg") return formatMass(v);
  if (unit === "rad") return `${sig((v * 180) / Math.PI)}°`;
  return unit ? `${sig(v)} ${unit}` : sig(v);
}

/** One row per marked component, with its changed quantities in the chosen units. */
export function changeRows(cmp: Cmp | null, units: Units): ChangeRowView[] {
  return (cmp?.marks ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    fields: (m.fields ?? []).map((f) => ({
      path: f.path,
      label: fieldLabel(f.path),
      old: formatQuantity(f.old, f.unit, units),
      new: formatQuantity(f.new, f.unit, units),
    })),
  }));
}

export interface EditRowView {
  /** Component id or table (`params`, `sims`). */
  owner: string;
  path: string;
  old: string;
  new: string;
}

const literal = (v: unknown): string => (v === undefined || v === null ? DASH : typeof v === "string" ? v : JSON.stringify(v));

/** The source edits between the versions (as written, units included). */
export function editRows(cmp: Cmp | null): EditRowView[] {
  return (cmp?.model.changed ?? []).map((c) => ({ owner: c.component, path: c.path, old: literal(c.old), new: literal(c.new) }));
}
