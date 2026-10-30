/**
 * W-B2.4 (plan B16; decisions 7, 13, 16, 19; D21, D25): RocketWright
 * against the user's own Lecturn server, from the real Electron app.
 * `node scripts/bar/live-smoke.ts --attach` (`make bar-live ATTACH=1`); no
 * network and no provider CLI: every turn is Lecturn's scripted provider
 * (`LECTURN_TEST_PROVIDERS=1` on the Lecturn sidecar and the user server for
 * this run, the script in a ```scripted block of the message), so the
 * mid-turn copy is never racy.
 *
 * The project is a temp copy of `fixtures/research-vehicle`; the Lecturn
 * pair is one temp `LECTURN_HOME` (the user server's base dir, which the
 * helper watches) plus one `RW_LECTURN_BASE_DIR` (the sidecar's), kept
 * across the app's restarts. The harness acts as the user's Lecturn client
 * over admin sessions (`scripts/bar/lecturn-admin.ts`, D16) and reads the
 * app's own view from its IF10 pushes (`lecturn.status`, `embed.threads`),
 * its rail and its pane.
 *
 * 1. live-switch: on the sidecar, a thread flies the baseline. The user
 *    server starts while RocketWright runs; the harness grants the pairing.
 *    The pane is the same `WebContentsView` (webContents id), now at the
 *    mapped copy on the user server with its run card; the rail keeps its
 *    selection (`<root>#<sidecar thread>`, the copy's
 *    `copiedFrom.sourceThreadId`); `rw_viewport_*` live tools run in a
 *    user-server thread.
 * 2. closed (spec W-B2 step 4, CPW2A): the copy is listed under Apps >
 *    RocketWright in a Lecturn client (the admin session's shell snapshot,
 *    and the user's web client on the user server, `lecturn-web.ts`).
 *    RocketWright closes; from the Lecturn client the copy gets "lengthen
 *    the body by 20 mm and re-run the sim" (scripted): the headless `rw_*`
 *    tools patch, check and fly; `rw_viewport_set_camera` answers the
 *    closed error; the web client shows the closed banner. RocketWright
 *    reopens on the user server: the body length (model and Inspector
 *    source: `model.get`) and the new run (its Results row) are there.
 * 3. fallback: the user server stops and RocketWright restarts. The copied
 *    thread opens from its rail entry, read-only in the pane with
 *    "Continued in Lecturn" and its "Open in Lecturn" link to the copy;
 *    the shot waits for the timeline and its card frames (CPW2A).
 * 4. recopy: a sidecar thread's turn flies the baseline, then holds until a
 *    release file exists (decision 19). The user server starts while it
 *    holds: the turn holds the switch (Lecturn pin22), so the app stays on
 *    the sidecar. The file is written, the turn completes on the sidecar,
 *    and the switch copies it, completed; the other copies are unchanged.
 *    After a subtitle write alone (it moves `updatedAt`, not
 *    `historyRevision`), the next attach re-copies nothing.
 */
import type { Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerApprovals,
  appThreads,
  continuedLink,
  copiesOf,
  copiesUnchanged,
  grantPairing,
  LecturnAdminSession,
  modeAfter,
  switchAfter,
  onlyCopy,
  railKeyOf,
  RW_APP_ID,
  scriptedMessage,
  threadsAfter,
  UserServer,
  type AdminProjection,
  type AppStatusLike,
  type ApprovalLogEntry,
  type StatusLike,
} from "../../scripts/bar/lecturn-admin.ts";
import { FOLLOW_UP_FIXTURE, FOLLOW_UP_PROJECT_NAME, transcriptOf, type ToolCallRecord } from "../../scripts/bar/live-smoke.ts";
import type { EmbedThread } from "../packages/contracts/src/rpc.ts";
import { stableStringify } from "./bar/paths.ts";
import { SCRIPTED_MODEL } from "./capture/scripted.ts";
import { launchEmbedApp, type EmbedSession } from "./b4b-live.ts";
import { countCardIframes, failedCardDocs, readFrameDoc, timelineRevealed } from "./capture/embed.ts";
import { captureGuest, embedGuest, guestContents, newThread, readContinued, scrollTimeline, until } from "./embed.ts";
import { lecturnEnv } from "./lecturn-env.ts";
import { bareTool, promptTurnOf, toolValue } from "./lecturn-transcript.ts";
import { LecturnWebClient } from "./lecturn-web.ts";

const SWITCH_TIMEOUT_MS = 90_000;
const FALLBACK_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 180_000;
const UI_TIMEOUT_MS = 30_000;
// How long check 4 watches the app stay on the sidecar while its turn holds: three or more of connect()'s beats (5 s or less).
const HOLD_MS = 15_000;

