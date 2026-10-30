/**
 * M2.10 page 03 (Design > Configurations), live: the web bundle on the app
 * server and sidecar over the seeded research vehicle (global setup). The
 * table lists the fixture's configurations with their motor, recovery, and
 * a simulation status derived from the real runs; the selection persists
 * across sub-tabs; the motor picker searches and filters the built-in
 * generic library and plots each curve; New / Duplicate / Rename / Assign /
 * deployment / Delete write the project through `model.patch`; and
 * `▶ Run configurations` flies every configuration. Recovery altitude, delay,
 * and timer are unit-aware fields (validation messages until the model is
 * complete); a two-stage fixture assigns a motor per stage mount and edits
 * the stage separation event and delay (R6.5, REV2-web).
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auxProject, REPO, type AuxProject } from "./aux-project.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";
const PROJECT = process.env["RW_E2E_PROJECT"] ?? "";

const row = (page: Page, id: string) => page.locator(`[data-testid="configs.row"][data-config="${id}"]`);
const action = (page: Page, a: string) => page.locator(`[data-testid="configs.action"][data-action="${a}"]`);
const subtab = (page: Page, name: string) => page.getByTestId("configs.subtab").filter({ hasText: name });
const motorRow = (page: Page, ref: string) => page.locator(`[data-testid="motors.row"][data-motor="${ref}"]`);
const filter = (page: Page, label: string) => page.locator(`[data-testid="motors.filter"][aria-label="${label}"]`);
const cfgFile = (id: string) => join(PROJECT, "configs", `${id}.rw.toml`);

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
  expect(PROJECT, "RW_E2E_PROJECT from global-setup").not.toBe("");
});

/** Specs on their own project (aux-project.ts) open it themselves. */
const MULTI = "multi-stage editing (two-stage fixture)";

