/**
 * The editor's live part preview (concept 02 "Fin profile (side view)"):
 * a fin set's planform dimensioned with tip chord, root chord, and span from
 * the fields; other parts get their side silhouette with length and outer
 * diameter. Pure SVG from the evaluated shape (draft preview while editing).
 */
import type { schema } from "@rw/contracts";
import { formatLength } from "../assembly/inspector-model.ts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { freeformPoints } from "./FinOutlineEditor.tsx";

type Comp = DeepReadonly<schema.EvalComponent>;

const W = 270;
const H = 190;
const PAD = { left: 26, right: 84, top: 30, bottom: 34 };

export interface Planform {
  rootChord: number;
  tipChord: number;
  span: number;
  sweep: number;
}

export function planformOf(c: Comp): Planform | null {
  const s = c.shape as { type: string; root_chord?: number; tip_chord?: number; span?: number; sweep?: number };
  if (typeof s.root_chord !== "number" || typeof s.span !== "number") return null;
  return { rootChord: s.root_chord, tipChord: s.tip_chord ?? 0, span: s.span, sweep: s.sweep ?? (s.root_chord - (s.tip_chord ?? 0)) / 2 };
}

/** Planform polygon in px (root along the bottom, LE at the left) and its scale. */
export function planformLayout(p: Planform, w = W, h = H) {
  const reachX = Math.max(p.rootChord, p.sweep + p.tipChord, 1e-6) - Math.min(0, p.sweep);
  const k = Math.min((w - PAD.left - PAD.right) / reachX, (h - PAD.top - PAD.bottom) / Math.max(p.span, 1e-6));
  const x0 = PAD.left - Math.min(0, p.sweep) * k;
  const yRoot = h - PAD.bottom;
  const yTip = yRoot - p.span * k;
  const pts: [number, number][] = [
    [x0, yRoot],
    [x0 + p.sweep * k, yTip],
    [x0 + (p.sweep + p.tipChord) * k, yTip],
    [x0 + p.rootChord * k, yRoot],
  ];
  return { pts, k, x0, yRoot, yTip };
}