// `force`: the held turn flies the baseline the live switch already flew, and a cached answer carries no job to poll.
const FLY = [
  { toolCall: { name: "rw_simulate", arguments: { sim: "baseline", force: true } }, saveAs: "sim" },
  {
    poll: {
      toolCall: { name: "rw_job_status", arguments: { job_id: "${sim.result.structuredContent.job_id}" } },
      until: { path: "result.structuredContent.state", equals: "complete" },
      maxTries: 300,
      intervalMs: 200,
    },
  },
];
export const SWITCH_REPLY = "Baseline flown on the sidecar.";
export const VIEWPORT_REPLY = "Moved the viewport from the user server.";
export const HELD_REPLY = "The held turn finished on the sidecar.";
export const SUBTITLE = "Held turn released";

/** The spec's W-B2 step 4 message, sent from a Lecturn client while RocketWright is closed. */
export const CLOSED_PROMPT = "lengthen the body by 20 mm and re-run the sim";
export const CLOSED_REPLY = "Lengthened the body by 20 mm and re-ran Baseline while RocketWright was closed.";
/** The research vehicle's body tube (`fixtures/research-vehicle/rocket.rw.toml` `[c.airframe]`). */
export const BODY_ID = "airframe";
export const BODY_DELTA_MM = 20;
/** Lecturn's closed-app tool error (`AppToolkit`: "<app> is closed; open it to use <tool>."). */
export const CLOSED_ERROR = /\bis closed\b/i;

/** The `[c.<id>]` table's `length = "<n> mm"` in a rocket file's text, in mm; null without one. */
export function componentLengthMm(toml: string, id: string): number | null {
  const head = toml.indexOf(`[c.${id}]`);
  if (head < 0) return null;
  const rest = toml.slice(head + id.length + 4);
  const next = rest.search(/^\[/m);
  const table = next < 0 ? rest : rest.slice(0, next);
  const m = /^length\s*=\s*"([\d.]+)\s*mm"/m.exec(table);
  return m === null ? null : Number(m[1]);
}

/** A component's length (m) in an evaluated model (`model.get`): its shape's `length`, else its station span. */
export function evaluatedLength(model: unknown, id: string): number | null {
  const comps = (model as { components?: unknown } | null)?.components;
  if (!Array.isArray(comps)) return null;
  const c = comps.find((x) => (x as { id?: unknown }).id === id) as { shape?: { length?: unknown }; x_fore?: unknown; x_aft?: unknown } | undefined;
  if (c === undefined) return null;
  if (typeof c.shape?.length === "number") return c.shape.length;
  return typeof c.x_fore === "number" && typeof c.x_aft === "number" ? c.x_aft - c.x_fore : null;
}

/** The scripted turn for `CLOSED_PROMPT`: patch the body, check, fly Baseline, then a live tool (closed). */
export function closedSteps(lengthMm: number): unknown[] {
  return [
    { toolCall: { name: "rw_model_patch", arguments: { ops: [{ op: "replace", path: `/c/${BODY_ID}/length`, value: `${lengthMm} mm` }], label: `Body ${lengthMm} mm` } } },
    { toolCall: { name: "rw_design_check", arguments: {} } },
    ...FLY,
    { toolCall: { name: "rw_viewport_set_camera", arguments: { view: "iso" } } },
    { assistantText: CLOSED_REPLY },
  ];
}

/**
 * What the closed turn's calls show (pure): the headless tools ran (patch,
 * check, simulate, a complete job), and every `viewport_*` call answered
 * the closed error. Returns the reasons and the new run's id.
 */
export function judgeClosedTurn(calls: readonly Pick<ToolCallRecord, "tool" | "isError" | "output">[]): { reasons: string[]; runId: string | null; sim: string | null } {
  const reasons: string[] = [];
  for (const tool of ["model_patch", "design_check", "simulate"]) {
    const c = calls.find((x) => x.tool === tool);
    if (c === undefined) reasons.push(`rw_${tool} did not run`);
    else if (c.isError !== false) reasons.push(`rw_${tool} failed with RocketWright closed: ${JSON.stringify(c.output).slice(0, 200)}`);
  }
  const job = calls.filter((x) => x.tool === "job_status").at(-1);
  const out = (job?.output ?? null) as { state?: unknown; run_id?: unknown; sim?: unknown } | null;
  if (job === undefined || job.isError !== false || out?.state !== "complete") reasons.push(`the run did not complete headless (${JSON.stringify(job?.output ?? null).slice(0, 200)})`);
  const live = calls.filter((x) => x.tool.startsWith("viewport_"));
  if (live.length === 0) reasons.push("no rw_viewport_* call was made");
  for (const c of live) {
    if (c.isError !== true || !CLOSED_ERROR.test(JSON.stringify(c.output))) reasons.push(`rw_${c.tool} did not answer the closed error: ${JSON.stringify(c.output).slice(0, 200)}`);
  }
  return { reasons, runId: typeof out?.run_id === "string" ? out.run_id : null, sim: typeof out?.sim === "string" ? out.sim : null };
}

export interface AttachCheck {
  name: "live-switch" | "closed" | "fallback" | "recopy";
  status: "pass" | "red" | "not-run";
  reasons: string[];
  facts: Record<string, unknown>;
}

export interface AttachResult {
  status: "pass" | "red";
  reasons: string[];
  project: string;
  checks: AttachCheck[];
  artifacts: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOf = (url: string): string => {
  try {
    return new URL(url).port;
  } catch {
    return "";
  }
};
const pathOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return "";
  }
};
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const readPid = (baseDir: string): number | null => {
  try {
    const v = JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8")) as { pid?: unknown };
    return typeof v.pid === "number" ? v.pid : null;
  } catch {
    return null;
  }
};

