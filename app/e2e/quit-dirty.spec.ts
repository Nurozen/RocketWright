/**
 * Quitting with a typed edit (R3.7, U62). A field's typed text lives in the
 * page until it blurs, so main asks before anything can lose it: on the
 * window's close (the red button, which skips `before-quit`) and on a quit,
 * with the answer stubbed. Keep editing leaves the app and the text as they
 * were; Quit without saving ends it; Save and quit saves as Close does, says
 * so honestly when that fails, and only then ends it. A quit with nothing
 * typed never asks: `b4a` and `native-menu` both end that way, and hang if it
 * does.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { killOrphans } from "./orphans.ts";
import { seededCopy, sidecarBinary } from "./live.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const KEEP = { response: 0 };
const SAVE = { response: 1 };
const DISCARD = { response: 2 };
/** On the prompt that follows a save that failed. */
const FAILED_KEEP = { response: 0 };

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

  /** The app on the Recovery tab of a fresh copy, with a typed value in the first deployment field. */
  async function launchWithTypedValue(prefix: string, typed: string) {
    const bin = sidecarBinary();
    project = seededCopy(bin, `${prefix}-`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    lecturn = lecturnEnv(env, `${prefix}-lecturn-`);
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
    await field.fill(typed);
    // The page's report reaches main on its next tick.
    await page.waitForTimeout(250);
    return { dialogs, page, field };
  }

  const alive = async () => (await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1;
  const projectText = () =>
    readdirSync(join(project, "configs"))
      .filter((f) => f.endsWith(".toml"))
      .map((f) => readFileSync(join(project, "configs", f), "utf8"))
      .join("\n");

  test("asks on window close and on quit, and only the discard ends the app", async () => {
    test.setTimeout(240_000);
    const { dialogs, field } = await launchWithTypedValue("rw-quit-dirty", "123.45");
    const saved = projectText();

    await dialogs.enqueue("showMessageBox", KEEP);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    const [prompt] = await dialogs.waitForCalls("showMessageBox", 1, 15_000);
    expect(prompt!.options).toMatchObject({ buttons: ["Keep editing", "Save and quit", "Quit without saving"], defaultId: 0, cancelId: 0 });
    expect(await alive()).toBe(true);
    await expect(field).toHaveValue("123.45");

    await dialogs.enqueue("showMessageBox", KEEP);
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    await dialogs.waitForCalls("showMessageBox", 2, 15_000);
    expect(await alive()).toBe(true);
    await expect(field).toHaveValue("123.45");

    await dialogs.enqueue("showMessageBox", DISCARD);
    const closing = app!;
    app = undefined;
    // Resolves only when the process has exited, so the discard is what ended it.
    await closing.close();
    expect(projectText()).toBe(saved);
  });

  test("Save and quit keeps the app open and says why when it fails, and writes the edit when it can", async () => {
    test.setTimeout(240_000);
    const { dialogs, page, field } = await launchWithTypedValue("rw-quit-save", "not a number");

    await dialogs.enqueue("showMessageBox", SAVE, FAILED_KEEP);
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    const calls = await dialogs.waitForCalls("showMessageBox", 2, 30_000);
    expect(calls[1]!.options).toMatchObject({ message: "Your edit could not be saved", buttons: ["Keep editing", "Quit without saving"], defaultId: 0, cancelId: 0 });
    expect(await alive()).toBe(true);
    await expect(field).toHaveValue("not a number");

    await field.fill("432.5");
    await page.waitForTimeout(250);
    expect(projectText()).not.toContain("432.5");
    await dialogs.enqueue("showMessageBox", SAVE);
    const closing = app!;
    app = undefined;
    // Resolves only when the process has exited, so the save is what ended it.
    await closing.close();
    expect(projectText()).toContain("432.5");
  });
});
