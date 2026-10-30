import { describe, expect, it } from "vitest";
import { countForeground, pngSize } from "./capture.ts";

function fakePng(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe("capture helpers", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(pngSize(fakePng(1536, 1024))).toEqual({ width: 1536, height: 1024 });
  });

  it("rejects non-PNG bytes", () => {
    expect(() => pngSize(new Uint8Array(40))).toThrow(/not a PNG/);
  });

  it("counts pixels that differ from the corner", () => {
    const bg = [13, 16, 20, 255];
    expect(countForeground(new Uint8Array([...bg, ...bg, 200, 200, 200, 255]))).toBe(1);
  });
});
