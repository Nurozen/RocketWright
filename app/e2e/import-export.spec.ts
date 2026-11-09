/**
 * R3.1 in a browser (D18), against the real server and sidecar: imports read a
 * typed path from outside the project, and exports stay inside it. The `.ork`
 * is generated here at runtime from a fixture and the motor files are
 * synthetic, because neither may ever be committed.
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auxProject, REPO, type AuxProject } from "./aux-project.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const ENG = "; synthetic test curve\nC6 18 70 0-3-5 0.0110 0.0240 Synth\n   0.050 6.000\n   0.200 12.000\n   0.400 6.000\n   1.500 4.500\n   1.800 0.000\n";
const RSE = `<engine-database><engine-list><engine mfg="Synth" code="D9" Type="single" dia="24." len="70." initWt="44.0" propWt="20." delays="0,3,5" auto-calc-mass="0" auto-calc-cg="0" avgThrust="9." peakThrust="20." throatDia="0." exitDia="0." Itot="18." burn-time="2." massFrac="0" Isp="0" tDiv="10" tStep="-1." tFix="1" FDiv="10" FStep="-1." FFix="1" nameDivs="1"><data><eng-data t="0." f="0." m="20." cg="35."/><eng-data t="0.2" f="20." m="18." cg="35."/><eng-data t="1.5" f="8." m="4." cg="35."/><eng-data t="2." f="0." m="0." cg="35."/></data></engine></engine-list></engine-database>\n`;

let base: string;
let outside: string;
let aux: AuxProject;

test.beforeAll(async () => {
  base = mkdtempSync(join(SCRATCH, "rw-e2e-import-"));
  outside = join(base, "outside");
  mkdirSync(outside);
  const source = join(base, "source");
  cpSync(join(REPO, "fixtures/research-vehicle"), source, { recursive: true });
  execFileSync(sidecarBinary(), ["export", "ork", join(outside, "generated.ork"), "--allow-outside"], { cwd: source, encoding: "utf8" });
  writeFileSync(join(outside, "Synth_C6.eng"), ENG);
  writeFileSync(join(outside, "Synth_D9.rse"), RSE);
  aux = await auxProject(join(REPO, "fixtures/research-vehicle"), "Import host");
});

test.afterAll(async () => {
  await aux?.stop();
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
});

async function open(page: Page): Promise<void> {
  await page.goto(`${WEB}?rpc=${encodeURIComponent(aux.rpc)}&http=${encodeURIComponent(aux.http)}&page=01`);
  await expect(page.getByTestId("header.project-switcher")).not.toHaveText(/^(Opening…|No project)?$/);
}

async function menu(page: Page, item: string): Promise<void> {
  await page.getByTestId("header.project-switcher").click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function typePath(page: Page, path: string, button: "Choose" | "Save"): Promise<void> {
  const prompt = page.getByTestId("path-prompt");
  await prompt.getByLabel("Path").fill(path);
  await prompt.getByRole("button", { name: button }).click();
}

const importTyped = async (page: Page, path: string): Promise<void> => {
  await menu(page, "Import…");
  await typePath(page, path, "Choose");
};

test("a motor from outside the project imports by typed path, as .eng and as .rse", async ({ page }) => {
  await open(page);
  for (const name of ["Synth_C6.eng", "Synth_D9.rse"]) {
    await importTyped(page, join(outside, name));
    await expect(page.getByTestId("project-actions.notice")).toContainText(`Imported ${name}`);
    await expect.poll(() => readdirSync(join(aux.dir, "lib/motors"))).toContain(name);
  }
});

test("a file it cannot read is refused by name", async ({ page }) => {
  await open(page);
  writeFileSync(join(outside, "notes.txt"), "hello");
  await importTyped(page, join(outside, "notes.txt"));
  await expect(page.getByTestId("project-actions.error")).toContainText(".ork, .eng and .rse");
});

test("a generated .ork replaces the design only after the confirmation", async ({ page }) => {
  await open(page);
  await importTyped(page, join(outside, "generated.ork"));
  const ask = page.getByTestId("ork-import");
  await expect(ask.getByRole("button", { name: "Create new project" })).toBeFocused();
  await ask.getByRole("button", { name: "Replace current design…" }).click();
  await page.getByTestId("ork-import.confirm").getByRole("button", { name: "Replace design" }).click();
  await expect(page.getByTestId("project-actions.notice")).toContainText("Imported generated.ork");
});

test("an export stays inside the project, and a path outside is refused", async ({ page }) => {
  await open(page);
  await menu(page, "Export…");
  await page.getByTestId("export-dialog").getByRole("radio", { name: "3D print mesh" }).check();
  await page.getByTestId("export-dialog").getByRole("button", { name: "Export…" }).click();
  await typePath(page, "exports/from-browser.stl", "Save");
  await expect(page.getByTestId("project-actions.notice")).toContainText("from-browser.stl");
  expect(existsSync(join(aux.dir, "exports/from-browser.stl"))).toBe(true);

  await menu(page, "Export…");
  await page.getByTestId("export-dialog").getByRole("button", { name: "Export…" }).click();
  const escaped = join(outside, "escaped.ork");
  await typePath(page, escaped, "Save");
  await expect(page.getByTestId("project-actions.error")).toContainText("outside the project");
  expect(existsSync(escaped)).toBe(false);
});

test("a generated .ork can become a new project and leaves the open one alone", async ({ page }) => {
  await open(page);
  const before = readFileSync(join(aux.dir, "rocket.rw.toml"), "utf8");
  await importTyped(page, join(outside, "generated.ork"));
  await page.getByTestId("ork-import").getByRole("button", { name: "Create new project" }).click();
  const form = page.getByTestId("new-project");
  await form.getByLabel("Name").fill("From ork");
  await form.getByLabel("Location").fill(join(base, "made"));
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("header.project-switcher")).toHaveText("From ork");
  expect(existsSync(join(base, "made/From ork/rocketwright.toml"))).toBe(true);
  expect(readFileSync(join(aux.dir, "rocket.rw.toml"), "utf8")).toBe(before);
});
