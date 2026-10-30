/**
 * Page 06 Engineering tier (M4.8) view model. Pure: an engine run's record
 * (`runs/engine.<id>/<run>/engine.json`, written by `engine_simulate`: the
 * `provenance`, the design, and every blowdown sample) becomes the three
 * time plots (tank pressure, mass flow, thrust), the run summary, and the
 * assumptions. The provenance label is read from the record, never assumed
 * (I13: a visual-tier record would say so).
 */
import { ENGINE_RUN_PATH, type schema } from "@rw/contracts";
import type { PlotLine } from "../../plots/TimePlot.tsx";

export type Provenance = "engineering" | "visual" | "cfd";

export interface BlowdownSample {
  t: number;
  chamber_pressure: number;
  ox_tank_pressure: number;
  fuel_tank_pressure: number;
  mdot_ox: number;
  mdot_fuel: number;
  mixture_ratio: number;
  thrust: number;
  ox_liquid: number;
  fuel_liquid: number;
}

export interface EngineRunRecord {
  engine: string;
  run_id: string;
  provenance: Provenance | string;
  core_version?: string;
  design: schema.LiquidEngineDesign;
  blowdown: { samples: BlowdownSample[]; end: string; burn_time: number; total_impulse: number; ox_used: number; fuel_used: number };
}

/** Parses `engine.json`; throws on anything that is not an engine run record. */
export function parseEngineRun(text: string): EngineRunRecord {
  const v = JSON.parse(text) as Partial<EngineRunRecord>;
  if (typeof v.engine !== "string" || typeof v.run_id !== "string" || typeof v.provenance !== "string" || !v.blowdown || !Array.isArray(v.blowdown.samples) || !v.design) {
    throw new Error("engine.json: not an engine run record");
  }
  return v as EngineRunRecord;
}

/** `<base>/api/projects/<p>/runs/<sim>/<runId>/engine.json` */
export function engineRunUrl(baseUrl: string, projectId: string, sim: string, runId: string): string {
  const path = ENGINE_RUN_PATH.replace(":projectId", encodeURIComponent(projectId)).replace(":sim", encodeURIComponent(sim)).replace(":runId", encodeURIComponent(runId));
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  engineering: "Engineering result",
  visual: "Visual model · Not an engineering result",
  cfd: "Imported CFD result",
};

export function provenanceLabel(p: string): string {
  return PROVENANCE_LABEL[p as Provenance] ?? p;
}

/** Series colours (tokens): oxidizer teal, fuel amber, chamber neutral. */
export const SERIES_COLORS = { ox: "#61b5ad", fuel: "#f1ae6e", chamber: "#c9ced1", total: "#e6e9ea" } as const;

export interface EngineeringPlot {
  id: "pressure" | "mass_flow" | "thrust";
  title: string;
  yLabel: string;
  lines: PlotLine[];
}

const FLUIDS: Record<string, string> = { n2o: "N2O", lox: "LOX", ipa: "IPA", "rp-1": "RP-1", rp1: "RP-1" };
const fluidName = (f: string | undefined, fallback: string) => (f ? (FLUIDS[f.toLowerCase()] ?? f[0]!.toUpperCase() + f.slice(1)) : fallback);

/** The three plots of a run (SI → bar, kg/s, N). */
export function engineeringPlots(run: EngineRunRecord): EngineeringPlot[] {
  const s = run.blowdown.samples;
  const t = s.map((x) => x.t);
  // `design.feed` is the oxidizer path, then the fuel path.
  const branches = run.design.feed ?? [];
  const oxName = fluidName(branches[0]?.fluid, "Oxidizer");
  const fuelName = fluidName(branches[1]?.fluid, "Fuel");
  const tankA = branches[0]?.tank;
  const tankB = branches[1]?.tank;
  const label = (tank: string | undefined, fluid: string) => (tank ? `${tank.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} · ${fluid}` : fluid);
  return [
    {
      id: "pressure",
      title: "Tank pressure",
      yLabel: "Pressure (bar)",
      lines: [
        { id: "ox_tank_pressure", label: label(tankA, oxName), color: SERIES_COLORS.ox, t, y: s.map((x) => x.ox_tank_pressure / 1e5) },
        { id: "fuel_tank_pressure", label: label(tankB, fuelName), color: SERIES_COLORS.fuel, t, y: s.map((x) => x.fuel_tank_pressure / 1e5) },
        { id: "chamber_pressure", label: "Chamber", color: SERIES_COLORS.chamber, t, y: s.map((x) => x.chamber_pressure / 1e5) },
      ],
    },
    {
      id: "mass_flow",
      title: "Mass flow",
      yLabel: "Mass flow (kg/s)",
      lines: [
        { id: "mdot_ox", label: oxName, color: SERIES_COLORS.ox, t, y: s.map((x) => x.mdot_ox) },
        { id: "mdot_fuel", label: fuelName, color: SERIES_COLORS.fuel, t, y: s.map((x) => x.mdot_fuel) },
      ],
    },
    {
      id: "thrust",
      title: "Thrust",
      yLabel: "Thrust (N)",
      lines: [{ id: "thrust", label: "Thrust", color: SERIES_COLORS.total, t, y: s.map((x) => x.thrust) }],
    },
  ];
}

const END_LABEL: Record<string, string> = {
  oxidizer_depleted: "Oxidizer depleted",
  fuel_depleted: "Fuel depleted",
  time_limit: "Time limit",
  thrust_zero: "Thrust reached zero",
  no_balance: "No pressure balance",
};

export interface SummaryRow {
  key: string;
  label: string;
  value: string;
}

const f = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function runSummary(run: EngineRunRecord): SummaryRow[] {
  const b = run.blowdown;
  const s = b.samples;
  const peak = s.reduce((m, x) => Math.max(m, x.thrust), 0);
  const avg = b.burn_time > 0 ? b.total_impulse / b.burn_time : 0;
  const first = s[0];
  const last = s[s.length - 1];
  return [
    { key: "burn_time", label: "Burn time", value: `${f(b.burn_time, 2)} s` },
    { key: "total_impulse", label: "Total impulse", value: `${f(b.total_impulse, 0)} N·s` },
    { key: "average_thrust", label: "Average thrust", value: `${f(avg, 0)} N` },
    { key: "peak_thrust", label: "Peak thrust", value: `${f(peak, 0)} N` },
    ...(first && last ? [{ key: "mixture_ratio", label: "O/F start → end", value: `${f(first.mixture_ratio, 2)} → ${f(last.mixture_ratio, 2)}` }] : []),
    { key: "end", label: "Burn ended", value: END_LABEL[b.end] ?? b.end.replace(/_/g, " ") },
  ];
}
