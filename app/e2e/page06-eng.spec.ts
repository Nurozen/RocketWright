/**
 * M4.8 page 06 Engineering tier (Simulate > Propulsion simulation), live: the
 * web bundle on the app server and sidecar over the seeded research vehicle
 * (global setup). The page flies the complete demo engine's tank blowdown
 * through `engine.simulate` and plots its run record (`engine.json` over
 * HTTP): tank pressure, mass flow, and thrust over time, with the record's
 * provenance (engineering) and the design's assumptions (single-phase N2O).
 * Every number is checked against the run's own `engine.json`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";

const plot = (page: Page, id: string) => page.locator(`[data-testid="engineering.plot"][data-plot="${id}"]`);
const tier = (page: Page, id: string) => page.locator(`[data-testid="propsim.tier-tab"][data-tier="${id}"]`);

interface EngineRun {
  run_id: string;
  provenance: string;
  design: { assumptions: string[] };
  blowdown: { samples: { t: number }[]; burn_time: number; total_impulse: number };
}

/** The run record the page is showing, read from the live project. */
function engineRun(runId: string): EngineRun {
  return JSON.parse(readFileSync(join(PROJECT, "runs", "engine.demo", runId, "engine.json"), "utf8")) as EngineRun;
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=06`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("propsim-page")).toBeVisible();
  await expect(page.getByTestId("propsim.engineering")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Engineering plots the demo engine's blowdown: tank pressure, mass flow, thrust", async ({ page }) => {
  await expect(page.getByTestId("page.title")).toHaveText("Propulsion simulation");
  await expect(page.getByTestId("propsim.tier-tab")).toHaveText(["Engineering", "Visual flow", "Imported CFD"]);
  await expect(tier(page, "engineering")).toHaveAttribute("aria-selected", "true");
  // The composer is the embedded Lecturn pane's (B17); its per-page placeholder is unit-tested (`embed/composerHints.test.ts`).
  const eng = page.getByTestId("propsim.engineering");
  // The complete engine (the incomplete copy cannot fly: its inputs are missing).
  await expect(eng).toHaveAttribute("data-engine", "demo");
  await expect(eng).toHaveAttribute("data-provenance", "engineering");
  await expect(page.getByTestId("traces.provenance")).toHaveText(/^Engineering result/);

  const runId = (await page.getByTestId("engineering.run-id").innerText()).match(/Run ([0-9a-f]{12})/)?.[1] ?? "";
  expect(runId).toMatch(/^[0-9a-f]{12}$/);
  expect(readdirSync(join(PROJECT, "runs", "engine.demo"))).toContain(runId);
  const run = engineRun(runId);
  expect(run.provenance).toBe("engineering");

  // Three plots, each with its series, every sample of the run.
  await expect(page.getByTestId("engineering.plot")).toHaveCount(3);
  for (const [id, series, title] of [
    ["pressure", 3, "Tank pressure"],
    ["mass_flow", 2, "Mass flow"],
    ["thrust", 1, "Thrust"],
  ] as const) {
    await expect(plot(page, id)).toHaveAttribute("data-series", String(series));
    await expect(plot(page, id)).toHaveAttribute("data-points", String(run.blowdown.samples.length));
    await expect(plot(page, id)).toContainText(title);
    await expect(plot(page, id).locator("canvas").first()).toBeVisible();
    expect(Number(await plot(page, id).getAttribute("data-t-end"))).toBeCloseTo(run.blowdown.samples.at(-1)!.t, 3);
  }
  await expect(plot(page, "pressure").getByTestId("engineering.series")).toHaveText(["Tank A · N2O", "Tank B · Ethanol", "Chamber"]);
  await expect(plot(page, "mass_flow").getByTestId("engineering.series")).toHaveText(["N2O", "Ethanol"]);
  await expect(plot(page, "pressure")).toContainText("Pressure (bar)");
  await expect(plot(page, "thrust")).toContainText("Time (s)");

  // Summary from the record; assumptions name the single-phase model.
  const summary = page.getByTestId("engineering.summary");
  await expect(summary.locator('[data-key="burn_time"] dd')).toHaveText(`${run.blowdown.burn_time.toFixed(2)} s`);
  await expect(summary.locator('[data-key="total_impulse"] dd')).toHaveText(`${Math.round(run.blowdown.total_impulse).toLocaleString("en-US")} N·s`);
  await expect(page.getByTestId("engineering.assumptions").locator("li")).toHaveCount(run.design.assumptions.length);
  await expect(page.getByTestId("engineering.assumptions")).toContainText("two-phase self-pressurizing N2O is not modelled");
});

test("the other tiers keep their own provenance and show no engineering numbers", async ({ page }) => {
  await tier(page, "visual").click();
  await expect(page.getByTestId("propsim-page")).toHaveAttribute("data-tier", "visual");
  // The visual tier's own record and label (page06-visual.spec.ts covers it in full).
  await expect(page.getByTestId("propsim.visual")).toHaveAttribute("data-provenance", "visual", { timeout: 60_000 });
  await expect(page.getByTestId("traces.provenance")).toHaveText("Visual model · Not an engineering result");
  await expect(page.getByTestId("engineering.plot")).toHaveCount(0);
  await tier(page, "cfd").click();
  await expect(page.getByTestId("propsim.cfd")).toBeVisible();
  await expect(page.getByTestId("engineering.plot")).toHaveCount(0);
  await tier(page, "engineering").click();
  await expect(page.getByTestId("engineering.plot")).toHaveCount(3);
});
