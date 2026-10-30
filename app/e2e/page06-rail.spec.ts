/**
 * M5.5 page 06 rail extras (Simulate > `Simulation` rail), live: the web
 * bundle on the app server and sidecar over the seeded research vehicle
 * (global setup; its Baseline and Higher altitude runs are Complete).
 *
 * - The rail lists Propulsion simulation, Trajectory analysis, Stability
 *   analysis, and Thermal analysis; no row is a dead entry.
 * - Trajectory analysis plots the flight runs' altitude and 3D flight path
 *   from their series and lists their summary figures (apogee as on Results).
 * - Stability analysis plots the stability margin to apogee from the same
 *   runs and lists liftoff, burnout, minimum, and maximum margins.
 * - Thermal analysis is an honest empty state: not modelled, no numbers.
 * - Propulsion simulation reopens the tier the user last had.
 */
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { REPO_ROOT } from "./bar/paths.ts";

/** Page shots for review (gitignored). */
const SHOTS = join(REPO_ROOT, ".playwright/m5/page06");
test.use({ viewport: { width: 1536, height: 1024 } });

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";

const row = (page: Page, id: string) => page.locator(`[data-testid="rail.nav-row"][data-row="${id}"]`);

async function openPage06(page: Page, errors: string[]): Promise<void> {
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=06`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("propsim-page")).toBeVisible();
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
});

test("the Simulation rail opens Trajectory, Stability, and Thermal analysis from the project's runs", async ({ page }) => {
  const errors: string[] = [];
  await openPage06(page, errors);
  await expect(page.getByTestId("rail.nav-title")).toHaveText("Simulation");
  await expect(page.getByTestId("rail.nav-row")).toHaveText(["Propulsion simulation", "Trajectory analysis", "Stability analysis", "Thermal analysis"]);
  await expect(row(page, "propulsion")).toHaveAttribute("aria-selected", "true");

  // Trajectory analysis: the two Complete flight runs, altitude plot, 3D path, summary figures.
  await row(page, "trajectory").click();
  await expect(row(page, "trajectory")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "propulsion")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator('[data-testid="header.tab"][aria-selected="true"]')).toHaveText("Simulate");
  await expect(page.getByTestId("analysis-page")).toHaveAttribute("data-view", "trajectory");
  await expect(page.getByTestId("page.title")).toHaveText("Trajectory analysis");
  await expect(page.getByTestId("analysis.body")).toHaveAttribute("data-runs", "baseline,higher_altitude");
  await expect(page.getByTestId("analysis.plot")).toHaveAttribute("data-lines", "2", { timeout: 30_000 });
  await expect(page.getByTestId("analysis.path")).toHaveAttribute("data-paths", "2");
  await expect(page.locator('[data-testid="analysis.plot"] canvas').first()).toBeVisible();
  await expect(page.getByTestId("inset.trajectory")).toBeVisible();
  const apogee = page.locator('[data-testid="analysis.stat"][data-stat="apogee"] td');
  await expect(apogee).toHaveCount(2);
  for (const cell of await apogee.allInnerTexts()) expect(cell).toMatch(/^[\d,]+ m$/);
  const trajApogee = await apogee.allInnerTexts();
  await page.screenshot({ path: join(SHOTS, "06-trajectory.png") });

  // Stability analysis: the same runs' margins, in calibers.
  await row(page, "stability").click();
  await expect(page.getByTestId("analysis-page")).toHaveAttribute("data-view", "stability");
  await expect(page.getByTestId("page.title")).toHaveText("Stability analysis");
  await expect(page.getByTestId("analysis.plot")).toHaveAttribute("data-lines", "2", { timeout: 30_000 });
  await expect(page.getByTestId("analysis.stat")).toHaveCount(5);
  for (const stat of ["liftoff", "max", "summary_min"]) {
    for (const cell of await page.locator(`[data-testid="analysis.stat"][data-stat="${stat}"] td`).allInnerTexts()) expect(cell, stat).toMatch(/^-?\d+\.\d\d cal$/);
  }
  for (const cell of await page.locator('[data-testid="analysis.stat"][data-stat="min"] td').allInnerTexts()) expect(cell).toMatch(/^-?\d+\.\d\d cal at \d+\.\d\d s$/);
  const min = (await page.locator('[data-testid="analysis.stat"][data-stat="min"] td').allInnerTexts()).map((c) => Number.parseFloat(c));
  const max = (await page.locator('[data-testid="analysis.stat"][data-stat="max"] td').allInnerTexts()).map((c) => Number.parseFloat(c));
  for (let i = 0; i < 2; i++) expect(min[i]!).toBeLessThanOrEqual(max[i]!);
  await page.screenshot({ path: join(SHOTS, "06-stability.png") });

  // The apogee agrees with the Results page (same runs, same summaries).
  await page.locator('[data-testid="header.tab"]', { hasText: "Results" }).click();
  await expect(page.getByTestId("results-page")).toBeVisible();
  for (const cell of trajApogee) await expect(page.getByTestId("results-page")).toContainText(cell.replace(" m", ""));
  await page.locator('[data-testid="header.tab"]', { hasText: "Simulate" }).click();

  // Thermal analysis: not modelled, says so, shows no figures.
  await row(page, "thermal").click();
  await expect(page.getByTestId("analysis-page")).toHaveAttribute("data-view", "thermal");
  await expect(page.getByTestId("analysis.thermal-empty")).toContainText("Thermal analysis is not modelled yet");
  await expect(page.getByTestId("analysis.plot")).toHaveCount(0);
  await expect(page.getByTestId("analysis.stat")).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "06-thermal.png") });
  await page.getByTestId("analysis.open-engineering").click();
  await expect(page.getByTestId("propsim-page")).toHaveAttribute("data-tier", "engineering");
  await expect(row(page, "propulsion")).toHaveAttribute("aria-selected", "true");

  // Propulsion simulation reopens the tier last shown.
  await page.locator('[data-testid="propsim.tier-tab"][data-tier="cfd"]').click();
  await row(page, "stability").click();
  await row(page, "propulsion").click();
  await expect(page.getByTestId("propsim-page")).toHaveAttribute("data-tier", "cfd");
  expect(errors).toEqual([]);
});