/** The app's view of one Lecturn attachment, from its IF10 pushes. */
class AppView {
  // A plain field, not a parameter property: Node runs this file with type stripping only.
  private readonly s: EmbedSession;

  constructor(s: EmbedSession) {
    this.s = s;
  }

  get pushes(): EmbedSession["appRpc"]["pushes"] {
    return this.s.appRpc.pushes;
  }

  get mark(): number {
    return this.pushes.length;
  }

  mode(from: number, mode: "sidecar" | "user-server", timeoutMs: number): Promise<{ index: number; status: StatusLike }> {
    return until(`RocketWright to report Lecturn ${mode}`, timeoutMs, async () => modeAfter(this.s.appRpc.pushes, from, mode) ?? undefined);
  }

  /** The live switch's announcement after `from` (`switchAfter`). */
  switched(from: number, timeoutMs: number): Promise<{ index: number; status: StatusLike }> {
    return until("RocketWright to announce the live switch to the user server", timeoutMs, async () => switchAfter(this.s.appRpc.pushes, from) ?? undefined, async () =>
      this.s.appRpc.pushes.slice(from).filter((p) => p.topic === "lecturn.status").map((p) => p.payload),
    );
  }

  /** The project's threads on the current server, once `pred` holds for the latest list after `from`. */
  threads(from: number, what: string, pred: (threads: EmbedThread[]) => boolean, timeoutMs = UI_TIMEOUT_MS): Promise<EmbedThread[]> {
    return until(`the app's thread list: ${what}`, timeoutMs, async () => {
      const l = threadsAfter(this.s.appRpc.pushes, from, this.s.projectId);
      return l !== null && pred(l.threads) ? l.threads : undefined;
    }, async () => {
      // What the app last listed (after `from`, else at all): the ids and their copiedFrom.
      const l = threadsAfter(this.s.appRpc.pushes, from, this.s.projectId) ?? threadsAfter(this.s.appRpc.pushes, 0, this.s.projectId);
      return { from, pushes: this.s.appRpc.pushes.length, at: l?.index ?? null, threads: l?.threads.map((t) => ({ threadId: t.threadId, copiedFrom: t.copiedFrom ?? null })) ?? null };
    });
  }

  /** Writes a thread's idle-row subtitle the way B12 does (`embed.setThreadAppData`). */
  async subtitle(t: EmbedThread, subtitle: string): Promise<void> {
    await this.s.appRpc.call("embed.setThreadAppData", { projectId: this.s.projectId, threadId: t.threadId, appData: t.appData, subtitle });
  }
}

/** The rail entry the window shows as selected (`data-thread-id`: the rail key), or null. */
async function railSelection(page: Page): Promise<string | null> {
  const sel = page.locator('[data-testid="rail.thread"][aria-selected="true"]');
  return (await sel.count()) === 0 ? null : sel.first().getAttribute("data-thread-id");
}

/** Clicks the rail entry `key` (the user's click) and waits for the rail to select it. */
async function selectRail(page: Page, key: string): Promise<void> {
  await page.locator(`[data-testid="rail.thread"][data-thread-id="${key.replace(/"/g, '\\"')}"]`).first().click({ timeout: UI_TIMEOUT_MS });
  await until(`the rail to select ${key}`, UI_TIMEOUT_MS, async () => ((await railSelection(page)) === key ? true : undefined));
}

/** The pane's guest once it shows `threadId` from the server at `origin` (matched by port). */
function guestAt(s: EmbedSession, origin: string, threadId: string, timeoutMs = SWITCH_TIMEOUT_MS): Promise<{ id: number; url: string }[]> {
  return until(`the pane at ${threadId} on ${origin}`, timeoutMs, async () => {
    const g = await guestContents(s.electron);
    const top = g[0];
    return top !== undefined && portOf(top.url) === portOf(origin) && pathOf(top.url).endsWith(`/${threadId}`) ? g : undefined;
  }, () => guestContents(s.electron));
}

async function replied(admin: LecturnAdminSession, threadId: string, text: string, timeoutMs = TURN_TIMEOUT_MS): Promise<AdminProjection> {
  return until(`the reply "${text}" in ${threadId}`, timeoutMs, async () => {
    const p = await admin.transcript(threadId);
    return p.messages.some((m) => m.role === "assistant" && m.text.includes(text)) ? p : undefined;
  });
}

/** A scripted turn sent as the user (the script travels in the message). */
async function scripted(admin: LecturnAdminSession, threadId: string, lead: string, steps: readonly unknown[]): Promise<string> {
  const text = scriptedMessage(lead, steps);
  await admin.sendMessage(threadId, text, SCRIPTED_MODEL);
  return text;
}

