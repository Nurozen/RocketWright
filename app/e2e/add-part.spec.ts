/**
 * R2.1 (U23): the Components "+" on a real Empty project, over the live app
 * server and sidecar. The first part is added from the palette and becomes the
 * root; the viewport shows it through the WASM core; a second part attaches to
 * it; the project on disk holds both. Controls are found by visible label and
 * role (D27).
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { auxProject, type AuxProject } from "./aux-project.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
let aux: AuxProject;
let src: string;

test.beforeAll(async () => {
  src = join(mkdtempSync(join(SCRATCH, "rw-e2e-addpart-src-")), "Empty");
  execFileSync(sidecarBinary(), ["init", "--template", "empty", src], { encoding: "utf8" });
  aux = await auxProject(src, "Empty");
});

test.afterAll(async () => {
  await aux?.stop();
  rmSync(dirname(src), { recursive: true, force: true });
});

const plus = (page: Page) => page.getByRole("button", { name: "Add part", exact: true });
const palette = (page: Page) => page.getByRole("dialog", { name: "Add part" });

test("the first part goes on an Empty project from the palette, and the next attaches to it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
  const viewport = page.getByTestId("viewport").first();
  await expect(viewport).toHaveAttribute("data-ready", "true");
  await expect(viewport).toHaveAttribute("data-glb-source", "empty");
  await expect(page.getByTestId("tree.empty")).toContainText("Add your first part");

  // Empty: only a body part can start the rocket, and there is nothing to attach to.
  await plus(page).click();
  await expect(palette(page).getByLabel("Attach to", { exact: true })).toHaveCount(0);
  await expect(palette(page).getByRole("button", { name: "Parachute", exact: true })).toBeDisabled();
  await expect(palette(page).getByRole("button", { name: "Tank", exact: true })).toBeDisabled();
  await palette(page).getByRole("button", { name: "Nose cone", exact: true }).click();

  // The sidecar took it, and the viewport meshes it with the WASM core.
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "Nose cone" })).toBeVisible();
  await expect(viewport).toHaveAttribute("data-glb-source", "rw-wasm");
  await expect(viewport).toHaveAttribute("data-selected", "nose_cone");
  await expect(page.getByTestId("tree.empty")).toHaveCount(0);

  // The second part attaches, by the part's visible name.
  await plus(page).click();
  await palette(page).getByLabel("Attach to", { exact: true }).selectOption({ label: "Nose cone" });
  await expect(palette(page).getByRole("button", { name: "Nose cone", exact: true })).toBeDisabled();
  await palette(page).getByRole("button", { name: "Body tube", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Body tube" })).toBeVisible();
  await expect(viewport).toHaveAttribute("data-selected", "body_tube");

  // Components shares the control, reached the way the B1 drive reaches it: unscoped, by name.
  await page.getByRole("tab", { name: "Components", exact: true }).click();
  await plus(page).click();
  await page.getByLabel("Attach to", { exact: true }).selectOption({ label: "Body tube" });
  await page.getByRole("button", { name: "Parachute", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Parachute" })).toBeVisible();

  expect(errors).toEqual([]);

  // On disk, through the sidecar: both parts, the tube attached to the nose.
  const toml = readFileSync(join(aux.dir, "rocket.rw.toml"), "utf8");
  expect(toml).toMatch(/\[c\.nose_cone\][\s\S]*type = "nose_cone"/);
  expect(toml).toMatch(/\[c\.parachute\][\s\S]*to = "body_tube\.inner"/);
  expect(toml).toMatch(/\[c\.body_tube\][\s\S]*attach = \{[^}]*to = "nose_cone\.base"/);
  const check = spawnSync(sidecarBinary(), ["-C", aux.dir, "--json", "check"], { encoding: "utf8" });
  expect(check.stdout).not.toContain("RW-E100");
});