function DimH({ x1, x2, y, label, testid }: { x1: number; x2: number; y: number; label: string; testid: string }) {
  return (
    <g data-testid={testid}>
      <line className="rw-part__dim" x1={x1} y1={y} x2={x2} y2={y} markerStart="url(#rw-part-arrow)" markerEnd="url(#rw-part-arrow)" />
      <line className="rw-part__tick" x1={x1} y1={y - 5} x2={x1} y2={y + 5} />
      <line className="rw-part__tick" x1={x2} y1={y - 5} x2={x2} y2={y + 5} />
      <text className="rw-part__text" x={(x1 + x2) / 2} y={y - 6} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** A freeform outline in px (root along the bottom, root LE at the left) with its root chord and span. */
export function outlineLayout(points: readonly (readonly [number, number])[], w = W, h = H) {
  const xs = points.map((p) => p[0]);
  const x0 = Math.min(0, ...xs);
  const reachX = Math.max(1e-6, Math.max(...xs) - x0);
  const span = Math.max(1e-6, ...points.map((p) => p[1]));
  const k = Math.min((w - PAD.left - PAD.right) / reachX, (h - PAD.top - PAD.bottom) / span);
  const left = PAD.left - x0 * k;
  const yRoot = h - PAD.bottom;
  const pts = points.map(([x, y]) => [left + x * k, yRoot - y * k] as [number, number]);
  // Root chord: from the root LE (first point) to the aftmost point on the root.
  const rootX = points.filter((p) => Math.abs(p[1]) <= 1e-9).map((p) => p[0]);
  const root = rootX.length > 0 ? Math.max(...rootX) - (points[0]?.[0] ?? 0) : reachX;
  return { pts, k, left, yRoot, yTip: yRoot - span * k, span, root, xRoot0: left + (points[0]?.[0] ?? 0) * k, xRoot1: left + ((points[0]?.[0] ?? 0) + root) * k, xMax: left + Math.max(...xs) * k };
}

export function PartProfile({ comp, units }: { comp: Comp; units: Units }) {
  const outline = freeformPoints(comp);
  const plan = outline === null ? planformOf(comp) : null;
  const fin = (plan !== null || outline !== null) && comp.shape.type.endsWith("fin_set");
  return (
    <figure className="rw-part" data-testid="editor.profile" data-kind={fin ? "fin" : "part"}>
      <figcaption className="rw-part__title">{fin ? "Fin profile (side view)" : "Profile (side view)"}</figcaption>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={fin ? "Fin planform" : "Part profile"}>
        <defs>
          <marker id="rw-part-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
          </marker>
          <linearGradient id="rw-part-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9cfd2" />
            <stop offset="1" stopColor="#9aa3a8" />
          </linearGradient>
        </defs>
        {outline !== null && outline.length >= 3 ? <FreeformDrawing points={outline} units={units} /> : fin && plan !== null ? <FinDrawing p={plan} units={units} /> : <BodyDrawing comp={comp} units={units} />}
      </svg>
    </figure>
  );
}

function FinDrawing({ p, units }: { p: Planform; units: Units }) {
  const L = planformLayout(p);
  const [rle, tle, tte, rte] = L.pts;
  const xSpan = Math.max(rte![0], tte![0]) + 22;
  return (
    <g data-root={p.rootChord.toFixed(4)} data-tip={p.tipChord.toFixed(4)} data-span={p.span.toFixed(4)} data-sweep={p.sweep.toFixed(4)}>
      <polygon className="rw-part__shape" points={L.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />
      <DimH x1={tle![0]} x2={tte![0]} y={L.yTip - 12} label={formatLength(p.tipChord, units)} testid="editor.profile-tip" />
      <DimH x1={rle![0]} x2={rte![0]} y={L.yRoot + 16} label={formatLength(p.rootChord, units)} testid="editor.profile-root" />
      <g data-testid="editor.profile-span">
        <line className="rw-part__dim" x1={xSpan} y1={L.yRoot} x2={xSpan} y2={L.yTip} markerStart="url(#rw-part-arrow)" markerEnd="url(#rw-part-arrow)" />
        <line className="rw-part__tick" x1={xSpan - 5} y1={L.yTip} x2={xSpan + 5} y2={L.yTip} />
        <line className="rw-part__tick" x1={xSpan - 5} y1={L.yRoot} x2={xSpan + 5} y2={L.yRoot} />
        <text className="rw-part__text" x={xSpan + 8} y={(L.yRoot + L.yTip) / 2 + 4}>
          {formatLength(p.span, units)}
        </text>
      </g>
    </g>
  );
}

function FreeformDrawing({ points, units }: { points: readonly (readonly [number, number])[]; units: Units }) {
  const L = outlineLayout(points);
  const xSpan = L.xMax + 22;
  return (
    <g data-testid="editor.profile-outline" data-points={points.length} data-root={L.root.toFixed(4)} data-span={L.span.toFixed(4)}>
      <polygon className="rw-part__shape" points={L.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />
      <DimH x1={L.xRoot0} x2={L.xRoot1} y={L.yRoot + 16} label={formatLength(L.root, units)} testid="editor.profile-root" />
      <g data-testid="editor.profile-span">
        <line className="rw-part__dim" x1={xSpan} y1={L.yRoot} x2={xSpan} y2={L.yTip} markerStart="url(#rw-part-arrow)" markerEnd="url(#rw-part-arrow)" />
        <line className="rw-part__tick" x1={xSpan - 5} y1={L.yTip} x2={xSpan + 5} y2={L.yTip} />
        <line className="rw-part__tick" x1={xSpan - 5} y1={L.yRoot} x2={xSpan + 5} y2={L.yRoot} />
        <text className="rw-part__text" x={xSpan + 8} y={(L.yRoot + L.yTip) / 2 + 4}>
          {formatLength(L.span, units)}
        </text>
      </g>
    </g>
  );
}

function BodyDrawing({ comp, units }: { comp: Comp; units: Units }) {
  const s = comp.shape as { type: string; od?: number; fore_od?: number; aft_od?: number; length?: number };
  const len = Math.max(comp.x_aft - comp.x_fore, s.length ?? 0, 1e-6);
  const foreR = (s.type === "nose_cone" ? 0 : (s.fore_od ?? s.od ?? 0)) / 2;
  const aftR = (s.aft_od ?? s.od ?? 0) / 2;
  const r = Math.max(foreR, aftR, 1e-6);
  const k = Math.min((W - PAD.left - PAD.right) / len, (H - PAD.top - PAD.bottom) / (2 * r));
  const x0 = PAD.left;
  const yc = (H - PAD.bottom + PAD.top) / 2;
  const x1 = x0 + len * k;
  const pts: [number, number][] =
    s.type === "nose_cone"
      ? Array.from({ length: 17 }, (_, i) => {
          const t = i / 16;
          // Tangent-ogive-like silhouette for the preview.
          const rr = aftR * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2));
          return [x0 + t * len * k, yc - rr * k] as [number, number];
        }).concat(
          Array.from({ length: 17 }, (_, i) => {
            const t = 1 - i / 16;
            const rr = aftR * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2));
            return [x0 + t * len * k, yc + rr * k] as [number, number];
          }),
        )
      : [
          [x0, yc - foreR * k],
          [x1, yc - aftR * k],
          [x1, yc + aftR * k],
          [x0, yc + foreR * k],
        ];
  return (
    <g>
      <polygon className="rw-part__shape" points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} />
      <DimH x1={x0} x2={x1} y={yc + r * k + 16} label={formatLength(len, units)} testid="editor.profile-length" />
      <g data-testid="editor.profile-od">
        <line className="rw-part__dim" x1={x1 + 18} y1={yc + aftR * k} x2={x1 + 18} y2={yc - aftR * k} markerStart="url(#rw-part-arrow)" markerEnd="url(#rw-part-arrow)" />
        <text className="rw-part__text" x={x1 + 26} y={yc + 4}>
          ⌀ {formatLength(2 * aftR, units)}
        </text>
      </g>
    </g>
  );
}
