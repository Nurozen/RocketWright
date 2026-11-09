import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BAR_SURFACES, isBarSurface } from "./model.ts";

describe("?surface= table", () => {
  it("names exactly the surfaces in tests/bar/surfaces.json", () => {
    const spec = JSON.parse(readFileSync(new URL("../../../../../tests/bar/surfaces.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(Object.keys(BAR_SURFACES).sort()).toEqual(Object.keys(spec).sort());
  });

  it("does not take a page id for a surface", () => {
    expect(isBarSurface("s-welcome")).toBe(true);
    expect(isBarSurface("01")).toBe(false);
    expect(isBarSurface(null)).toBe(false);
  });
});
