/**
 * The native menu's Undo in the real app (R0.10, U05): the menu item is the one
 * Cmd-Z fires, and its routing reads the real focused webContents. With the
 * Lecturn composer focused it must undo there and never reach
 * `history.restore`, which would take the person's model back a step behind a
 * chat edit. The same item with the page focused is the control: it does
 * restore, so the composer case cannot pass just because nothing happens.
 *
 * View zoom (D7) is CSS zoom on the page, so the shell must still fill the
 * window and the pane must still sit over its slot.
 *
 * Clicks the item rather than pressing the keys: Playwright's key events reach
 * the renderer only, never macOS's menu handling (U05 needed AppKit for that).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { B4A_FIXTURE } from "./b4a.ts";
import { REPO_ROOT } from "./bar/paths.ts";
import { embedGuest, loadTurnFixture, newThread, readGuestView, type EmbedGuest } from "./embed.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { killOrphans } from "./orphans.ts";
import { seededCopy, sidecarBinary } from "./live.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/** Clicks a native menu item by id, as a person picking it or its accelerator would. */
const clickMenuItem = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (item === null || item === undefined) throw new Error(`no menu item ${itemId}`);
    item.click();
  }, id);

/** Which webContents Electron reports as focused: the app page, the guest, something else, or none. */
const focusedKind = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ BrowserWindow, webContents }) => {
    const wc = webContents.getFocusedWebContents();
    if (wc === null) return "none";
    if (wc === BrowserWindow.getAllWindows()[0]?.webContents) return "host";
    return wc.getURL().includes("/embed/") ? "guest" : "other";
  });

/** Gives the window and then one of its webContents focus, the way a click would. */
const focusContents = (app: ElectronApplication, target: "host" | "guest"): Promise<void> =>
  app.evaluate(({ app: electronApp, BrowserWindow, webContents }, which) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    electronApp.focus({ steal: true });
    win.focus();
    const wc = which === "host" ? win.webContents : webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().includes("/embed/")).sort((x, y) => y.id - x.id)[0];
    if (wc === undefined) throw new Error("no guest webContents");
    wc.focus();
  }, target);

/** Counts `undo()` on the newest guest, then runs the real one. */
const spyOnGuestUndo = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().includes("/embed/")).sort((x, y) => y.id - x.id)[0]!;
    const real = wc.undo.bind(wc);
    const store = globalThis as unknown as { __guestUndos: number };
    store.__guestUndos = 0;
    wc.undo = () => {
      store.__guestUndos++;
      real();
    };
  });

const guestUndos = (app: ElectronApplication): Promise<number> => app.evaluate(() => (globalThis as unknown as { __guestUndos: number }).__guestUndos);

async function typeInComposer(guest: EmbedGuest, text: string): Promise<void> {
  await guest.evaluate((t) => {
    const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (editor === null) throw new Error("no composer");
    editor.focus();
    document.execCommand("insertText", false, t);
  }, text);
}

/** The agent pane's slot and where main actually put the guest's view. */
const paneGeometry = (app: ElectronApplication, page: Page) =>
  Promise.all([
    page.evaluate(() => {
      const box = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return { slot: box('[data-testid="agent.embed"]'), shell: box('[data-testid="app-shell"]'), inner: { width: window.innerWidth, height: window.innerHeight } };
    }),
    app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find((c) => "webContents" in c && (c as Electron.WebContentsView).webContents.getURL().includes("/embed/"));
      return view?.getBounds() ?? null;
    }),
  ]);

test.describe("the native menu", () => {
  let app: ElectronApplication | undefined;
  let project = "";
  let lecturn: LecturnEnv | undefined;

  test.afterEach(async () => {
    await app?.close();
    killOrphans([project ? dirname(project) : "", lecturn?.dir ?? ""]);
    if (project) rmSync(dirname(project), { recursive: true, force: true });
    lecturn?.cleanup();
  });

  test("Undo goes to the focused composer, not the design history, and restores only for the page", async () => {
    test.setTimeout(300_000);
    const bin = sidecarBinary();
    project = seededCopy(bin, "rw-native-menu-");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    lecturn = lecturnEnv(env, "rw-native-menu-lecturn-", { scripts: loadTurnFixture(B4A_FIXTURE).scripts });
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", project, "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    const page = await app.firstWindow();
    await expect(byTestId(page, "header.project-switcher")).not.toHaveText(/^(Opening…|No project)?$/, { timeout: 120_000 });

    const minimum = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize());
    expect(minimum[0]).toBe(1024);

    await expect(byTestId(page, "agent.embed")).toBeVisible({ timeout: 90_000 });
    await newThread(app, page, { title: "Native menu" });
    const guest = await embedGuest(app);
    await expect.poll(async () => (await guest.evaluate(readGuestView, null)).composer, { timeout: 60_000 }).toBe(true);
    const stepsBefore = await byTestId(page, "history.step").count();
    await expect(byTestId(page, "header.undo"), "the seeded project has a step to undo").toBeEnabled();

    // The composer: the guest takes the undo and the design history stays put.
    await focusContents(app, "guest");
    await typeInComposer(guest, "ab");
    await expect.poll(async () => (await guest.evaluate(readGuestView, null)).draft).toContain("ab");
    await expect.poll(() => focusedKind(app!), { timeout: 15_000 }).toBe("guest");
    await spyOnGuestUndo(app);
    await clickMenuItem(app, "edit.undo");
    await expect.poll(() => guestUndos(app!)).toBe(1);
    await expect.poll(async () => (await guest.evaluate(readGuestView, null)).draft).not.toBe("ab");
    await page.waitForTimeout(1_500);
    await expect(byTestId(page, "history.step")).toHaveCount(stepsBefore);

    // The control: with the page focused the same item is a design undo, so a broken route above could not pass.
    await focusContents(app, "host");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => focusedKind(app!), { timeout: 15_000 }).toBe("host");
    await clickMenuItem(app, "edit.undo");
    await expect(byTestId(page, "history.step")).toHaveCount(stepsBefore + 1, { timeout: 30_000 });
    await expect.poll(() => guestUndos(app!)).toBe(1);

    await clickMenuItem(app, "view.zoom:in");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("zoom"))).toBe("1.1");
    await expect
      .poll(async () => {
        const [{ slot, shell, inner }, bounds] = await paneGeometry(app!, page);
        if (bounds === null) return "no pane view";
        const off = Math.max(Math.abs(bounds.x - slot.x), Math.abs(bounds.y - slot.y), Math.abs(bounds.width - slot.width), Math.abs(bounds.height - slot.height));
        if (off > 1.5) return `pane off its slot by ${off}`;
        return Math.abs(shell.width - inner.width) <= 1.5 && Math.abs(shell.height - inner.height) <= 1.5 ? "fits" : `shell ${shell.width}x${shell.height} in ${inner.width}x${inner.height}`;
      })
      .toBe("fits");
    await clickMenuItem(app, "view.zoom:reset");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("zoom"))).toBe("1");
  });
});
