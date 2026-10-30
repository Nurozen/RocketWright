/**
 * B4(a) (spec S:198, plan M1.18; W5.2, B14): chat drives a simulation, through
 * the embedded Lecturn pane.
 *
 * Open a copy of the seeded research vehicle (`fixtures/research-vehicle/seed.sh`,
 * M1.55: a Complete Baseline run on the current model) in the Electron app
 * (`--project`). Lecturn's sidecar runs in temp dirs
 * with its test-only `scripted` provider as the default model
 * (`LECTURN_TEST_PROVIDERS=1`, Lecturn A16), replaying
 * `fixtures/scripted/b4a.json` (D22; it replaced the stand-in script B17 deleted:
 * `saveAs`, `${sim.job_id}`, `poll`) from the scripts file keyed by run
 * ordinal. The turn goes through the pane's bridge (`embed.ts`): a new
 * thread (`lecturn/thread.new`), the prompt as its draft
 * (`lecturn/composer.setDraft`), the composer's send button, then
 * `lecturn/turn.state` until idle. The tools run through Lecturn's app
 * toolkit into the project. Then assert: exactly one new history step, the
 * previous Baseline run flagged Outdated, a new Complete Baseline run, the
 * altitude plot showing both series, the history strip updated, and, in the
 * pane, the reply, the step card and a complete flight run card with its
 * chart (`ui://rw/*`, D7). Screenshots and the trace go to
 * `<bar out>/e2e/b4a/` (plan BC2).
 *
 * In `make merge-gate` via `make e2e`. No test hooks (I12): `RW_TEST_HOOKS`
 * is unset.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { B4A_FIXTURE, B4A_THREAD_TITLE, B4A_TITLE } from "./b4a.ts";
import { barOutDir, REPO_ROOT } from "./bar/paths.ts";
import type { CardFrameFacts } from "./capture/pane-checks.ts";
import { LecturnAdmin } from "./capture/scripted.ts";
import { captureGuest, embedGuest, loadTurnFixture, scanPane, sendTurn } from "./embed.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { killOrphans } from "./orphans.ts";
import { seededCopy, sidecarBinary } from "./live.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const OUT = join(barOutDir(), "e2e/b4a");

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);
const region = (page: Page, name: string) => page.locator(`[data-rw-region="${name}"]`);

/** Baseline rows in the run table (`runs.table-row`, concept 04). */
const baselineRows = (page: Page) => byTestId(page, "runs.table-row").filter({ hasText: /Baseline/ });

test.describe("B4(a) chat drives a simulation", () => {
  let app: ElectronApplication | undefined;
  let project = "";
  let lecturn: LecturnEnv | undefined;

  test.afterEach(async () => {
    await app?.close();
    // CPW1R5A: nothing of this run may outlive it (orphans starved the next spec's Chromium).
    const left = killOrphans([project ? dirname(project) : "", lecturn?.dir ?? ""]);
    if (left.length > 0) console.warn(`b4a: killed ${left.length} process(es) the app left behind:\n  ${left.join("\n  ")}`);
    if (project) rmSync(dirname(project), { recursive: true, force: true });
    lecturn?.cleanup();
  });

  test(B4A_TITLE, async () => {
    // Sidecar cold start, the Lecturn sidecar's, the turn and the run.
    test.setTimeout(360_000);
    const fixture = loadTurnFixture(B4A_FIXTURE);
    const bin = sidecarBinary();
    project = seededCopy(bin, "rw-b4a-");
    mkdirSync(OUT, { recursive: true });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["RW_TEST_HOOKS"]; // B4(a) uses no test hooks (I12)
    Object.assign(env, { RW_SIDECAR_BIN: bin, RW_OFFLINE: "1" });
    // Fresh Lecturn dirs (never ~/.lecturn) with the scripted provider and this turn's scripts file.
    lecturn = lecturnEnv(env, "rw-b4a-lecturn-", { scripts: fixture.scripts });
    Object.assign(env, lecturn.env);

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    app = await electron.launch({
      executablePath,
      args: [join(DESKTOP, "src/main.ts"), "--project", project, "-ApplePersistenceIgnoreState", "YES"],
      env,
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    await expect(region(page, "workspace")).toBeVisible({ timeout: 120_000 });

    // Results page (04) with the seeded Baseline run Complete.
    await page.goto(new URL("?page=04", page.url()).href);
    await expect(region(page, "run-table")).toBeVisible();
    await expect(baselineRows(page)).toHaveCount(1);
    await expect(baselineRows(page).first()).toContainText("Complete");
    await expect(byTestId(page, "agent.embed")).toBeVisible({ timeout: 60_000 });
    const stepsBefore = await byTestId(page, "history.step").count();
    await page.screenshot({ path: join(OUT, "before.png") });

    // The scripted turn: model_patch → simulate → job_status polled until complete.
    const turn = await sendTurn(app, page, { prompt: fixture.prompt, title: B4A_THREAD_TITLE, timeoutMs: 180_000, log: (l) => console.log(l) });
    expect(turn.states).toContain("running");
    // For a failure's diagnosis: the Lecturn thread as the server has it (tool inputs and results).
    const baseDir = lecturn.env["RW_LECTURN_BASE_DIR"];
    if (baseDir !== undefined) {
      await LecturnAdmin.open(baseDir)
        .then(async (admin) => writeFileSync(join(OUT, "lecturn-thread.json"), `${JSON.stringify(await admin.projection(turn.threadId), null, 2)}\n`))
        .catch((e: unknown) => console.log(`b4a: no thread dump: ${e instanceof Error ? e.message : String(e)}`));
    }
    const guest = await embedGuest(app);
    // The pane (D7): the reply, the patch's step card, and the new run's flight card complete with its chart.
    const reply = "Baseline is Complete with the 90 mm fins";
    const flightDone = (c: CardFrameFacts | null): boolean => c !== null && c.kind === "flight" && c.phase === "complete" && c.points >= 2;
    const scan = await scanPane(guest, (s) => s.text.some((t) => t.includes(reply)) && s.stepCards.some((t) => /Fin span 90 mm/i.test(t)) && s.runCards.some(flightDone), 90_000);
    expect(scan.text.join("\n")).toContain(fixture.prompt);
    const pane = await captureGuest(app);
    if (pane !== null) writeFileSync(join(OUT, "pane.png"), pane);

    // Exactly one new step, and the strip shows it as current.
    await expect(byTestId(page, "history.step")).toHaveCount(stepsBefore + 1);
    await expect(byTestId(page, "history.step").last()).toContainText(/Fin span 90 mm/i);

    // The old Baseline run is Outdated, the new one Complete.
    await expect(baselineRows(page)).toHaveCount(2);
    await expect(baselineRows(page).filter({ hasText: "Outdated" })).toHaveCount(1);
    await expect(baselineRows(page).filter({ hasText: "Complete" })).toHaveCount(1);
    await expect(byTestId(page, "results.outdated-banner")).toBeVisible();

    // The altitude plot overlays both Baseline series.
    await expect(region(page, "plot")).toBeVisible();
    expect(await byTestId(page, "plot.series").count()).toBeGreaterThanOrEqual(2);

    await page.screenshot({ path: join(OUT, "after.png") });
    await page.context().tracing.stop({ path: join(OUT, "trace.zip") });
  });
});
