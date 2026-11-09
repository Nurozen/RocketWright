/**
 * Typed text and the agent pane (L4), in the real app with the real Lecturn
 * guest. The pane is a view of its own, so to the page a click into it looks
 * like the window losing focus, which must leave typed text alone for a native
 * dialog. Main hears the guest take focus and asks the page for its flush, so
 * a value typed and then followed by a click into the chat is on disk before
 * the agent reads the model; a real native dialog still leaves the text typed
 * and unsaved; text that cannot be saved stays typed and marked.
 *
 * What Playwright can and cannot drive:
 * - It turns on Chromium's focus emulation for every page it attaches, so the
 *   page would never see the window lose focus and `document.hasFocus()` would
 *   stay true. `realFocus` turns it back off on the page with a CDP session of
 *   its own (on, then off, so the change is sent).
 * - It cannot click a native view: the guest takes focus through its own
 *   `webContents.focus()` in main, which is what a click into the view does to
 *   Electron's focus, and fires the same `focus` event.
 * - The dialog is a real `dialog.showMessageBox` sheet, closed by its
 *   `AbortSignal`, not a stub. Switching to another app cannot be driven.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { embedGuest } from "./embed.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { seededCopy, sidecarBinary } from "./live.ts";
import { killOrphans } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");

/** Playwright's focus emulation off for `page`, so it sees its window's focus as a person's page does. */
async function realFocus(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
}

/** Keyboard focus to the window's own page, as a click on it gives. */
const focusPage = (app: ElectronApplication): Promise<void> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.focus());

/** Keyboard focus to the agent pane's guest, as a click into the view gives. */
async function focusPane(app: ElectronApplication): Promise<void> {
  const focused = await app.evaluate(({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
      .sort((x, y) => y.id - x.id)[0];
    if (wc === undefined) throw new Error("no guest");
    wc.focus();
    return wc.isFocused();
  });
  expect(focused).toBe(true);
}

const DIALOG_KEY = "__rwPaneFocusDialog";
/** The quit prompt's third button. */
const QUIT_WITHOUT_SAVING = { response: 2 };

test.describe("typed text and the agent pane", () => {
  let app: ElectronApplication | undefined;
  let lecturn: LecturnEnv | undefined;
  let project = "";

  test.afterEach(async () => {
    if (app !== undefined) {
      // A dialog left open, or the quit's question after a failure left text typed, would hold the close.
      await app.evaluate((_e, key) => (globalThis as unknown as Record<string, AbortController | undefined>)[key]?.abort(), DIALOG_KEY).catch(() => undefined);
      const dialogs = new DialogQueues();
      await dialogs.install(app).catch(() => undefined);
      await dialogs.enqueue("showMessageBox", QUIT_WITHOUT_SAVING).catch(() => undefined);
      await app.close();
    }
    killOrphans([project ? dirname(project) : "", lecturn?.dir ?? ""]);
    lecturn?.cleanup();
    if (project !== "") rmSync(dirname(project), { recursive: true, force: true });
  });

  test("a click into the pane saves typed text before anything else, and a native dialog leaves it typed", async () => {
    test.setTimeout(300_000);
    const bin = sidecarBinary();
    project = seededCopy(bin, "rw-e2e-pane-focus-");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    lecturn = lecturnEnv(env, "rw-e2e-pane-focus-lecturn-", { scripts: {} });
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    const electronApp = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", project, "--page", "02", "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    app = electronApp;
    const page = await electronApp.firstWindow({ timeout: 120_000 });
    await expect(page.getByTestId("agent.embed")).toBeVisible({ timeout: 120_000 });
    await embedGuest(electronApp);
    await realFocus(page);

    const savedLength = (): string | undefined => /^length = "([^"]*)"/m.exec(readFileSync(join(project, "parts/fin_can.rw.toml"), "utf8"))?.[1];
    const pageHasFocus = (): Promise<boolean> => page.evaluate(() => document.hasFocus());
    const length = page.locator('[data-testid="editor.field"][data-field="length"] input').first();
    const typeLength = async (text: string): Promise<void> => {
      await focusPage(electronApp);
      await length.click();
      await length.fill(text);
      await expect.poll(pageHasFocus).toBe(true);
    };
    const openDialog = (): Promise<void> =>
      electronApp.evaluate(({ dialog, BrowserWindow }, key) => {
        const ac = new AbortController();
        (globalThis as unknown as Record<string, AbortController>)[key] = ac;
        void dialog.showMessageBox(BrowserWindow.getAllWindows()[0]!, { message: "A native dialog", buttons: ["OK"], signal: ac.signal });
      }, DIALOG_KEY);
    const closeDialog = (): Promise<void> => electronApp.evaluate((_e, key) => (globalThis as unknown as Record<string, AbortController | undefined>)[key]?.abort(), DIALOG_KEY);

    await focusPage(electronApp);
    await page.getByRole("treeitem", { name: "Fin can" }).first().click();
    await expect(page.getByTestId("editor")).toHaveAttribute("data-part", "fin_can");
    await expect(length).toHaveValue("200");
    expect(savedLength()).toBe("200 mm");

    // Typed, then straight into the chat: saved with nothing else done in the page.
    await typeLength("234");
    expect(savedLength()).toBe("200 mm");
    await focusPane(electronApp);
    await expect.poll(savedLength, { timeout: 10_000 }).toBe("234 mm");
    // The page saw its window's focus go, so its own blur did not save this.
    expect(await pageHasFocus()).toBe(false);
    await expect(length).toHaveValue("234");

    // A native dialog takes the window's focus: the text stays typed and unsaved, and is still there when it closes.
    await typeLength("245");
    await openDialog();
    await expect.poll(pageHasFocus).toBe(false);
    await page.waitForTimeout(1_500);
    expect(savedLength()).toBe("234 mm");
    await expect(length).toHaveValue("245");
    await closeDialog();
    await expect.poll(pageHasFocus).toBe(true);
    await expect(length).toBeFocused();
    await expect(length).toHaveValue("245");
    expect(savedLength()).toBe("234 mm");
    // Then into the chat: saved.
    await focusPane(electronApp);
    await expect.poll(savedLength, { timeout: 10_000 }).toBe("245 mm");

    // Text that cannot be saved stays typed and marked, never put back.
    await typeLength("not a number");
    await expect(length).toHaveAttribute("aria-invalid", "true");
    await focusPane(electronApp);
    await page.waitForTimeout(1_500);
    await expect(length).toHaveValue("not a number");
    await expect(length).toHaveAttribute("aria-invalid", "true");
    expect(savedLength()).toBe("245 mm");

  });
});
