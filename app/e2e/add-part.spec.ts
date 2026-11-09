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

/** Every part type on a fresh Empty project, and catalog parts through the real search. Each test owns its project. */
test.describe("every kind and the catalog", () => {
  let fresh: AuxProject;
  let freshSrc: string;

  test.beforeEach(async () => {
    freshSrc = join(mkdtempSync(join(SCRATCH, "rw-e2e-addall-src-")), "Empty");
    execFileSync(sidecarBinary(), ["init", "--template", "empty", freshSrc], { encoding: "utf8" });
    fresh = await auxProject(freshSrc, "Empty");
  });

  test.afterEach(async () => {
    await fresh?.stop();
    rmSync(dirname(freshSrc), { recursive: true, force: true });
  });

  async function open(page: Page): Promise<void> {
    await page.goto(`${WEB}?rpc=${encodeURIComponent(fresh.rpc)}&http=${encodeURIComponent(fresh.http)}&page=01`);
    await expect(page.getByTestId("viewport").first()).toHaveAttribute("data-ready", "true");
  }

  async function addTile(page: Page, tile: string, attachTo?: string): Promise<void> {
    await plus(page).click();
    if (attachTo !== undefined) await palette(page).getByLabel("Attach to", { exact: true }).selectOption({ label: attachTo });
    await palette(page).getByRole("button", { name: tile, exact: true }).click();
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name: tile }).first()).toBeVisible();
  }

  /** RW-E0xx: parse, schema, reference and placement errors, the ones adding a part can cause. */
  function structuralErrors(dir: string): string[] {
    const out = spawnSync(sidecarBinary(), ["-C", dir, "--json", "check"], { encoding: "utf8" });
    const report = JSON.parse(out.stdout) as { diagnostics?: { code: string; severity: string; path: string; message: string }[] };
    expect(report.diagnostics, out.stdout + out.stderr).toBeDefined();
    return report.diagnostics!.filter((d) => d.severity === "error" && d.code.startsWith("RW-E0")).map((d) => `${d.code} ${d.path}: ${d.message}`);
  }

  test("adds all 19 kinds to Empty, and the project has no schema or placement errors", async ({ page }) => {
    await open(page);
    const tiles = ["Nose cone", "Body tube", "Transition", "Trapezoidal fin set", "Elliptical fin set", "Freeform fin set", "Tube fin set", "Inner tube", "Coupler", "Centering ring", "Bulkhead", "Engine block", "Launch lug", "Rail button", "Parachute", "Streamer", "Shock cord", "Mass component", "Tank"];
    await plus(page).click();
    await expect(palette(page).locator(".rw-add-part__tile")).toHaveCount(tiles.length);
    await page.keyboard.press("Escape");

    for (const tile of tiles) await addTile(page, tile, tile === "Nose cone" ? undefined : tile === "Body tube" ? "Nose cone" : "Body tube");
    await expect(page.getByTestId("tree")).toHaveAttribute("data-count", String(tiles.length));
    expect(structuralErrors(fresh.dir)).toEqual([]);
  });

  test("finds a part across the whole catalog by manufacturer and type, and adds it with its material", async ({ page }) => {
    await open(page);
    await addTile(page, "Nose cone");
    await addTile(page, "Body tube", "Nose cone");
    await plus(page).click();
    await palette(page).getByRole("tab", { name: "Parts library", exact: true }).click();

    const count = palette(page).getByTestId("add-part.library-count");
    await expect(count).toHaveText("3,449 parts");
    // Only a window of the rows exists in the page.
    expect(await palette(page).getByRole("listitem").count()).toBeLessThan(30);

    await palette(page).getByLabel("Manufacturer", { exact: true }).selectOption("Estes");
    await palette(page).getByLabel("Type", { exact: true }).selectOption("parachute");
    // A number, and not the whole catalog: "Searching…" shows while a filter applies.
    await expect(count).toHaveText(/^(?!3,449)[\d,]+ parts?$/);
    const narrowed = await count.innerText();

    await palette(page).getByLabel("Search parts", { exact: true }).fill("no such part anywhere");
    await expect(palette(page).getByText("No parts match")).toBeVisible();
    await palette(page).getByLabel("Search parts", { exact: true }).fill("");
    await expect(count).toHaveText(narrowed);

    await palette(page).getByLabel("Attach to", { exact: true }).selectOption({ label: "Body tube" });
    const row = palette(page).getByRole("listitem").first();
    const name = await row.locator(".rw-parts__name").innerText();
    await expect(row.getByText("Adds default Cd", { exact: false })).toBeVisible();
    await row.getByRole("button", { name: "Add", exact: true }).click();

    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole("treeitem", { name })).toBeVisible();
    const toml = readFileSync(join(fresh.dir, "rocket.rw.toml"), "utf8");
    expect(toml).not.toMatch(/^preset\b/m);
    expect(toml).toMatch(/\[materials\.[a-z0-9_]+\]/);
    expect(structuralErrors(fresh.dir)).toEqual([]);
  });

  test("replaces the selected part's geometry from the catalog", async ({ page }) => {
    await open(page);
    await addTile(page, "Nose cone");
    await addTile(page, "Body tube", "Nose cone");
    await addTile(page, "Coupler", "Body tube");
    await expect(page.getByRole("treeitem", { name: "Coupler" }).first()).toHaveAttribute("aria-selected", "true");
    await plus(page).click();
    await palette(page).getByRole("tab", { name: "Parts library", exact: true }).click();
    await palette(page).getByLabel("Type", { exact: true }).selectOption("coupler");
    await expect(palette(page).getByTestId("add-part.library-count")).toHaveText(/^(?!3,449)[\d,]+ parts?$/);
    await palette(page).getByRole("listitem").first().getByRole("button", { name: "Replace geometry", exact: true }).click();
    await expect(palette(page)).toHaveCount(0);
    await expect.poll(() => readFileSync(join(fresh.dir, "rocket.rw.toml"), "utf8")).toMatch(/\[c\.coupler\][^[]* in"/);
    expect(structuralErrors(fresh.dir)).toEqual([]);
  });
});
