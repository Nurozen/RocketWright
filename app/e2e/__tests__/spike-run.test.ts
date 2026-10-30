/** RL1 spike capture CLI (`app/e2e/capture/run.ts`): argument parsing, output names, and PNG checks (no Electron). */
import { describe, expect, it } from "vitest";
import { solidImage, fillRect } from "../bar/png.ts";
import { captureName, HEIGHT, imageChecks, parseArgs, WIDTH } from "../capture/run.ts";

describe("spike run.ts", () => {
  it("parses --url spikes/<x>[?query] and options", () => {
    const a = parseArgs(["--url", "spikes/transmission?glass=oit&ao=0", "--out", "/tmp/x", "--build", "--timeout-ms", "5000"]);
    expect(a).toMatchObject({ spike: "transmission", query: "glass=oit&ao=0", out: "/tmp/x", build: true, oidnWeights: null, timeoutMs: 5000 });
    expect(parseArgs(["--url", "spikes/section.html"]).spike).toBe("section");
    expect(() => parseArgs(["--url", "../index"])).toThrow(/usage/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it("names captures after the spike and its query (oidn excluded)", () => {
    expect(captureName("transmission", "")).toBe("transmission");
    expect(captureName("transmission", "glass=oit&ao=0")).toBe("transmission-glass-oit-ao-0");
    expect(captureName("pathtrace", "oidn=oidn/rt.tza&spp=64")).toBe("pathtrace-spp-64");
  });

  it("transmission checks: chute orange through the glass, 2 px teal outline", () => {
    const img = solidImage(WIDTH, HEIGHT, [0x1e, 0x22, 0x26]);
    fillRect(img, [400, 300, 200, 100], [0xb3, 0x71, 0x4a]); // chute seen through the clear wall
    // A 2 px teal frame around [300, 200, 700, 500) (`fillRect` takes x, y, w, h).
    for (const r of [
      [300, 200, 400, 2],
      [300, 498, 400, 2],
      [300, 200, 2, 300],
      [698, 200, 2, 300],
    ] as const)
      fillRect(img, r, [0x61, 0xb5, 0xad]);
    const c = imageChecks("transmission", img, { chute: [400, 300, 600, 400], bay: [300, 200, 700, 500] }, "");
    expect(c["size"]?.pass).toBe(true);
    expect(c["chuteThroughGlass"]).toMatchObject({ value: 1, pass: true });
    expect(c["outlineWidthPx"]).toMatchObject({ value: 2, pass: true });
    expect(c["outlinePixels"]?.pass).toBe(true);

    const washed = solidImage(WIDTH, HEIGHT, [0x1e, 0x22, 0x26]);
    fillRect(washed, [400, 300, 200, 100], [0xd1, 0x9c, 0x87]); // blended glass haze over the chute
    expect(imageChecks("transmission", washed, { chute: [400, 300, 600, 400] }, "")["chuteThroughGlass"]?.pass).toBe(false);
    expect(imageChecks("transmission", washed, {}, "")["outlineWidthPx"]).toMatchObject({ value: null, pass: false });
  });

  it("pathtrace: noise of a flat still is 0; size is checked", () => {
    const flat = solidImage(WIDTH, HEIGHT, [90, 90, 90]);
    const plain = imageChecks("pathtrace", flat, { bay: [100, 100, 300, 300] }, "");
    expect(plain["noise"]).toMatchObject({ value: 0, pass: true });
    expect(imageChecks("pathtrace", solidImage(10, 10, [0, 0, 0]), {}, "oidn=x")["size"]?.pass).toBe(false);
  });
});
