/**
 * B2-b's live trial (U41, D24, D28): the real Electron app on a temp caller
 * project, a real provider in Lecturn's sidecar, the native dialog stubbed
 * with one answer. The prompt goes through the pane as a person's would, in
 * Supervised: the provider's shell and file requests are declined and logged,
 * and any app approval is declined, since no path needs one.
 *
 * Tool results are read through `LecturnAdminSession.transcript`, which
 * fetches each settled tool's full output (`getTurnItem`): the projection
 * alone stubs them (U06), and a result naming the thread could not be read.
 *
 * Loaded only by a live run of `scripts/bar/agent-project-live.ts`. Kills only
 * processes it saw descend from its own Electron.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { LecturnAdminSession, RUNTIME_MODE_LABEL, declineProviderApprovals, pendingAppApprovals, type AdminProjection, type ModelSelection, type ProviderRequestEntry } from "../../scripts/bar/lecturn-admin.ts";
import { CALLER_PROJECT, NEW_PROJECT, PROMPTS, isolationProblems, projectNewCalls, snapshotTree, type EvaluatedModel, type LivePath, type ThreadRecord, type TrialRecord } from "../../scripts/bar/agent-project-live.ts";
import { CONSENT_ACCEPT_BUTTON, CONSENT_CANCEL_BUTTON } from "../apps/desktop/src/nativeDialogs.ts";
import type { FileChange } from "../packages/contracts/src/generated/types.ts";
import { REPO_ROOT } from "./bar/paths.ts";
import { DialogQueues } from "./electron-dialogs.ts";
import { embedGuest, readRuntimeMode, sendTurn, until } from "./embed.ts";
import { lecturnEnv } from "./lecturn-env.ts";
import { SCRATCH } from "./live.ts";
import { currentProcs, killStarted, processTreeOf, stillRunning } from "./orphans.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const POLL_MS = 1000;
/** Nothing new for this long once every turn has ended: a new thread's first run can start just after the call returns. */
const QUIET_MS = 4000;
const EXIT_GRACE_MS = 15_000;

