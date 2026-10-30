/**
 * Page 03 motor graphics (concepts.md §4.3): the thrust curve from the motor
 * file (`Thrust (N)` against `Time (s)`, teal), the SVG casing fallback at the
 * motor's proportions (the render is `CasingView`), the rocket silhouette with the aft mount in teal, and
 * the small casing thumbnail of the motor rows. SVG from the curve and the
 * evaluated model; nothing illustrative.
 */
import { useId } from "react";
import type { EvaluatedModel, schema } from "@rw/contracts";
import { formatLength } from "../assembly/inspector-model.ts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import type { Mount } from "./model.ts";

type Curve = DeepReadonly<schema.ThrustCurve>;

/** Round axis steps (1, 2, 2.5, 5 × 10ⁿ) giving about `n` ticks up to `max`. */
export function niceTicks(max: number, n = 5): number[] {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const step = ([1, 2, 2.5, 5, 10].find((b) => b >= base) ?? 10) * 10 ** exp;
  const out: number[] = [];
  for (let v = 0; v <= max * 1.0001 + step * 0.0001; v += step) out.push(Number(v.toPrecision(10)));
  if (out[out.length - 1]! < max) out.push(Number((out.length * step).toPrecision(10)));
  return out;
}

/** The closed area under a thrust curve, down to the zero-thrust baseline (SVG path; empty for fewer than two points). */
export function thrustAreaPath(pts: readonly { t: number; thrust: number }[], sx: (t: number) => number, sy: (f: number) => number): string {
  if (pts.length < 2) return "";
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.thrust).toFixed(1)}`).join(" ");
  const base = sy(0).toFixed(1);
  return `${line} L${sx(pts[pts.length - 1]!.t).toFixed(1)},${base} L${sx(pts[0]!.t).toFixed(1)},${base} Z`;
}

const fmtTick = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4))));

export function ThrustPlot({ curve, width, height, grid }: { curve: Curve; width: number; height: number; grid: boolean }) {
  const pad = { left: 52, right: 14, top: 12, bottom: 42 };
  const pts = curve.points;
  const tMax = Math.max(...pts.map((p) => p.t), curve.burn_time, 1e-3);
  const fMax = Math.max(...pts.map((p) => p.thrust), 1e-3);
  const xt = niceTicks(tMax, 5);
  const yt = niceTicks(fMax, 4);
  const X = xt[xt.length - 1]!;
  const Y = yt[yt.length - 1]!;
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const sx = (t: number) => pad.left + (t / X) * w;
  const sy = (f: number) => pad.top + h - (f / Y) * h;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.thrust).toFixed(1)}`).join(" ");
  const area = thrustAreaPath(pts, sx, sy);
  const fillId = `rw-thrust-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // The grid is always there, light (R20-03); "Show grid" strengthens it.
  const gridClass = grid ? "rw-thrust__grid" : "rw-thrust__grid-light";
  return (
    <svg className="rw-thrust" data-testid="motor.thrust-curve" data-points={pts.length} data-max={curve.max_thrust.toFixed(2)} data-grid={grid ? "true" : "false"} width={width} height={height} role="img" aria-label={`Thrust curve of ${curve.designation}`}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop className="rw-thrust__fill-top" offset="0" />
          <stop className="rw-thrust__fill-bottom" offset="1" />
        </linearGradient>
      </defs>
      {yt.map((v) => (
        <line key={`gy${v}`} className={gridClass} x1={pad.left} x2={pad.left + w} y1={sy(v)} y2={sy(v)} />
      ))}
      {xt.map((v) => (
        <line key={`gx${v}`} className={gridClass} x1={sx(v)} x2={sx(v)} y1={pad.top} y2={pad.top + h} />
      ))}
      {area !== "" && <path className="rw-thrust__area" data-testid="motor.thrust-area" d={area} fill={`url(#${fillId})`} />}
      <line className="rw-thrust__axis" x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + h} />
      <line className="rw-thrust__axis" x1={pad.left} x2={pad.left + w} y1={pad.top + h} y2={pad.top + h} />
      {yt.map((v) => (
        <text key={`ty${v}`} className="rw-thrust__tick" x={pad.left - 8} y={sy(v) + 4} textAnchor="end">
          {fmtTick(v)}
        </text>
      ))}
      {xt.map((v) => (
        <text key={`tx${v}`} className="rw-thrust__tick" x={sx(v)} y={pad.top + h + 16} textAnchor="middle">
          {fmtTick(v)}
        </text>
      ))}
      <text className="rw-thrust__label" x={pad.left + w / 2} y={height - 6} textAnchor="middle">
        Time (s)
      </text>
      <text className="rw-thrust__label" transform={`translate(14 ${pad.top + h / 2}) rotate(-90)`} textAnchor="middle">
        Thrust (N)
      </text>
      <path className="rw-thrust__line" d={d} />
    </svg>
  );
}

