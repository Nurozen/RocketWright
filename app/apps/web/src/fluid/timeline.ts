/**
 * A visual flow study's timeline (`runs/<study>/<run>/visual.json`,
 * `VisualRun`, M5.1) sampled at the transport time: the vehicle tilt, the
 * body-frame specific force the liquid settles against, the relative flow
 * and fill, and the tank fill fraction the GPU fluid drains to. Pure.
 * Visual tier only (I13): `provenance` is read from the record, never assumed.
 */
import type { schema } from "@rw/contracts";

export type VisualRun = schema.VisualRun;
export type VisualSample = schema.VisualSample;

export interface TimelineState {
  t: number;
  tiltDeg: number;
  specificForce: [number, number, number];
  relativeFlow: number;
  relativeFill: number;
  fillFraction: number;
}

/** Parses `visual.json`; throws on anything that is not a visual run record. */
export function parseVisualRun(text: string): VisualRun {
  const v = JSON.parse(text) as Partial<VisualRun>;
  if (typeof v.run_id !== "string" || typeof v.provenance !== "string" || !Array.isArray(v.samples) || v.samples.length === 0 || !v.tank || !v.geometry || typeof v.duration !== "number") {
    throw new Error("visual.json: not a visual run record");
  }
  return v as VisualRun;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** The study state at `t` (clamped to 0..duration), linear between samples. */
export function sampleAt(run: Pick<VisualRun, "samples" | "duration">, t: number): TimelineState {
  const s = run.samples;
  const tc = Math.min(Math.max(t, 0), run.duration);
  let i = 0;
  // Samples are on a fixed grid: start from the estimate, then walk.
  if (s.length > 1) {
    const dt = s[1]!.t - s[0]!.t;
    i = dt > 0 ? Math.min(s.length - 2, Math.max(0, Math.floor((tc - s[0]!.t) / dt))) : 0;
    while (i > 0 && s[i]!.t > tc) i--;
    while (i < s.length - 2 && s[i + 1]!.t < tc) i++;
  }
  const a = s[i]!;
  const b = s[Math.min(i + 1, s.length - 1)]!;
  const f = b.t > a.t ? Math.min(1, Math.max(0, (tc - a.t) / (b.t - a.t))) : 0;
  const sf = (k: 0 | 1 | 2) => lerp(a.specific_force[k] ?? 0, b.specific_force[k] ?? 0, f);
  return {
    t: tc,
    tiltDeg: lerp(a.tilt_deg, b.tilt_deg, f),
    specificForce: [sf(0), sf(1), sf(2)],
    relativeFlow: lerp(a.relative_flow, b.relative_flow, f),
    relativeFill: lerp(a.relative_fill, b.relative_fill, f),
    fillFraction: lerp(a.fill_fraction, b.fill_fraction, f),
  };
}

/** The two traces over normalized time (0..1): "Relative flow" and "Relative fill". */
export function traces(run: Pick<VisualRun, "samples" | "duration">): { flow: [number, number][]; fill: [number, number][] } {
  const d = run.duration > 0 ? run.duration : 1;
  return {
    flow: run.samples.map((s) => [s.t / d, s.relative_flow]),
    fill: run.samples.map((s) => [s.t / d, s.relative_fill]),
  };
}

/** `0.0 s / 10.0 s` */
export const clockLabel = (t: number, duration: number): string => `${t.toFixed(1)} s / ${duration.toFixed(1)} s`;