/** Attaches to the started user server: the stored credential needs no prompt; a pairing request, if one comes, is granted and noted. */
async function attachTo(view: AppView, server: UserServer, userHome: string, facts: Record<string, unknown>, log: (line: string) => void): Promise<{ index: number; from: number; status: StatusLike; admin: LecturnAdminSession }> {
  const from = view.mark;
  await server.start();
  return attached(view, from, await LecturnAdminSession.open(userHome), facts, log);
}

/** Waits for the app to report the running user server after `from`, granting a pairing request if one comes. */
async function attached(view: AppView, from: number, admin: LecturnAdminSession, facts: Record<string, unknown>, log: (line: string) => void): Promise<{ index: number; from: number; status: StatusLike; admin: LecturnAdminSession }> {
  const deadline = Date.now() + SWITCH_TIMEOUT_MS;
  for (;;) {
    const m = modeAfter(view.pushes, from, "user-server");
    if (m !== null) return { ...m, from, admin };
    const pending = (await admin.app().catch(() => null))?.pendingRequest?.requestId;
    if (typeof pending === "string") {
      await admin.decidePairing(pending, "grant");
      facts["repaired"] = [...((facts["repaired"] as string[] | undefined) ?? []), pending];
      log(`attach: granted a new pairing request ${pending}`);
    }
    if (Date.now() > deadline) throw new Error(`RocketWright did not attach to the user server within ${SWITCH_TIMEOUT_MS} ms`);
    await sleep(500);
  }
}

/** The timeline's message rows (runs in the guest). */
function countMessages(): number {
  return document.querySelectorAll("[data-message-role]").length;
}

/**
 * CPW2A: waits until the pane has drawn what a shot should show (the CP-W2
 * fallback shots were blank or had empty card frames): the timeline
 * revealed with its messages, every MCP Apps card frame loaded with its
 * card (none an error page; the capture harness's checks), and, when
 * `flight`, a complete flight run card with its chart. Scrolls to the
 * bottom. Returns why not, after `timeoutMs` (empty: rendered).
 */
async function paneRendered(s: EmbedSession, label: string, o: { flight: boolean; timeoutMs?: number }): Promise<string[]> {
  const deadline = Date.now() + (o.timeoutMs ?? UI_TIMEOUT_MS);
  let last: Record<string, unknown> = {};
  for (;;) {
    const g = await embedGuest(s.electron, UI_TIMEOUT_MS);
    const main = { revealed: await g.evaluate(timelineRevealed, null).catch(() => false), messages: await g.evaluate(countMessages, null).catch(() => 0) };
    const frames = await g.evaluate(countCardIframes, null).catch(() => 0);
    const docs = await g.evaluateFrames(readFrameDoc, null).catch(() => []);
    const loaded = docs.filter((d) => d.card).length;
    const failed = failedCardDocs(docs);
    last = { ...main, frames, loaded, failed };
    if (main.revealed && main.messages > 0 && frames > 0 && loaded >= frames && failed.length === 0) {
      const cards = o.flight ? await s.runCards() : [];
      last["runCards"] = cards.map((c) => `${c.kind}:${c.phase}:${c.points}`);
      if (!o.flight || cards.some((c) => c.kind === "flight" && c.phase === "complete" && c.points >= 2)) {
        await g.evaluate(scrollTimeline, 1);
        // The reveal fade and the cards' own first paint.
        await sleep(600);
        if (await g.evaluate(timelineRevealed, null).catch(() => false)) return [];
      }
    }
    if (Date.now() > deadline) return [`${label}: the pane had not rendered before the shot (${JSON.stringify(last)})`];
    await sleep(500);
  }
}

