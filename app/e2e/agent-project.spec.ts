/**
 * B2-a (U40, D28): the agent's `rw_project_new`, end to end in the real
 * Electron app with Lecturn's scripted provider, in Supervised and Full
 * access. The scripted turn reaches the live route; the native dialog is a
 * stub held open while the spec reads what the app has done so far.
 *
 * Each case: one native dialog naming the action, path and full `request`;
 * nothing created and no new thread before the accept; on accept the window
 * switches to the new project, a new thread there carries the request, and
 * the calling turn's result names both, after the switch; on Cancel nothing
 * changes and the calling turn hears why; with no `request` the new thread
 * exists and takes no turn.
 *
 * The projection stubs a dynamic tool's output (U06), so results are read
 * through `LecturnAdminSession.transcript` (`orchestration.getTurnItem`).
 * Temp project, Documents and Lecturn dirs; only processes this run saw
 * descend from its own Electron are ever killed.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { LecturnAdminSession, RUNTIME_MODE_LABEL, type AdminProjection, type RuntimeMode } from "../../scripts/bar/lecturn-admin.ts";
import { CONSENT_ACCEPT_BUTTON, CONSENT_CANCEL_BUTTON } from "../apps/desktop/src/nativeDialogs.ts";
import { BARE, PROJECT_NEW_FIXTURE, WITH_REQUEST } from "./agent-project.ts";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues, type DialogCall } from "./electron-dialogs.ts";
import { draftAndSend, embedGuest, loadTurnFixture, newThread, readGuestView, readRuntimeMode, sendTurn, until } from "./embed.ts";
import { lecturnEnv, type LecturnEnv, type ScriptsFile } from "./lecturn-env.ts";
import { SCRATCH, sidecarBinary } from "./live.ts";
import { bareTool } from "./lecturn-transcript.ts";
import { currentProcs, killStarted, processTreeOf, stillRunning } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const NEW_PROJECT = "solstice-rocket";
const CALLER_PROJECT = "caller-rocket";
/** `apps/server/src/lecturn/connection.ts`: the server's line above the request. */
const JUST_CREATED = "This project was just created and is open; do not create it again.";
const HOLD = "consent";
const DIALOG_MS = 90_000;
const SETTLE_MS = 90_000;
const EXIT_GRACE_MS = 15_000;