/**
 * A shaded sealed motor casing (metal tube, aft nozzle, fore closure) at the
 * motor's length:diameter, in SVG: the fallback when the studio render
 * (`CasingView`) has no WebGPU.
 */
export function CasingRender({ curve, width, height, style, view }: { curve: Curve; width: number; height: number; style: "realistic" | "flat"; view: string }) {
  const end = view === "front" || view === "rear";
  const aspect = Math.max(1.5, curve.length / Math.max(curve.diameter, 1e-3));
  const len = Math.min(width * 0.78, (height * 0.62) * aspect);
  const dia = len / aspect;
  const cx = width / 2;
  const cy = height / 2;
  const tilt = view === "iso" ? -14 : 0;
  const metal = style === "realistic";
  const id = `rw-casing-${style}`;
  return (
    <svg className="rw-casing" data-testid="motor.casing" data-style={style} data-view={view} width={width} height={height} role="img" aria-label={`${curve.designation} casing`}>
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={metal ? "#5f666a" : "#9aa3a8"} />
          <stop offset="0.22" stopColor={metal ? "#e9eef0" : "#9aa3a8"} />
          <stop offset="0.45" stopColor={metal ? "#b7bec2" : "#9aa3a8"} />
          <stop offset="0.8" stopColor={metal ? "#6c7377" : "#9aa3a8"} />
          <stop offset="1" stopColor={metal ? "#3c4245" : "#9aa3a8"} />
        </linearGradient>
        <radialGradient id={`${id}-end`} cx="0.45" cy="0.4" r="0.7">
          <stop offset="0" stopColor={metal ? "#d7dde0" : "#b4bcc0"} />
          <stop offset="1" stopColor={metal ? "#62696d" : "#8a9397"} />
        </radialGradient>
        <radialGradient id={`${id}-shadow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#000" stopOpacity="0.45" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      {end ? (
        <g>
          <ellipse cx={cx} cy={cy + dia * 0.62} rx={dia * 0.6} ry={dia * 0.12} fill={`url(#${id}-shadow)`} />
          <circle cx={cx} cy={cy} r={dia / 2} fill={`url(#${id}-end)`} stroke="#2a3034" />
          <circle cx={cx} cy={cy} r={dia * 0.22} fill="#2a2f32" stroke="#80898d" />
        </g>
      ) : (
        <g transform={`rotate(${tilt} ${cx} ${cy})`}>
          <ellipse cx={cx} cy={cy + dia * 0.75} rx={len * 0.52} ry={dia * 0.16} fill={`url(#${id}-shadow)`} />
          <rect x={cx - len / 2} y={cy - dia / 2} width={len} height={dia} rx={dia * 0.08} fill={`url(#${id}-body)`} />
          {/* Fore closure and aft nozzle end. */}
          <rect x={cx - len / 2} y={cy - dia / 2} width={len * 0.06} height={dia} fill={`url(#${id}-body)`} stroke="#3c4245" strokeWidth={0.8} />
          <ellipse cx={cx + len / 2} cy={cy} rx={dia * 0.18} ry={dia / 2} fill={`url(#${id}-end)`} stroke="#3c4245" strokeWidth={0.8} />
          <ellipse cx={cx + len / 2 + dia * 0.03} cy={cy} rx={dia * 0.08} ry={dia * 0.2} fill="#24292c" />
          <line x1={cx - len / 2 + len * 0.12} x2={cx - len / 2 + len * 0.12} y1={cy - dia / 2} y2={cy + dia / 2} stroke="#3c4245" strokeWidth={0.8} opacity={0.6} />
        </g>
      )}
    </svg>
  );
}

