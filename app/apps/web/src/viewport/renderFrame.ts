/**
 * Waiting for a fresh render frame before a probe render (B7e).
 *
 * three's WebGPU renderer draws each pass node (the scene `pass()`, GTAO,
 * the outline) at most once per node frame (`NodeUpdateType.FRAME`), and
 * only its animation loop starts a node frame (`renderer.info.frame`, bumped
 * on each animation-loop callback). A second `pipeline.render()` in the same
 * frame reuses the first one's pass textures. So a probe that toggles the
 * floor, the outline or the AO term and renders again within one frame
 * (`setTimeout(0)` tasks are far shorter than a frame) reads the earlier
 * passes: page01.spec's contact shadow read 0 when the "with floor" and
 * "without floor" renders shared a frame, depending on where the frame
 * boundary fell (about 2 runs in 3 under load). Each probe render waits on
 * the frame id changing, not on a sleep.
 */

/** The render loop's frame id (`renderer.info.frame`). */
export type FrameId = () => number;

/** Animation frames to wait before deciding the render loop has stopped. */
export const MAX_WAIT_FRAMES = 600;

/**
 * Resolves in a task after the render loop has started a new frame (the
 * frame id differs from its value now), so the next render redraws every
 * pass. Rejects when the id has not moved after `maxFrames` animation
 * frames (no render loop).
 */
export function nextRenderFrame(
  frame: FrameId,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb),
  later: (cb: () => void) => unknown = (cb) => setTimeout(cb, 0),
  maxFrames = MAX_WAIT_FRAMES,
): Promise<void> {
  const start = frame();
  return new Promise<void>((resolve, reject) => {
    let waited = 0;
    const check = () => {
      if (frame() !== start) {
        // A task of its own: the animation-loop callback that bumped the id is done.
        later(resolve);
        return;
      }
      if (++waited > maxFrames) {
        reject(new Error(`the render loop started no frame in ${maxFrames} animation frames`));
        return;
      }
      raf(check);
    };
    raf(check);
  });
}

/** How long an agent capture waits for a render-loop frame before it reads the canvas anyway (ms). */
export const CAPTURE_FRAME_TIMEOUT_MS = 2_000;

/**
 * `viewport_render` after `viewport_set_camera` (CPW1R5A): a capture that
 * renders in the frame the camera moved in reuses that frame's pass
 * textures, drawn with the previous camera, and returns the old picture.
 * So the capture waits for a render-loop frame that starts after the
 * request (the camera is current by then: the caller set it first), then
 * renders and reads in a task of its own. Without a running loop (the id
 * never moves) it captures after `timeoutMs` rather than hanging the call.
 */
export async function freshCapture<T>(
  frame: FrameId,
  capture: () => T,
  o: { raf?: (cb: () => void) => unknown; later?: (cb: () => void) => unknown; timeoutMs?: number; timer?: (cb: () => void, ms: number) => unknown } = {},
): Promise<T> {
  const timer = o.timer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const timeout = new Promise<void>((resolve) => void timer(resolve, o.timeoutMs ?? CAPTURE_FRAME_TIMEOUT_MS));
  await Promise.race([nextRenderFrame(frame, o.raf, o.later).catch(() => undefined), timeout]);
  return capture();
}
