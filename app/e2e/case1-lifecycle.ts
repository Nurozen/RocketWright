/**
 * What the B1 drive may not do itself (D27): launching and quitting the app,
 * the native dialog stubs, the trace and the checks on what quit left behind.
 * The source scan covers the drive (`case1-stages.ts`, `rebuild-case1.spec.ts`)
 * and leaves this file out, so it comes in only through `Lifecycle` and the
 * free functions below.
 *
 * Every run gets a clean profile and its own Documents (`RW_DOCUMENTS_DIR`,
 * spec B1: a short `/tmp` path, never the real `~/Documents`). A process left
 * after quit is reported. Only a process this run saw descend from its own
 * Electron is ever killed, and only once quit has had its chance: before the
 * post-quit reads, or when a failed run is torn down.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { barOutDir, REPO_ROOT } from "./bar/paths.ts";
import { createPostQuitReader, judgeRebuild } from "./case1-compare.ts";
import { loadCase1Plan } from "./case1-plan.ts";
import { B1_STAGES, enabledRowKeys, type DriveContext, type Lifecycle } from "./case1-stages.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";
import { currentProcs, findOrphans, killStarted, processTreeOf, stillRunning } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const OUT = join(barOutDir(), "e2e/b1");
const LAUNCH_TIMEOUT_MS = 120_000;
/** How long the app may take to record the project it is showing. */
const LAST_ACTIVE_TIMEOUT_MS = 15_000;
/** How long the server and sidecars get to stop on their own after the app closes. */
const EXIT_GRACE_MS = 15_000;
/** How long a killed process gets to disappear. */
const KILLED_EXIT_MS = 5_000;

export class Case1Run {
  page!: Page;
  readonly lifecycle: Lifecycle;
  private app: ElectronApplication | undefined;
  private launches = 0;
  private readonly dialogs = new DialogQueues();
  private readonly base = mkdtempSync(join(SCRATCH, "rw-b1-"));
  private readonly documents = join(this.base, "docs");
  private readonly lecturn: LecturnEnv;
  private readonly env: Record<string, string> = {};
  /** Every process seen descending from this run's Electron: the only ones it may kill. */
  private readonly started = new Map<number, string>();
  /** The folder the Location picker returned; without it the default location is used. */
  private location: string | undefined;

