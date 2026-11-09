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

// ---- Recent rows (R0.2) ----

test("a long Recent path keeps a gutter before the time and the status, and Missing keeps clear of Remove", async ({ page }) => {
  const longDir = (name: string): string => `/Users/someone/${"a-rather-long-folder-name/".repeat(12)}${name}`;
  const recents = [
    { dir: longDir("weekend-flyer"), name: "weekend-flyer", lastOpened: new Date(Date.now() - 7_200_000).toISOString(), status: "ok" },
    { dir: longDir("old-prototype"), name: "old-prototype", lastOpened: new Date(Date.now() - 86_400_000).toISOString(), status: "missing" },
  ];
  // A browser keeps no Recents (R0.12), so this stands in for the preload that serves them.
  await page.addInitScript((list) => {
    const done = <T,>(value: T) => () => Promise.resolve(value);
    Object.assign(window, {
      rwDesktop: {
        desktop: true,
        platform: "darwin",
        rpcUrl: null,
        serverUrl: null,
        boot: done({ activeProjectId: null, notice: null }),
        recents: done(list),
        removeRecent: done(undefined),
        setActiveProject: done(undefined),
        setDirty: done(undefined),
        prefs: done({ window: null, view: {}, lastTab: null, defaultDisplayUnits: null }),
        setPrefs: done(undefined),
        openProviders: done(undefined),
        onCommand: () => () => {},
        pathForFile: () => "",
      },
    });
  }, recents);
  await openWelcome(page);
  const rows = page.locator(".rw-welcome__recent-row");
  await expect(rows).toHaveCount(2);
  for (const row of [rows.nth(0), rows.nth(1)]) {
    const path = await row.locator(".rw-welcome__recent-path").boundingBox();
    const age = await row.locator(".rw-welcome__recent-age").boundingBox();
    expect(path, "the path is on screen").not.toBeNull();
    expect(age, "the time or status is on screen").not.toBeNull();
    expect(path!.x + path!.width + 16, "the path stops short of the time or status").toBeLessThanOrEqual(age!.x);
  }
  const missing = rows.nth(1);
  const status = await missing.locator(".rw-welcome__recent-age").boundingBox();
  const remove = await missing.getByRole("button", exact("Remove old-prototype from Recent")).boundingBox();
  expect(status!.x + status!.width + 8, "Missing stops short of Remove").toBeLessThanOrEqual(remove!.x);
});

// ---- the header's project menu (R0.6, R0.7, D22) ----

const exact = (name: string) => ({ name, exact: true });
const FIRST = "first-rocket";
const SECOND = "second-rocket";

function folder(name: string): string {
  return join(documents, "RocketWright", name);
}

async function createFromWelcome(page: Page, name: string): Promise<void> {
  await openWelcome(page);
  await page.getByRole("button", exact("New project")).click();
  await createInDialog(page, name);
}

async function createInDialog(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("textbox", { name: "Location" })).toHaveValue(join(documents, "RocketWright"));
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", exact("Create project")).click();
  await expect(page.getByRole("button", exact(name))).toBeVisible({ timeout: 60_000 });
}

/** Opens the project menu by the name on its button, the way a person finds it. */
async function openMenu(page: Page, projectName: string) {
  await page.getByRole("button", exact(projectName)).click();
  const menu = page.getByRole("menu", { name: "Projects" });
  await expect(menu).toBeVisible();
  return menu;
}

async function pick(page: Page, projectName: string, item: string): Promise<void> {
  const menu = await openMenu(page, projectName);
  await menu.getByRole("menuitem", exact(item)).click();
}

/** Two open projects, the second on screen. */
async function twoProjects(page: Page): Promise<void> {
  await createFromWelcome(page, FIRST);
  await pick(page, FIRST, "New project…");
  await createInDialog(page, SECOND);
}

const read = (file: string): string => readFileSync(file, "utf8");

const SURFACES = [
  {
    name: "editor",
    file: "rocket.rw.toml",
    async open(page: Page): Promise<void> {
      await page.getByRole("tab", exact("Components")).click();
      await page.getByRole("treeitem", { name: /nose/ }).first().click();
    },
    field: (page: Page) => page.getByLabel("Length", { exact: true }),
    value: "123",
    saved: 'length = "123 mm"',
  },
  {
    name: "Configurations",
    file: "configs/default.rw.toml",
    async open(page: Page): Promise<void> {
      await page.getByRole("tab", exact("Configurations")).click();
      await page.getByRole("tab", exact("Recovery")).click();
      await page.getByTestId("recovery.event").selectOption("altitude");
      // The altitude field also shows for an Ejection event, so only the row proves the write landed.
      await expect(page.getByTestId("recovery.row")).toHaveAttribute("data-event", "altitude");
      await expect(page.getByTestId("recovery.altitude")).toBeVisible();
    },
    field: (page: Page) => page.getByTestId("recovery.altitude"),
    value: "321",
    saved: "321 m",
  },
] as const;

