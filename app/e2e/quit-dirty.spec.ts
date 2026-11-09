/**
 * Quitting with a typed edit (R3.7, U62). A field's typed text lives in the
 * page until it blurs, so main asks before anything can lose it: on the
 * window's close (the red button, which skips `before-quit`) and on a quit,
 * with the answer stubbed. Keep editing leaves the app and the text as they
 * were; Quit without saving ends it. A quit with nothing typed never asks:
 * `b4a` and `native-menu` both end that way, and hang if it does.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { killOrphans } from "./orphans.ts";
import { seededCopy, sidecarBinary } from "./live.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const KEEP = { response: 0 };
const DISCARD = { response: 1 };

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

test.describe("quitting with a typed edit", () => {
  let app: ElectronApplication | undefined;
  let project = "";
  let lecturn: LecturnEnv | undefined;

  test.afterEach(async () => {
    await app?.close();
    killOrphans([project ? dirname(project) : "", lecturn?.dir ?? ""]);
    if (project) rmSync(dirname(project), { recursive: true, force: true });
    lecturn?.cleanup();
  });

  test("asks on window close and on quit, and only the discard ends the app", async () => {
    test.setTimeout(240_000);
    const bin = sidecarBinary();
    project = seededCopy(bin, "rw-quit-dirty-");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    lecturn = lecturnEnv(env, "rw-quit-dirty-lecturn-");
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", project, "--page", "03", "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    const dialogs = new DialogQueues();
    await dialogs.install(app);
    const page = await app.firstWindow();
    await expect(byTestId(page, "header.project-switcher")).not.toHaveText(/^(Opening…|No project)?$/, { timeout: 120_000 });

    await page.getByTestId("configs.subtab").filter({ hasText: "Recovery" }).click();
    const field = page.locator('[data-testid="recovery.altitude"], [data-testid="recovery.delay"]').first();
    await field.click();
    await field.fill("123.45");
    // The page's report reaches main on its next tick.
    await page.waitForTimeout(250);

    const alive = async () => (await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1;

    await dialogs.enqueue("showMessageBox", KEEP);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await dialogs.waitForCalls("showMessageBox", 1, 15_000);
    expect(await alive()).toBe(true);
    await expect(field).toHaveValue("123.45");

    await dialogs.enqueue("showMessageBox", KEEP);
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await dialogs.waitForCalls("showMessageBox", 2, 15_000);
    expect(await alive()).toBe(true);
    await expect(field).toHaveValue("123.45");

    await dialogs.enqueue("showMessageBox", DISCARD);
    const closing = app;
    app = undefined;
    // Resolves only when the process has exited, so the discard is what ended it.
    await closing.close();
  });
});