const fixture = loadTurnFixture(PROJECT_NEW_FIXTURE);
const requestOf = (ordinal: string): string => {
  const step = fixture.scripts[ordinal]!.find((s) => "toolCall" in s) as { toolCall: { arguments: Record<string, unknown> } };
  return step.toolCall.arguments["request"] as string;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const header = (page: Page) => page.locator('[data-testid="header.project-switcher"]');

/** One app launch with its temp project, Documents, Lecturn dirs and a stubbed consent dialog. */
class ProjectRun {
  app!: ElectronApplication;
  page!: Page;
  readonly dialogs = new DialogQueues();
  readonly base = mkdtempSync(join(SCRATCH, "rw-b2-"));
  readonly documents = join(this.base, "docs");
  readonly caller = join(this.base, CALLER_PROJECT);
  readonly env: Record<string, string> = {};
  private readonly lecturn: LecturnEnv;
  private readonly started = new Map<number, string>();
  private adminSession: LecturnAdminSession | null = null;

  constructor(scripts: ScriptsFile) {
    mkdirSync(this.documents);
    execFileSync(sidecarBinary(), ["init", this.caller], { encoding: "utf8" });
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) this.env[k] = v;
    delete this.env["ELECTRON_RUN_AS_NODE"];
    delete this.env["RW_TEST_HOOKS"];
    this.lecturn = lecturnEnv(this.env, "rw-b2-lecturn-", { scripts });
    Object.assign(this.env, this.lecturn.env, { RW_SIDECAR_BIN: sidecarBinary(), RW_OFFLINE: "1", RW_DOCUMENTS_DIR: this.documents });
  }

  get target(): string {
    return join(this.documents, "RocketWright", NEW_PROJECT);
  }

  async launch(project = this.caller): Promise<void> {
    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    this.app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", project, "-ApplePersistenceIgnoreState", "YES"], env: this.env, timeout: 120_000 });
    this.page = await this.app.firstWindow({ timeout: 120_000 });
    await this.dialogs.install(this.app);
    await expect(this.page.locator('[data-rw-region="workspace"]')).toBeVisible({ timeout: 120_000 });
    await expect(header(this.page)).toHaveText(project === this.caller ? CALLER_PROJECT : NEW_PROJECT);
    await expect(this.page.locator('[data-testid="agent.embed"]')).toBeVisible({ timeout: 60_000 });
    this.remember();
  }

  admin(): Promise<LecturnAdminSession> {
    if (this.adminSession !== null) return Promise.resolve(this.adminSession);
    // The pane can be up before the sidecar has written where it listens.
    return until("the Lecturn sidecar", 120_000, () => LecturnAdminSession.open(this.env["RW_LECTURN_BASE_DIR"]!, this.env)).then((a) => (this.adminSession = a));
  }

  /** Every process seen descending from this run's Electron: the only ones it may kill. */
  remember(): void {
    const pid = this.app.process().pid;
    if (pid !== undefined) for (const p of processTreeOf(pid)) this.started.set(p.pid, p.command);
  }

  async quit(): Promise<void> {
    this.remember();
    await this.app.close().catch(() => undefined);
    this.adminSession = null;
    const deadline = Date.now() + EXIT_GRACE_MS;
    while (stillRunning(this.started, currentProcs()).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  async finish(): Promise<void> {
    if (this.app !== undefined) await this.quit();
    const killed = killStarted(this.started);
    if (killed.length > 0) console.warn(`B2: killed ${killed.length} process(es) this run started that outlived quit:\n  ${killed.join("\n  ")}`);
    rmSync(this.base, { recursive: true, force: true });
    this.lecturn.cleanup();
  }
}

/** The app's Lecturn threads, deleted ones left out. */
async function liveThreads(run: ProjectRun): Promise<{ id: string; projectId: string; title: string }[]> {
  const shell = await (await run.admin()).shell();
  return shell.threads.filter((t) => (t.deletedAt ?? null) === null).map((t) => ({ id: t.id, projectId: t.projectId, title: t.title }));
}

/** A run of `threadId` until its latest run is settled. */
async function settledTranscript(run: ProjectRun, threadId: string): Promise<AdminProjection> {
  const admin = await run.admin();
  return until(
    `thread ${threadId} to settle`,
    SETTLE_MS,
    async () => {
      const p = await admin.transcript(threadId);
      return p.runs.length > 0 && p.runs.every((r) => ["completed", "failed", "interrupted", "cancelled"].includes(r.status)) ? p : undefined;
    },
    async () => (await admin.transcript(threadId)).runs,
  );
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
  completedAt: string | null;
}

function projectNewCalls(p: AdminProjection): ToolOutcome[] {
  return p.turnItems
    .filter((i) => i.type === "dynamic_tool" && bareTool(i.toolName) === "project_new")
    .map((i) => {
      const output = i.output as { result?: unknown } | undefined;
      const result = (isObject(output) && "result" in output ? output.result : output) as { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown } | undefined;
      return {
        isError: result?.isError === true || i.status === "failed",
        text: (result?.content ?? []).map((c) => c.text ?? "").join("\n"),
        structured: result?.structuredContent,
        completedAt: (i as { completedAt?: string | null }).completedAt ?? null,
      };
    });
}

/** The thread's first user message's text, when there is one. */
const firstUserText = (p: AdminProjection): string | undefined => p.messages.find((m) => m.role === "user")?.text;

/** The settings Lecturn holds for the thread (`projection.thread`). */
function settings(p: AdminProjection): { runtimeMode: unknown; interactionMode: unknown; instanceId: unknown } {
  const t = (p as unknown as { thread: { runtimeMode?: unknown; interactionMode?: unknown; modelSelection?: { instanceId?: unknown } } }).thread;
  return { runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, instanceId: t.modelSelection?.instanceId };
}

function assertDialog(call: DialogCall | undefined, run: ProjectRun, request: string | null): void {
  expect(call, "the consent dialog was shown").toBeDefined();
  const o = call!.options as { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };
  expect(o.message).toBe("The agent wants to create a new project");
  expect(o.detail).toContain(`Name: ${NEW_PROJECT}`);
  expect(o.detail).toContain(`Folder: ${run.target}`);
  expect(o.buttons).toEqual(["Cancel", "Create project"]);
  expect(o.defaultId).toBe(CONSENT_CANCEL_BUTTON);
  expect(o.cancelId).toBe(CONSENT_CANCEL_BUTTON);
  if (request === null) expect(o.detail).not.toContain("A new thread will then start");
  else expect(o.detail).toContain(request);
}

/** Records when main's switch to another project reaches the page: the header's render follows it. */
async function watchSwitch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rwSwitchedAt?: number; rwDesktop: { lecturn: { onMessage(cb: (m: { type?: string }) => void): () => void } } };
    w.rwDesktop.lecturn.onMessage((m) => {
      if (m.type === "open-project" && w.__rwSwitchedAt === undefined) w.__rwSwitchedAt = Date.now();
    });
  });
}

