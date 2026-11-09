/**
 * Shell failures in the real app (R3.3, D19): an app server that dies mid-session
 * and one that never starts both say so in the window and offer Relaunch.
 *
 * `app.relaunch` is stubbed so the new instance cannot escape the harness; the
 * stub records the call, then the app exits as it would for real. The only
 * process killed is the server this test's own Electron started, found by
 * walking that Electron's process tree.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { seededCopy, SCRATCH, sidecarBinary } from "./live.ts";
import { killStarted, processTreeOf } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const SERVER_ENTRY = "apps/server/src/rpc/cli.ts";

let app: ElectronApplication | undefined;
let lecturn: LecturnEnv | undefined;
let project = "";
let scratch = "";
let started: ReadonlyMap<number, string> = new Map();

function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["RW_TEST_HOOKS"];
  lecturn = lecturnEnv(env, "rw-errors-lecturn-", { fresh: true });
  return { ...env, ...lecturn.env, RW_OFFLINE: "1", ...extra };
}

async function launch(args: string[], env: Record<string, string>): Promise<{ running: ElectronApplication; page: Page }> {
  const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
  const running = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), ...args, "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
  app = running;
  return { running, page: await running.firstWindow() };
}

/** Replaces `app.relaunch` with one that leaves a file, so the test can tell it ran after the app has exited. */
const stubRelaunch = (running: ElectronApplication, marker: string): Promise<void> =>
  running.evaluate(({ app: electronApp }, path) => {
    electronApp.relaunch = () => {
      process.getBuiltinModule("node:fs").writeFileSync(path, "relaunched");
    };
  }, marker);

async function expectRelaunchEnds(running: ElectronApplication, page: Page, marker: string): Promise<void> {
  const closed = running.waitForEvent("close");
  await page.getByRole("button", { name: "Relaunch", exact: true }).click();
  await closed;
  app = undefined;
  expect(existsSync(marker), "Relaunch called app.relaunch").toBe(true);
}

test.beforeEach(() => {
  scratch = mkdtempSync(join(SCRATCH, "rw-errors-"));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  killStarted(started);
  started = new Map();
  if (project !== "") rmSync(dirname(project), { recursive: true, force: true });
  project = "";
  rmSync(scratch, { recursive: true, force: true });
  lecturn?.cleanup();
  lecturn = undefined;
});

test("a killed app server keeps the page and offers Relaunch", async () => {
  test.setTimeout(240_000);
  const bin = sidecarBinary();
  project = seededCopy(bin, "rw-errors-");
  const { running, page } = await launch(["--project", project], launchEnv({ RW_SIDECAR_BIN: bin }));
  await expect(page.locator('[data-testid="header.project-switcher"]')).not.toHaveText(/^(Opening…|No project)?$/, { timeout: 120_000 });

  const electronPid = await running.evaluate(() => process.pid);
  const tree = processTreeOf(electronPid);
  const server = tree.find((p) => p.command.includes(SERVER_ENTRY));
  expect(server, `the server under Electron ${electronPid}: ${tree.map((p) => p.command.slice(0, 120)).join("\n")}`).toBeDefined();
  // Everything below our Electron, so teardown can clear this run's sidecars by pid and command.
  started = new Map(tree.map((p) => [p.pid, p.command]));
  process.kill(server!.pid, "SIGKILL");

  await expect(page.getByTestId("connection.reconnecting")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Relaunch", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("connection.lost")).toContainText("The app server has stopped");
  // The project is still on screen behind the banner.
  await expect(page.locator('[data-testid="header.project-switcher"]')).not.toHaveText(/^(Opening…|No project)?$/);

  const marker = join(scratch, "relaunched");
  await stubRelaunch(running, marker);
  await expectRelaunchEnds(running, page, marker);
});

test("a server that will not start says why in the window, with Relaunch", async () => {
  test.setTimeout(120_000);
  const { running, page } = await launch([], launchEnv({ RW_NODE: "/usr/bin/false" }));
  const fatal = page.getByTestId("fatal");
  await expect(fatal).toBeVisible({ timeout: 90_000 });
  await expect(fatal).toContainText("RocketWright could not start");
  await expect(fatal).toContainText("before announcing its URLs");

  const marker = join(scratch, "relaunched");
  await stubRelaunch(running, marker);
  await expectRelaunchEnds(running, page, marker);
});
