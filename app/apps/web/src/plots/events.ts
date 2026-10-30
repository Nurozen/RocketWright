/**
 * Event lines on the Results plots (C §4.4): Burnout, Apogee, Recovery.
 *
 * Times come from the run itself: its `events.json` (`FlightEvent[]`, served
 * at `EVENTS_PATH`), else its summary for Burnout and Apogee. Recovery marks
 * the chute deployment (the last recovery-device deployment, the main chute),
 * never the touchdown: a run without a deployment event (or whose events are
 * unavailable) has no Recovery line.
 */
import type { RunListOut, schema } from "@rw/contracts";

export type RunSummary = NonNullable<RunListOut["runs"][number]["summary"]>;
export type FlightEvent = schema.FlightEvent;

export type EventLabel = "Burnout" | "Apogee" | "Recovery";

export interface EventMarker {
  label: EventLabel;
  /** Seconds after launch. */
  t: number;
  /** The plotted run the event belongs to (row key) and its series colour; absent: a single unnamed run. */
  run?: string;
  color?: string;
}

const finite = (t: number | null | undefined): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0;

/** The three event markers of one run, in time order (missing events are dropped). */
export function eventMarkers(summary: RunSummary | null | undefined, events?: readonly FlightEvent[] | null): EventMarker[] {
  const out: EventMarker[] = [];
  const last = (kind: FlightEvent["kind"]): number | undefined => events?.filter((e) => e.kind === kind).at(-1)?.t;
  const first = (kind: FlightEvent["kind"]): number | undefined => events?.find((e) => e.kind === kind)?.t;
  const burnout = first("burnout") ?? summary?.burnout_time_s;
  const apogee = first("apogee") ?? summary?.time_to_apogee_s;
  const recovery = last("deployment");
  if (finite(burnout)) out.push({ label: "Burnout", t: burnout });
  if (finite(apogee)) out.push({ label: "Apogee", t: apogee });
  if (finite(recovery)) out.push({ label: "Recovery", t: recovery });
  return out.sort((a, b) => a.t - b.t);
}

/** A plotted (or plottable) run as the event lines see it. */
export interface EventRun {
  /** The run's row key: the id of its plotted series line. */
  id: string;
  /** The run's name, as in the plot legend. */
  name: string;
  /** Its series colour. */
  color: string;
  summary: RunSummary | null | undefined;
  events?: readonly FlightEvent[] | null;
}

/**
 * The event lines a multi-run plot draws: one run's only, never a mix of
 * runs (one run's Burnout beside another's Apogee reads as one flight). The
 * run is `preferred` (the selected run) when its series is plotted, else the
 * first run whose series is. Every marker carries that run's id and series
 * colour; `run` is `null` (no lines) when no run's series is plotted.
 */
export function plotEventMarkers(
  runs: readonly EventRun[],
  plotted: readonly string[],
  preferred?: string | null,
): { run: EventRun | null; markers: EventMarker[] } {
  const shown = runs.filter((r) => plotted.includes(r.id));
  const run = shown.find((r) => r.id === preferred) ?? shown[0] ?? null;
  if (run === null) return { run: null, markers: [] };
  return { run, markers: eventMarkers(run.summary, run.events).map((m) => ({ ...m, run: run.id, color: run.color })) };
}
