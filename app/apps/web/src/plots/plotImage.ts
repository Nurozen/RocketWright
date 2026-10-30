/**
 * A Results plot as a PNG (the broker's `plot_render`, CPW2A): the same
 * uPlot time plot the Results page draws (`timePlotOptions`), mounted
 * off-screen at the requested size, then composited with its title, direct
 * legend and axis titles onto one canvas in the page's colours. Needs a DOM
 * (the window); the run data and lines come from `broker/plot.ts`.
 */
import uPlot from "uplot";
import { laneHeight, laneOf, type Lane } from "./eventLines.ts";
import type { EventMarker } from "./events.ts";
import { alignLines, plotTokens, timePlotOptions, type PlotLine, type PlotTokens } from "./TimePlot.tsx";

export interface PlotLegendEntry {
  label: string;
  color: string;
  /** Drawn as the event-lines key (an outlined swatch). */
  events?: boolean;
}

export interface PlotImageSpec {
  /** The tab's name: `Altitude`. */
  title: string;
  yLabel: string;
  xLabel: string;
  lines: readonly PlotLine[];
  events: readonly EventMarker[];
  legend: readonly PlotLegendEntry[];
  /** Output size (image px). */
  width: number;
  height: number;
}

export interface PlotImage {
  png_base64: string;
  width: number;
  height: number;
}

/** The plot's layout in CSS px (logical size `width / scale`). Pure, for tests. */
export interface PlotLayout {
  /** Image px per CSS px. */
  scale: number;
  width: number;
  height: number;
  pad: number;
  titleY: number;
  legendY: number;
  plot: { left: number; top: number; width: number; height: number };
  yTitleX: number;
  xTitleY: number;
}

/** Text sizes compared with the Results page: an image wider than this is drawn larger, not with smaller text. */
export const LOGICAL_MAX_WIDTH = 900;

export function plotLayout(width: number, height: number): PlotLayout {
  const scale = Math.max(1, width / LOGICAL_MAX_WIDTH);
  const w = width / scale;
  const h = height / scale;
  const pad = 16;
  const titleY = pad;
  const legendY = titleY + 26;
  const top = legendY + 24;
  const left = pad + 22;
  const bottom = h - pad - 20;
  return {
    scale,
    width: w,
    height: h,
    pad,
    titleY,
    legendY,
    plot: { left, top, width: Math.max(1, w - left - pad), height: Math.max(1, bottom - top) },
    yTitleX: pad + 6,
    xTitleY: h - pad - 6,
  };
}

/** Draws `u` once (uPlot commits in a microtask) and resolves after its draw hook ran. */
function drawn(make: (onDraw: () => void) => uPlot, timeoutMs = 2_000): Promise<uPlot> {
  return new Promise((resolve, reject) => {
    let plot: uPlot | null = null;
    let done = false;
    const finish = () => {
      if (done || plot === null) return;
      done = true;
      clearTimeout(timer);
      resolve(plot);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      plot?.destroy();
      reject(new Error("the plot did not draw"));
    }, timeoutMs);
    plot = make(() => queueMicrotask(finish));
  });
}

function legendRow(ctx: CanvasRenderingContext2D, entries: readonly PlotLegendEntry[], x: number, y: number, maxX: number, tk: PlotTokens): void {
  ctx.font = `13px ${tk.font}`;
  ctx.textBaseline = "middle";
  let cx = x;
  for (const e of entries) {
    const w = ctx.measureText(e.label).width;
    if (cx + 18 + w > maxX) break;
    if (e.events === true) {
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(cx + 0.75, y - 5.25, 10.5, 10.5);
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = e.color;
      ctx.fillRect(cx, y - 1.5, 12, 3);
    }
    ctx.fillStyle = tk.textPrimary;
    ctx.fillText(e.label, cx + 18, y);
    cx += 18 + w + 20;
  }
}

/** Renders `spec` to a PNG (see the module comment). */
export async function renderPlotImage(spec: PlotImageSpec, doc: Document = document): Promise<PlotImage> {
  const L = plotLayout(spec.width, spec.height);
  const tk = plotTokens(doc.documentElement);
  // Off-screen, not hidden: uPlot sizes from the options, and the canvas must paint.
  const host = doc.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${L.plot.width}px;height:${L.plot.height}px;pointer-events:none;`;
  doc.body.appendChild(host);
  try {
    const data = alignLines(spec.lines);
    let lane: Lane = { rows: spec.events.length > 0 ? 1 : 0, free: 0 };
    let plot: uPlot | null = null;
    // A second pass only when the event labels need another lane height than reserved.
    for (let pass = 0; pass < 2; pass++) {
      let need: Lane = lane;
      plot?.destroy();
      plot = await drawn(
        (onDraw) =>
          new uPlot(
            timePlotOptions({
              width: L.plot.width,
              height: L.plot.height,
              tokens: tk,
              lines: spec.lines,
              events: spec.events,
              top: Math.max(8, spec.events.length > 0 ? laneHeight(lane) : 0),
              onDraw: (placed) => {
                need = laneOf(placed);
                onDraw();
              },
            }),
            data,
            host,
          ),
      );
      if (need.rows === lane.rows && need.free === lane.free) break;
      lane = need;
    }
    const src = plot!.ctx.canvas;
    const out = doc.createElement("canvas");
    out.width = spec.width;
    out.height = spec.height;
    const ctx = out.getContext("2d");
    if (ctx === null) throw new Error("no 2D canvas in this window");
    ctx.scale(L.scale, L.scale);
    ctx.fillStyle = tk.background;
    ctx.fillRect(0, 0, L.width, L.height);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = tk.textPrimary;
    ctx.font = `600 16px ${tk.font}`;
    ctx.fillText(spec.title, L.pad, L.titleY);
    legendRow(ctx, spec.legend, L.pad, L.legendY + 8, L.width - L.pad, tk);
    ctx.drawImage(src, L.plot.left, L.plot.top, L.plot.width, L.plot.height);
    ctx.fillStyle = tk.textSecondary;
    ctx.font = `12px ${tk.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(spec.xLabel, L.plot.left + L.plot.width / 2, L.xTitleY);
    ctx.save();
    ctx.translate(L.yTitleX, L.plot.top + L.plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "top";
    ctx.fillText(spec.yLabel, 0, 0);
    ctx.restore();
    plot!.destroy();
    const url = out.toDataURL("image/png");
    const comma = url.indexOf(",");
    if (!url.startsWith("data:image/png") || comma < 0) throw new Error("the plot canvas did not encode a PNG");
    return { png_base64: url.slice(comma + 1), width: spec.width, height: spec.height };
  } finally {
    host.remove();
  }
}
