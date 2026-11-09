/**
 * R3.1 over the agent pane, in the real app with the real Lecturn guest: a file
 * RocketWright imports runs the page's import flow wherever it lands, and any
 * other file still goes to Lecturn's composer.
 *
 * The drop is Chromium's own drag path, not a script-made event: CDP's
 * `Input.dispatchDragEvent` with real file paths, on the guest's webContents
 * from Electron main, so the guest gets a trusted `drop` whose `File`s are
 * backed by the paths. Playwright cannot start a native OS drag, so what this
 * does not cover is macOS handing the drag to the view.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { embedGuest, newThread, readGuestView, until, type EmbedGuest } from "./embed.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { SCRATCH, seededCopy, sidecarBinary } from "./live.ts";
import { killOrphans } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const ENG = (code: string): string => `; synthetic test curve\n${code} 18 70 0-3-5 0.0110 0.0240 Synth\n   0.050 6.000\n   0.200 12.000\n   0.400 6.000\n   1.500 4.500\n   1.800 0.000\n`;

interface Point {
  x: number;
  y: number;
}

/** Enter, over, drop at `at` in the guest, through Chromium's drag path, on the guest's one debugger client (D15): the bridge's when it has attached, otherwise this call's alone. */
async function dropOnGuest(app: ElectronApplication, at: Point, files: string[]): Promise<void> {
  await app.evaluate(
    async ({ webContents }, a: { at: Point; files: string[] }) => {
      const wc = webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
        .sort((x, y) => y.id - x.id)[0];
      if (wc === undefined) throw new Error("no guest");
      const own = !wc.debugger.isAttached();
      if (own) wc.debugger.attach("1.3");
      try {
        const data = { items: [], files: a.files, dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver", "drop"]) await wc.debugger.sendCommand("Input.dispatchDragEvent", { type, x: a.at.x, y: a.at.y, data });
      } finally {
        if (own) wc.debugger.detach();
      }
    },
    { at, files },
  );
}

/** The composer's centre in the guest, and a point over the conversation above it. */
const composerPoints = (guest: EmbedGuest): Promise<{ composer: Point; conversation: Point } | null> =>
  guest.evaluate(() => {
    const editor = document.querySelector('[data-testid="composer-editor"]');
    if (editor === null) return null;
    const r = editor.getBoundingClientRect();
    return { composer: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }, conversation: { x: Math.round(window.innerWidth / 2), y: Math.max(40, Math.round(r.top / 2)) } };
  }, null);

const guestText = (guest: EmbedGuest): Promise<string> => guest.evaluate(() => document.body.innerText, null);

test.describe("files dropped on the agent pane", () => {
  let app: ElectronApplication | undefined;
  let lecturn: LecturnEnv | undefined;
  let project = "";
  let outside = "";

  test.afterEach(async () => {
    await app?.close();
    killOrphans([project ? dirname(project) : "", lecturn?.dir ?? ""]);
    lecturn?.cleanup();
    if (project !== "") rmSync(dirname(project), { recursive: true, force: true });
    if (outside !== "") rmSync(outside, { recursive: true, force: true });
  });

  test("an import dropped anywhere on the pane runs the page's import, and other files stay Lecturn's", async () => {
    test.setTimeout(300_000);
    const bin = sidecarBinary();
    project = seededCopy(bin, "rw-e2e-pane-drop-");
    outside = mkdtempSync(join(SCRATCH, "rw-e2e-pane-drop-out-"));
    const ork = join(outside, "generated.ork");
    execFileSync(bin, ["export", "ork", ork, "--allow-outside"], { cwd: project, encoding: "utf8" });
    writeFileSync(join(outside, "Pane_C6.eng"), ENG("C6"));
    writeFileSync(join(outside, "Pane_D7.eng"), ENG("D7"));
    const notes = join(outside, "pane-notes.txt");
    writeFileSync(notes, "for the agent\n");

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    lecturn = lecturnEnv(env, "rw-e2e-pane-drop-lecturn-", { scripts: {} });
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", project, "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    const page: Page = await app.firstWindow({ timeout: 120_000 });
    await expect(page.getByTestId("agent.embed")).toBeVisible({ timeout: 120_000 });
    const guest = await embedGuest(app);
    // A fresh project shows no composer until a thread is open.
    await until("the embed's empty project", 120_000, async () => ((await guest.evaluate(readGuestView, null)).empty ? true : undefined));
    await newThread(app, page, { title: "Pane drop" });
    const points = await until("the guest's composer", 120_000, async () => (await composerPoints(guest)) ?? undefined);

    // The boundary stays where it was: this feature gives the guest's page nothing.
    expect(await guest.evaluate(() => ({ desktop: typeof (window as unknown as Record<string, unknown>)["rwDesktop"], require: typeof (window as unknown as Record<string, unknown>)["require"] }), null)).toEqual({ desktop: "undefined", require: "undefined" });

    const notice = page.getByTestId("project-actions.notice");
    const motors = (): string[] => (existsSync(join(project, "lib/motors")) ? readdirSync(join(project, "lib/motors")) : []);

    // Over the conversation, away from any drop target of Lecturn's.
    await dropOnGuest(app, points.conversation, [join(outside, "Pane_C6.eng")]);
    await expect(notice).toContainText("Imported Pane_C6.eng", { timeout: 30_000 });
    await expect.poll(motors).toContain("Pane_C6.eng");

    // Over the composer, which would otherwise attach it.
    await dropOnGuest(app, points.composer, [join(outside, "Pane_D7.eng")]);
    await expect(notice).toContainText("Imported Pane_D7.eng", { timeout: 30_000 });
    await expect.poll(motors).toContain("Pane_D7.eng");
    expect(await guestText(guest)).not.toContain("Pane_D7.eng");
    // Lecturn's drop highlight went away though its drop handler never ran.
    expect(await guest.evaluate(() => document.querySelector("[data-chat-workspace-drop-overlay]") !== null, null)).toBe(false);

    // An .ork brings up the same choice a drop on the page does.
    await dropOnGuest(app, points.conversation, [ork]);
    const choice = page.getByTestId("ork-import");
    await expect(choice).toBeVisible({ timeout: 30_000 });
    await choice.getByRole("button", { name: "Cancel" }).click();
    await expect(choice).toHaveCount(0);

    // Several imports at once are refused as a drop on the page is.
    await dropOnGuest(app, points.conversation, [join(outside, "Pane_C6.eng"), join(outside, "Pane_D7.eng")]);
    await expect(page.getByText("Drop one file at a time.")).toBeVisible({ timeout: 30_000 });

    // Anything else is still Lecturn's: an attachment, and nothing imported.
    const before = motors();
    await dropOnGuest(app, points.composer, [notes]);
    await expect.poll(() => guestText(guest), { timeout: 30_000 }).toContain("pane-notes.txt");
    expect(motors()).toEqual(before);
    await expect(page.getByText("pane-notes.txt")).toHaveCount(0);
  });
});
