/**
 * R0.3a (U19): a real Empty project (`rw init --template empty`) on the live
 * app server opens cleanly on every page: viewports resolve `data-ready`, no
 * fixture rocket is ever requested, the header is neutral, and each page says
 * what to do next. Rust still reports RW-E100; only the UI's reading changes.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { auxProject, type AuxProject } from "./aux-project.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
let aux: AuxProject;
let src: string;

test.beforeAll(async () => {
  src = join(mkdtempSync(join(SCRATCH, "rw-e2e-empty-src-")), "Empty");
  execFileSync(sidecarBinary(), ["init", "--template", "empty", src], { encoding: "utf8" });
  aux = await auxProject(src, "Empty");
});

test.afterAll(async () => {
  await aux?.stop();
  rmSync(dirname(src), { recursive: true, force: true });
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const ready = (page: Page) => expect(page.getByTestId("viewport").first()).toHaveAttribute("data-ready", "true");

test("an Empty project opens cleanly on every page", async ({ page }) => {
  const errors: string[] = [];
  const glb: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    if (r.url().endsWith(".glb")) glb.push(r.url());
  });
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
  await page.waitForFunction(() => {
    const st = (window as unknown as { __rwShell?: { status: string } }).__rwShell?.status;
    return st === "ready" || st === "error";
  });

  // Header: neutral, with no error count or Check model button.
  const header = page.getByTestId("header");
  await expect(header.getByText("Add parts to begin")).toBeVisible();
  await expect(page.getByTestId("header.check-model")).toHaveAttribute("data-check-status", "empty");
  await expect(page.getByTestId("header.check-count")).toHaveCount(0);

  // Design > Assembly.
  await ready(page);
  await expect(page.getByTestId("viewport").first()).toHaveAttribute("data-glb-source", "empty");
  await expect(page.getByTestId("viewport.empty")).toContainText("Add your first part");
  await expect(page.getByTestId("tree.empty")).toContainText("Add your first part");
  await expect(page.getByTestId("inspector")).toContainText("Add your first part");

  // Design > Components: no CP, CG or station labels on a rocket that does not exist.
  await tab(page, "Components").click();
  await ready(page);
  await expect(page.getByTestId("viewport.empty")).toContainText("Add your first part");
  await expect(page.getByTestId("editor")).toContainText("Add your first part");
  await expect(page.getByTestId("viewport").first()).not.toContainText("0 mm");
  await expect(page.getByTestId("vp.scale")).toHaveCount(0);

  // Design > Configurations.
  await tab(page, "Configurations").click();
  await expect(page.getByTestId("motor.add-mount")).toContainText("Add a motor mount first");
  await expect(page.getByTestId("motor.assign")).toBeDisabled();
  await expect(page.getByTestId("motor.silhouette")).toHaveCount(0);
  await tab(page, "Recovery").click();
  await expect(page.getByText("No parachute or streamer in this rocket.")).toBeVisible();
  await tab(page, "Stage separation").click();
  await expect(page.getByText("Single-stage vehicle")).toBeVisible();
  for (const name of ["Recovery", "Stage separation"]) {
    await tab(page, name).click();
  }

  // Propulsion.
  await tab(page, "Propulsion").click();
  await expect(page.getByTestId("liquid.empty")).toContainText("Press New engine to add one");
  await expect(page.getByTestId("propulsion.tree-empty")).toBeVisible();

  // Simulate: every tier and analysis view.
  await tab(page, "Simulate").click();
  await page.locator('[data-testid="propsim.tier-tab"][data-tier="engineering"]').click();
  await expect(page.getByTestId("engineering.empty")).toContainText("Press New engine on the Propulsion page");
  await page.locator('[data-testid="propsim.tier-tab"][data-tier="visual"]').click();
  await expect(page.getByTestId("visual.loading")).toContainText("No visual flow study");
  await expect(page.getByTestId("traces")).toHaveCount(0);
  await page.locator('[data-testid="propsim.tier-tab"][data-tier="cfd"]').click();
  await expect(page.getByTestId("propsim.cfd-empty")).toContainText("Import a CSV");
  for (const row of ["trajectory", "stability"]) {
    await page.locator(`[data-testid="rail.nav-row"][data-row="${row}"]`).click();
    await expect(page.getByTestId("analysis.empty")).toContainText("Run a flight simulation");
  }
  await page.locator('[data-testid="rail.nav-row"][data-row="thermal"]').click();
  await expect(page.getByTestId("analysis.thermal-empty")).toBeVisible();

  // Results.
  await tab(page, "Results").click();
  await expect(page.getByTestId("plot.empty")).toContainText("Nothing to fly yet");

  // Compare: the one step against itself.
  await page.getByTestId("history.compare").click();
  await expect(page.getByTestId("compare")).toHaveAttribute("data-state", "ready");
  await ready(page);
  await expect(page.getByTestId("compare.empty")).toContainText("Nothing to compare yet");
  await expect(page.getByTestId("compare.error")).toHaveCount(0);

  expect(glb, "no fixture rocket for an empty project").toEqual([]);
  expect(errors).toEqual([]);

  // R0.3a: the UI is neutral; `rw check` still reports RW-E100.
  const check = spawnSync(sidecarBinary(), ["-C", src, "--json", "check"], { encoding: "utf8" });
  expect(check.status).not.toBe(0);
  expect(check.stdout).toContain("RW-E100");
});
