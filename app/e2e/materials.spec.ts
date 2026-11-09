/**
 * R2.4 (U50) on the web bundle over a live Empty project: all four case 1
 * materials are created through the panel with the same script rows and row
 * driver as the B1 drive, a material is edited, and a library material is
 * copied into the project (D15).
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { auxProject, type AuxProject } from "./aux-project.ts";
import { boundRows } from "./case1-script.ts";
import { driveRow, type DriveContext, type Lifecycle, type RowStatus } from "./case1-stages.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
let aux: AuxProject;
let src: string;

test.beforeAll(async () => {
  src = join(mkdtempSync(join(SCRATCH, "rw-e2e-materials-src-")), "Empty");
  execFileSync(sidecarBinary(), ["init", "--template", "empty", src], { encoding: "utf8" });
  aux = await auxProject(src, "Empty");
});

test.afterAll(async () => {
  await aux?.stop();
  rmSync(dirname(src), { recursive: true, force: true });
});

const materialsOnDisk = () => (parse(readFileSync(join(aux.dir, "rocket.rw.toml"), "utf8")) as { materials?: Record<string, Record<string, unknown>> }).materials ?? {};

function context(page: Page): DriveContext {
  const unused = () => Promise.reject(new Error("not part of this spec"));
  const lifecycle: Lifecycle = { chooseFolder: unused, quit: unused, relaunch: unused, finish: unused };
  return { page, expect, lifecycle, projectName: "Empty", statuses: new Map<string, RowStatus>(), added: new Set(), timeouts: { row: 10_000, launch: 30_000, run: 30_000 }, timing: {}, tableReads: [] };
}

test("creates, edits and copies materials on an Empty project", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
  await page.waitForFunction(() => (window as unknown as { __rwShell?: { status: string } }).__rwShell?.status === "ready");

  const ctx = context(page);
  const rows = boundRows().filter((r) => r.stage === "materials");
  expect(rows.map((r) => r.key)).toEqual(["materials.polystyrene.density", "materials.cardboard.density", "materials.ripstop_nylon.surface_density", "materials.elastic_cord.line_density"]);
  for (const row of rows) await driveRow(ctx, row);

  await expect.poll(materialsOnDisk).toEqual({
    polystyrene: { density: "1050 kg/m^3" },
    cardboard: { density: "680 kg/m^3" },
    ripstop_nylon: { surface_density: "67 g/m^2" },
    elastic_cord: { line_density: "1.8 g/m" },
  });
  const list = page.getByTestId("materials.item");
  await expect(list).toHaveText([/cardboard.*680 kg\/m³/, /elastic cord.*1\.8 g\/m/, /polystyrene.*1050 kg\/m³/, /ripstop nylon.*67 g\/m²/]);

  // Editing rewrites the one entry; the name can still be corrected.
  await page.getByRole("button", { name: /^cardboard/ }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeEditable();
  await expect(page.getByLabel("Density", { exact: true })).toHaveValue("680");
  await page.getByLabel("Density", { exact: true }).fill("700");
  await page.getByLabel("Density", { exact: true }).press("Tab");
  await expect.poll(() => materialsOnDisk()["cardboard"]).toEqual({ density: "700 kg/m^3" });

  // D15: picking a library material copies it into the project.
  await page.getByLabel("Search the library", { exact: true }).fill("Fiber, bulk");
  const item = page.getByTestId("materials.library-item").first();
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(() => materialsOnDisk()["fiber_bulk"]).toMatchObject({ density: "657.0 kg/m^3" });
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("fiber bulk");

  expect(errors).toEqual([]);
});
