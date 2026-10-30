/**
 * M3.6 part thumbnails on the live app: the window renders each part (with
 * its visual detail) once per model hash, stores the PNGs in the project's
 * `.rw/cache/thumbs/<model_hash>/`, and shows them in the component tree,
 * the inspector header card, and the motor list (the `@` chip's icon in the
 * embedded pane: `mention.spec.ts`).
 * A second load reads them from the cache (nothing re-rendered). A few land
 * in `.playwright/m3/thumbs/` for review.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HTTP, openAssembly, PROJECT, row, RPC, saveArtifact, viewport, vp, WEB } from "./viewport-helpers.ts";

const status = (page: Page) => page.getByTestId("thumbs.status");

async function thumbsReady(page: Page): Promise<void> {
  await expect(status(page)).toHaveAttribute("data-state", /ready|unavailable/, { timeout: 60_000 });
  test.skip((await status(page).getAttribute("data-state")) === "unavailable", "thumbnails need WebGPU");
}

async function imgBase64(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const src = document.querySelector<HTMLImageElement>(sel)?.src ?? "";
    return src.slice(src.indexOf(",") + 1);
  }, selector);
}

test("tree and inspector card show rendered thumbnails cached by model hash", async ({ page }) => {
  await openAssembly(page);
  test.skip((await vp<string>(page, "backend")) !== "webgpu", "thumbnails render with WebGPU");
  await thumbsReady(page);
  const hash = (await status(page).getAttribute("data-hash"))!;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).toBe(await viewport(page).getAttribute("data-model-hash").then((h) => h || hash));

  // Tree: every row shows a rendered thumbnail, not the line icon.
  const rows = await page.getByTestId("rail.nav-row").count();
  await expect(page.locator('[data-testid="tree.thumbnail"][data-source="render"]')).toHaveCount(rows);
  const natural = await page.locator('[data-testid="tree.thumbnail"] img').first().evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  expect(natural).toEqual([64, 96]);

  // Inspector header card for the selection.
  await row(page, "recovery_bay").click();
  const card = page.getByTestId("insp.thumbnail");
  await expect(card).toHaveAttribute("data-source", "render");
  expect(await card.locator("img").evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([400, 200]);
  saveArtifact("thumbs", "recovery_bay--card.png", await imgBase64(page, '[data-testid="insp.thumbnail"] img'));
  saveArtifact("thumbs", "recovery_bay.png", await imgBase64(page, '[data-testid="rail.nav-row"][data-part="recovery_bay"] [data-testid="tree.thumbnail"] img'));
  saveArtifact("thumbs", "fins.png", await imgBase64(page, '[data-testid="rail.nav-row"][data-part="fins"] [data-testid="tree.thumbnail"] img'));

  // The cache on disk: one PNG per (model_hash, key). Other renders share this
  // cache (page 06's `sim-<id>--section`, Results' `snap-assembly` rocket), so count part keys only.
  const dir = join(PROJECT, ".rw/cache/thumbs", hash);
  const partPngs = () =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png") && !f.startsWith("sim-") && !f.startsWith("snap-")).length : 0;
  await expect.poll(partPngs).toBe(rows * 2);
});

test("a second load reads the cache (nothing re-rendered); the motor list shows the casing", async ({ page }) => {
  await openAssembly(page);
  test.skip((await vp<string>(page, "backend")) !== "webgpu", "thumbnails render with WebGPU");
  await thumbsReady(page);
  // Page 03 in a fresh window: thumbnails come from .rw/cache/thumbs, none rendered here.
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=03`);
  await expect(status(page)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(await status(page).getAttribute("data-rendered")).toBe("0");
  await expect(page.locator('[data-testid="tree.thumbnail"][data-source="render"]').first()).toBeVisible();
  await expect(page.getByTestId("motors.thumbnail").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("motors.thumbnail").first()).toHaveAttribute("data-source", "render");
});