  constructor(private readonly projectName: string) {
    mkdirSync(this.documents);
    mkdirSync(OUT, { recursive: true });
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) this.env[k] = v;
    delete this.env["ELECTRON_RUN_AS_NODE"];
    delete this.env["RW_TEST_HOOKS"];
    // A fresh Lecturn pair also names the clean Electron profile (`RW_USER_DATA_DIR`).
    this.lecturn = lecturnEnv(this.env, "rw-b1-lecturn-", { fresh: true });
    Object.assign(this.env, this.lecturn.env, { RW_SIDECAR_BIN: sidecarBinary(), RW_OFFLINE: "1", RW_DOCUMENTS_DIR: this.documents });
    this.lifecycle = {
      chooseFolder: () => this.chooseFolder(),
      quit: () => this.quit(),
      relaunch: () => this.launch(),
      finish: (drive) => this.finish(drive),
    };
  }

  async launch(): Promise<Page> {
    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    this.launches += 1;
    // No `--project`: this is the launch a person makes.
    this.app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "-ApplePersistenceIgnoreState", "YES"], env: this.env, timeout: LAUNCH_TIMEOUT_MS });
    this.page = await this.app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await this.page.context().tracing.start({ screenshots: true, snapshots: true });
    await this.dialogs.install(this.app);
    return this.page;
  }

  private async chooseFolder(): Promise<string> {
    const folder = join(this.base, "chosen");
    mkdirSync(folder, { recursive: true });
    await this.dialogs.enqueue("showOpenDialog", { canceled: false, filePaths: [folder] });
    this.location = folder;
    return folder;
  }

  private projectDir(): string {
    return join(this.location ?? join(this.documents, "RocketWright"), this.projectName);
  }

  /** Recents and last-active are written through as the project shows (D5): quit must find them there. */
  private async waitForLastActive(): Promise<void> {
    const file = join(this.env["RW_USER_DATA_DIR"]!, "recents.json");
    const want = realpathSync(this.projectDir());
    const deadline = Date.now() + LAST_ACTIVE_TIMEOUT_MS;
    let seen: unknown = null;
    for (;;) {
      if (existsSync(file)) {
        seen = (JSON.parse(readFileSync(file, "utf8")) as { lastActive?: unknown }).lastActive ?? null;
        if (seen === want) return;
      }
      if (Date.now() > deadline) throw new Error(`recents.json never named ${want} as last active (it says ${String(seen)})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async stopTrace(): Promise<void> {
    await this.page.context().tracing.stop({ path: join(OUT, `trace-launch-${this.launches}.zip`) });
  }

  private async quit(): Promise<void> {
    if (!existsSync(join(this.projectDir(), "rocketwright.toml"))) throw new Error(`no project on disk at ${this.projectDir()}`);
    await this.waitForLastActive();
    await this.dialogs.sync();
    await this.stopTrace();
    await this.closeApp();
    this.reportLeftovers();
  }

  /** Records what the app started, closes it, and gives its server and sidecars time to stop. */
  private async closeApp(): Promise<void> {
    const app = this.app;
    if (app === undefined) return;
    for (const p of processTreeOf(app.process().pid ?? -1)) this.started.set(p.pid, p.command);
    await app.close().catch(() => undefined);
    this.app = undefined;
    await this.waitForStartedToExit(EXIT_GRACE_MS);
  }

  private async waitForStartedToExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (stillRunning(this.started, currentProcs()).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  /** What still names this run's temp dirs. */
  private leftovers() {
    return findOrphans([this.base, this.lecturn.dir ?? ""]);
  }

  private reportLeftovers(): void {
    const left = this.leftovers();
    if (left.length > 0) console.warn(`B1: the app left ${left.length} process(es) behind:\n  ${left.map((p) => `${p.pid} ${p.command.slice(0, 200)}`).join("\n  ")}`);
  }

  /** Kills what this run started and quit did not stop: never anything found by a path alone. */
  private async killWhatThisRunStarted(): Promise<void> {
    const killed = killStarted(this.started);
    if (killed.length === 0) return;
    console.warn(`B1: killed ${killed.length} process(es) this run started that outlived quit:\n  ${killed.join("\n  ")}`);
    await this.waitForStartedToExit(KILLED_EXIT_MS);
  }

  /** The final quit, then the reads: `rw eval` and the comparison on what the enabled stages built. */
  private async finish(drive: DriveContext): Promise<void> {
    if (this.app !== undefined) await this.quit();
    await this.killWhatThisRunStarted();
    // A live sidecar would answer the reads for the session, not from what quit left on disk.
    const left = this.leftovers();
    if (left.length > 0) throw new Error(`compare: ${left.length} process(es) still name this run's folders, so nothing can be read yet:\n  ${left.map((p) => `${p.pid} ${p.command.slice(0, 200)}`).join("\n  ")}`);
    const bin = sidecarBinary();
    const project = this.projectDir();
    const verdict = judgeRebuild({ plan: loadCase1Plan(bin), project, reader: createPostQuitReader(bin, project), enabled: enabledRowKeys(B1_STAGES), ...this.runScoring(drive) });
    writeFileSync(join(OUT, "post-quit-eval.json"), `${JSON.stringify(verdict.model, null, 2)}\n`);
    writeFileSync(join(OUT, "compare.json"), `${JSON.stringify({ diffs: verdict.diffs, problems: verdict.problems }, null, 2)}\n`);
    if (verdict.diffs.length > 0 || verdict.problems.length > 0) throw new Error(`compare: the project on disk is not what was built:\n${JSON.stringify({ diffs: verdict.diffs, problems: verdict.problems }, null, 2)}`);
  }

  /** Once `run` is enabled the app's flight is scored too (D29); until then there is none to score. */
  private runScoring(drive: DriveContext) {
    if (!B1_STAGES.has("run")) return {};
    const { runClickedAt, quitAt } = drive.timing;
    if (runClickedAt === undefined || quitAt === undefined) throw new Error("compare: the run stage is enabled but recorded no Run click or quit");
    return { run: { runClickedAtMs: runClickedAt, quitAtMs: quitAt, table: drive.tableReads } };
  }

  /** Saves what a failed run reached, closes whatever is still open, and removes the temp dirs. */
  async stop(): Promise<void> {
    if (this.app !== undefined) {
      await this.stopTrace().catch(() => undefined);
      await this.closeApp();
    }
    await this.killWhatThisRunStarted();
    this.reportLeftovers();
    rmSync(this.base, { recursive: true, force: true });
    this.lecturn.cleanup();
  }
}

/** A clean run of the desktop app, launched and showing its first window. */
export async function startCase1Run(projectName: string): Promise<Case1Run> {
  const run = new Case1Run(projectName);
  try {
    await run.launch();
  } catch (e) {
    await run.stop();
    throw e;
  }
  return run;
}

export const stopCase1Run = (run: Case1Run | undefined): Promise<void> => run?.stop() ?? Promise.resolve();
