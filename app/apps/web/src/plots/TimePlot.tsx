/**
 * Time plot (uPlot 1.6.32) for run series: one line per run on a shared time
 * axis, Canvas2D event lines from the `draw` hook with their labels in a lane
 * above the plot area (its top padding grows to the rows the labels need,
 * clear of the legend), DOM axis titles, and a DOM direct legend drawn by the
 * caller. Colours come from the design tokens on the host element (no
 * literal colours in CSS).
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { drawEventLines, laneHeight, laneOf, type DrawnEvent, type Lane } from "./eventLines.ts";
import type { EventMarker } from "./events.ts";
import { fmtNum } from "./quantities.ts";

export interface PlotLine {
  id: string;
  label: string;
  color: string;
  t: readonly number[];
  y: readonly number[];
}

export interface TimePlotProps {
  lines: readonly PlotLine[];
  events: readonly EventMarker[];
  yLabel: string;
  xLabel?: string;
  /** Called after every redraw with the event lines as drawn (CSS px). */
  onDrawn?: (events: DrawnEvent[]) => void;
  /** Least space above the plot area (CSS px), e.g. for a direct legend. */
  topInset?: number;
  /** An element over the canvas top (the direct legend) that event labels must not cover. */
  avoid?: RefObject<HTMLElement | null>;
}

/** Token fallbacks (tokens.css values) for environments without computed styles. */
const FALLBACK = { line: "#2a3034", textSecondary: "#8e989c", textPrimary: "#e6e9ea", font: "Inter", background: "#1b1e20" };

export type PlotTokens = typeof FALLBACK;

/** The plot's design tokens as computed on `el` (tokens.css fallbacks). */
export function plotTokens(el: Element): PlotTokens {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    line: v("--rw-line", FALLBACK.line),
    textSecondary: v("--rw-text-secondary", FALLBACK.textSecondary),
    textPrimary: v("--rw-text-primary", FALLBACK.textPrimary),
    font: v("--rw-font-sans", FALLBACK.font),
    background: v("--rw-bg-canvas", FALLBACK.background),
  };
}

/** Joins per-run (t, y) tables onto one sorted time axis (uPlot aligned data; gaps are null). */
export function alignLines(lines: readonly PlotLine[]): uPlot.AlignedData {
  if (lines.length === 0) return [[]];
  const tables = lines.map((l) => [Array.from(l.t), Array.from(l.y)] as uPlot.AlignedData);
  return lines.length === 1 ? tables[0]! : uPlot.join(tables);
}

const Y_RANGE: uPlot.Range.Config = { min: { pad: 0.1, soft: 0, mode: 3 }, max: { pad: 0.1, soft: 0, mode: 3 } };

/** The y minimum to range from: 0 when the data dips below zero by under 5 % of its maximum. */
export function yFloor(min: number, max: number): number {
  return min < 0 && min >= -0.05 * Math.abs(max) ? 0 : min;
}

export interface TimePlotOptionsInput {
  /** Plot size (CSS px). */
  width: number;
  height: number;
  tokens: PlotTokens;
  lines: readonly PlotLine[];
  events: readonly EventMarker[];
  /** Space above the plot area (CSS px): the event-label lane and any legend. */
  top: number;
  /** Canvas x spans (device px) upper-row event labels avoid (the legend). */
  blocked?: () => [number, number][];
  /** After each redraw, with the event lines as drawn (device px). */
  onDraw?: (placed: DrawnEvent[]) => void;
}

/** The uPlot options of a time plot: axes, scales, series and the event-line `draw` hook (shared by `TimePlot` and `renderPlotImage`). */
export function timePlotOptions(o: TimePlotOptionsInput): uPlot.Options {
  const { tokens: tk, lines, events } = o;
  const axisFont = `12px ${tk.font}`;
  const axis = (size: number): uPlot.Axis => ({
    stroke: tk.textSecondary,
    font: axisFont,
    size,
    gap: 6,
    grid: { stroke: tk.line, width: 1 },
    ticks: { stroke: tk.line, width: 1, size: 4 },
    values: (_u, splits) => splits.map((v) => fmtNum(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0)),
  });
  return {
    width: o.width,
    height: o.height,
    padding: [o.top, 16, 0, 0],
    legend: { show: false },
    cursor: { drag: { x: false, y: false }, points: { size: 6 } },
    scales: {
      x: { time: false },
      // A flight that ends a hair below the pad (landing interpolation) still plots from 0, not a padded -20.
      y: { range: (_u, min, max) => uPlot.rangeNum(yFloor(min, max), max, Y_RANGE) },
    },
    axes: [axis(32), axis(52)],
    series: [{ label: "t" }, ...lines.map((l) => ({ label: l.label, stroke: l.color, width: 2, spanGaps: true, points: { show: false } }))],
    hooks: {
      draw: [
        (u) => {
          const px = uPlot.pxRatio;
          const placed = drawEventLines(
            u.ctx,
            events,
            (t) => u.valToPos(t, "x", true),
            u.bbox,
            { stroke: tk.textSecondary, text: tk.textPrimary, pxRatio: px, font: `${Math.round(12 * px)}px ${tk.font}` },
            o.blocked?.() ?? [],
          );
          o.onDraw?.(placed);
        },
      ],
    },
  };
}

export function TimePlot({ lines, events, yLabel, xLabel = "Time (s)", onDrawn, topInset = 14, avoid }: TimePlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const drawnRef = useRef(onDrawn);
  drawnRef.current = onDrawn;
  // The label lane the plot reserves; corrected after a draw that needs another
  // (placement depends only on x positions and the legend, so one correction settles it).
  const [laneKey, setLaneKey] = useState("1/0");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tk = plotTokens(host);
    const [rows, free] = laneKey.split("/").map(Number);
    let reserved = laneKey;
    // The legend's box relative to the canvas (CSS px), or null.
    const legend = () => {
      const el = avoid?.current;
      if (!el) return null;
      const h = host.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > h.top ? { left: r.left - h.left, right: r.right - h.left, bottom: r.bottom - h.top } : null;
    };
    const lane: Lane = { rows: rows ?? 0, free: free ?? 0 };
    const top = Math.max(topInset, events.length > 0 ? laneHeight(lane, legend()?.bottom ?? 0) : 0);
    const opts = timePlotOptions({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      tokens: tk,
      lines,
      events,
      top,
      blocked: () => {
        const box = legend();
        return box ? [[box.left * uPlot.pxRatio, box.right * uPlot.pxRatio]] : [];
      },
      onDraw: (placed) => {
        const px = uPlot.pxRatio;
        drawnRef.current?.(
          placed.map((e) => ({ ...e, x: e.x / px, labelTop: e.labelTop === null ? null : e.labelTop / px, lineTop: e.lineTop / px, plotTop: e.plotTop / px })),
        );
        const need = laneOf(placed);
        const key = `${need.rows}/${need.free}`;
        if (events.length > 0 && key !== reserved) {
          reserved = key;
          queueMicrotask(() => setLaneKey(key));
        }
      },
    });
    const plot = new uPlot(opts, alignLines(lines), host);
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      if (w !== plot.width || h !== plot.height) plot.setSize({ width: w, height: h });
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [lines, events, topInset, laneKey, avoid]);

  return (
    <div className="rw-timeplot">
      <span className="rw-timeplot__ytitle" data-testid="plot.axis" data-axis="y">
        {yLabel}
      </span>
      <div className="rw-timeplot__canvas" ref={hostRef} data-testid="plot.canvas" />
      <span className="rw-timeplot__xtitle" data-testid="plot.axis" data-axis="x">
        {xLabel}
      </span>
    </div>
  );
}
