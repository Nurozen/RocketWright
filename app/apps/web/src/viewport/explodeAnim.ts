/**
 * Exploded-view animation (M3.2, R6.3/R6.12): eases the explode factor from
 * its current value to a target over a duration proportional to the
 * distance, on top of the M3.0 spacing (`explode.ts` maps the factor to
 * part offsets, so every in-between frame keeps the ordered, non-overlapping
 * layout).
 *
 * Time is injected (`clock`), so the animation is a pure function of the
 * normalised time `t` in [0, 1]. Captures pin `t` with `seek(t)` (the clip
 * frames and the e2e are deterministic: no wall clock is read while pinned);
 * `seek(null)` hands the tween back to the clock from that point.
 *
 * The slider drags the factor directly (`jump`); the Assembled/Exploded
 * end buttons and agent requests animate (`start`).
 */

/** Full sweep (0 -> 1) duration. */
export const EXPLODE_ANIM_MS = 650;
/** Shortest animation (tiny moves still read as motion, not a jump). */
export const EXPLODE_ANIM_MIN_MS = 160;

export type Easing = (u: number) => number;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Cubic ease-in-out: zero velocity at both ends, symmetric about t = 0.5. */
export const easeInOutCubic: Easing = (u) => {
  const t = clamp01(u);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Duration of a move by `delta` (explode units). */
export function durationFor(delta: number): number {
  const d = Math.abs(delta);
  if (!(d > 0)) return 0;
  return Math.max(EXPLODE_ANIM_MIN_MS, EXPLODE_ANIM_MS * Math.min(1, d));
}

/** The eased factor at normalised time `t` of a `from` -> `to` tween. */
export function explodeAt(from: number, to: number, t: number, ease: Easing = easeInOutCubic): number {
  const u = clamp01(t);
  if (u >= 1) return to;
  if (u <= 0) return from;
  return from + (to - from) * ease(u);
}

export interface ExplodeTween {
  from: number;
  to: number;
  durationMs: number;
  /** Clock time of t = 0. */
  startMs: number;
}

export interface AnimFrame {
  value: number;
  /** Normalised time of the tween (1 when idle). */
  t: number;
  running: boolean;
}

export class ExplodeAnimator {
  private current = 0;
  private tween: ExplodeTween | null = null;
  /** Pinned normalised time (deterministic capture), or null to follow the clock. */
  private pinned: number | null = null;

  private readonly clock: () => number;
  private readonly ease: Easing;

  constructor(clock: () => number = () => performance.now(), ease: Easing = easeInOutCubic) {
    this.clock = clock;
    this.ease = ease;
  }

  /** The factor shown now (call `step` first in a frame). */
  get value(): number {
    return this.current;
  }

  /** Where the factor is heading (the tween's end, or the value when idle). */
  get target(): number {
    return this.tween?.to ?? this.current;
  }

  get running(): boolean {
    return this.tween !== null;
  }

  /** The tween in flight (null when idle). */
  get active(): Readonly<ExplodeTween> | null {
    return this.tween;
  }

  /** Sets the factor at once (slider drags), cancelling any tween. */
  jump(to: number): void {
    this.current = clamp01(to);
    this.tween = null;
    this.pinned = null;
  }

  /**
   * Starts a tween from the shown value to `to`. A pinned time stays pinned
   * where it is (a capture pins, starts, then steps `seek(t)` frame by frame).
   */
  start(to: number, durationMs?: number): void {
    const target = clamp01(to);
    const d = durationMs ?? durationFor(target - this.current);
    if (target === this.current || !(d > 0)) {
      this.jump(target);
      return;
    }
    this.tween = { from: this.current, to: target, durationMs: d, startMs: this.clock() };
  }

  /**
   * Deterministic capture: pins the tween at normalised time `t` (0..1).
   * `null` resumes on the clock from the pinned time.
   */
  seek(t: number | null): void {
    if (t === null) {
      const tw = this.tween;
      if (tw && this.pinned !== null) tw.startMs = this.clock() - this.pinned * tw.durationMs;
      this.pinned = null;
      return;
    }
    this.pinned = clamp01(t);
  }

  /** Whether the time is pinned (`seek`). */
  get paused(): boolean {
    return this.pinned !== null;
  }

  /** Advances to the clock (or the pinned time) and returns the frame. */
  step(): AnimFrame {
    const tw = this.tween;
    if (!tw) return { value: this.current, t: 1, running: false };
    const t = this.pinned ?? clamp01((this.clock() - tw.startMs) / tw.durationMs);
    this.current = explodeAt(tw.from, tw.to, t, this.ease);
    // A pinned tween stays alive at t = 1 until it is released or replaced.
    if (t >= 1 && this.pinned === null) this.tween = null;
    return { value: this.current, t, running: this.tween !== null };
  }
}
