/**
 * Page 06 visual flow traces (M5.3): "Relative flow" and "Relative fill"
 * over normalized time (0..1), each with a cursor at the transport time
 * (`t / duration`, the same store the stage reads). SVG, token colours.
 * The values come from the study's `visual.json` (provenance visual, I13).
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import type { TransportStore } from "./transport.tsx";

export interface TracePlotProps {
  id: "flow" | "fill";
  title: string;
  points: readonly [number, number][];
  /** Cursor at normalized time 0..1. */
  cursor: number;
}

/** Plot box in the SVG's own units (the SVG scales to its box). */
export const PLOT = { w: 400, h: 120, left: 34, right: 10, top: 8, bottom: 34 } as const;

export const xOf = (u: number) => PLOT.left + Math.min(1, Math.max(0, u)) * (PLOT.w - PLOT.left - PLOT.right);
export const yOf = (v: number) => PLOT.top + (1 - Math.min(1, Math.max(0, v))) * (PLOT.h - PLOT.top - PLOT.bottom);

/** SVG path through the samples. */
export function tracePath(points: readonly [number, number][]): string {
  return points.map(([u, v], i) => `${i === 0 ? "M" : "L"}${xOf(u).toFixed(2)},${yOf(v).toFixed(2)}`).join("");
}

export function TracePlot({ id, title, points, cursor }: TracePlotProps) {
  const d = useMemo(() => tracePath(points), [points]);
  const cx = xOf(cursor);
  return (
    <figure className="rw-trace" data-testid="visual.trace" data-trace={id} data-cursor={cursor.toFixed(4)} data-points={points.length}>
      <figcaption className="rw-trace__title">{title}</figcaption>
      <svg className="rw-trace__plot" viewBox={`0 0 ${PLOT.w} ${PLOT.h}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label={`${title} over normalized time`}>
        {[0, 0.5, 1].map((v) => (
          <g key={`y${v}`}>
            <text className="rw-trace__tick" x={PLOT.left - 6} y={yOf(v) + 3.5} textAnchor="end">
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        <line className="rw-trace__axis" x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={yOf(0)} />
        <line className="rw-trace__axis" x1={PLOT.left} y1={yOf(0)} x2={PLOT.w - PLOT.right} y2={yOf(0)} />
        {[0, 0.25, 0.5, 0.75, 1].map((u) => (
          <line key={`t${u}`} className="rw-trace__axis" x1={xOf(u)} y1={yOf(0)} x2={xOf(u)} y2={yOf(0) + 4} />
        ))}
        {[0, 0.5, 1].map((u) => (
          <text key={`x${u}`} className="rw-trace__tick" x={xOf(u)} y={yOf(0) + 15} textAnchor="middle">
            {u.toFixed(1)}
          </text>
        ))}
        <text className="rw-trace__label" x={(PLOT.left + PLOT.w - PLOT.right) / 2} y={PLOT.h - 3} textAnchor="middle">
          Normalized time
        </text>
        <path className="rw-trace__line" d={d} />
        <line className="rw-trace__cursor" data-testid="visual.trace-cursor" x1={cx} y1={PLOT.top} x2={cx} y2={yOf(0)} />
      </svg>
    </figure>
  );
}

export function Traces({ store, flow, fill }: { store: TransportStore; flow: readonly [number, number][]; fill: readonly [number, number][] }) {
  const t = useStore(store, (s) => s.t);
  const duration = useStore(store, (s) => s.duration);
  const cursor = duration > 0 ? t / duration : 0;
  return (
    <div className="rw-traces" data-testid="visual.traces">
      <TracePlot id="flow" title="Relative flow" points={flow} cursor={cursor} />
      <TracePlot id="fill" title="Relative fill" points={fill} cursor={cursor} />
    </div>
  );
}
