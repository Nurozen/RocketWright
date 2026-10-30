/**
 * The mounted assembly viewport, as the broker host (M1.32+web) sees it:
 * capture, camera placement, readiness. `AssemblyViewport` registers itself
 * on mount; the host waits for one when an op arrives on another page.
 */
import type { RenderBackend } from "./engine.ts";
import type { Vec3 } from "./views.ts";

export interface ViewportController {
  /** A model is loaded and the renderer has settled (any backend). */
  ready(): boolean;
  backend(): RenderBackend;
  adapter(): string;
  /** Resolves with a frame drawn with the current camera (`renderFrame.ts` `freshCapture`), never the previous one. */
  capture(width?: number, height?: number): Promise<{ png_base64: string; width: number; height: number }>;
  setCamera(position: Vec3 | undefined, target: Vec3 | undefined): void;
  /** M3.2: pins the explode tween at normalised time `t` (deterministic capture); null resumes it. */
  seekExplode?(t: number | null): void;
}

let active: ViewportController | null = null;

export function setActiveViewport(c: ViewportController | null): void {
  active = c;
}

/** Unregisters `c` only if it is still the active one (a newer mount may have replaced it). */
export function clearActiveViewport(c: ViewportController): void {
  if (active === c) active = null;
}

export function activeViewport(): ViewportController | null {
  return active;
}

const tick = (): Promise<void> =>
  new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

/** Two animation frames: state changes reach the engine and a frame renders. */
export async function settle(): Promise<void> {
  await tick();
  await tick();
}

/** Resolves with a ready viewport, or rejects after `timeoutMs`. */
export async function waitForViewport(timeoutMs = 8000): Promise<ViewportController> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const c = active;
    if (c !== null && c.ready()) return c;
    if (Date.now() > end) throw new Error(c === null ? "the assembly viewport is not open" : "the viewport has no model yet");
    await tick();
  }
}
