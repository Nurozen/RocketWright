import { describe, expect, it } from "vitest";
import { bodyToYUp, countNonZero, countObjectPixels } from "./probe.ts";

describe("viewport probe helpers", () => {
  it("counts non-zero pixels", () => {
    expect(countNonZero([0, 0, 0, 0, 0, 0, 1, 0, 9, 9, 9, 255])).toBe(2);
    expect(countNonZero([])).toBe(0);
  });

  it("counts pixels that differ from the background corner", () => {
    const bg = [10, 12, 14, 255];
    const px = [...bg, ...bg, 200, 200, 200, 255, 12, 13, 15, 255];
    expect(countObjectPixels(px)).toBe(1);
    expect(countObjectPixels(px, 0)).toBe(2);
  });

  it("maps body +Z up to three.js +Y up and keeps +X aft", () => {
    const close = (v: number[], w: number[]) => v.forEach((a, i) => expect(a).toBeCloseTo(w[i] ?? NaN, 12));
    close(bodyToYUp([0, 0, 1]), [0, 1, 0]);
    close(bodyToYUp([1, 0, 0]), [1, 0, 0]);
    close(bodyToYUp([0, 1, 0]), [0, 0, -1]);
  });
});
