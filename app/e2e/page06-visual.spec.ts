/**
 * M5.1-M5.3 page 06 Visual flow tier (Simulate > Propulsion simulation),
 * live: the web bundle on the app server and sidecar over the seeded
 * research vehicle (global setup). The tier lists the project's
 * `kind = "visual_flow"` studies, runs the selected one through `sim.run`
 * (a run whose manifest and `visual.json` say `provenance = "visual"`), and
 * shows the cutaway, transport, layers, and traces.
 *
 * - The label "Visual model · Not an engineering result" is present iff the
 *   record's provenance is visual (I13): a record served with another
 *   provenance shows that provenance's label instead, and the Engineering
 *   tier never shows it.
 * - The traces' cursor is the transport time (scrub, play, speed).
 * - RL1d/M5.3 capture: the live page at 1536x1024 beside exemplar 06 and a
 *   5 s motion clip (frames + contact sheet) in `.playwright/m5/page06/`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { grid, resize, crop } from "../apps/web/spikes/recovery-bay/compose.ts";
import { exemplarDir, REPO_ROOT } from "./bar/paths.ts";
import { decodePng, encodePng } from "./bar/png.ts";

/** Captures for the RL1d/M5 gate (gitignored). */
const M5_OUT = join(REPO_ROOT, ".playwright/m5");

function saveArtifact(sub: string, name: string, pngBase64: string): string {
  const dir = join(M5_OUT, sub);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(pngBase64, "base64"));
  return p;
}

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";
const VISUAL_LABEL = "Visual model · Not an engineering result";

const tier = (page: Page, id: string) => page.locator(`[data-testid="propsim.tier-tab"][data-tier="${id}"]`);
const visual = (page: Page) => page.getByTestId("propsim.visual");

