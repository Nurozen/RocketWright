import { describe, expect, it } from "vitest";
import { durationFor, easeInOutCubic, explodeAt, ExplodeAnimator, EXPLODE_ANIM_MIN_MS, EXPLODE_ANIM_MS } from "./explodeAnim.ts";

describe("easeInOutCubic", () => {
  it("is 0 and 1 at the ends, symmetric, and monotonic", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      const v = easeInOutCubic(u);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v + easeInOutCubic(1 - u)).toBeCloseTo(1, 12);
      prev = v;
    }
  });

  it("starts and ends with zero velocity", () => {
    const h = 1e-4;
    expect(easeInOutCubic(h) / h).toBeLessThan(1e-6);
    expect((1 - easeInOutCubic(1 - h)) / h).toBeLessThan(1e-6);
  });
});

describe("explodeAt / durationFor", () => {
  it("interpolates between from and to", () => {
    expect(explodeAt(0.2, 1, 0)).toBe(0.2);
    expect(explodeAt(0.2, 1, 1)).toBe(1);
    expect(explodeAt(1, 0, 0.5)).toBeCloseTo(0.5, 12);
    expect(explodeAt(0, 1, 0.25)).toBeCloseTo(0.0625, 12);
  });

  it("scales the duration with the distance, with a floor", () => {
    expect(durationFor(0)).toBe(0);
    expect(durationFor(1)).toBe(EXPLODE_ANIM_MS);
    expect(durationFor(-1)).toBe(EXPLODE_ANIM_MS);
    expect(durationFor(0.01)).toBe(EXPLODE_ANIM_MIN_MS);
  });
});

describe("ExplodeAnimator", () => {
  it("follows the injected clock and finishes at the target", () => {
    let now = 1000;
    const a = new ExplodeAnimator(() => now);
    a.start(1);
    expect(a.running).toBe(true);
    expect(a.step().value).toBe(0);
    now += EXPLODE_ANIM_MS / 2;
    expect(a.step().value).toBeCloseTo(0.5, 12);
    now += EXPLODE_ANIM_MS;
    const f = a.step();
    expect(f).toEqual({ value: 1, t: 1, running: false });
    expect(a.running).toBe(false);
  });

  it("is deterministic under seek: values depend on t only", () => {
    let now = 0;
    const a = new ExplodeAnimator(() => now);
    a.seek(0);
    a.start(1);
    const vals: number[] = [];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      now += 12345; // the wall clock is ignored while pinned
      a.seek(t);
      vals.push(a.step().value);
    }
    expect(vals).toEqual([0, explodeAt(0, 1, 0.25), explodeAt(0, 1, 0.5), explodeAt(0, 1, 0.75), 1]);
    // Pinned at t = 1 the tween is still held; releasing finishes it.
    expect(a.running).toBe(true);
    a.seek(null);
    expect(a.step().running).toBe(false);
    expect(a.value).toBe(1);
  });

  it("resumes on the clock from the pinned time", () => {
    let now = 0;
    const a = new ExplodeAnimator(() => now);
    a.start(1);
    a.seek(0.5);
    expect(a.step().value).toBeCloseTo(0.5, 12);
    now = 50_000;
    a.seek(null);
    expect(a.step().value).toBeCloseTo(0.5, 12);
    now += EXPLODE_ANIM_MS / 2;
    expect(a.step().value).toBe(1);
  });

  it("jump cancels a tween; a retarget starts from the shown value", () => {
    let now = 0;
    const a = new ExplodeAnimator(() => now);
    a.start(1);
    now = EXPLODE_ANIM_MS / 2;
    const mid = a.step().value;
    a.start(0);
    expect(a.active?.from).toBe(mid);
    expect(a.active?.durationMs).toBe(durationFor(mid));
    a.jump(0.3);
    expect(a.running).toBe(false);
    expect(a.step().value).toBe(0.3);
    a.start(0.3);
    expect(a.running).toBe(false);
  });
});
