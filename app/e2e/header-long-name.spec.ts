/**
 * The header at the narrowest window the app runs in, with the longest name a
 * project can have (255 bytes, `MAX_PROJECT_NAME_BYTES`). No minimum window
 * size is enforced; 1024 is the width of the smallest display RocketWright
 * has been seen on (a 1024x768 macOS CI runner, content 1024x656).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnServer, type ServerHandle } from "../apps/desktop/src/backend.ts";
import { seededCopy, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const NAME = "A very long project name ".repeat(11).slice(0, 255);
/** The floor, both sides of each step where the start column sheds a label, and the default window. */
const WIDTHS = [1024, 1100, 1199, 1200, 1319, 1320, 1536];
const HEIGHT = 656;

let dir: string;
let server: ServerHandle;

test.beforeAll(async () => {
  dir = seededCopy(sidecarBinary(), "rw-e2e-long-name-");
  const manifest = join(dir, "rocketwright.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^name = .*$/m, `name = "${NAME}"`));
  // Two app servers cannot share one Lecturn sidecar base dir.
  const env: NodeJS.ProcessEnv = { ...process.env, LECTURN_HOME: join(dirname(dir), "lh"), RW_LECTURN_BASE_DIR: join(dirname(dir), "lb") };
  delete env["RW_TEST_HOOKS"];
  server = await spawnServer({ projects: [dir], env, log: () => {} });
});

test.afterAll(async () => {
  await server.stop();
  rmSync(dirname(dir), { recursive: true, force: true });
});

async function open(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`${WEB}?rpc=${encodeURIComponent(server.rpcUrl)}&http=${encodeURIComponent(server.serverUrl)}&page=05`);
  await expect(page.getByTestId("header.project-switcher")).toContainText(NAME.slice(0, 20));
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  expect(b, "element has a box").not.toBeNull();
  return b!;
}

const intersects = (a: { x: number; width: number }, b: { x: number; width: number }): boolean => a.x < b.x + b.width && b.x < a.x + a.width;

for (const width of WIDTHS) {
  test(`a 255-character name leaves every tab clear and clickable at ${width} wide`, async ({ page }) => {
    await open(page, width);
    const name = page.getByTestId("header.project-name");
    await expect(name).toHaveCount(1);
    const tabs = page.getByRole("tablist", { name: "Workspace" }).getByRole("tab");
    await expect(tabs).toHaveCount(4);
    const nameBox = await box(name);
    for (const tab of await tabs.all()) {
      const tabBox = await box(tab);
      expect(intersects(tabBox, nameBox), `${await tab.innerText()} tab is clear of the name`).toBe(false);
      const centre = { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 };
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, centre);
      expect(hit, "the tab is the topmost element at its centre").toBe(await tab.innerText());
    }
    const start = await box(page.locator(".rw-header__start"));
    const end = await box(page.locator(".rw-header__end"));
    const first = await box(tabs.first());
    const last = await box(tabs.last());
    expect(start.x + start.width, "the start column ends before the tabs").toBeLessThanOrEqual(first.x + 0.5);
    expect(end.x, "the end column starts after the tabs").toBeGreaterThanOrEqual(last.x + last.width - 0.5);
    const trigger = await box(page.getByTestId("header.project-switcher"));
    expect(trigger.x + trigger.width, "the project trigger is whole, not clipped").toBeLessThanOrEqual(start.x + start.width + 0.5);
    const save = await box(page.getByTestId("header.save-state"));
    expect(save.x + save.width, "the save state is whole, not clipped").toBeLessThanOrEqual(start.x + start.width + 0.5);
    const design = page.getByRole("tab", { name: "Design", exact: true });
    await expect(design).toHaveAttribute("aria-selected", "false");
    await design.click({ timeout: 5000 });
    await expect(design).toHaveAttribute("aria-selected", "true");
  });
}

test("the name truncates with an ellipsis, keeps its full text on hover, and its menu still opens", async ({ page }) => {
  await open(page, WIDTHS[0]!);
  const trigger = page.getByTestId("header.project-switcher");
  const name = page.getByTestId("header.project-name");
  await expect(trigger).toHaveAttribute("title", NAME);
  const overflow = await name.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, style: getComputedStyle(el).textOverflow }));
  expect(overflow.style).toBe("ellipsis");
  expect(overflow.scroll, "the text is cut, not spilled").toBeGreaterThan(overflow.client);
  expect(overflow.client, "enough of the name stays readable").toBeGreaterThanOrEqual(40);
  await trigger.click({ timeout: 5000 });
  await expect(page.getByRole("menu", { name: "Projects" })).toBeVisible();
});