async function openVisual(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=06`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await tier(page, "visual").click();
  await expect(page.getByTestId("propsim-page")).toHaveAttribute("data-tier", "visual");
  await expect(visual(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(page.getByTestId("visual.viewport")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(errors).toEqual([]);
}

const transportT = async (page: Page) => Number(await page.getByTestId("transport").getAttribute("data-t"));
const cursor = async (page: Page, id: "flow" | "fill") => Number(await page.locator(`[data-testid="visual.trace"][data-trace="${id}"]`).getAttribute("data-cursor"));

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

test("a study runs as a visual run: studies, layers, transport, traces, and the provenance label", async ({ page }) => {
  await openVisual(page);
  await expect(page.getByTestId("visual.study")).toHaveText(["Study 01", "Flow overview", "Tank motion"]);
  await expect(page.locator('[data-testid="visual.study"][aria-selected="true"]')).toHaveText("Study 01");
  await expect(page.getByTestId("visual.layer")).toHaveCount(4);
  for (const l of ["shell", "section", "flow", "labels"]) await expect(page.locator(`[data-testid="visual.layer"][data-layer="${l}"]`)).toBeChecked();

  // The run on disk: manifest and timeline both visual.
  const runId = (await visual(page).getAttribute("data-run")) ?? "";
  expect(runId).toMatch(/^[0-9a-f]{12}$/);
  const dir = join(PROJECT, "runs", "study_01", runId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { provenance: string; kind: string };
  const record = JSON.parse(readFileSync(join(dir, "visual.json"), "utf8")) as { provenance: string; duration: number; samples: unknown[] };
  expect(manifest).toMatchObject({ provenance: "visual", kind: "visual_flow" });
  expect(record.provenance).toBe("visual");
  await expect(visual(page)).toHaveAttribute("data-provenance", "visual");
  await expect(page.getByTestId("traces.provenance")).toHaveText(VISUAL_LABEL);
  await expect(page.getByText(VISUAL_LABEL)).toHaveCount(1);

  // Labels, legend, transport controls, traces.
  await expect(page.getByTestId("visual.label")).toHaveText(["Liquid propellant(forward tank)", "Feed line", "Engine inlet", "Engine nozzle"]);
  await expect(page.getByTestId("visual.legend")).toContainText("Illustrative flow preview");
  await expect(page.getByTestId("transport.clock")).toHaveText(`0.0 s / ${record.duration.toFixed(1)} s`);
  await expect(page.getByTestId("transport.speed")).toHaveText(["0.5×", "1×", "2×"]);
  await expect(page.locator('[data-testid="transport.speed"][aria-checked="true"]')).toHaveText("1×");
  await expect(page.getByTestId("visual.subtab")).toHaveText(["Inputs", "Traces", "Assumptions"]);
  await expect(page.getByTestId("visual.trace")).toHaveCount(2);
  await expect(page.locator('[data-testid="visual.trace"] figcaption')).toHaveText(["Relative flow", "Relative fill"]);
  for (const id of ["flow", "fill"] as const) await expect(page.locator(`[data-testid="visual.trace"][data-trace="${id}"]`)).toHaveAttribute("data-points", String(record.samples.length));
  await expect(page.getByTestId("visual.open-engineering")).toHaveText("Open engineering run");
  await expect(page.getByTestId("visual.import-cfd")).toHaveText("Import CFD result");

  // Section view switch and the Section layer are one state.
  await page.getByTestId("transport.section").click();
  await expect(page.locator('[data-testid="visual.layer"][data-layer="section"]')).not.toBeChecked();
  await expect(page.getByTestId("visual.viewport")).toHaveAttribute("data-section", "false");
  await page.locator('[data-testid="visual.layer"][data-layer="section"]').check();
  await expect(page.getByTestId("transport.section")).toBeChecked();
  await expect(page.getByTestId("visual.viewport")).toHaveAttribute("data-section", "true");

  // Assumptions and inputs come from the record.
  await page.locator('[data-testid="visual.subtab"][data-sub="assumptions"]').click();
  await expect(page.getByTestId("visual.assumptions")).toContainText("not a CFD solution");
  await page.locator('[data-testid="visual.subtab"][data-sub="inputs"]').click();
  await expect(page.getByTestId("visual.inputs")).toContainText(runId);
  await page.locator('[data-testid="visual.subtab"][data-sub="traces"]').click();

  // Open engineering run goes to the Engineering tier, which never shows the visual label.
  await page.getByTestId("visual.open-engineering").click();
  await expect(tier(page, "engineering")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("propsim.engineering")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(page.getByText(VISUAL_LABEL)).toHaveCount(0);
});

test("the label is bound to the record's provenance, not to the tier", async ({ page }) => {
  // Serve the study's record with another provenance: the tier must say so and drop the visual label.
  await page.route("**/visual.json", async (route) => {
    const res = await route.fetch();
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    await route.fulfill({ response: res, body: JSON.stringify({ ...body, provenance: "engineering" }) });
  });
  await openVisual(page);
  await expect(visual(page)).toHaveAttribute("data-provenance", "engineering");
  await expect(page.getByTestId("traces.provenance")).toHaveText("Engineering result");
  await expect(page.getByText(VISUAL_LABEL)).toHaveCount(0);
});

test("the trace cursor is the transport time: scrub, play, speed", async ({ page }) => {
  await openVisual(page);
  const duration = Number((await page.getByTestId("transport.clock").innerText()).split("/")[1]!.replace("s", "").trim());
  await page.getByTestId("transport.scrubber").fill(String(duration / 2));
  await expect(page.getByTestId("transport.clock")).toHaveText(`${(duration / 2).toFixed(1)} s / ${duration.toFixed(1)} s`);
  for (const id of ["flow", "fill"] as const) expect(await cursor(page, id)).toBeCloseTo(0.5, 3);

  await page.locator('[data-testid="transport.speed"][data-speed="2"]').click();
  await page.getByTestId("transport.play").click();
  await expect(page.getByTestId("transport")).toHaveAttribute("data-playing", "true");
  await page.waitForTimeout(1000);
  await page.getByTestId("transport.play").click();
  await expect(page.getByTestId("transport")).toHaveAttribute("data-playing", "false");
  const t = await transportT(page);
  // 2x for about a second (plus the click round trips) from the middle; still playing time, not the end.
  expect(t).toBeGreaterThan(duration / 2 + 1.2);
  expect(t).toBeLessThan(duration);
  for (const id of ["flow", "fill"] as const) expect(await cursor(page, id)).toBeCloseTo(t / duration, 3);
  // The cursor's line sits at that x in both plots.
  const x = await page.locator('[data-testid="visual.trace"][data-trace="fill"] [data-testid="visual.trace-cursor"]').getAttribute("x1");
  expect(Number(x)).toBeGreaterThan(34 + (400 - 44) * 0.5);
});

test("capture: the live page beside exemplar 06 and a 5 s motion clip", async ({ page }) => {
  // The exemplars are maintainer-only bar material, absent from a plain checkout and CI.
  let exemplars: string | undefined;
  try {
    exemplars = exemplarDir();
  } catch {}
  test.skip(exemplars === undefined, "exemplar PNGs not available (RW_BAR_EXEMPLARS)");
  await openVisual(page);
  await page.waitForTimeout(1500);
  const shot = await page.screenshot();
  saveArtifact("page06", "06-visual.png", shot.toString("base64"));
  const ex = decodePng(readFileSync(join(exemplars!, "06-liquid-simulator.png")));
  const ours = decodePng(shot);
  saveArtifact("page06", "06-side-by-side.png", Buffer.from(encodePng(grid([[resize(ex, 768, 512), resize(ours, 768, 512)]]))).toString("base64"));
  const vp = { x: 262, y: 107, w: 892, h: 570 };
  saveArtifact("page06", "06-viewport-side-by-side.png", Buffer.from(encodePng(grid([[crop(ex, vp), crop(ours, vp)]]))).toString("base64"));
  // Motion: 5 s of play at 1x, 4 frames a second.
  await page.getByTestId("transport.play").click();
  const box = await page.getByTestId("visual.viewport").boundingBox();
  expect(box).not.toBeNull();
  const frames = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    const f = await page.screenshot({ clip: box! });
    saveArtifact("page06/clip", `f${String(i).padStart(2, "0")}.png`, f.toString("base64"));
    frames.push(resize(decodePng(f), Math.round(box!.width / 3), Math.round(box!.height / 3)));
    await page.waitForTimeout(Math.max(0, 250 - (Date.now() - t0)));
  }
  const rows = [];
  for (let i = 0; i < frames.length; i += 5) rows.push(frames.slice(i, i + 5));
  saveArtifact("page06", "06-motion-sheet.png", Buffer.from(encodePng(grid(rows, 6))).toString("base64"));
  expect(await transportT(page)).toBeGreaterThan(3);
  expect(readdirSync(join(M5_OUT, "page06", "clip")).length).toBeGreaterThanOrEqual(20);
});
