/**
 * Welcome and New project in a plain browser against a real app server that
 * has no project open (R0.2-R0.4, R0.12): typed paths, the real `rw init`,
 * and every result read back from disk. Each test gets its own server, because
 * a project opened by one would skip Welcome in the next.
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnServer, type ServerHandle } from "../apps/desktop/src/backend.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";

let base: string;
let server: ServerHandle;
let documents: string;

test.beforeEach(async () => {
  base = mkdtempSync(join(SCRATCH, "rw-e2e-welcome-"));
  documents = join(base, "docs");
  mkdirSync(documents);
  // Two app servers cannot share one Lecturn sidecar base dir.
  const env: NodeJS.ProcessEnv = { ...process.env, LECTURN_HOME: join(base, "lh"), RW_LECTURN_BASE_DIR: join(base, "lb") };
  delete env["RW_TEST_HOOKS"];
  server = await spawnServer({ projects: [], env, documentsDir: documents, log: () => {} });
});

test.afterEach(async () => {
  await server.stop();
  rmSync(base, { recursive: true, force: true });
});

async function openWelcome(page: Page): Promise<void> {
  await page.goto(`${WEB}?rpc=${encodeURIComponent(server.rpcUrl)}&http=${encodeURIComponent(server.serverUrl)}`);
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeVisible();
}

async function typeFolder(page: Page, path: string): Promise<void> {
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "Open folder" });
  await prompt.getByRole("textbox", { name: "Path" }).fill(path);
  await prompt.getByRole("button", { name: "Choose", exact: true }).click();
}

const design = (page: Page) => page.getByRole("tab", { name: "Design", exact: true });

test("creates a project from the dialog, in the default location with the default template", async ({ page }) => {
  await openWelcome(page);
  await expect(page.getByRole("region", { name: "Recent" })).toHaveCount(0);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("radio", { name: "Minimal" })).toBeChecked();
  await expect(dialog.getByText("Nose, tube, fins, motor mount, and streamer")).toBeVisible();
  const location = join(documents, "RocketWright");
  await expect(dialog.getByRole("textbox", { name: "Location" })).toHaveValue(location);
  await dialog.getByRole("textbox", { name: "Name" }).fill("solstice-rocket");
  await expect(dialog.getByText(`Creates ${location}/solstice-rocket`)).toBeVisible();
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(design(page)).toBeVisible({ timeout: 60_000 });
  expect(readFileSync(join(location, "solstice-rocket", "rocketwright.toml"), "utf8")).toContain('name = "solstice-rocket"');
});

test("opens a typed path that holds a project", async ({ page }) => {
  const dir = join(base, "existing");
  execFileSync(sidecarBinary(), ["init", dir, "--name=existing", "--template=minimal", "--json"], { stdio: "ignore" });
  await openWelcome(page);
  await typeFolder(page, dir);
  await expect(design(page)).toBeVisible({ timeout: 60_000 });
});

test("a folder that is not a project says so and lists what is in the way", async ({ page }) => {
  const dir = join(base, "not-a-project");
  mkdirSync(dir);
  writeFileSync(join(dir, "rocket.rw.toml"), "# someone else's file\n");
  await openWelcome(page);
  await typeFolder(page, dir);
  const error = page.getByTestId("welcome.error");
  await expect(error).toContainText("has no RocketWright project");
  await expect(error).toContainText("rocket.rw.toml");
  await expect(page.getByRole("dialog", { name: "New project" })).toHaveCount(0);
  expect(readFileSync(join(dir, "rocket.rw.toml"), "utf8")).toBe("# someone else's file\n");
  expect(existsSync(join(dir, "rocketwright.toml"))).toBe(false);
});

test("a folder with no project offers to create one there", async ({ page }) => {
  const dir = join(base, "fresh-folder");
  mkdirSync(dir);
  await openWelcome(page);
  await typeFolder(page, dir);
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByText("has no RocketWright project")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("fresh-folder");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(design(page)).toBeVisible({ timeout: 60_000 });
  expect(existsSync(join(dir, "rocketwright.toml"))).toBe(true);
});

test("a name already taken is refused in the dialog", async ({ page }) => {
  const location = join(base, "work");
  execFileSync(sidecarBinary(), ["init", join(location, "taken"), "--name=taken", "--template=minimal", "--json"], { stdio: "ignore" });
  await openWelcome(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("taken");
  await dialog.getByRole("textbox", { name: "Location" }).fill(location);
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("new-project.error")).toContainText("already holds a project");
  await expect(dialog).toBeVisible();
});
