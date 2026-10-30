/**
 * M3.4 "Render still" on the live page 01: the viewport's camera button opens
 * the panel; a path-traced still (three-gpu-pathtracer/webgpu) of the current
 * view reaches its sample count, stays under the noise ceiling, is labelled
 * visual tier, and can be saved. With the section on, the still is cut for
 * real (manifold-3d). Product feature only: these stills are never bar
 * evidence (D26). Stills land in `.playwright/m3/still/`.
 */
import { expect, test, type Page } from "@playwright/test";
import { STILL_NOISE_MAX } from "../apps/web/src/render/metrics.ts";
import { openAssembly, saveArtifact, viewport, vp } from "./viewport-helpers.ts";

test.setTimeout(240_000);

const panel = (page: Page) => page.getByTestId("still.panel");

async function renderStill(page: Page, samples: number): Promise<void> {
  await page.getByTestId("still.samples").selectOption(String(samples));
  await page.getByTestId("still.render").click();
  await expect(panel(page)).toHaveAttribute("data-state", /rendering|done/);
  await expect(panel(page)).toHaveAttribute("data-state", "done", { timeout: 200_000 });
}

async function savedPng(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const a = document.querySelector<HTMLAnchorElement>('[data-testid="still.save"]')!;
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    let s = "";
    for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
}

test.beforeEach(async ({ page }) => {
  await openAssembly(page);
  test.skip((await vp<string>(page, "backend")) !== "webgpu", "the path tracer needs WebGPU");
});

test("renders a path-traced still of the view: samples reached, low noise, visual tier, saveable", async ({ page }) => {
  await page.getByTestId("toolbar.explode").fill("60");
  await expect(viewport(page)).toHaveAttribute("data-explode", "0.60");
  await page.getByTestId("vp.render-still").click();
  await expect(panel(page)).toHaveAttribute("data-state", "idle");
  await expect(panel(page)).toHaveAttribute("data-provenance", "visual");
  await expect(panel(page)).toContainText("Visual only");
  await renderStill(page, 32);
  const samples = Number(await panel(page).getAttribute("data-samples"));
  const noise = Number(await panel(page).getAttribute("data-noise"));
  expect(samples).toBeGreaterThanOrEqual(32);
  expect(noise, `noise ${noise}`).toBeLessThan(STILL_NOISE_MAX);
  const box = (await viewport(page).boundingBox())!;
  expect(Number(await panel(page).getAttribute("data-width"))).toBe(Math.round(box.width));
  await expect(page.getByTestId("still.image")).toBeVisible();
  await expect(page.getByTestId("still.save")).toHaveAttribute("download", /\.png$/);
  const png = await savedPng(page);
  expect(png.length).toBeGreaterThan(10_000);
  saveArtifact("still", "still-exploded-32spp.png", png);
  // The live view kept running underneath.
  await expect(viewport(page)).toHaveAttribute("data-ready", "true");
  await page.getByTestId("still.close").click();
  await expect(panel(page)).toHaveCount(0);
});

test("a section still is cut with manifold-3d (the tracer ignores clipping planes)", async ({ page }) => {
  await page.getByTestId("toolbar.section").click();
  await expect(viewport(page)).toHaveAttribute("data-section", "true");
  await page.getByTestId("vp.render-still").click();
  await renderStill(page, 16);
  expect(Number(await panel(page).getAttribute("data-samples"))).toBeGreaterThanOrEqual(16);
  expect(Number(await panel(page).getAttribute("data-section-manifold"))).toBeGreaterThan(3);
  saveArtifact("still", "still-section-16spp.png", await savedPng(page));
});
