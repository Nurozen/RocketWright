/**
 * Event markers (C §4.4, concept 04), drawn with Canvas2D onto the uPlot
 * canvas in its `draw` hook: one labelled dashed marker line per event name
 * (Burnout, Apogee, Recovery), and, when more than one run is plotted, a
 * short solid tick in each run's colour on the time axis at that run's own
 * event time (runs whose same-name events fall within `SHARED_EVENT_S` share
 * one position, their ticks stacked). The marker stands on one of the runs'
 * times (the earliest that fits its label); it is neutral when several runs
 * have the event, else in the run's colour. Labels sit in a lane above the
 * plot area (the plot's top padding reserves it), so they never cover a
 * curve; a label that would overlap another label or marker drops to the
 * next lane row. Pure over a minimal context so it unit-tests without a DOM.
 * The Results page passes one run's markers only (`plotEventMarkers`), so its
 * lines are always in that run's colour; the multi-run modes serve other plots.
 */
import type { EventMarker } from "./events.ts";

/** Same-name events of different runs closer than this (s) share one line. */
export const SHARED_EVENT_S = 0.2;
/** Height of one label-lane row (CSS px). */
export const LANE_ROW_PX = 16;
/** Space between the label lane and the plot area (CSS px). */
export const LANE_GAP_PX = 4;
/** Height of one run's event tick on the time axis (CSS px). */
export const TICK_PX = 7;

/** The Canvas2D subset the event lines use. */
export interface Ctx2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
  measureText(text: string): { width: number };
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
}

export interface EventLineStyle {
  stroke: string;
  text: string;
  /** Device pixel ratio (uPlot draws in device pixels). */
  pxRatio: number;
  font: string;
}

/** Plot box in canvas (device) pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlacedEvent extends EventMarker {
  /** Canvas x of the line (device pixels). */
  x: number;
  /** Label-lane row (0 = top); labels that would overlap drop to the next row. */
  row: number;
  /** The label sits left of the line (it would run past the plot's right edge, or collide on the right). */
  flip: boolean;
  /**
   * This position carries the event's marker line and label: one per event
   * name; the other runs' positions of that event are ticks only.
   */
  labelled: boolean;
  /** The runs this line stands for: more than one when their events share it (it is then neutral, `color` unset). */
  runs: string[];
  /** The label's row runs under the legend (set only when a legend is avoided). */
  underLegend?: boolean;
}

/** A placed event as drawn: where its label and line start (device pixels). */
export interface DrawnEvent extends PlacedEvent {
  /** Top of the label's lane row; `null` for a line without a label. */
  labelTop: number | null;
  /** Where the drawn mark starts: the marker line just under its label, a tick above the time axis. */
  lineTop: number;
  /** A labelled dashed marker line, or a run tick on the time axis. */
  mark: "line" | "tick";
  /** Top of the plot area. */
  plotTop: number;
}

type Merged = EventMarker & { runs: string[] };

/**
 * Collapses same-name events of different runs that lie within `tol` seconds
 * of the first of them into one marker at that first time, with no colour
 * (drawn neutral) and every run listed. A single run's markers pass through.
 */
export function mergeShared(markers: readonly EventMarker[], tol = SHARED_EVENT_S): Merged[] {
  const sorted = [...markers].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.t - b.t));
  const out: Merged[] = [];
  for (const m of sorted) {
    let prev: Merged | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.label === m.label) {
        prev = out[i];
        break;
      }
    }
    if (prev !== undefined && m.run !== undefined && prev.runs.length > 0 && !prev.runs.includes(m.run) && m.t - prev.t <= tol + 1e-9) {
      prev.runs.push(m.run);
      delete prev.color;
      continue;
    }
    out.push({ ...m, runs: m.run === undefined ? [] : [m.run] });
  }
  return out;
}

/** The label lane the placed events use: `rows` in all, the bottom `free` of them below the legend. */
export interface Lane {
  rows: number;
  free: number;
}

/** The label lane the placed events use (`rows` 0 when none is labelled). */
export function laneOf(placed: readonly PlacedEvent[]): Lane {
  let rows = 0;
  let upper = 0;
  for (const p of placed) {
    if (!p.labelled) continue;
    rows = Math.max(rows, p.row + 1);
    if (!p.underLegend) upper = Math.max(upper, p.row + 1);
  }
  return { rows, free: rows - upper };
}

/**
 * The top padding (CSS px) a plot needs for its label lane: every row above
 * the plot area, and the rows that may run under the legend (`free`) below
 * the legend's bottom edge. `0` without labels.
 */