test.beforeEach(async ({ page }, info) => {
  if (info.titlePath.includes(MULTI)) return;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=03`);
  await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
  await expect(page.getByTestId("configurations-page")).toBeVisible();
  await expect(page.getByTestId("configs.row")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("motors.list")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("lists the configurations with motor, recovery, and run status", async ({ page }) => {
  await expect(page.getByTestId("page.title")).toHaveText("Flight configurations");
  await expect(page.getByTestId("configs.header").locator('[role="columnheader"]')).toHaveText(["", "Configuration", "Motor", "Recovery", "Simulation"]);
  await expect(page.getByTestId("configs.action")).toHaveText(["New", "Duplicate", "Rename", "Delete"]);
  const want = [
    ["baseline", "Baseline", "RW_B4G", "Parachute (stowed)", "simulated"],
    ["higher_altitude", "Higher altitude", "RW_C6G", "Parachute (stowed)", "simulated"],
    ["recovery_test", "Recovery test", "RW_A8G", "Streamer", "not_simulated"],
  ] as const;
  for (const [id, name, motor, recovery, status] of want) {
    await expect(row(page, id)).toContainText(name);
    await expect(row(page, id).getByTestId("configs.motor")).toHaveText(motor);
    await expect(row(page, id).getByTestId("configs.recovery")).toHaveText(recovery);
    await expect(row(page, id)).toHaveAttribute("data-status", status);
  }
  await expect(row(page, "baseline").getByTestId("configs.status")).toHaveText(/^Simulated · \w{3} \d+, \d{4}$/);
  await expect(row(page, "recovery_test").getByTestId("configs.status")).toHaveText("—Not simulated");
  // The first configuration is selected by default.
  await expect(row(page, "baseline")).toHaveAttribute("aria-checked", "true");
  // The composer is the embedded Lecturn pane's (B17); its per-page placeholder is unit-tested (`embed/composerHints.test.ts`).
});

test("the selected configuration persists across sub-tabs", async ({ page }) => {
  await row(page, "higher_altitude").click();
  await expect(row(page, "higher_altitude")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("motor.detail")).toHaveAttribute("data-motor", "generic:RW_C6G");
  await subtab(page, "Recovery").click();
  await expect(subtab(page, "Recovery")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("recovery-panel")).toHaveAttribute("data-config", "higher_altitude");
  await expect(page.locator('[data-testid="recovery.row"][data-component="chute"]')).toHaveAttribute("data-event", "ejection");
  await expect(page.locator('[data-testid="recovery.row"][data-component="streamer"]')).toHaveAttribute("data-event", "never");
  await subtab(page, "Stage separation").click();
  await expect(page.getByTestId("stage-panel")).toHaveAttribute("data-config", "higher_altitude");
  await expect(page.getByTestId("stage.empty")).toContainText("Single-stage");
  await subtab(page, "Motors").click();
  await expect(row(page, "higher_altitude")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("motor-panel")).toHaveAttribute("data-config", "higher_altitude");
});

test("the motor detail follows the selected configuration's mounted motor (R19-03)", async ({ page }) => {
  // configs.<id>.motors.<mount>.motor, read from the project file.
  const mounted = (id: string) => /\[motors\.[^\]]+\][^[]*?motor = "([^"]+)"/.exec(readFileSync(cfgFile(id), "utf8"))?.[1];
  const detail = page.getByTestId("motor.detail");
  for (const id of ["baseline", "higher_altitude", "recovery_test"]) {
    await row(page, id).click();
    await expect(detail).toHaveAttribute("data-motor", mounted(id)!);
    await expect(page.getByTestId("motor-panel")).toHaveAttribute("data-assigned", mounted(id)!);
  }
  // A comparison candidate shows only while its configuration stays selected.
  await row(page, "baseline").click();
  await expect(detail).toHaveAttribute("data-motor", "generic:RW_B4G");
  await motorRow(page, "generic:RW_C6G").click();
  await expect(detail).toHaveAttribute("data-motor", "generic:RW_C6G");
  await row(page, "recovery_test").click();
  await expect(detail).toHaveAttribute("data-motor", mounted("recovery_test")!);
  await row(page, "baseline").click();
  await expect(detail).toHaveAttribute("data-motor", mounted("baseline")!);
  await expect(page.getByTestId("motor.assign")).toHaveAttribute("data-state", "assigned");
});

test("the motor picker searches and filters the generic library and plots the curve", async ({ page }) => {
  const total = await page.getByTestId("motors.row").count();
  expect(total).toBeGreaterThanOrEqual(7);
  for (const label of ["Diameter", "Manufacturer", "Impulse class"]) await expect(filter(page, label)).toHaveValue("All");
  await expect(page.getByTestId("motors.search")).toHaveAttribute("placeholder", "Search motors…");
  await filter(page, "Diameter").selectOption("18 mm");
  await expect(page.getByTestId("motors.row")).toHaveCount(3);
  await filter(page, "Diameter").selectOption("All");
  await filter(page, "Impulse class").selectOption("C");
  await expect(page.getByTestId("motors.row")).toHaveCount(1);
  await filter(page, "Impulse class").selectOption("All");
  await page.getByTestId("motors.search").fill("a8");
  await expect(page.getByTestId("motors.row")).toHaveCount(1);
  await page.getByTestId("motors.search").fill("");
  await expect(page.getByTestId("motors.row")).toHaveCount(total);

  // Baseline flies RW_B4G: its row is the assigned one and the detail shows it.
  await expect(motorRow(page, "generic:RW_B4G").getByTestId("motors.assigned")).toHaveCount(1);
  await expect(page.getByTestId("motor.title")).toHaveText("RW_B4G");
  await expect(page.getByTestId("motor.mount-pill")).toHaveText("18 mm mount");
  await expect(page.getByTestId("motor.assign")).toHaveText("Assigned");
  await expect(page.getByTestId("motor.assign")).toBeDisabled();
  await expect(motorRow(page, "generic:RW_B4G")).toContainText("18 mm · Generic");
  const curve = page.getByTestId("motor.thrust-curve");
  expect(Number(await curve.getAttribute("data-points"))).toBeGreaterThan(2);
  await expect(curve).toContainText("Thrust (N)");
  await expect(curve).toContainText("Time (s)");
  await expect(page.getByTestId("motor.silhouette")).toContainText("Motor mount18 mm");
  await expect(page.getByTestId("motor.mount-highlight")).toHaveCount(1);
  await expect(page.locator('[data-testid="motor.field"][data-field="mount"]')).toContainText("18 mm");
  await expect(page.locator('[data-testid="motor.field"][data-field="delay"]')).toContainText("Ejection delay");
  // R20-03: the seeded 3 s is not one of RW_B4G's listed delays (2, 4, 6 s): a custom delay, and the box agrees.
  await expect(page.getByTestId("motor.delay")).toHaveValue("3");
  await expect(page.getByTestId("motor.delay-source")).toHaveText("Custom");
  await expect(page.getByTestId("motor.use-file")).not.toBeChecked();
  await expect(page.getByTestId("motor.use-file-label")).toHaveText("Off · lists 2, 4, 6 s");
  // The thrust curve has its light grid and the accent area under it with the grid toggle off.
  expect(await page.locator(".rw-thrust__grid-light").count()).toBeGreaterThan(4);
  await expect(page.getByTestId("motor.thrust-area")).toHaveCount(1);

  // A different motor: its own curve; a 24 mm motor does not fit the 18 mm mount.
  await motorRow(page, "generic:RW_C6G").click();
  await expect(page.getByTestId("motor.title")).toHaveText("RW_C6G");
  await expect(page.getByTestId("motor.assign")).toHaveText("Assign to configuration");
  await expect(page.getByTestId("motor.assign")).toBeEnabled();
  await motorRow(page, "generic:RW_D10G").click();
  await expect(motorRow(page, "generic:RW_D10G")).toHaveAttribute("data-fits", "false");
  await expect(page.getByTestId("motor.assign")).toBeDisabled();
  await page.getByTestId("motors.info").first().click();
  await expect(page.getByTestId("motors.details")).toContainText("Total impulse");

  // Toolbar: grid, rendering, show rocket, units.
  await page.getByTestId("toolbar.show-grid").click();
  await expect(page.getByTestId("toolbar.show-grid")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("motor.thrust-curve")).toHaveAttribute("data-grid", "true");
  expect(await page.locator(".rw-thrust__grid").count()).toBeGreaterThan(4);
  await page.getByTestId("toolbar.rendering").selectOption("flat");
  await expect(page.getByTestId("motor.casing")).toHaveAttribute("data-style", "flat");
  await page.getByTestId("toolbar.show-rocket").click();
  await expect(page.getByTestId("motor.silhouette")).toHaveCount(0);
  await page.getByTestId("toolbar.units").selectOption("cm");
  await expect(page.getByTestId("motor.mount-pill")).toHaveText("1.8 cm mount");
  await page.getByTestId("toolbar.view-chip").filter({ hasText: "Side" }).click();
  await expect(page.getByTestId("motor.casing")).toHaveAttribute("data-view", "side");
});

test("New, Duplicate, Rename, Assign, deployment, and Delete write the project", async ({ page }) => {
  // Duplicate Baseline: a configuration and its linked sim, selected.
  await action(page, "duplicate").click();
  await expect(page.getByTestId("configs.row")).toHaveCount(4);
  await expect(row(page, "baseline_copy")).toHaveAttribute("aria-checked", "true");
  await expect(row(page, "baseline_copy")).toContainText("Baseline (copy)");
  await expect(row(page, "baseline_copy")).toHaveAttribute("data-status", "not_simulated");
  expect(existsSync(cfgFile("baseline_copy"))).toBe(true);
  expect(readFileSync(join(PROJECT, "sims", "baseline_copy.rw.toml"), "utf8")).toMatch(/config = "baseline_copy"/);

  // Rename it.
  await action(page, "rename").click();
  await page.getByTestId("configs.rename-input").fill("Copy test");
  await page.getByTestId("configs.rename-input").press("Enter");
  await expect(row(page, "baseline_copy")).toContainText("Copy test");
  await expect.poll(() => readFileSync(cfgFile("baseline_copy"), "utf8")).toMatch(/name = "Copy test"/);

  // Assign another motor.
  await motorRow(page, "generic:RW_A8G").click();
  await page.getByTestId("motor.assign").click();
  await expect(row(page, "baseline_copy").getByTestId("configs.motor")).toHaveText("RW_A8G");
  await expect(page.getByTestId("motor.assign")).toHaveText("Assigned");
  await expect.poll(() => readFileSync(cfgFile("baseline_copy"), "utf8")).toMatch(/motor = "generic:RW_A8G"/);

  // Deploy the streamer at apogee.
  await subtab(page, "Recovery").click();
  await page.locator('[data-testid="recovery.row"][data-component="streamer"] [data-testid="recovery.event"]').selectOption("apogee");
  await expect(page.locator('[data-testid="recovery.row"][data-component="streamer"]')).toHaveAttribute("data-event", "apogee");
  await expect(row(page, "baseline_copy").getByTestId("configs.recovery")).toHaveText("Parachute (stowed), Streamer");
  await subtab(page, "Motors").click();

  // Delete it (and its sim).
  await action(page, "delete").click();
  await page.getByTestId("configs.confirm").click();
  await expect(page.getByTestId("configs.row")).toHaveCount(3);
  await expect.poll(() => existsSync(cfgFile("baseline_copy"))).toBe(false);
  expect(existsSync(join(PROJECT, "sims", "baseline_copy.rw.toml"))).toBe(false);

  // New: a fitting motor and a linked sim; then remove it.
  await action(page, "new").click();
  await expect(row(page, "new_configuration")).toHaveAttribute("aria-checked", "true");
  await expect(row(page, "new_configuration").getByTestId("configs.motor")).toHaveText(/^RW_/);
  expect(existsSync(join(PROJECT, "sims", "new_configuration.rw.toml"))).toBe(true);
  await action(page, "delete").click();
  await page.getByTestId("configs.confirm").click();
  await expect(page.getByTestId("configs.row")).toHaveCount(3);
});

test("Run configurations flies every configuration", async ({ page }) => {
  const run = page.getByTestId("agent.run-configurations");
  await expect(run).toHaveAttribute("data-sims", /baseline/);
  await expect(run).toContainText("Run configurations");
  await run.click();
  // Recovery test had never flown: it ends Simulated, like the others.
  await expect(row(page, "recovery_test")).toHaveAttribute("data-status", "simulated", { timeout: 90_000 });
  await expect(row(page, "baseline")).toHaveAttribute("data-status", "simulated");
  await expect(row(page, "higher_altitude")).toHaveAttribute("data-status", "simulated");
});

test("altitude, delay, and timer deployments are editable and validated", async ({ page }) => {
  await action(page, "duplicate").click();
  await expect(row(page, "baseline_copy")).toHaveAttribute("aria-checked", "true");
  await subtab(page, "Recovery").click();
  const chute = page.locator('[data-testid="recovery.row"][data-component="chute"]');
  const streamer = page.locator('[data-testid="recovery.row"][data-component="streamer"]');

  // At altitude without an altitude: the model's error shows and the field is there to fix it.
  await chute.getByTestId("recovery.event").selectOption("altitude");
  await expect(chute).toHaveAttribute("data-event", "altitude");
  await expect(chute).toHaveAttribute("data-invalid", "true");
  await expect(page.getByTestId("recovery.validation")).toContainText("deploys at an altitude but none is given");
  const alt = chute.getByTestId("recovery.altitude");
  await expect(chute.getByTestId("recovery.altitude-cell")).toContainText("m");
  // Local validation: a non-positive altitude is refused and nothing is written.
  await alt.fill("0");
  await alt.press("Enter");
  await expect(chute.getByTestId("recovery.altitude-error")).toContainText("greater than 0");
  await alt.fill("150");
  await alt.press("Enter");
  await expect.poll(() => readFileSync(cfgFile("baseline_copy"), "utf8")).toMatch(/\[deploy\.chute\][^[]*altitude = "150 m"/);
  await expect(chute).not.toHaveAttribute("data-invalid", "true");
  await expect(page.getByTestId("recovery.validation")).toHaveCount(0);
  await expect(alt).toHaveValue("150");
  // Units follow the toolbar: inches show the altitude in feet.
  await page.getByTestId("toolbar.units").selectOption("in");
  await expect(alt).toHaveValue("492.1");
  await expect(chute.getByTestId("recovery.altitude-cell")).toContainText("ft");
  await page.getByTestId("toolbar.units").selectOption("mm");

  // A delay after the event.
  const delay = chute.getByTestId("recovery.delay");
  await delay.fill("1.5");
  await delay.press("Enter");
  await expect.poll(() => readFileSync(cfgFile("baseline_copy"), "utf8")).toMatch(/\[deploy\.chute\][^[]*delay = "1\.5 s"/);

  // Timer: the time after launch is required, then written.
  await streamer.getByTestId("recovery.event").selectOption("timer");
  await expect(streamer).toHaveAttribute("data-event", "timer");
  await expect(page.getByTestId("recovery.validation")).toContainText("deploys on a timer but no `delay` is given");
  const timer = streamer.getByTestId("recovery.delay");
  await expect(timer).toHaveAttribute("aria-label", "Streamer time after launch");
  await timer.fill("-2");
  await timer.press("Enter");
  await expect(streamer.getByTestId("recovery.delay-error")).toContainText("0 s or more");
  await timer.fill("6");
  await timer.press("Enter");
  await expect.poll(() => readFileSync(cfgFile("baseline_copy"), "utf8")).toMatch(/\[deploy\.streamer\][^[]*event = "timer"[^[]*delay = "6 s"/);
  await expect(page.getByTestId("recovery.validation")).toHaveCount(0);

  // Clean up: the shared project keeps its three configurations.
  await subtab(page, "Motors").click();
  await action(page, "delete").click();
  await page.getByTestId("configs.confirm").click();
  await expect(page.getByTestId("configs.row")).toHaveCount(3);
});

test.describe(MULTI, () => {
  let aux: AuxProject;
  const file = () => join(aux.dir, "configs", "a8_c6.rw.toml");

  test.beforeAll(async () => {
    aux = await auxProject(join(REPO, "app/e2e/fixtures/two-stage"), "Two stage");
  });
  test.afterAll(async () => {
    await aux?.stop();
  });

  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=03`);
    await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
    await expect(page.getByTestId("configs.row")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("motors.list")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  test("assigns a motor per stage mount", async ({ page }) => {
    await expect(row(page, "a8_c6").getByTestId("configs.motor")).toHaveText("RW_C6G, RW_A8G");
    const mount = page.getByTestId("motor.mount");
    await expect(mount.locator("option")).toHaveText(["Sustainer · Sustainer mount · RW_A8G", "Booster · Booster mount · RW_C6G"]);
    // Each mount shows its own assignment.
    await expect(page.getByTestId("motor-panel")).toHaveAttribute("data-mount", "sustainer_mmt");
    await expect(page.getByTestId("motor.title")).toHaveText("RW_A8G");
    await expect(page.getByTestId("motor.ignition")).toHaveValue("previous_burnout");
    await mount.selectOption("booster_mmt");
    await expect(page.getByTestId("motor-panel")).toHaveAttribute("data-mount", "booster_mmt");
    await expect(page.getByTestId("motor.title")).toHaveText("RW_C6G");
    await expect(motorRow(page, "generic:RW_C6G").getByTestId("motors.assigned")).toHaveCount(1);
    await expect(page.getByTestId("motor.ignition")).toHaveValue("launch");
    // A new booster motor goes to the booster mount only.
    await motorRow(page, "generic:RW_B4G").click();
    await expect(page.getByTestId("motor.assign")).toHaveAttribute("title", /\(Booster · Booster mount\)$/);
    await page.getByTestId("motor.assign").click();
    await expect(row(page, "a8_c6").getByTestId("configs.motor")).toHaveText("RW_B4G, RW_A8G");
    await expect.poll(() => readFileSync(file(), "utf8")).toMatch(/\[motors\.booster_mmt\]\s*motor = "generic:RW_B4G"/);
    expect(readFileSync(file(), "utf8")).toMatch(/\[motors\.sustainer_mmt\]\s*motor = "generic:RW_A8G"/);
    // The sustainer keeps its motor and ignition; its ignition is editable.
    await mount.selectOption("sustainer_mmt");
    await expect(page.getByTestId("motor.title")).toHaveText("RW_A8G");
    await page.getByTestId("motor.ignition").selectOption("stage_separation");
    await expect.poll(() => readFileSync(file(), "utf8")).toMatch(/\[motors\.sustainer_mmt\][^[]*ignition = "stage_separation"/);
  });

  test("edits the separation event and delay per stage", async ({ page }) => {
    await subtab(page, "Stage separation").click();
    await expect(page.getByTestId("stage.row")).toHaveCount(2);
    const booster = page.locator('[data-testid="stage.row"][data-stage="booster"]');
    await expect(booster).toHaveAttribute("data-separation", "upper_ignition");
    // The top stage has no separation of its own.
    await expect(page.locator('[data-testid="stage.row"][data-stage="sustainer"] [data-testid="stage.separation"]')).toHaveCount(0);
    await booster.getByTestId("stage.separation").selectOption("burnout");
    await expect(booster).toHaveAttribute("data-separation", "burnout");
    await expect.poll(() => readFileSync(file(), "utf8")).toMatch(/\[stages\.booster\][^[]*separation = "burnout"/);
    const delay = booster.getByTestId("stage.delay");
    await delay.fill("-1");
    await delay.press("Enter");
    await expect(booster.getByTestId("stage.delay-error")).toContainText("0 s or more");
    await delay.fill("0.5");
    await delay.press("Enter");
    await expect.poll(() => readFileSync(file(), "utf8")).toMatch(/\[stages\.booster\][^[]*separation_delay = "0\.5 s"/);
    await expect(delay).toHaveValue("0.5");
  });
});