/**
 * Row thumbnail: the rendered motor-mount casing (M3.6 part thumbnail, when
 * cached), else a small casing glyph.
 */
export function CasingThumb({ url }: { url?: string | undefined } = {}) {
  if (url !== undefined) return <img className="rw-motor-thumb" data-testid="motors.thumbnail" data-source="render" src={url} width={22} height={34} style={{ objectFit: "contain" }} alt="" aria-hidden draggable={false} />;
  return (
    <svg className="rw-motor-thumb" width={22} height={34} viewBox="0 0 22 34" aria-hidden>
      <defs>
        <linearGradient id="rw-thumb-metal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6c7377" />
          <stop offset="0.35" stopColor="#e6eaec" />
          <stop offset="0.7" stopColor="#9aa1a5" />
          <stop offset="1" stopColor="#4a5053" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="16" height="27" rx="2" fill="url(#rw-thumb-metal)" />
      <ellipse cx="11" cy="3.5" rx="8" ry="2" fill="#c9cfd2" />
      <rect x="7" y="30" width="8" height="2.5" rx="1" fill="#6c7377" />
    </svg>
  );
}

/**
 * Rocket silhouette (nose up) from the evaluated model's external parts,
 * with the motor mount filled teal and labelled `Motor mount 18 mm`.
 */
export function MountSilhouette({ model, mount, units, height }: { model: DeepReadonly<EvaluatedModel>; mount: Mount | undefined; units: Units; height: number }) {
  const ext = model.components.filter((c) => c.aero && c.containment !== "surface");
  const fins = model.components.filter((c) => c.containment === "surface" && c.shape.type.endsWith("fin_set"));
  const L = Math.max(...model.components.map((c) => c.x_aft), 1e-3);
  const R = Math.max(...ext.map((c) => ((c.shape as { od?: number }).od ?? 0) / 2), 1e-3);
  const finR = Math.max(R, ...fins.flatMap((f) => f.anchors.map((a) => a.r)));
  const k = (height - 56) / L;
  const W = Math.max(60, finR * k * 2 + 24);
  const cx = W / 2;
  const y = (x: number) => 6 + x * k;
  const body: string[] = [];
  for (const c of ext) {
    const s = c.shape as { type: string; od?: number; fore_od?: number; aft_od?: number };
    const rf = (s.type === "nose_cone" ? 0 : (s.fore_od ?? s.od ?? 0) / 2) * k;
    const ra = ((s.aft_od ?? s.od ?? 0) / 2) * k;
    body.push(`M${cx - rf},${y(c.x_fore)} L${cx + rf},${y(c.x_fore)} L${cx + ra},${y(c.x_aft)} L${cx - ra},${y(c.x_aft)} Z`);
  }
  const finPaths = fins.flatMap((f) => {
    const a = (n: string) => f.anchors.find((x) => x.name === n);
    const rle = a("root_le");
    const rte = a("root_te");
    const tle = a("tip_le");
    const tte = a("tip_te");
    if (!rle || !rte || !tle || !tte) return [];
    return [1, -1].map((sgn) => `M${cx + sgn * rle.r * k},${y(rle.x)} L${cx + sgn * tle.r * k},${y(tle.x)} L${cx + sgn * tte.r * k},${y(tte.x)} L${cx + sgn * rte.r * k},${y(rte.x)} Z`);
  });
  const mr = mount ? (mount.diameter / 2) * k : 0;
  return (
    <figure className="rw-silhouette" data-testid="motor.silhouette" data-mount={mount?.id ?? ""} style={{ width: W + 40 }}>
      <svg width={W} height={height - 40} role="img" aria-label="Rocket with the motor mount highlighted">
        {body.map((d, i) => (
          <path key={`b${i}`} d={d} className="rw-silhouette__body" />
        ))}
        {finPaths.map((d, i) => (
          <path key={`f${i}`} d={d} className="rw-silhouette__body" />
        ))}
        {mount && <rect className="rw-silhouette__mount" data-testid="motor.mount-highlight" x={cx - mr} y={y(mount.x_fore)} width={2 * mr} height={(mount.x_aft - mount.x_fore) * k} rx={1} />}
      </svg>
      {mount && (
        <figcaption className="rw-silhouette__label">
          Motor mount
          <br />
          {formatLength(mount.nominal, units)}
        </figcaption>
      )}
    </figure>
  );
}
