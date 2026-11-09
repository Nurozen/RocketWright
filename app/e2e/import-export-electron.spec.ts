/**
 * R3.1 on the desktop (D17, D18), in the real app with its native dialogs
 * answered by a stub: from Welcome an `.ork` becomes a new project; with a
 * project open the picker imports motors and an `.ork` from outside it; and an
 * export goes through main's save dialog to a path outside the project, which
 * a renderer may not do on its own. The `.ork` is generated here at runtime and
 * the motor files are synthetic, because neither may ever be committed.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";
import { killOrphans } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const ENG = "; synthetic test curve\nC6 18 70 0-3-5 0.0110 0.0240 Synth\n   0.050 6.000\n   0.200 12.000\n   0.400 6.000\n   1.500 4.500\n   1.800 0.000\n";
const RSE = `<engine-database><engine-list><engine mfg="Synth" code="D9" Type="single" dia="24." len="70." initWt="44.0" propWt="20." delays="0,3,5" auto-calc-mass="0" auto-calc-cg="0" avgThrust="9." peakThrust="20." throatDia="0." exitDia="0." Itot="18." burn-time="2." massFrac="0" Isp="0" tDiv="10" tStep="-1." tFix="1" FDiv="10" FStep="-1." FFix="1" nameDivs="1"><data><eng-data t="0." f="0." m="20." cg="35."/><eng-data t="0.2" f="20." m="18." cg="35."/><eng-data t="1.5" f="8." m="4." cg="35."/><eng-data t="2." f="0." m="0." cg="35."/></data></engine></engine-list></engine-database>\n`;

/** Clicks a native menu item by id, as a person picking it would. */
const clickMenuItem = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (item === null || item === undefined) throw new Error(`no menu item ${itemId}`);
    item.click();
  }, id);

test.describe("import and export on the desktop", () => {
  let app: ElectronApplication | undefined;
  let lecturn: LecturnEnv | undefined;
  let base = "";

  test.afterEach(async () => {
    await app?.close();
    killOrphans([base, lecturn?.dir ?? ""]);
    lecturn?.cleanup();
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  test("an .ork starts a project from Welcome, the picker imports from outside, and main's dialog exports outside", async () => {
    test.setTimeout(300_000);
    const bin = sidecarBinary();
    base = mkdtempSync(join(SCRATCH, "rw-e2e-desktop-import-"));
    const outside = join(base, "outside");
    const documents = join(base, "docs");
    mkdirSync(outside);
    mkdirSync(documents);
    const source = join(base, "source");
    cpSync(join(REPO_ROOT, "fixtures/research-vehicle"), source, { recursive: true });
    const ork = join(outside, "generated.ork");
    execFileSync(bin, ["export", "ork", ork, "--allow-outside"], { cwd: source, encoding: "utf8" });
    writeFileSync(join(outside, "Synth_C6.eng"), ENG);
    writeFileSync(join(outside, "Synth_D9.rse"), RSE);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"];
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1", RW_DOCUMENTS_DIR: documents });
    lecturn = lecturnEnv(env, "rw-e2e-import-lecturn-", { fresh: true });
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    const page: Page = await app.firstWindow({ timeout: 120_000 });
    const dialogs = new DialogQueues();
    await dialogs.install(app);
    await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 120_000 });

    // From Welcome: the New project flow, never an import into something existing.
    await dialogs.enqueue("showOpenDialog", { canceled: false, filePaths: [ork] });
    await clickMenuItem(app, "file.import");
    const form = page.getByTestId("new-project");
    await expect(form.getByLabel("Name")).toHaveValue("generated");
    await form.getByLabel("Name").fill("From ork");
    await form.getByRole("button", { name: "Create project" }).click();
    const switcher = page.getByTestId("header.project-switcher");
    await expect(switcher).toHaveText("From ork", { timeout: 60_000 });
    const project = join(documents, "RocketWright/From ork");
    expect(existsSync(join(project, "rocketwright.toml"))).toBe(true);
    const [picked] = await dialogs.waitForCalls("showOpenDialog", 1, 10_000);
    expect(JSON.stringify(picked!.options)).toContain('"ork"');

    // Motors from outside the project, picked natively.
    for (const name of ["Synth_C6.eng", "Synth_D9.rse"]) {
      await dialogs.enqueue("showOpenDialog", { canceled: false, filePaths: [join(outside, name)] });
      await clickMenuItem(app, "file.import");
      await expect(page.getByTestId("project-actions.notice")).toContainText(`Imported ${name}`, { timeout: 30_000 });
      await expect.poll(() => readdirSync(join(project, "lib/motors"))).toContain(name);
    }

    // An .ork on an open project: asks, and replaces only after the confirmation.
    await dialogs.enqueue("showOpenDialog", { canceled: false, filePaths: [ork] });
    await clickMenuItem(app, "file.import");
    await page.getByTestId("ork-import").getByRole("button", { name: "Replace current design…" }).click();
    await page.getByTestId("ork-import.confirm").getByRole("button", { name: "Replace design" }).click();
    await expect(page.getByTestId("project-actions.notice")).toContainText("Imported generated.ork", { timeout: 30_000 });

    // Export: main owns the save dialog and writes outside the project over its own socket.
    const saved = join(outside, "exported.ork");
    await dialogs.enqueue("showSaveDialog", { canceled: false, filePath: saved });
    await clickMenuItem(app, "file.export");
    await page.getByTestId("export-dialog").getByRole("button", { name: "Export…" }).click();
    await expect(page.getByTestId("project-actions.notice")).toContainText(saved, { timeout: 30_000 });
    expect(statSync(saved).size).toBeGreaterThan(0);
    const [save] = await dialogs.waitForCalls("showSaveDialog", 1, 10_000);
    expect((save!.options as { defaultPath: string }).defaultPath.startsWith(documents)).toBe(true);

    // Cancelling the save writes nothing and says nothing.
    const notice = page.getByTestId("project-actions.notice");
    await dialogs.enqueue("showSaveDialog", { canceled: true });
    await clickMenuItem(app, "file.export");
    await page.getByTestId("export-dialog").getByRole("button", { name: "Export…" }).click();
    await dialogs.waitForCalls("showSaveDialog", 2, 10_000);
    await expect(notice).toHaveCount(0);
  });
});
