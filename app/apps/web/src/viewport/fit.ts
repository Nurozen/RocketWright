/**
 * Camera auto-fit placement (concept 01): given the model's projected
 * footprint (screen rectangles), find the largest image scale and the
 * alignment inside the fit rect that keeps every footprint rectangle clear of
 * the occluders (inspector strip, gizmo). The model may pass under an
 * occluder's bottom edge (the aft end below the inspector). Pure; screen px.
 */

export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FitPlacement {
  /** Image scale relative to the footprint as given (<= the rect-limited scale). */
  scale: number;
  /** Alignment of the scaled footprint inside the rect's slack (0..1). */
  ax: number;
  ay: number;
  /** A clear placement was found. */
  clear: boolean;
}

export function unionRect(rs: readonly FitRect[]): FitRect | null {
  if (rs.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function rectsTouch(a: FitRect, b: FitRect, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Translation (px) that puts the footprint union `b` at alignment (ax, ay) in `rect`; centred on an axis without slack. */
export function alignOffset(b: FitRect, rect: FitRect, ax: number, ay: number): [number, number] {
  const sx = rect.w - b.w;
  const sy = rect.h - b.h;
  const tx = sx >= 0 ? rect.x + sx * ax - b.x : rect.x + sx / 2 - b.x;
  const ty = sy >= 0 ? rect.y + sy * ay - b.y : rect.y + sy / 2 - b.y;
  return [tx, ty];
}

/** Whether the footprint translated by (tx, ty) keeps `clearance` from every occluder. */
export function footprintClear(fp: readonly FitRect[], tx: number, ty: number, occluders: readonly FitRect[], clearance: number): boolean {
  for (const r of fp) {
    const m = { x: r.x + tx, y: r.y + ty, w: r.w, h: r.h };
    for (const o of occluders) if (rectsTouch(m, o, clearance)) return false;
  }
  return true;
}

/** Alignment grid, nearest to the preferred alignment first (deterministic). */
function alignments(steps: number, prefer: readonly [number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) out.push([i / steps, j / steps]);
  const d = (a: [number, number]) => Math.hypot(a[0] - prefer[0], a[1] - prefer[1]);
  return out.sort((a, b) => d(a) - d(b) || a[1] - b[1] || a[0] - b[0]);
}

/**
 * Largest scale in [minScale, rect-limited] (bisection) at which some
 * alignment is clear; the footprint is scaled about its own origin (exact for
 * an orthographic image, close for a narrow perspective one).
 */
export function fitPlacement(
  fp: readonly FitRect[],
  rect: FitRect,
  occluders: readonly FitRect[],
  clearance: number,
  opts: { minScale?: number; steps?: number; prefer?: readonly [number, number] } = {},
): FitPlacement {
  const b = unionRect(fp);
  if (!b) return { scale: 1, ax: 0.5, ay: 0.5, clear: true };
  const maxScale = Math.min(rect.w / b.w, rect.h / b.h);
  const minScale = Math.min(maxScale, opts.minScale ?? 0.55 * maxScale);
  const grid = alignments(opts.steps ?? 16, opts.prefer ?? [0.5, 0.5]);
  const tryScale = (s: number): [number, number] | null => {
    const scaled = fp.map((r) => ({ x: (r.x - b.x) * s, y: (r.y - b.y) * s, w: r.w * s, h: r.h * s }));
    const ub = { x: 0, y: 0, w: b.w * s, h: b.h * s };
    for (const [ax, ay] of grid) {
      const [tx, ty] = alignOffset(ub, rect, ax, ay);
      if (footprintClear(scaled, tx, ty, occluders, clearance)) return [ax, ay];
    }
    return null;
  };
  const top = tryScale(maxScale);
  if (top) return { scale: maxScale, ax: top[0], ay: top[1], clear: true };
  let lo = minScale;
  let best = tryScale(lo);
  if (!best) return { scale: maxScale, ax: 0.5, ay: 0.5, clear: false };
  let hi = maxScale;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const a = tryScale(mid);
    if (a) {
      lo = mid;
      best = a;
    } else hi = mid;
  }
  return { scale: lo, ax: best[0], ay: best[1], clear: true };
}
