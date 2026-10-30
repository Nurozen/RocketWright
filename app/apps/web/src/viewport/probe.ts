/** Pure helpers for the GPU probe (unit-testable without a GPU). */

/** What the GPU gate (I11) asserts about a rendered viewport. */
export interface ViewportProbe {
  isWebGPUBackend: boolean;
  adapter: { vendor: string; architecture: string; description: string; isFallbackAdapter: boolean | null };
  /** Linear render-target readback (probe only; never a PNG source). */
  rt: { width: number; height: number; nonZero: number; objectPixels: number };
  canvas: { width: number; height: number; devicePixelRatio: number };
  coreVersion: string;
}

/** Counts RGBA pixels with any non-zero channel. */
export function countNonZero(rgba: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0 || rgba[i + 3] !== 0) n++;
  }
  return n;
}

/**
 * Counts pixels whose RGB differs from the first pixel (a background corner)
 * by more than `tolerance` in any channel: the drawn geometry's coverage.
 */
export function countObjectPixels(rgba: ArrayLike<number>, tolerance = 4): number {
  if (rgba.length < 4) return 0;
  const bg = [rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0];
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs((rgba[i + k] ?? 0) - (bg[k] ?? 0)) > tolerance) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * Body frame (+X aft, +Z up) to three.js (Y up): rotate -90 degrees about X,
 * so body (x, y, z) maps to (x, z, -y). Applied once, in the GLB loader.
 */
export const BODY_TO_YUP_RX = -Math.PI / 2;

export function bodyToYUp([x, y, z]: readonly [number, number, number]): [number, number, number] {
  const c = Math.cos(BODY_TO_YUP_RX);
  const s = Math.sin(BODY_TO_YUP_RX);
  return [x, y * c - z * s, y * s + z * c];
}