export function laneHeight(lane: Lane, legendBottom = 0): number {
  if (lane.rows === 0) return 0;
  return Math.max(lane.rows * LANE_ROW_PX, legendBottom + lane.free * LANE_ROW_PX) + LANE_GAP_PX;
}

interface Row {
  /** A row below the legend: labels may sit under it. Upper rows avoid the legend's x span. */
  free: boolean;
  spans: [number, number][];
  /** Lines leaving this row's labels downward. */
  lines: number[];
}

/**
 * Places the markers inside `box` (markers outside the x range are dropped)
 * after merging runs' shared events (`mergeShared`). Every remaining marker
 * keeps its own line; same-name lines closer than their label share one
 * label, carried by whichever of those lines fits best. Labels go in lane
 * rows (0 = top) beside their line: right of it unless that would cross the
 * plot's right edge, trying the other side and the other lines before a
 * lower row. A label never overlaps another label in its row, the line of a
 * label in a row above it (that line runs down through the lower rows), or
 * `blocked` (the legend's x spans) unless it drops to a row under the legend.
 */
export function placeEvents(
  markers: readonly EventMarker[],
  toX: (t: number) => number,
  box: Box,
  labelWidth: (s: string) => number,
  gap = 6,
  blocked: readonly (readonly [number, number])[] = [],
): PlacedEvent[] {
  const lines = mergeShared(markers)
    .map((m) => ({ m, x: Math.round(toX(m.t)) + 0.5 }))
    .filter(({ x }) => Number.isFinite(x) && x >= box.left - 0.5 && x <= box.left + box.width + 0.5)
    .sort((a, b) => a.x - b.x || a.m.t - b.m.t);
  // One group (one marker and label) per event name.
  const groups: { label: string; x: number; members: number[] }[] = [];
  for (const [i, { m, x }] of lines.entries()) {
    const g = groups.find((g) => g.label === m.label);
    if (g) g.members.push(i);
    else groups.push({ label: m.label, x, members: [i] });
  }
  const out: PlacedEvent[] = lines.map(({ m, x }) => ({ ...m, x, row: 0, flip: false, labelled: false }));
  const rows: Row[] = [];
  const right = box.left + box.width;
  const clear = (span: readonly [number, number], spans: readonly (readonly [number, number])[]) => spans.every(([a, b]) => span[1] + gap <= a || span[0] >= b + gap);
  // Can a label with this span and line go in row `r` (an existing row, or a new one inserted at `r`)?
  const fits = (r: number, isNew: boolean, free: boolean, span: [number, number], x: number): boolean => {
    if (!free && !clear(span, blocked)) return false;
    if (!isNew && !clear(span, rows[r]!.spans)) return false;
    for (let k = 0; k < r; k++) if (rows[k]!.lines.some((lx) => lx > span[0] - gap / 2 && lx < span[1] + gap / 2)) return false;
    for (let k = isNew ? r : r + 1; k < rows.length; k++) if (rows[k]!.spans.some(([a, b]) => x > a - gap / 2 && x < b + gap / 2)) return false;
    return true;
  };
  const placedRow = new Map<number, Row>();
  for (const g of groups.sort((a, b) => a.x - b.x)) {
    const w = labelWidth(g.label);
    const spanOf = (x: number, flip: boolean): [number, number] => (flip ? [x - gap - w, x] : [x, x + gap + w]);
    // Carrier lines and sides, best first: the group's first line, right of it unless that crosses the right edge.
    const options = g.members.flatMap((i) => {
      const x = out[i]!.x;
      const natural = x + gap + w > right;
      const inside = (flip: boolean) => (flip ? x - gap - w >= box.left - 0.5 : x + gap + w <= right + 0.5);
      return [natural, !natural].filter((flip) => inside(flip)).map((flip) => ({ i, x, flip }));
    });
    if (options.length === 0) options.push({ i: g.members[0]!, x: out[g.members[0]!]!.x, flip: g.x + gap + w > right });
    const upper = rows.filter((r) => !r.free).length;
    // Existing upper rows, a new upper row, existing free rows, a new free row.
    const tries: { r: number; isNew: boolean; free: boolean }[] = [
      ...rows.slice(0, upper).map((_, r) => ({ r, isNew: false, free: false })),
      { r: upper, isNew: true, free: false },
      ...rows.slice(upper).map((_, k) => ({ r: upper + k, isNew: false, free: true })),
      { r: rows.length, isNew: true, free: true },
    ];
    let pick: { r: number; isNew: boolean; free: boolean; o: (typeof options)[number] } | undefined;
    for (const t of tries) {
      const o = options.find((o) => fits(t.r, t.isNew, t.free, spanOf(o.x, o.flip), o.x));
      if (o !== undefined) {
        pick = { ...t, o };
        break;
      }
    }
    pick ??= { r: rows.length, isNew: true, free: true, o: options[0]! };
    if (pick.isNew) rows.splice(pick.r, 0, { free: pick.free, spans: [], lines: [] });
    const row = rows[pick.r]!;
    row.spans.push(spanOf(pick.o.x, pick.o.flip));
    row.lines.push(pick.o.x);
    for (const i of g.members) {
      Object.assign(out[i]!, { flip: pick.o.flip, labelled: i === pick.o.i });
      placedRow.set(i, row);
    }
  }
  for (const [i, row] of placedRow) Object.assign(out[i]!, { row: rows.indexOf(row), underLegend: row.free && blocked.length > 0 ? true : undefined });
  for (const p of out) if (p.underLegend === undefined) delete p.underLegend;
  return out;
}