export interface LiveTrialOptions {
  path: LivePath;
  trial: number;
  bin: string;
  /** `liveAppEnv`: the parent session's variables already gone. */
  env: Record<string, string>;
  model: ModelSelection;
  timeoutMs: number;
  keep: boolean;
  log: (line: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const runsDone = (p: AdminProjection): boolean => p.runs.every((r) => SETTLED.has(r.status));

function recordThread(id: string, projectId: string, p: AdminProjection): ThreadRecord {
  return {
    id,
    projectId,
    runs: p.runs.map((r) => ({ id: r.id, status: r.status })),
    messages: p.messages.map((m) => ({ id: m.id, runId: m.runId, role: m.role, text: m.text })),
    turnItems: p.turnItems.map((i) => ({
      id: i.id,
      runId: i.runId,
      type: i.type,
      status: i.status,
      ...(i.ordinal === undefined ? {} : { ordinal: i.ordinal }),
      ...(i.toolName === undefined ? {} : { toolName: i.toolName }),
      ...(i.text === undefined ? {} : { text: i.text }),
      ...(i.input === undefined ? {} : { input: i.input }),
      ...(i.output === undefined ? {} : { output: i.output }),
    })),
  };
}

/** `rw eval --json`'s model; the closing app's sidecar may hold the project for a moment. */
async function evaluated(bin: string, dir: string): Promise<EvaluatedModel> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = JSON.parse(execFileSync(bin, ["eval", "--json", "-C", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { model: EvaluatedModel };
      return out.model;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(2000);
    }
  }
}

/** D24's reference: the same `rw init` the server runs (`ProjectCreator.createAt`), somewhere else. */
async function controlProject(bin: string, base: string, template: string | null): Promise<NonNullable<TrialRecord["control"]>> {
  const dir = join(base, "control", NEW_PROJECT);
  mkdirSync(join(base, "control"));
  const args = ["init", dir, `--name=${NEW_PROJECT}`, ...(template === null ? [] : [`--template=${template}`]), "--json"];
  const out = JSON.parse(execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { files: FileChange[] };
  return { template, files: out.files, tree: snapshotTree(dir)!, model: await evaluated(bin, dir) };
}

class Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  private readonly started = new Map<number, string>();

  constructor(app: ElectronApplication, page: Page) {
    this.app = app;
    this.page = page;
    this.remember();
  }

  /** Every process seen descending from this Electron: the only ones this run may kill. */
  remember(): void {
    const pid = this.app.process().pid;
    if (pid !== undefined) for (const p of processTreeOf(pid)) this.started.set(p.pid, p.command);
  }

  async quit(log: (line: string) => void): Promise<void> {
    this.remember();
    await this.app.close().catch(() => undefined);
    const deadline = Date.now() + EXIT_GRACE_MS;
    while (stillRunning(this.started, currentProcs()).length > 0 && Date.now() < deadline) await sleep(100);
    const killed = killStarted(this.started);
    if (killed.length > 0) log(`killed ${killed.length} process(es) this trial started that outlived quit`);
  }
}

/** Plays the person until every turn has ended; false on timeout (the running turns are then interrupted). */
async function settle(o: { admin: LecturnAdminSession; launched: Launched; callerId: string; record: TrialRecord; timeoutMs: number; log: (line: string) => void }): Promise<boolean> {
  const { admin, callerId, record } = o;
  const answered = new Set<string>();
  const declines: ProviderRequestEntry[] = record.provider_requests as ProviderRequestEntry[];
  const approvals = record.app_approvals as { threadId: string; requestId: string; tool: string }[];
  const t0 = Date.now();
  const end = t0 + o.timeoutMs;
  let quietSince: number | null = null;
  let lastActivity = "";
  for (;;) {
    // One failed read while the app switches projects is not a failed trial; the deadline still ends it.
    try {
      o.launched.remember();
      const shell = await admin.shell();
      const ids = shell.threads.filter((t) => (t.deletedAt ?? null) === null).map((t) => t.id);
      const views = await Promise.all(ids.map(async (id) => ({ id, p: await admin.transcript(id) })));
      for (const { id, p } of views) {
        await declineProviderApprovals({ admin, threadId: id, projection: p, answered, into: declines, t0, log: o.log });
        for (const r of pendingAppApprovals(p, answered)) {
          answered.add(r.id);
          await admin.respond(id, r.id, "decline");
          approvals.push({ threadId: id, requestId: r.id, tool: r.connectedAppTool?.toolName ?? "?" });
          o.log(`app approval ${r.connectedAppTool?.toolName ?? "?"}: decline`);
        }
      }
      const caller = views.find((v) => v.id === callerId)?.p;
      const others = views.filter((v) => v.id !== callerId).map((v) => v.p);
      // A call that carried a request must have started the new thread's turn before this can end.
      const calls = caller === undefined ? [] : projectNewCalls({ caller_thread: callerId, threads: { [callerId]: recordThread(callerId, "", caller) } });
      const awaitingTurn = calls.some((c) => !c.isError && typeof c.args["request"] === "string" && c.args["request"].trim() !== "") && others.every((p) => p.runs.length === 0);
      const done = caller !== undefined && caller.runs.length > 0 && runsDone(caller) && others.every(runsDone) && !awaitingTurn;
      const activity = JSON.stringify(views.map((v) => [v.id, v.p.runs.map((r) => r.status), v.p.turnItems.length]));
      if (!done || activity !== lastActivity) quietSince = null;
      lastActivity = activity;
      if (done) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= QUIET_MS) return true;
      }
      if (Date.now() > end) {
        for (const { id, p } of views) {
          for (const r of p.runs) if (!SETTLED.has(r.status)) await admin.dispatch({ type: "run.interrupt", threadId: id, runId: r.id, reason: "B2 live timeout" }).catch(() => undefined);
        }
        return false;
      }
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    await sleep(POLL_MS);
  }
}

/** One trial, recorded; a failure of the app or provider lands in `infra`, never as an exception. */
export async function runLiveTrial(o: LiveTrialOptions): Promise<TrialRecord> {
  const base = mkdtempSync(join(SCRATCH, "rw-b2l-"));
  const documents = join(base, "docs");
  const callerDir = join(base, CALLER_PROJECT);
  const target = join(documents, "RocketWright", NEW_PROJECT);
  const record: TrialRecord = {
    path: o.path,
    trial: o.trial,
    prompt: PROMPTS[o.path],
    timed_out: false,
    documents,
    target,
    caller_thread: null,
    threads: {},
    shell: { threads: [], projects: [] },
    dialogs: [],
    caller_tree: { before: {}, after: {} },
    target_tree: null,
    target_model: null,
    control: null,
    provider_requests: [],
    app_approvals: [],
  };
  // `defaultModel` always makes a fresh pair: a home and base dir no other run has seen, never ~/.lecturn.
  const lecturn = lecturnEnv(o.env, "rw-b2l-lecturn-", { defaultModel: o.model });
  const env: Record<string, string> = { ...o.env, ...lecturn.env, RW_DOCUMENTS_DIR: documents };
  let launched: Launched | null = null;
  try {
    const problems = isolationProblems(env);
    if (problems.length > 0) throw new Error(`refusing to launch: ${problems.join("; ")}`);
    mkdirSync(documents);
    execFileSync(o.bin, ["init", callerDir], { stdio: ["ignore", "ignore", "pipe"] });
    record.caller_tree.before = snapshotTree(callerDir)!;

    const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
    const app = await electron.launch({ executablePath, args: [join(DESKTOP, "src/main.ts"), "--project", callerDir, "-ApplePersistenceIgnoreState", "YES"], env, timeout: 120_000 });
    const page = await app.firstWindow({ timeout: 120_000 });
    launched = new Launched(app, page);
    const dialogs = new DialogQueues();
    await dialogs.install(app);
    // One answer: a second dialog finds an empty queue, fails the call, and is logged.
    await dialogs.enqueue("showMessageBox", { response: o.path === "cancel" ? CONSENT_CANCEL_BUTTON : CONSENT_ACCEPT_BUTTON });
    await page.locator('[data-rw-region="workspace"]').waitFor({ state: "visible", timeout: 120_000 });
    await page.locator('[data-testid="agent.embed"]').first().waitFor({ state: "visible", timeout: 120_000 });
    launched.remember();

    const baseDir = env["RW_LECTURN_BASE_DIR"]!;
    const admin = await until("the Lecturn sidecar", 120_000, () => LecturnAdminSession.open(baseDir, env));
    const sent = await sendTurn(app, page, {
      prompt: PROMPTS[o.path],
      title: `B2 live ${o.path} ${o.trial}`,
      wait: false,
      log: o.log,
      beforeSend: async (threadId) => {
        await admin.setRuntimeMode(threadId, "approval-required");
        const guest = await embedGuest(app);
        const label = RUNTIME_MODE_LABEL["approval-required"];
        await until(`the composer to show ${label}`, 30_000, async () => ((await guest.evaluate(readRuntimeMode, null)) === label ? true : undefined));
      },
    });
    record.caller_thread = sent.threadId;
    const settled = await settle({ admin, launched, callerId: sent.threadId, record, timeoutMs: o.timeoutMs, log: o.log });
    record.timed_out = !settled;

    const shell = await admin.shell();
    const live = shell.threads.filter((t) => (t.deletedAt ?? null) === null);
    record.shell = { threads: live.map((t) => ({ id: t.id, projectId: t.projectId })), projects: shell.projects.map((p) => ({ id: p.id, workspaceRoot: p.appBinding?.workspaceRoot ?? null })) };
    for (const t of live) record.threads[t.id] = recordThread(t.id, t.projectId, await admin.transcript(t.id));
    await dialogs.sync();
    record.dialogs = dialogs.calls("showMessageBox").map((c) => {
      const box = c.options as { message?: string; detail?: string };
      return { message: box.message ?? "", detail: box.detail ?? "", response: (c.answer as { response?: number } | null)?.response ?? null };
    });

    await launched.quit(o.log);
    launched = null;
    // After quit, with nothing left to write. `rw eval` records a snapshot under `.rw/` only, but the trees come first anyway.
    record.caller_tree.after = snapshotTree(callerDir) ?? {};
    record.target_tree = snapshotTree(target);
    if (record.target_tree !== null) {
      record.target_model = await evaluated(o.bin, target);
      const call = projectNewCalls(record)[0];
      const template = typeof call?.args["template"] === "string" ? call.args["template"] : null;
      try {
        record.control = await controlProject(o.bin, base, template);
      } catch (e) {
        record.control_error = e instanceof Error ? e.message : String(e);
      }
    }
  } catch (e) {
    record.infra = e instanceof Error ? e.message : String(e);
  } finally {
    await launched?.quit(o.log).catch(() => undefined);
    lecturn.cleanup();
    if (!o.keep) rmSync(base, { recursive: true, force: true });
  }
  return record;
}