const switchedAt = (page: Page): Promise<number | undefined> => page.evaluate(() => (window as unknown as { __rwSwitchedAt?: number }).__rwSwitchedAt);

/** Starts a calling turn in `mode`; returns its thread once the consent dialog is up and has been checked. */
async function callingTurn(run: ProjectRun, mode: RuntimeMode, answer: number, request: string | null): Promise<string> {
  await run.dialogs.enqueueHeld("showMessageBox", HOLD, { response: answer });
  const admin = await run.admin();
  const sent = await sendTurn(run.app, run.page, {
    prompt: fixture.prompt,
    title: "Calling thread",
    wait: false,
    beforeSend: async (threadId) => {
      await admin.setRuntimeMode(threadId, mode);
      const guest = await embedGuest(run.app);
      const label = RUNTIME_MODE_LABEL[mode];
      await until(`the composer to show ${label}`, 30_000, async () => ((await guest.evaluate(readRuntimeMode, null)) === label ? true : undefined), () => guest.evaluate(readRuntimeMode, null));
    },
  });
  const calls = await run.dialogs.waitForCalls("showMessageBox", 1, DIALOG_MS);
  expect(calls).toHaveLength(1);
  assertDialog(calls[0], run, request);
  // The dialog is on screen and unanswered: nothing has happened yet.
  expect(existsSync(run.target), "nothing is created before the accept").toBe(false);
  expect((await liveThreads(run)).map((t) => t.id), "no new thread before the accept").toEqual([sent.threadId]);
  await expect(header(run.page)).toHaveText(CALLER_PROJECT);
  return sent.threadId;
}

/** No Lecturn approval card: the native dialog is the only consent, in every mode. */
function assertNoLecturnApproval(p: AdminProjection): void {
  expect(p.runtimeRequests.filter((r) => r.connectedAppTool?.toolName?.includes("project_new"))).toEqual([]);
}

const MODES: { mode: RuntimeMode; name: string }[] = [
  { mode: "approval-required", name: "Supervised" },
  { mode: "full-access", name: "Full access" },
];