/**
 * Draws the placed event lines and their labels in the lane above `box`
 * (rows of `LANE_ROW_PX`, the bottom one `LANE_GAP_PX` above the plot
 * area), keeping upper-row labels clear of `blocked` (the legend).
 * Returns what was drawn (for probes and tests).
 */
export function drawEventLines(
  ctx: Ctx2D,
  markers: readonly EventMarker[],
  toX: (t: number) => number,
  box: Box,
  style: EventLineStyle,
  blocked: readonly (readonly [number, number])[] = [],
): DrawnEvent[] {
  const r = style.pxRatio;
  ctx.save();
  ctx.font = style.font;
  const placed = placeEvents(markers, toX, box, (s) => ctx.measureText(s).width, 4 * r, blocked);
  const rowH = LANE_ROW_PX * r;
  const laneBottom = box.top - LANE_GAP_PX * r;
  const n = laneOf(placed).rows;
  const bottom = box.top + box.height;
  const tickH = TICK_PX * r;
  // Run colours (merged positions drop theirs) and how many runs the plot has.
  const colorOf = new Map<string, string>();
  for (const m of markers) if (m.run !== undefined && m.color !== undefined && !colorOf.has(m.run)) colorOf.set(m.run, m.color);
  const runs = new Set(markers.map((m) => m.run ?? ""));
  const ticks = runs.size > 1;
  const drawn: DrawnEvent[] = placed.map((e) => {
    const labelTop = e.labelled ? laneBottom - (n - e.row) * rowH : null;
    const lineTop = labelTop !== null ? labelTop + rowH : bottom - tickH * Math.max(1, e.runs.length);
    return { ...e, labelTop, lineTop, plotTop: box.top, mark: e.labelled ? "line" : "tick" };
  });
  ctx.lineWidth = r;
  ctx.setLineDash([4 * r, 4 * r]);
  for (const e of drawn) {
    if (e.mark !== "line") continue;
    // One marker per event: neutral when several runs share the event name, else the run's colour.
    const several = placed.filter((p) => p.label === e.label).reduce((k, p) => k + Math.max(1, p.runs.length), 0) > 1;
    ctx.strokeStyle = several ? style.stroke : (e.color ?? style.stroke);
    ctx.beginPath();
    ctx.moveTo(e.x, e.lineTop);
    ctx.lineTo(e.x, bottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (ticks) {
    // Each run's own time of each event: a solid tick on the time axis in the run's colour (stacked when shared).
    ctx.lineWidth = 2 * r;
    for (const e of drawn) {
      const ids = e.runs.length > 0 ? e.runs : [""];
      for (const [k, id] of ids.entries()) {
        ctx.strokeStyle = colorOf.get(id) ?? e.color ?? style.stroke;
        ctx.beginPath();
        ctx.moveTo(e.x, bottom - tickH * k);
        ctx.lineTo(e.x, bottom - tickH * (k + 1));
        ctx.stroke();
      }
    }
  }
  ctx.fillStyle = style.text;
  ctx.textBaseline = "top";
  for (const e of drawn) {
    if (e.labelTop === null) continue;
    ctx.textAlign = e.flip ? "right" : "left";
    ctx.fillText(e.label, e.flip ? e.x - 4 * r : e.x + 4 * r, e.labelTop + 2 * r);
  }
  ctx.restore();
  return drawn;
}
