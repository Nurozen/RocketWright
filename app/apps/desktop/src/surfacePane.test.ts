import { describe, expect, it } from "vitest";
import { classifyPane, waitOverlaySnapshot } from "./surfacePane.ts";

const embed = { x: 1100, y: 60, width: 400, height: 900 };

describe("classifyPane", () => {
  it("is absent with no embed in the page", () => {
    expect(classifyPane({ embed: null, overlays: [] })).toBe("absent");
  });

  it("is visible when no overlay touches the pane", () => {
    expect(classifyPane({ embed, overlays: [] })).toBe("visible");
    expect(classifyPane({ embed, overlays: [{ x: 200, y: 50, width: 200, height: 300 }] })).toBe("visible");
  });

  it("is overlay when one reaches into the pane", () => {
    expect(classifyPane({ embed, overlays: [{ x: 1000, y: 100, width: 200, height: 300 }] })).toBe("overlay");
    expect(classifyPane({ embed, overlays: [{ x: 200, y: 50, width: 200, height: 300 }, { x: 0, y: 0, width: 1536, height: 1024 }] })).toBe("overlay");
  });
});

describe("waitOverlaySnapshot", () => {
  it("returns once the snapshot is shown", async () => {
    let polls = 0;
    await expect(waitOverlaySnapshot(() => Promise.resolve(++polls >= 3), Date.now() + 10_000, () => Promise.resolve())).resolves.toBeNull();
    expect(polls).toBe(3);
  });

  it("says why when it never appears", async () => {
    await expect(waitOverlaySnapshot(() => Promise.resolve(false), Date.now() - 1, () => Promise.resolve())).resolves.toMatch(/guest snapshot never appeared/);
  });
});