for (const { mode, name } of MODES) {
  test.describe(`B2-a project_new in ${name}`, () => {
    let run: ProjectRun | undefined;

    test.afterEach(async () => {
      await run?.finish();
      run = undefined;
    });

    test(`accept with a request: opens the project and starts a thread (${name})`, async () => {
      test.setTimeout(300_000);
      run = new ProjectRun({ "1": fixture.scripts[WITH_REQUEST]! });
      await run.launch();
      const request = requestOf(WITH_REQUEST);
      const calling = await callingTurn(run, mode, CONSENT_ACCEPT_BUTTON, request);
      await watchSwitch(run.page);
      await run.dialogs.release(HOLD);

      await expect(header(run.page)).toHaveText(NEW_PROJECT, { timeout: 60_000 });
      expect(existsSync(join(run.target, "rocketwright.toml")), "the project is on disk").toBe(true);

      const caller = await settledTranscript(run, calling);
      const calls = projectNewCalls(caller);
      expect(calls, "exactly one project_new in the calling thread").toHaveLength(1);
      const result = calls[0]!;
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain(NEW_PROJECT);
      const structured = result.structured as { project: { name: string; dir: string }; threadId: string };
      expect(structured.project.name).toBe(NEW_PROJECT);
      expect(structured.threadId).toEqual(expect.any(String));
      expect(caller.runs.at(-1)!.status).toBe("completed");
      expect(caller.messages.some((m) => m.role === "assistant" && m.text.includes("Calling turn finished."))).toBe(true);
      assertNoLecturnApproval(caller);

      // The calling turn's result arrived after the pane had switched.
      const at = await switchedAt(run.page);
      expect(at, "main told the page to switch").toBeDefined();
      expect(result.completedAt, "the call has a completion time").not.toBeNull();
      expect(Date.parse(result.completedAt!), "the result arrived after the switch").toBeGreaterThanOrEqual(at!);

      // The new thread: the server's line, then the request verbatim, and the inner script ran there.
      const threadId = structured.threadId;
      const fresh = await settledTranscript(run, threadId);
      expect(firstUserText(fresh)).toBe(`${JUST_CREATED}\n\n${request}`);
      expect(fresh.runs.at(-1)!.status).toBe("completed");
      expect(projectNewCalls(fresh), "the new thread never calls project_new").toEqual([]);
      const tools = fresh.turnItems.filter((i) => i.type === "dynamic_tool").map((i) => bareTool(i.toolName));
      expect(tools).toEqual(["model_get"]);
      expect(fresh.messages.some((m) => m.role === "assistant" && m.text.includes("Inner turn read the new project."))).toBe(true);
      expect(settings(fresh)).toEqual(settings(caller));
      expect(settings(fresh).runtimeMode).toBe(mode);

      // The pane is on the new thread, and the caller stayed in its own project.
      const guest = await embedGuest(run.app);
      await until("the pane to show the new thread", 60_000, async () => ((await guest.evaluate(readGuestView, null)).threadId === threadId ? true : undefined), () => guest.evaluate(readGuestView, null));
      const threads = await liveThreads(run);
      expect(threads.map((t) => t.id).sort()).toEqual([calling, threadId].sort());
      expect(threads.find((t) => t.id === calling)!.projectId).not.toBe(threads.find((t) => t.id === threadId)!.projectId);
      await run.dialogs.sync();
      expect(run.dialogs.calls("showMessageBox"), "one dialog for the one call").toHaveLength(1);
    });

    test(`cancel: nothing changes and the calling turn hears it (${name})`, async () => {
      test.setTimeout(300_000);
      run = new ProjectRun({ "1": fixture.scripts[WITH_REQUEST]! });
      await run.launch();
      const calling = await callingTurn(run, mode, CONSENT_CANCEL_BUTTON, requestOf(WITH_REQUEST));
      await run.dialogs.release(HOLD);

      const caller = await settledTranscript(run, calling);
      const calls = projectNewCalls(caller);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.isError).toBe(true);
      expect(calls[0]!.text).toContain("cancelled");
      expect(calls[0]!.text).toContain("Nothing was created");
      assertNoLecturnApproval(caller);

      expect(existsSync(run.target), "Cancel creates nothing").toBe(false);
      expect((await liveThreads(run)).map((t) => t.id), "Cancel starts no thread").toEqual([calling]);
      await expect(header(run.page)).toHaveText(CALLER_PROJECT);
      await run.dialogs.sync();
      expect(run.dialogs.calls("showMessageBox")).toHaveLength(1);
    });

    test(`no request: an empty thread and no turn (${name})`, async () => {
      test.setTimeout(300_000);
      run = new ProjectRun({ "1": fixture.scripts[BARE]! });
      await run.launch();
      const calling = await callingTurn(run, mode, CONSENT_ACCEPT_BUTTON, null);
      await run.dialogs.release(HOLD);

      await expect(header(run.page)).toHaveText(NEW_PROJECT, { timeout: 60_000 });
      const caller = await settledTranscript(run, calling);
      const calls = projectNewCalls(caller);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.isError, calls[0]!.text).toBe(false);
      const threadId = (calls[0]!.structured as { threadId: string }).threadId;
      expect(threadId).toEqual(expect.any(String));
      const fresh = await (await run.admin()).transcript(threadId);
      expect(fresh.runs, "no turn runs on an empty thread").toEqual([]);
      expect(fresh.messages).toEqual([]);
      expect(settings(fresh).runtimeMode).toBe(mode);
      const guest = await embedGuest(run.app);
      await until("the pane to show the empty thread", 60_000, async () => ((await guest.evaluate(readGuestView, null)).threadId === threadId ? true : undefined), () => guest.evaluate(readGuestView, null));
    });
  });
}