/** Runs the four W-B2.4 checks (see the module comment); never throws for a check's outcome. */
export async function runAttach(o: { env: Record<string, string>; outDir: string; log?: (line: string) => void; keep?: boolean }): Promise<AttachResult> {
  const log = o.log ?? (() => undefined);
  mkdirSync(o.outDir, { recursive: true });
  const artifacts: string[] = [];
  const parent = mkdtempSync("/tmp/rw-attach-");
  const projectDir = join(parent, FOLLOW_UP_PROJECT_NAME);
  cpSync(FOLLOW_UP_FIXTURE, projectDir, { recursive: true });
  const root = realpathSync(projectDir);
  const release = join(parent, "release");
  // One pair for the whole run: the scripted provider on the sidecar, the scripted model as its default.
  const pair = lecturnEnv({}, "rw-attach-lecturn-", { scripted: true, defaultModel: SCRIPTED_MODEL });
  const userHome = pair.env["LECTURN_HOME"]!;
  const sidecarBase = pair.env["RW_LECTURN_BASE_DIR"]!;
  const server = new UserServer(userHome, { testProviders: true, log });
  const checks: AttachCheck[] = (["live-switch", "closed", "fallback", "recopy"] as const).map((name) => ({ name, status: "not-run", reasons: [], facts: {} }));
  const [sw, cl, fb, rc] = checks as [AttachCheck, AttachCheck, AttachCheck, AttachCheck];
  const fail = (c: AttachCheck, why: string): void => {
    c.reasons.push(why);
    log(`${c.name}: ${why}`);
  };
  const shot = async (s: EmbedSession, name: string): Promise<void> => {
    const png = await captureGuest(s.electron).catch(() => null);
    if (png === null) return;
    writeFileSync(join(o.outDir, name), png);
    artifacts.push(name);
  };
  const launch = () => launchEmbedApp({ projectDir, env: o.env, outDir: o.outDir, log, lecturn: pair });
  let s: EmbedSession | null = null;
  let current: AttachCheck = sw;
  try {
    // ---- 1. live switch ----
    s = await launch();
    let view = new AppView(s);
    await view.mode(0, "sidecar", SWITCH_TIMEOUT_MS);
    const sidecar = await LecturnAdminSession.open(sidecarBase);
    const ts = await newThread(s.electron, s.window, { title: "Live switch", log });
    await scripted(sidecar, ts, "Fly the baseline.", [...FLY, { assistantText: SWITCH_REPLY }]);
    await replied(sidecar, ts, SWITCH_REPLY);
    const key = railKeyOf(root, ts);
    await selectRail(s.window, key);
    await guestAt(s, sidecar.origin, ts);
    const before = await guestContents(s.electron);
    sw.facts["sidecarThread"] = ts;
    sw.facts["webContentsBefore"] = before[0]?.id;

    const from = view.mark;
    const user = await server.start();
    const userAdmin = await LecturnAdminSession.open(userHome);
    await grantPairing(userAdmin, { timeoutMs: SWITCH_TIMEOUT_MS, log });
    const switched = await view.switched(from, SWITCH_TIMEOUT_MS);
    const tc = switched.status.switched?.threadIdMap[ts];
    sw.facts["userEnvironmentId"] = user.environmentId;
    sw.facts["copyThread"] = tc;
    if (switched.status.switched?.environmentId !== user.environmentId) fail(sw, `the switch names environment ${String(switched.status.switched?.environmentId)}, not the user server's ${user.environmentId}`);
    if (tc === undefined) throw new Error(`the switch maps no copy of the open thread ${ts}: ${JSON.stringify(switched.status.switched)}`);
    const after = await guestAt(s, user.origin, tc);
    sw.facts["webContentsAfter"] = after[0]?.id;
    if (after[0]?.id !== before[0]?.id) fail(sw, `the pane is a new webContents (${String(before[0]?.id)} -> ${String(after[0]?.id)}), not the same WebContentsView`);
    if (after.length !== 1) fail(sw, `${after.length} embed guests are live after the switch`);
    // The copy's timeline renders after the guest navigates: give its run card a moment.
    const sess = s;
    const cards = await until("the mapped copy's flight run card", UI_TIMEOUT_MS, async () => {
      const c = await sess.runCards();
      return c.some((x) => x.kind === "flight" && x.phase === "complete") ? c : undefined;
    }).catch(() => sess.runCards());
    if (!cards.some((c) => c.kind === "flight" && c.phase === "complete")) fail(sw, `the mapped copy shows no complete flight run card (${JSON.stringify(cards.slice(-3))})`);
    const selected = await railSelection(s.window);
    sw.facts["railSelection"] = selected;
    if (selected !== key) fail(sw, `the rail selection moved: ${String(selected)}, want ${key}`);
    // From the user server's start, not the switch: its thread snapshot can reach the app before the switch is announced.
    const userThreads = await view.threads(from, `the copy ${tc}`, (l) => l.some((t) => t.threadId === tc));
    const copy = userThreads.find((t) => t.threadId === tc)!;
    const sidecarEnv = copy.copiedFrom?.sourceEnvironmentId ?? "";
    if (copy.copiedFrom?.sourceThreadId !== ts) fail(sw, `the copy's copiedFrom.sourceThreadId is ${String(copy.copiedFrom?.sourceThreadId)}, want ${ts}`);
    else if (railKeyOf(copy.workspaceRoot, copy.copiedFrom.sourceThreadId) !== key) fail(sw, `the copy's rail key ${railKeyOf(copy.workspaceRoot, ts)} is not ${key}`);
    for (const why of await paneRendered(s, "the switched pane", { flight: true })) fail(sw, why);
    await shot(s, "attach-switched.png");
    // Live tools against the user server: a user-server thread moves the viewport.
    const tv = await newThread(s.electron, s.window, { title: "Viewport tools", log });
    const vtext = await scripted(userAdmin, tv, "Move the viewport.", [
      { toolCall: { name: "rw_viewport_set_camera", arguments: { explode: 0 } } },
      { toolCall: { name: "rw_viewport_select", arguments: { refs: [] } } },
      { assistantText: VIEWPORT_REPLY },
    ]);
    const vp = await replied(userAdmin, tv, VIEWPORT_REPLY);
    const vturn = promptTurnOf(vp, tv, vtext);
    const vcalls = vturn === null ? [] : transcriptOf(tv, vturn.events, vtext).tool_calls;
    sw.facts["viewportCalls"] = vcalls.map((c) => ({ tool: c.tool, isError: c.isError }));
    for (const tool of ["viewport_set_camera", "viewport_select"]) {
      const c = vcalls.find((x) => x.tool === tool);
      if (c === undefined || c.isError !== false) fail(sw, `rw_${tool} did not run against the user server (${JSON.stringify(c?.output ?? null)})`);
    }
    sw.status = sw.reasons.length === 0 ? "pass" : "red";

    // ---- 2. closed: listed under Apps > RocketWright, a turn from a Lecturn client with RocketWright closed, reopen ----
    current = cl;
    const listing = appThreads(await userAdmin.shell(), RW_APP_ID, root);
    const copyTitle = listing?.threads.find((t) => t.id === tc)?.title ?? null;
    cl.facts["appsListing"] = listing === null ? null : { project: listing.projectTitle, threads: listing.threads.map((t) => t.title) };
    if (copyTitle === null) fail(cl, `the user server lists no ${tc} under Apps > RocketWright for ${root} (${JSON.stringify(cl.facts["appsListing"])})`);
    const bodyBefore = componentLengthMm(readFileSync(join(projectDir, "rocket.rw.toml"), "utf8"), BODY_ID);
    if (bodyBefore === null) throw new Error(`no [c.${BODY_ID}] length in ${projectDir}/rocket.rw.toml`);
    const lengthMm = bodyBefore + BODY_DELTA_MM;
    const bodyFacts: Record<string, unknown> = { before: bodyBefore, want: lengthMm };
    cl.facts["bodyLengthMm"] = bodyFacts;
    const web = await LecturnWebClient.open(userHome, user.origin, log);
    let closedRun: { sim: string; run_id: string } | null = null;
    try {
      const webListing = await web.appListing(RW_APP_ID, "RocketWright", copyTitle ?? "Live switch");
      cl.facts["webListing"] = webListing;
      if (await web.screenshot(join(o.outDir, "apps-listing.png"))) artifacts.push("apps-listing.png");
      if (!webListing.appRow || !webListing.thread) fail(cl, `the web client's Apps sidebar does not list "${copyTitle ?? "Live switch"}" under RocketWright (${JSON.stringify(webListing)})`);
      // Close RocketWright: its live-tools lease goes, so Lecturn reports it closed.
      await s.close();
      s = null;
      const closed = await until("RocketWright's live tools lease to clear on the user server", SWITCH_TIMEOUT_MS, async () => {
        const a = (await userAdmin.app().catch(() => null)) as (AppStatusLike & { state?: unknown }) | null;
        return a !== null && (a.live === null || a.live === undefined) ? a : undefined;
      });
      cl.facts["appState"] = { state: closed.state ?? null, live: closed.live ?? null };
      // From the Lecturn client: the scripted turn in the copy, approvals answered (logged) as the user would.
      const answerer = await answerApprovals({ admin: userAdmin, threadId: tc, decide: () => "accept", log });
      const ctext = await scripted(userAdmin, tc, CLOSED_PROMPT, closedSteps(lengthMm));
      const cp = await replied(userAdmin, tc, CLOSED_REPLY).finally(() => answerer.stop());
      cl.facts["approvals"] = answerer.log.map((a: ApprovalLogEntry) => ({ tool: a.toolName, decision: a.decision }));
      const cturn = promptTurnOf(cp, tc, ctext);
      const ccalls = cturn === null ? [] : transcriptOf(tc, cturn.events, ctext).tool_calls;
      cl.facts["toolCalls"] = ccalls.map((c) => ({ tool: c.tool, isError: c.isError }));
      const judged = judgeClosedTurn(ccalls);
      for (const why of judged.reasons) fail(cl, why);
      if (judged.runId !== null) closedRun = { sim: judged.sim ?? "baseline", run_id: judged.runId };
      cl.facts["run"] = closedRun;
      const banner = await web.closedBanner(user.environmentId, tc);
      cl.facts["banner"] = banner;
      if (await web.screenshot(join(o.outDir, "closed-banner.png"))) artifacts.push("closed-banner.png");
      if (!banner.shown || !/RocketWright closed/.test(banner.text)) fail(cl, `the web client shows no closed banner on ${tc} (${JSON.stringify(banner)})`);
    } finally {
      await web.close();
    }
    // Reopen: back on the user server with the stored credential; the edit and the run are there.
    s = await launch();
    view = new AppView(s);
    await attached(view, 0, userAdmin, cl.facts, log);
    const got = await s.appRpc.call<{ model?: unknown }>("model.get", { projectId: s.projectId });
    const length = evaluatedLength(got.model ?? null, BODY_ID);
    bodyFacts["reopened"] = length === null ? null : Math.round(length * 1e4) / 10;
    if (length === null || Math.abs(length * 1000 - lengthMm) > 0.01) fail(cl, `after reopening, ${BODY_ID} is ${String(length)} m, want ${lengthMm} mm`);
    if (closedRun !== null) {
      const want = closedRun;
      const runs = await s.appRuns();
      const entry = runs.runs.find((r) => r.sim === want.sim && r.run_id === want.run_id);
      if (entry === undefined) fail(cl, `after reopening, the app lists no run ${want.sim}/${want.run_id}`);
      const apogee = (entry?.summary as { apogee_m?: number } | null | undefined)?.apogee_m;
      const results = await s.showResults({ sim: want.sim, run_id: want.run_id, apogee_m: apogee ?? null });
      cl.facts["results"] = results;
      if (!results.visible) fail(cl, `after reopening, the Results page does not show the new run (${JSON.stringify(results)})`);
      if (await s.screenshot("window", join(o.outDir, "closed-reopened.png"))) artifacts.push("closed-reopened.png");
    }
    cl.status = cl.reasons.length === 0 ? "pass" : "red";
    // The copies as they stand now (the closed turn moved the copy's own history), for the re-copy checks.
    const copies0 = copiesOf(await view.threads(0, "the copies", (l) => l.some((t) => t.threadId === tc)), sidecarEnv);

    // ---- 3. fallback after a restart ----
    current = fb;
    const stopMark = view.mark;
    await server.stop();
    const fell = await view.mode(stopMark, "sidecar", FALLBACK_TIMEOUT_MS).catch((e: unknown) => {
      fail(fb, `no live fallback to the sidecar: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    fb.facts["liveFallback"] = fell !== null;
    await s.close();
    s = await launch();
    view = new AppView(s);
    await view.mode(0, "sidecar", FALLBACK_TIMEOUT_MS);
    const sidecar2 = await LecturnAdminSession.open(sidecarBase);
    const listed = await view.threads(0, `${ts} continued in Lecturn`, (l) => l.some((t) => t.threadId === ts && t.continuedIn !== undefined));
    const original = listed.find((t) => t.threadId === ts)!;
    fb.facts["continuedIn"] = original.continuedIn;
    if (original.continuedIn?.threadId !== tc) fail(fb, `${ts} is continued in ${String(original.continuedIn?.threadId)}, not its copy ${tc}`);
    const entries = await s.window.locator(`[data-testid="rail.thread"][data-thread-id="${key}"]`).count();
    if (entries !== 1) fail(fb, `${entries} rail entries carry ${key}, want 1`);
    await selectRail(s.window, key);
    await guestAt(s, sidecar2.origin, ts, UI_TIMEOUT_MS);
    const guest = await embedGuest(s.electron);
    const shown = await until("the read-only notice", UI_TIMEOUT_MS, async () => {
      const v = await guest.evaluate(readContinued, null);
      return v.marked && v.notice && v.link !== null ? v : undefined;
    }, () => guest.evaluate(readContinued, null));
    fb.facts["notice"] = shown;
    const want = continuedLink(user.environmentId, tc);
    if (shown.link === null || decodeURIComponent(shown.link) !== want) fail(fb, `the notice links to ${String(shown.link)}, want ${want}`);
    if (shown.composer) fail(fb, "the copied thread still shows a composer on the sidecar");
    for (const why of await paneRendered(s, "the fallback pane", { flight: true })) fail(fb, why);
    await shot(s, "attach-continued.png");
    fb.status = fb.reasons.length === 0 ? "pass" : "red";

    // ---- 4. a running sidecar turn holds the switch; a subtitle write alone re-copies nothing ----
    current = rc;
    const th = await newThread(s.electron, s.window, { title: "Held turn", log });
    if (existsSync(release)) rmSync(release);
    await scripted(sidecar2, th, "Fly the baseline, then wait for the release file.", [...FLY, { hold: { until: release } }, { assistantText: HELD_REPLY }]);
    await until("the held turn to fly and hold", TURN_TIMEOUT_MS, async () => {
      const p = await sidecar2.transcript(th);
      const flown = p.turnItems.some((i) => i.type === "dynamic_tool" && bareTool(i.toolName) === "job_status" && i.status === "completed" && (toolValue(i.output) as { state?: unknown } | null)?.state === "complete");
      return flown && p.runs.some((r) => r.status === "running") ? true : undefined;
    }, async () => {
      const p = await sidecar2.transcript(th);
      return {
        runs: p.runs.map((r) => r.status),
        tools: p.turnItems.filter((i) => i.type === "dynamic_tool").map((i) => `${String(i.toolName)} ${i.status} ${JSON.stringify(toolValue(i.output)).slice(0, 120)}`),
        last: p.messages.at(-1)?.text.slice(0, 200) ?? null,
      };
    });
    const sidecarPid = readPid(sidecarBase);
    rc.facts["heldThread"] = th;
    // The user server starts while the turn holds: the app stays on the sidecar, which keeps serving it.
    const heldFrom = view.mark;
    await server.start();
    const heldAdmin = await LecturnAdminSession.open(userHome);
    const holdEnd = Date.now() + HOLD_MS;
    while (Date.now() < holdEnd && modeAfter(view.pushes, heldFrom, "user-server") === null) {
      // A pending pairing request would hold the switch on its own and prove nothing: grant it.
      const pending = (await heldAdmin.app().catch(() => null))?.pendingRequest?.requestId;
      if (typeof pending === "string") await heldAdmin.decidePairing(pending, "grant");
      await sleep(500);
    }
    if (modeAfter(view.pushes, heldFrom, "user-server") !== null) fail(rc, "the app switched to the user server while a sidecar turn ran");
    if (sidecarPid !== null && !isAlive(sidecarPid)) fail(rc, "the sidecar stopped while its turn held");
    writeFileSync(release, "");
    log("recopy: released the held turn");
    // Once the turn ends, the switch copies it, completed.
    const held = await attached(view, heldFrom, heldAdmin, rc.facts, log);
    const heldList = await view.threads(held.from, `a copy of ${th}`, (l) => l.some((t) => t.copiedFrom?.sourceThreadId === th));
    const copies1 = copiesOf(heldList, sidecarEnv);
    rc.reasons.push(...copiesUnchanged(copies0, copies1, "the attach after the release"));
    const heldCopy = onlyCopy(copies1, th);
    if (typeof heldCopy === "string") throw new Error(`the attach after the release: ${heldCopy}`);
    rc.facts["copy"] = { threadId: heldCopy.threadId, sourceHistoryRevision: heldCopy.copiedFrom?.sourceHistoryRevision };
    await replied(held.admin, heldCopy.threadId, HELD_REPLY, UI_TIMEOUT_MS).catch(() => fail(rc, "the copy does not show the completed turn"));
    if (sidecarPid !== null) await until("the old sidecar to stop after the switch", TURN_TIMEOUT_MS, async () => (isAlive(sidecarPid) ? undefined : true)).catch((e: unknown) => fail(rc, String(e)));
    // Back on the sidecar: the turn completed there.
    let mark = view.mark;
    await server.stop();
    await view.mode(mark, "sidecar", FALLBACK_TIMEOUT_MS);
    const sidecar3 = await LecturnAdminSession.open(sidecarBase);
    const done = await replied(sidecar3, th, HELD_REPLY, UI_TIMEOUT_MS);
    const lastRun = [...done.runs].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1);
    if (lastRun?.status !== "completed") fail(rc, `the held turn ended ${String(lastRun?.status)}, not completed`);
    // A subtitle write alone re-copies nothing.
    const beforeSub = (await view.threads(mark, th, (l) => l.some((t) => t.threadId === th))).find((t) => t.threadId === th)!;
    mark = view.mark;
    await view.subtitle(beforeSub, SUBTITLE);
    const resub = (await view.threads(mark, `the subtitle "${SUBTITLE}"`, (l) => l.some((t) => t.threadId === th && t.subtitle === SUBTITLE))).find((t) => t.threadId === th)!;
    if (!(Date.parse(resub.updatedAt) > Date.parse(beforeSub.updatedAt))) fail(rc, "the subtitle write did not move updatedAt (the check proves nothing)");
    if (resub.historyRevision !== beforeSub.historyRevision) fail(rc, `the subtitle write moved historyRevision (${beforeSub.historyRevision} -> ${resub.historyRevision})`);
    const third = await attachTo(view, server, userHome, rc.facts, log);
    const list3 = await view.threads(third.from, "the copies", (l) => l.some((t) => t.copiedFrom?.sourceThreadId === th));
    const copies3 = copiesOf(list3, sidecarEnv);
    rc.reasons.push(...copiesUnchanged(copies1, copies3, "the attach after a subtitle write"));
    const kept = onlyCopy(copies3, th);
    if (typeof kept !== "string" && kept.subtitle !== heldCopy.subtitle) fail(rc, `the copy's subtitle is ${JSON.stringify(kept.subtitle)}, want the one it was copied with (${JSON.stringify(heldCopy.subtitle)})`);
    rc.status = rc.reasons.length === 0 ? "pass" : "red";
  } catch (e) {
    fail(current, `stopped: ${e instanceof Error ? e.message : String(e)}`);
    current.status = "red";
    log(`--- user server output ---\n${server.output().slice(-4000)}`);
  } finally {
    await s?.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    if (o.keep === true) log(`kept ${parent} and ${pair.dir ?? ""}`);
    else {
      pair.cleanup();
      rmSync(parent, { recursive: true, force: true });
    }
  }
  const reasons = checks.flatMap((c) => (c.status === "not-run" ? [`${c.name}: not run`] : c.reasons.map((r) => `${c.name}: ${r}`)));
  const result: AttachResult = { status: reasons.length === 0 ? "pass" : "red", reasons, project: projectDir, checks, artifacts };
  writeFileSync(join(o.outDir, "attach-result.json"), stableStringify(result));
  return result;
}
