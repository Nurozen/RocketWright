/**
 * The critic packet (`app/e2e/bar/packet.ts`; D23): the files it carries,
 * and for pages 01 and 06 the approved mockup, the no-regression capture and
 * the concept art with their per-page roles in the manifest.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBED_MOCKUP, PAGE_REFERENCES, assertAllowedPath, buildPacket } from "../bar/packet.ts";
import { CRITIC_PROMPT_PATH, stableStringify, type PageId } from "../bar/paths.ts";
import { encodePng, solidImage } from "../bar/png.ts";
import { loadRegions, loadTokens } from "../bar/spec.ts";
import { measureImage } from "../visual-tokens.ts";

const tokens = loadTokens();
const regions = loadRegions();

/** A distinct small solid PNG per name, so copied files can be told apart by hash (the packet copies them as is). */
function png(seed: number): Buffer {
  return Buffer.from(encodePng(solidImage(8, 8, [seed % 256, (seed * 7) % 256, (seed * 13) % 256])));
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Temp inputs for `page`: a capture, its token report, a concept-art dir and an embed-assets dir holding every reference image. */
function fixtureInputs(page: PageId, reportPage: PageId = page) {
  const dir = mkdtempSync(join(tmpdir(), "rw-packet-"));
  const capture = join(dir, "capture.png");
  const report = join(dir, `${reportPage}.tokens.json`);
  const img = solidImage(1536, 1024, [27, 30, 32]);
  writeFileSync(capture, encodePng(img));
  writeFileSync(report, stableStringify(measureImage(img, reportPage, tokens, regions)));
  const exDir = mkdtempSync(join(dir, "visual-"));
  const embedDir = mkdtempSync(join(dir, "embed-bar-"));
  const bytes = new Map<string, Buffer>();
  let seed = 1;
  for (const p of ["01", "02", "03", "04", "05", "06"] as const) {
    const b = png(seed++);
    bytes.set(`exemplars/${regions.pages[p].exemplar}`, b);
    writeFileSync(join(exDir, regions.pages[p].exemplar), b);
  }
  for (const f of [EMBED_MOCKUP, "current-01-capture.png", "current-06-capture.png"]) {
    const b = png(seed++);
    bytes.set(`embed/${f}`, b);
    writeFileSync(join(embedDir, f), b);
  }
  return { dir, capture, report, exDir, embedDir, bytes };
}

describe("critic packet", () => {
  it("assembles exactly the packet files with a manifest of hashes (a page without embed references)", () => {
    const { dir, capture, report, exDir, embedDir } = fixtureInputs("04");
    const out = join(dir, "packet");
    const m = buildPacket({ page: "04", capture, tokensReport: report, milestone: "M1", fidelity: false, out, exemplars: exDir, embedAssets: embedDir });
    expect(readdirSync(out).sort()).toEqual(["capture.png", "checklist.json", "critic-prompt.md", "exemplar.png", "manifest.json", "regions.json", "tokens.json"]);
    expect(Object.keys(m.files).sort()).toEqual(["capture.png", "checklist.json", "critic-prompt.md", "exemplar.png", "regions.json", "tokens.json"]);
    expect(m.files["capture.png"]).toBe(sha(readFileSync(capture)));
    expect(m.milestoneInScope).toBe("M1");
    expect(m.references).toEqual({ "exemplar.png": { source: "04-flight-results.png", role: expect.stringMatching(/concept art/) } });
    expect(readFileSync(join(out, "critic-prompt.md"), "utf8")).toBe(readFileSync(CRITIC_PROMPT_PATH, "utf8"));
    expect(JSON.parse(readFileSync(join(out, "regions.json"), "utf8")).page).toBe("04");
    // A second build into the same directory is refused.
    expect(() => buildPacket({ page: "04", capture, tokensReport: report, milestone: "M1", fidelity: false, out, exemplars: exDir, embedAssets: embedDir })).toThrow(/not empty/);
  });

  it("page 01 carries the mockup, the current capture and the concept art, each with its role (D23)", () => {
    const { dir, capture, report, exDir, embedDir, bytes } = fixtureInputs("01");
    const out = join(dir, "packet");
    const m = buildPacket({ page: "01", capture, tokensReport: report, milestone: "M5", fidelity: true, out, exemplars: exDir, embedAssets: embedDir });
    expect(readdirSync(out).sort()).toEqual(["capture.png", "checklist.json", "critic-prompt.md", "current.png", "exemplar.png", "manifest.json", "mockup.png", "regions.json", "tokens.json"]);
    expect(m.files["mockup.png"]).toBe(sha(bytes.get(`embed/${EMBED_MOCKUP}`)!));
    expect(m.files["current.png"]).toBe(sha(bytes.get("embed/current-01-capture.png")!));
    expect(m.files["exemplar.png"]).toBe(sha(bytes.get("exemplars/01-assembly.png")!));
    expect(Object.keys(m.references).sort()).toEqual(["current.png", "exemplar.png", "mockup.png"]);
    expect(m.references["mockup.png"]).toMatchObject({ source: "rocketwright-embedded-chat.png", role: expect.stringMatching(/agent pane/) });
    expect(m.references["current.png"]).toMatchObject({ source: "current-01-capture.png", role: expect.stringMatching(/outside the agent pane: no regression/) });
    expect(m.references["exemplar.png"]).toMatchObject({ source: "01-assembly.png", role: expect.stringMatching(/theme fit/) });
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { references: unknown };
    expect(manifest.references).toEqual(m.references);
  });

  it("page 06 judges outside the pane against its concept art and current capture, and uses the mockup for the pane only (D23)", () => {
    const { dir, capture, report, exDir, embedDir, bytes } = fixtureInputs("06");
    const out = join(dir, "packet");
    const m = buildPacket({ page: "06", capture, tokensReport: report, milestone: "M5", fidelity: true, out, exemplars: exDir, embedAssets: embedDir });
    expect(m.files["exemplar.png"]).toBe(sha(bytes.get("exemplars/06-liquid-simulator.png")!));
    expect(m.files["current.png"]).toBe(sha(bytes.get("embed/current-06-capture.png")!));
    expect(m.files["mockup.png"]).toBe(sha(bytes.get(`embed/${EMBED_MOCKUP}`)!));
    expect(m.references["exemplar.png"]).toMatchObject({ source: "06-liquid-simulator.png", role: expect.stringMatching(/outside the agent pane/) });
    expect(m.references["current.png"]).toMatchObject({ source: "current-06-capture.png", role: expect.stringMatching(/no regression outside the agent pane/) });
    expect(m.references["mockup.png"]).toMatchObject({ source: "rocketwright-embedded-chat.png", role: expect.stringMatching(/only the agent pane/) });
    // Neither page-01 image governs page 06 outside the pane.
    expect(Object.values(m.references).map((r) => r.source)).not.toContain("current-01-capture.png");
    expect(Object.values(m.references).map((r) => r.source)).not.toContain("01-assembly.png");
  });

  it("only pages 01 and 06 carry embed references", () => {
    expect(Object.keys(PAGE_REFERENCES).sort()).toEqual(["01", "06"]);
  });

  it("refuses a missing reference image", () => {
    const { dir, capture, report, exDir } = fixtureInputs("01");
    const empty = mkdtempSync(join(dir, "none-"));
    expect(() => buildPacket({ page: "01", capture, tokensReport: report, milestone: "M1", fidelity: false, out: join(dir, "p"), exemplars: exDir, embedAssets: empty })).toThrow(/missing input .*rocketwright-embedded-chat\.png/);
  });

  it("refuses clean-room-restricted inputs and a report for another page", () => {
    expect(() => assertAllowedPath("/x/RocketCAD/artifacts/concepts/dark-studio/01-assembly.png")).toThrow(/clean-room/);
    expect(() => assertAllowedPath("/x/RocketCAD/openrocket/core/a.png")).toThrow(/clean-room/);
    expect(() => assertAllowedPath("/x/RocketCAD/artifacts/features/rocketwright/bar/visual/01-assembly.png")).not.toThrow();
    expect(() => assertAllowedPath("/x/RocketCAD/artifacts/features/rocketwright-lecturn/bar/rocketwright-embedded-chat.png")).not.toThrow();
    const { dir, capture, report, exDir, embedDir } = fixtureInputs("04", "01");
    expect(() =>
      buildPacket({ page: "04", capture, tokensReport: report, milestone: "M1", fidelity: false, out: join(dir, "p4"), exemplars: exDir, embedAssets: embedDir }),
    ).toThrow(/token report is for page 01/);
  });
});
