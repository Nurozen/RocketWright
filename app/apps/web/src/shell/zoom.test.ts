// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { applyZoom, nextZoom, ZOOM_DEFAULT, ZOOM_LEVELS } from "./zoom.ts";

describe("view zoom", () => {
  it("steps through the levels and stops at each end", () => {
    expect(nextZoom(1, "in")).toBe(1.1);
    expect(nextZoom(1.1, "out")).toBe(1);
    expect(nextZoom(ZOOM_LEVELS.at(-1)!, "in")).toBe(ZOOM_LEVELS.at(-1));
    expect(nextZoom(ZOOM_LEVELS[0]!, "out")).toBe(ZOOM_LEVELS[0]);
  });

  it("resets to actual size from anywhere", () => {
    for (const level of ZOOM_LEVELS) expect(nextZoom(level, "reset")).toBe(ZOOM_DEFAULT);
  });

  it("keeps the header's project menu at the minimum window", () => {
    expect(1024 / Math.max(...ZOOM_LEVELS)).toBeGreaterThan(792);
  });

  it("zooms the document element and tells the pane to re-measure", () => {
    const resized = vi.fn<() => void>();
    window.addEventListener("resize", resized);
    applyZoom(window, 1.25);
    window.removeEventListener("resize", resized);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.25");
    expect(resized).toHaveBeenCalledOnce();
  });
});