test.describe("B2-a a deleted project folder", () => {
  let run: ProjectRun | undefined;

  test.afterEach(async () => {
    await run?.finish();
    run = undefined;
  });

  test("the app survives a Lecturn ledger naming a deleted folder", async () => {
    test.setTimeout(300_000);
    run = new ProjectRun({ "1": fixture.scripts[BARE]! });
    await run.launch();
    const calling = await callingTurn(run, "full-access", CONSENT_ACCEPT_BUTTON, null);
    await run.dialogs.release(HOLD);
    await expect(header(run.page)).toHaveText(NEW_PROJECT, { timeout: 60_000 });
    await settledTranscript(run, calling);
    await run.quit();

    // The folder goes; Lecturn's ledger (kept with its dirs) still names it.
    rmSync(run.target, { recursive: true, force: true });
    await run.launch();
    await run.dialogs.enqueue("showMessageBox", { response: CONSENT_ACCEPT_BUTTON });
    const guest = await embedGuest(run.app);
    await until("the caller's thread back in the pane", 90_000, async () => ((await guest.evaluate(readGuestView, null)).composer ? true : undefined), () => guest.evaluate(readGuestView, null));

    // A new thread in the caller's project asks for the same name again: the folder is gone, so it is created anew.
    const again = await newThread(run.app, run.page, { title: "After deletion" });
    await draftAndSend(run.app, run.page, fixture.prompt);
    await expect(header(run.page)).toHaveText(NEW_PROJECT, { timeout: 90_000 });
    expect(existsSync(join(run.target, "rocketwright.toml")), "the project is back on disk").toBe(true);
    expect(await run.dialogs.waitForCalls("showMessageBox", 2, DIALOG_MS)).toHaveLength(2);
    const result = projectNewCalls(await settledTranscript(run, again));
    expect(result).toHaveLength(1);
    expect(result[0]!.isError, result[0]!.text).toBe(false);
  });
});

test.describe("B2-a a person's own first thread", () => {
  let run: ProjectRun | undefined;

  test.afterEach(async () => {
    await run?.finish();
    run = undefined;
  });

  test("a project with no threads can start one from the New thread button", async () => {
    test.setTimeout(180_000);
    run = new ProjectRun({ "1": [{ assistantText: "Hello from the first thread." }] });
    await run.launch();
    const guest = await embedGuest(run.app);
    // Before any click: the pane says there are no threads, and that is all it offers.
    await until("the embed's empty project", 120_000, async () => ((await guest.evaluate(readGuestView, null)).empty ? true : undefined), () => guest.evaluate(readGuestView, null));
    const view = await guest.evaluate(readGuestView, null);
    expect(view.empty).toBe(true);
    // Lecturn's guest drops a host command that lands before its handshake settles, with no error
    // and nothing on screen (a click in the first seconds after the pane appears); a later click works.
    await until(
      "a thread from the New thread button",
      40_000,
      async () => {
        if ((await guest.evaluate(readGuestView, null)).composer) return true;
        await run!.page.getByRole("button", { name: "New thread" }).click();
        await run!.page.waitForTimeout(4_000);
        return undefined;
      },
      () => guest.evaluate(readGuestView, null),
    );
    await until("the composer in the new thread", 60_000, async () => ((await guest.evaluate(readGuestView, null)).composer ? true : undefined), () => guest.evaluate(readGuestView, null));
    await draftAndSend(run.app, run.page, "Say hello.");
    await until("the first reply", 60_000, async () => ((await guest.evaluate(readGuestView, null)).text.includes("Hello from the first thread.") ? true : undefined), () => guest.evaluate(readGuestView, null));
  });
});
