/**
 * B3 surface tooling (`bar/surfaces.ts`, `bar/visual.ts`, `buildSurfacePacket`):
 * the surface table, the "not built yet" report, the seeded Recents, and the
 * surface critic packet.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRecents } from "../../apps/desktop/src/recents.ts";
import { PANE_OVERLAY_SELECTOR } from "../../apps/desktop/src/surfacePane.ts";
import { OVERLAY_SELECTOR } from "../../apps/web/src/embed/bridge.ts";
import { buildSurfacePacket } from "../bar/packet.ts";
import { BAR_DATA_DIR, isSurfaceId, SURFACE_CRITIC_PROMPT_PATH, SURFACES, type SurfaceId } from "../bar/paths.ts";
import { loadSurfaces, surfaceFailures, type SurfaceSpec } from "../bar/surfaces.ts";
import { notBuiltLine, parseArgs, SEEDED_RECENTS, seedSurfaceFixture, SURFACE_CAPTURE_DIR, SURFACE_CLOCK_MS, surfaceDesktopArgs, surfaceReport, surfaceScript } from "../bar/visual.ts";

const specs = loadSurfaces();
const temps: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "rw-surfaces-test-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("surface table (tests/bar/surfaces.json)", () => {
  it("lists exactly the plan's eight surfaces, each with its mockup and checks", () => {
    expect(Object.keys(specs).sort()).toEqual([...SURFACES].sort());
    for (const id of SURFACES) {
      expect(specs[id].mockup, id).toMatch(/^0[1-7]-.+\.png$/);
      expect(specs[id].existing, id).toMatch(/\.png$/);
      expect(specs[id].checks.length, id).toBeGreaterThan(0);
    }
  });

  it("gives every built surface a ready selector and a pane case, so its capture is checked", () => {
    for (const id of SURFACES) {
      if (surfaceScript(id) === null) continue;
      expect(specs[id].ready, id).not.toBeNull();
      expect(specs[id].pane, id).not.toBeNull();
    }
  });

  it("keeps surface data out of the frozen checklists", () => {
    expect(existsSync(join(BAR_DATA_DIR, "checklists/s-welcome.json"))).toBe(false);
  });

  it("uses the page's own overlay selector, so a capture classifies overlays as the pane does", () => {
    expect(PANE_OVERLAY_SELECTOR).toBe(OVERLAY_SELECTOR);
  });
});

describe("surface arguments", () => {
  it("accepts every surface, built or not, and captures no page unless asked", () => {
    const a = parseArgs(["--surfaces", SURFACES.join(",")]);
    expect(a.surfaces).toEqual([...SURFACES]);
    expect(a.pages).toEqual([]);
    expect(parseArgs(["--surfaces", "s-welcome", "--pages", "02"]).pages.map((p) => p.page)).toEqual(["02"]);
    expect(parseArgs([]).pages.map((p) => p.page)).toEqual(["01"]);
    expect(parseArgs([]).surfaces).toEqual([]);
  });

  it("refuses an unknown surface", () => {
    expect(() => parseArgs(["--surfaces", "s-nope"])).toThrow(/unknown surface s-nope/);
    expect(isSurfaceId("s-nope")).toBe(false);
  });

  it("boots with no project or the sample, and always on the frozen clock", () => {
    const zero = surfaceDesktopArgs("s-welcome", "/o", "/d/s-welcome.ts", null);
    expect(zero).toContain("--zero-project");
    expect(zero).not.toContain("--project");
    expect(zero[zero.indexOf("--query") + 1]).toBe("surface=s-welcome");
    expect(zero[zero.indexOf("--freeze-clock") + 1]).toBe(String(SURFACE_CLOCK_MS));
    const sample = surfaceDesktopArgs("s-project-menu", "/o", "/d/s.ts", "/p/Sample rocket");
    expect(sample.slice(sample.indexOf("--project"), sample.indexOf("--project") + 2)).toEqual(["--project", "/p/Sample rocket"]);
    expect(sample).not.toContain("--zero-project");
  });

  it("names a surface without a script as not built, never as captured", () => {
    expect(surfaceScript("s-welcome", SURFACE_CAPTURE_DIR)).not.toBeNull();
    const empty = temp();
    expect(surfaceScript("s-add-part", empty)).toBeNull();
    expect(notBuiltLine("s-add-part")).toBe("surface s-add-part: not built yet (no capture script app/e2e/capture/surfaces/s-add-part.ts); nothing captured");
  });
});

describe("seeded surface fixture", () => {
  const init = (made: string[]) => (dir: string, name: string, template: string) => {
    made.push(`${name}:${template}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rocketwright.toml"), "");
  };

  it("seeds three Recents, one of them missing, in a profile main can read", () => {
    const made: string[] = [];
    const f = seedSurfaceFixture("zero-project", SURFACE_CLOCK_MS, init(made));
    temps.push(f.scratch);
    expect(f.project).toBeNull();
    expect(f.profile.startsWith(f.scratch)).toBe(true);
    const parsed = parseRecents(readFileSync(join(f.profile, "recents.json"), "utf8"));
    expect(parsed.recents.map((r) => r.name)).toEqual(SEEDED_RECENTS.map((r) => r.name));
    expect(parsed.lastActive).toBeNull();
    expect(parsed.recents.map((r) => existsSync(join(r.dir, "rocketwright.toml")))).toEqual([true, true, false]);
    expect(Date.parse(parsed.recents[0]!.lastOpened)).toBeLessThan(SURFACE_CLOCK_MS);
    expect(made).toEqual(["weekend-flyer:empty", "altitude-study:empty"]);
  });

  it("keeps the open sample out of Recents: it would be omitted from the menu's list", () => {
    const made: string[] = [];
    const f = seedSurfaceFixture("project", SURFACE_CLOCK_MS, init(made));
    temps.push(f.scratch);
    expect(f.project).toBe(join(f.documents, "RocketWright", "Sample rocket"));
    expect(made.at(-1)).toBe("Sample rocket:sample");
    const parsed = parseRecents(readFileSync(join(f.profile, "recents.json"), "utf8"));
    expect(parsed.recents.map((r) => r.dir)).not.toContain(f.project);
  });
});

describe("surface capture checks", () => {
  const spec: SurfaceSpec = { ...specs["s-new-project"] };
  const ok = { surface: "s-new-project" as SurfaceId, ready: true, overlay: { selector: '[role="dialog"]', present: true, rect: [1, 2, 3, 4] as [number, number, number, number] } };

  it("passes readiness plus overlay presence, with no region table", () => {
    expect(surfaceFailures("s-new-project", spec, { measure: ok, pane: "absent" })).toEqual([]);
  });

  it("fails without readiness, without the overlay, or with the wrong pane case", () => {
    expect(surfaceFailures("s-new-project", spec, { measure: { ...ok, ready: false }, pane: "absent" })).toEqual([expect.stringMatching(/not ready/)]);
    expect(surfaceFailures("s-new-project", spec, { measure: { ...ok, overlay: { ...ok.overlay, present: false, rect: null } }, pane: "absent" })).toEqual([expect.stringMatching(/overlay not shown/)]);
    expect(surfaceFailures("s-new-project", spec, { measure: ok, pane: "visible" })).toEqual([expect.stringMatching(/agent pane is visible, expected absent/)]);
    expect(surfaceFailures("s-new-project", spec, {})).toEqual([expect.stringMatching(/no measurements/), expect.stringMatching(/agent pane is undefined/)]);
  });

  it("does not hold a surface to a pane case it has not chosen", () => {
    expect(surfaceFailures("s-new-project", { ...spec, pane: null }, { measure: ok, pane: "overlay" })).toEqual([]);
  });

  it("reports the measured state", () => {
    const { pass, lines } = surfaceReport("s-new-project", spec, { page: { status: "ready" }, drive: { state: { dialog: "New project" } }, measure: ok, surfacePane: "absent", capture: { path: "/c.png", width: 1536, height: 1024 } });
    expect(pass).toBe(true);
    expect(lines).toContain("surface s-new-project (New project): reached");
    expect(lines).toContain("  overlay [role=\"dialog\"]: shown");
  });
});

describe("surface critic packet", () => {
  it("carries the capture, the mockup, the nearest page, the checks and the surface prompt", () => {
    const bar = temp();
    mkdirSync(join(bar, "mockups"));
    mkdirSync(join(bar, "existing"));
    writeFileSync(join(bar, "mockups/01-welcome.png"), "mock");
    writeFileSync(join(bar, "existing/design-assembly.png"), "exist");
    const dir = temp();
    writeFileSync(join(dir, "capture.png"), "cap");
    const out = join(dir, "packet");
    const manifest = buildSurfacePacket({ surface: "s-welcome", capture: join(dir, "capture.png"), out, bar });
    expect(Object.keys(manifest.files).sort()).toEqual(["capture.png", "checks.json", "critic-prompt.md", "existing.png", "mockup.png"]);
    expect(readFileSync(join(out, "mockup.png"), "utf8")).toBe("mock");
    expect(readFileSync(join(out, "existing.png"), "utf8")).toBe("exist");
    expect(readFileSync(join(out, "critic-prompt.md"), "utf8")).toBe(readFileSync(SURFACE_CRITIC_PROMPT_PATH, "utf8"));
    expect(JSON.parse(readFileSync(join(out, "checks.json"), "utf8"))).toEqual({ surface: "s-welcome", checks: specs["s-welcome"].checks });
    expect(manifest.references["mockup.png"].source).toBe("mockups/01-welcome.png");
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("refuses a missing mockup rather than building a packet without it", () => {
    const bar = temp();
    const dir = temp();
    writeFileSync(join(dir, "capture.png"), "cap");
    expect(() => buildSurfacePacket({ surface: "s-welcome", capture: join(dir, "capture.png"), out: join(dir, "p"), bar })).toThrow(/missing input/);
  });

  it("tells critics the mockup's copy, numbers and pixel positions are direction only", () => {
    const prompt = readFileSync(SURFACE_CRITIC_PROMPT_PATH, "utf8");
    expect(prompt).toMatch(/Exact copy, sample numbers, sample project names and pixel positions/);
    expect(prompt).toMatch(/real data wins/);
  });
});
