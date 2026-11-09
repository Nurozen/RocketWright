/**
 * Preferences in the real app (R3.4): the default units reach a project made
 * from the New project dialog, the Units control edits that project's
 * `[display_units]`, and a relaunch restores the window, view options and tab.
 *
 * The agent's `rw_project_new` path is `project-tools.test.ts` (a real server,
 * host channel and `rw init`) with `nativeDialogs.test.ts` (main's reply).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";
import { killOrphans } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const BOUNDS = { x: 140, y: 90, width: 1180, height: 820 };

const clickMenuItem = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (item === null || item === undefined) throw new Error(`no menu item ${itemId}`);
    item.click();
  }, id);

let app: ElectronApplication | undefined;
let lecturn: LecturnEnv | undefined;
let base = "";

async function launch(env: Record<string, string>): Promise<{ running: ElectronApplication; page: Page }> {
  const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
  const running = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
  app = running;
  return { running, page: await running.firstWindow({ timeout: 120_000 }) };
}

async function createProject(page: Page, name: string): Promise<void> {
  const form = page.getByTestId("new-project");
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("header.project-switcher")).toHaveText(name, { timeout: 60_000 });
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  killOrphans([lecturn?.dir ?? "", base]);
  if (base !== "") rmSync(base, { recursive: true, force: true });
  lecturn?.cleanup();
});

test("default units reach a new project, Units edits it, and a relaunch restores window, view and tab", async () => {
  test.setTimeout(300_000);
  base = mkdtempSync(join(SCRATCH, "rw-e2e-prefs-"));
  const documents = join(base, "documents");
  mkdirSync(documents);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["RW_TEST_HOOKS"];
  Object.assign(env, { RW_SIDECAR_BIN: sidecarBinary(), RW_OFFLINE: "1", RW_DOCUMENTS_DIR: documents });
  lecturn = lecturnEnv(env, "rw-e2e-prefs-lecturn-", { fresh: true });
  Object.assign(env, lecturn.env);

  const first = await launch(env);
  await expect(first.page.getByTestId("welcome")).toBeVisible({ timeout: 120_000 });
  await first.page.getByRole("button", { name: "New project", exact: true }).click();
  await createProject(first.page, "First");

  // The Settings gear, with the Agent providers entry.
  await first.page.getByTestId("header.settings").click();
  const settings = first.page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("button", { name: "Agent providers…" })).toBeVisible();
  await settings.getByLabel("Default units for new projects").selectOption("in");
  await settings.getByRole("button", { name: "Done" }).click();

  // The renderer's creation path.
  await clickMenuItem(first.running, "project.new");
  await createProject(first.page, "Inches");
  const manifest = join(documents, "RocketWright/Inches/rocketwright.toml");
  expect(readFileSync(manifest, "utf8")).toMatch(/^length = "in"$/m);
  await expect(first.page.getByTestId("toolbar.units")).toHaveValue("in");

  // The control edits the project's own table, and stays on the project.
  await first.page.getByTestId("toolbar.units").selectOption("cm");
  await expect.poll(() => readFileSync(manifest, "utf8")).toMatch(/^length = "cm"$/m);
  expect(readFileSync(join(documents, "RocketWright/First/rocketwright.toml"), "utf8")).not.toMatch(/^length = "cm"$/m);

  await first.page.getByTestId("toolbar.section").check();
  await first.page.getByTestId("toolbar.view-chip").filter({ hasText: "Top" }).click();
  await first.page.getByRole("tab", { name: "Results", exact: true }).click();
  await first.running.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b), BOUNDS);
  await first.running.close();
  app = undefined;

  const profile = env["RW_USER_DATA_DIR"]!;
  expect(existsSync(join(profile, "preferences.json"))).toBe(true);

  const second = await launch(env);
  await expect(second.page.getByTestId("header.project-switcher")).toHaveText("Inches", { timeout: 120_000 });
  await expect(second.page.getByRole("tab", { name: "Results", exact: true })).toHaveAttribute("aria-selected", "true");
  const bounds = await second.running.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  expect(bounds.width).toBe(BOUNDS.width);
  expect(bounds.x).toBe(BOUNDS.x);
  expect(bounds.y).toBe(BOUNDS.y);
  expect(bounds.height).toBe(BOUNDS.height);

  await second.page.getByRole("tab", { name: "Design", exact: true }).click();
  await expect(second.page.getByTestId("toolbar.units")).toHaveValue("cm");
  await expect(second.page.getByTestId("toolbar.section")).toBeChecked();
  await expect(second.page.getByTestId("toolbar.view-chip").filter({ hasText: "Top" })).toHaveAttribute("aria-checked", "true");
});