test("the project menu shows the mockup's rows and closes on an outside press", async ({ page }) => {
  await createFromWelcome(page, FIRST);
  const menu = await openMenu(page, FIRST);
  await expect(menu.getByRole("menuitemcheckbox", exact(FIRST))).toBeChecked();
  for (const item of ["New project…", "Open folder…", "Open sample rocket", "Rename project…", "Close project"]) await expect(menu.getByRole("menuitem", exact(item))).toBeVisible();
  // A browser keeps no Recents (R0.12), so the section is absent rather than empty.
  await expect(menu.getByText("Recent", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", exact("Results")).click({ position: { x: 2, y: 2 } });
  await expect(menu).toHaveCount(0);
});

test("Rename warns about runs, then updates the header, the window title and both manifests", async ({ page }) => {
  await createFromWelcome(page, FIRST);
  await expect(page).toHaveTitle(`${FIRST} – RocketWright`);
  await pick(page, FIRST, "Rename project…");
  const dialog = page.getByRole("dialog", { name: "Rename project" });
  await expect(dialog.getByText(/runs .*outdated/)).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Solstice II");
  await dialog.getByRole("button", exact("Rename")).click();
  await expect(page.getByRole("button", exact("Solstice II"))).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle("Solstice II – RocketWright");
  for (const f of ["rocketwright.toml", "rocket.rw.toml"]) expect(read(join(folder(FIRST), f))).toMatch(/^name = "Solstice II"$/m);
  // Too long for the session: said in the dialog, and nothing is sent.
  await pick(page, "Solstice II", "Rename project…");
  await dialog.getByRole("textbox", { name: "Name" }).fill("x".repeat(256));
  await expect(dialog.getByText("A name can be at most 255 bytes.")).toBeVisible();
  await dialog.getByRole("button", exact("Cancel")).click();
  await expect(page.getByRole("button", exact("Solstice II"))).toBeVisible();
});

test("Close goes to the next open project, then to Welcome", async ({ page }) => {
  await twoProjects(page);
  await pick(page, SECOND, "Close project");
  await expect(page.getByRole("button", exact(FIRST))).toBeVisible({ timeout: 60_000 });
  await pick(page, FIRST, "Close project");
  await expect(page.getByRole("button", exact("New project"))).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveTitle("RocketWright");
});

test("Open sample rocket and Open folder from the menu show the new project, and a bad folder says why", async ({ page }) => {
  await createFromWelcome(page, FIRST);
  const dir = join(base, "not-a-project");
  mkdirSync(dir);
  writeFileSync(join(dir, "rocket.rw.toml"), "# someone else's file\n");
  await pick(page, FIRST, "Open folder…");
  const prompt = page.getByRole("dialog", { name: "Open folder" });
  await prompt.getByRole("textbox", { name: "Path" }).fill(dir);
  await prompt.getByRole("button", exact("Choose")).click();
  await expect(page.getByRole("alert").filter({ hasText: "has no RocketWright project" })).toBeVisible();
  await expect(page.getByRole("button", exact(FIRST))).toBeVisible();

  const other = join(base, "existing");
  execFileSync(sidecarBinary(), ["init", other, "--name=existing", "--template=minimal", "--json"], { stdio: "ignore" });
  await pick(page, FIRST, "Open folder…");
  await prompt.getByRole("textbox", { name: "Path" }).fill(other);
  await prompt.getByRole("button", exact("Choose")).click();
  await expect(page.getByRole("button", exact("existing"))).toBeVisible({ timeout: 60_000 });

  await pick(page, "existing", "Open sample rocket");
  await expect(page.getByRole("button", exact("existing"))).toHaveCount(0, { timeout: 60_000 });
  expect(existsSync(join(documents, "RocketWright", "Sample rocket", "rocketwright.toml"))).toBe(true);
});

for (const surface of SURFACES) {
  for (const leave of [
    {
      name: "Close",
      async go(page: Page): Promise<void> {
        await pick(page, SECOND, "Close project");
        await expect(page.getByRole("button", exact(FIRST))).toBeVisible({ timeout: 60_000 });
      },
    },
    {
      name: "switching",
      async go(page: Page): Promise<void> {
        const menu = await openMenu(page, SECOND);
        await menu.getByRole("menuitemcheckbox", exact(FIRST)).click();
        await expect(page.getByRole("button", exact(FIRST))).toBeVisible({ timeout: 60_000 });
      },
    },
    {
      name: "New",
      async go(page: Page): Promise<void> {
        await pick(page, SECOND, "New project…");
        await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
      },
    },
    {
      name: "Open",
      async go(page: Page): Promise<void> {
        await pick(page, SECOND, "Open folder…");
        await expect(page.getByRole("dialog", { name: "Open folder" })).toBeVisible();
      },
    },
  ]) {
    test(`${leave.name} saves a value still being typed on the ${surface.name} page`, async ({ page }) => {
      await twoProjects(page);
      await surface.open(page);
      await surface.field(page).fill(surface.value);
      await expect(surface.field(page)).toBeFocused();
      await leave.go(page);
      await expect.poll(() => read(join(folder(SECOND), surface.file))).toContain(surface.saved);
    });
  }

  test(`text that cannot be saved on the ${surface.name} page prompts before leaving, and Keep editing stays`, async ({ page }) => {
    await createFromWelcome(page, FIRST);
    await surface.open(page);
    const before = read(join(folder(FIRST), surface.file));
    await surface.field(page).fill("not-a-number");
    await pick(page, FIRST, "Close project");
    const prompt = page.getByRole("dialog", { name: "Unsaved changes" });
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", exact("Keep editing")).click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByRole("button", exact(FIRST))).toBeVisible();
    await expect(surface.field(page)).toBeVisible();

    await pick(page, FIRST, "Close project");
    await prompt.getByRole("button", exact("Don't save")).click();
    await expect(page.getByRole("button", exact("New project"))).toBeVisible({ timeout: 60_000 });
    expect(read(join(folder(FIRST), surface.file))).toBe(before);
  });
}
