/**
 * B4(b) live app session (plan M5.6): the real Electron desktop app on one
 * project, driven through Playwright exactly as a user would (composer, the
 * approval panel's buttons, the reveal-run card, the Results tab). Launched
 * like `b4a.spec.ts` (`_electron`, `src/main.ts --project`). The app state
 * (runs) comes from a second IF10 client on the app's own RPC socket.
 *
 * The session is the embedded Lecturn pane's (the only agent pane since
 * B17, which removed the old chat and its `LiveSession`):
 * - `EmbedSession` (B14, B16): the prompt goes
 *   through the pane's bridge (`embed.ts` `sendTurn`: `thread.new`,
 *   `composer.setDraft`, the composer's send button) after the thread is
 *   set to Supervised; the turn, its tool calls and its app approvals are
 *   read from the Lecturn thread over the admin session
 *   (`scripts/bar/lecturn-admin.ts`, D16; `lecturn-transcript.ts`) and
 *   approvals are answered with `runtime-request.respond`; the reveal card
 *   is the run card's Open (`rw:run/<id>`, D8), clicked with trusted input
 *   (`trustedClickInFrame`). It also carries the W-B2 follow-up turn's
 *   needs (`EmbedTurnSession`: modes, later prompts, the approval cards the
 *   pane showed, the run card frames) and W-B2 step 3's (B16b,
 *   `MentionSession`: the viewport's `@` into the composer strip, the app's
 *   selection state, a trusted click on the reply's ref chip).
 *   `--rehearse` always runs this one, with Lecturn's scripted provider
 *   replaying `fixtures/scripted/b4b.json` plus `b4b-mention.json` (and
 *   `b4b-followup.json`).
 * - `AppSession`, its base: the app state over a second IF10 client, the
 *   Results page, screenshots and close.
 *
 * Loaded only by `scripts/bar/live-smoke.ts` (`make bar-live`, or
 * `--rehearse`), never by `make check`.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ApprovalDecision } from "../../scripts/bar/transcript-events.ts";
import { answerApprovals, declineProviderApprovals, LecturnAdminSession, pendingAppApprovals, RUNTIME_MODE_LABEL, type ApprovalAnswerer, type ModelSelection, type ProviderRequestEntry, type RuntimeMode } from "../../scripts/bar/lecturn-admin.ts";
import { parseShownNumber, RpcClient, type B4bSession, type findPromptTurn, type ResultsView } from "../../scripts/bar/live-smoke.ts";
import { readAppSelection, type AppSelection, type MentionSession, type StripChip } from "../../scripts/bar/mention.ts";
import { REPO_ROOT } from "./bar/paths.ts";
import { readCardFrame, type CardFrameFacts } from "./capture/pane-checks.ts";
import {
  approvalCardsSeen,
  captureGuest,
  draftAndSend,
  embedGuest,
  mergeTurnFixtures,
  readApprovalCards,
  readRuntimeMode,
  readStripChips,
  scrollTimeline,
  sendTurn,
  trustedClickInFrame,
  trustedClickInGuest,
  until as waitFor,
  watchApprovalCards,
  type ApprovalCardView,
  type TrustedClick,
} from "./embed.ts";
import { lecturnEnv, type LecturnEnv } from "./lecturn-env.ts";
import { promptTurnOf, type TranscriptProjection } from "./lecturn-transcript.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");

const byTestId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);
const region = (page: Page, name: string) => page.locator(`[data-rw-region="${name}"]`);

export interface LaunchOptions {
  projectDir: string;
  env: Record<string, string>;
  outDir: string;
  log?: (line: string) => void;
  /**
   * `--rehearse` (B14): the scripted turn (`fixtures/scripted/<name>.json`)
   * Lecturn's scripted provider replays in the embedded pane in place of the
   * agent. Several names (B16b: the B4(b) turn, then the mention turn) merge
   * their scripts, which must not share a run ordinal.
   */
  rehearse?: string | readonly string[];
  /** B16: the live provider's model, the default for new threads in a fresh Lecturn pair (W-B2 steps 1 and 2). */
  model?: ModelSelection;
  /** B16: a Lecturn pair the caller owns and keeps across launches (W-B2.4); never removed on close. */
  lecturn?: LecturnEnv;
}

/** Waits for `fn` to hold (polls); false on timeout. */
async function until(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** What every app session shares: the app state over a second IF10 client, the Results page, screenshots, close. */
export abstract class AppSession {
  readonly projectDir: string;
  protected readonly app: ElectronApplication;
  protected readonly page: Page;
  private readonly rpc: RpcClient;
  readonly projectId: string;
  private closed = false;

  constructor(projectDir: string, app: ElectronApplication, page: Page, rpc: RpcClient, projectId: string) {
    this.projectDir = projectDir;
    this.app = app;
    this.page = page;
    this.rpc = rpc;
    this.projectId = projectId;
  }

  abstract send(prompt: string): Promise<void>;
  abstract pendingApprovals(): Promise<string[]>;
  abstract respond(approvalId: string, decision: ApprovalDecision): Promise<void>;
  abstract interrupt(): Promise<void>;
  /** Opens the turn's run card for `runId` (its Open), else its latest one; false without one. */
  protected abstract revealCard(runId: string): Promise<boolean>;

  appRuns() {
    return this.rpc.runs(this.projectId);
  }

  /** The second IF10 client on the app's RPC socket (its pushes: `lecturn.status`, `embed.threads`). */
  protected get rpcClient(): RpcClient {
    return this.rpc;
  }

  private async row(sim: string): Promise<ResultsView["row"]> {
    const rows = this.page.locator(`[data-testid="runs.table-row"][data-sim="${sim}"]`);
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      if ((await r.getAttribute("data-status")) !== "complete" || !(await r.isVisible())) continue;
      const status = ((await r.locator('[data-testid="runs.status"]').textContent()) ?? "").trim();
      const apogee_text = ((await r.locator('[data-testid="runs.apogee"]').textContent()) ?? "").trim();
      return { sim, status, apogee_text };
    }
    return null;
  }

  async showResults(run: { sim: string; run_id: string; apogee_m: number | null }): Promise<ResultsView> {
    const table = region(this.page, "run-table");
    const onResults = async (): Promise<boolean> => (await table.count()) > 0 && (await table.first().isVisible());
    let via: ResultsView["via"] = null;
    if (await onResults()) via = "already";
    if (via === null && (await this.revealCard(run.run_id)) && (await until(onResults, 10_000))) via = "reveal-card";
    if (via === null) {
      await this.page.locator('[data-testid="header.tab"][data-tab="results"]').click();
      if (await until(onResults, 15_000)) via = "navigate";
    }
    let row = null as ResultsView["row"];
    await until(async () => (row = await this.row(run.sim)) !== null, 15_000);
    const shown = parseShownNumber(row?.apogee_text);
    const matches = run.apogee_m === null || (shown !== null && Math.abs(shown - run.apogee_m) <= 1);
    return { visible: via !== null && row !== null && matches, via, row };
  }

  async screenshot(what: "chat-pane" | "results" | "window", file: string): Promise<boolean> {
    if (what === "chat-pane") {
      const pane = region(this.page, "agent-pane");
      if ((await pane.count()) === 0) return false;
      await pane.first().screenshot({ path: file });
      return true;
    }
    await this.page.screenshot({ path: file });
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rpc.close();
    await this.app.close();
  }
}

/** The complete flight run card's Open (in a card frame; `rw:run/<id>`, D8). */
export const FLIGHT_CARD_OPEN = '[data-testid="rw.run-card"][data-kind="flight"][data-phase="complete"] [data-testid="rw.run-card.open"]';

/**
 * The embedded Lecturn pane's session (B14, B16; see the module comment).
 * Its turns run in Supervised (set over the admin session before the
 * prompt is sent, and shown by the composer); `setRuntimeMode` switches
 * the thread for the Full-access and Auto checks.
 */
export class EmbedSession extends AppSession implements B4bSession, MentionSession {
  readonly baseDir: string;
  private readonly log: (line: string) => void;
  private thread: string | null = null;
  private adminP: Promise<LecturnAdminSession> | null = null;

  constructor(projectDir: string, app: ElectronApplication, page: Page, rpc: RpcClient, projectId: string, baseDir: string, log: (line: string) => void) {
    super(projectDir, app, page, rpc, projectId);
    this.baseDir = baseDir;
    this.log = log;
  }

  get threadId(): string | null {
    return this.thread;
  }

  get electron(): ElectronApplication {
    return this.app;
  }

  get window(): Page {
    return this.page;
  }

  get appRpc(): RpcClient {
    return this.rpcClient;
  }

  /** The admin session on the Lecturn sidecar in `baseDir` (D16). */
  admin(): Promise<LecturnAdminSession> {
    this.adminP ??= LecturnAdminSession.open(this.baseDir);
    return this.adminP;
  }

  private async projection(): Promise<(TranscriptProjection & { threadId: string }) | null> {
    if (this.thread === null) return null;
    const p = await (await this.admin()).transcript(this.thread);
    return { ...p, threadId: this.thread };
  }

  /** Sets `threadId`'s runtime mode and waits for the composer to show it (it sends its own mode with the next message). */
  async setThreadMode(threadId: string, mode: RuntimeMode): Promise<void> {
    await (await this.admin()).setRuntimeMode(threadId, mode);
    const guest = await embedGuest(this.app);
    const label = RUNTIME_MODE_LABEL[mode];
    await waitFor(`the composer to show ${label}`, 30_000, async () => ((await guest.evaluate(readRuntimeMode, null)) === label ? true : undefined), () => guest.evaluate(readRuntimeMode, null));
    this.log(`thread ${threadId}: ${label}`);
  }

  override async send(prompt: string): Promise<void> {
    const sent = await sendTurn(this.app, this.page, {
      prompt,
      title: "B4(b)",
      wait: false,
      log: this.log,
      // Supervised before the first message (W-B2: threads run in Supervised), with the card watch on.
      beforeSend: async (threadId) => {
        this.thread = threadId;
        await this.setThreadMode(threadId, "approval-required");
        await this.watchApprovalCards();
      },
    });
    this.thread = sent.threadId;
  }

  async setRuntimeMode(mode: RuntimeMode): Promise<void> {
    if (this.thread === null) throw new Error("no thread yet: send a prompt first");
    await this.setThreadMode(this.thread, mode);
  }

  async sendInThread(prompt: string): Promise<void> {
    await draftAndSend(this.app, this.page, prompt);
  }

  async watchApprovalCards(): Promise<void> {
    await (await embedGuest(this.app)).evaluate(watchApprovalCards, true);
  }

  async approvalCardsSeen(): Promise<string[]> {
    return (await (await embedGuest(this.app)).evaluate(approvalCardsSeen, null)) ?? [];
  }

  async approvalCards(): Promise<ApprovalCardView[]> {
    return (await embedGuest(this.app)).evaluate(readApprovalCards, null);
  }

  /** Every RocketWright run card frame the timeline shows (it renders only rows near its viewport: scanned bottom to top). */
  async runCards(): Promise<CardFrameFacts[]> {
    const guest = await embedGuest(this.app, 30_000);
    const out: CardFrameFacts[] = [];
    for (const f of [1, 0.75, 0.5, 0.25, 0]) {
      await guest.evaluate(scrollTimeline, f);
      await new Promise((r) => setTimeout(r, 300));
      out.push(...(await guest.evaluateFrames(readCardFrame, null)).filter((c): c is CardFrameFacts => c !== null));
    }
    await guest.evaluate(scrollTimeline, 1);
    return out;
  }

  /** Evidence only: the pane page by page, top to bottom (`NN.png`), then back at the bottom. */
  async paneScrollShots(dir: string): Promise<string[]> {
    const guest = await embedGuest(this.app, 30_000);
    const pages = await guest.evaluate(timelinePages, null);
    const n = Math.min(Math.max(pages, 1), 24);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < n; i++) {
      await guest.evaluate(scrollTimeline, n === 1 ? 1 : i / (n - 1));
      await new Promise((r) => setTimeout(r, 600));
      const png = await captureGuest(this.app);
      if (png === null) continue;
      const name = `${String(i).padStart(2, "0")}.png`;
      writeFileSync(join(dir, name), png);
      files.push(name);
    }
    await guest.evaluate(scrollTimeline, 1);
    return files;
  }

  async answerApprovals(o: { decide: (r: { toolName: string; reason: string | null }) => "accept" | "decline"; before?: (r: { id: string }) => Promise<void> }): Promise<ApprovalAnswerer> {
    if (this.thread === null) throw new Error("no thread yet: send a prompt first");
    return answerApprovals({ admin: await this.admin(), threadId: this.thread, decide: o.decide, ...(o.before === undefined ? {} : { before: o.before }), log: this.log });
  }

  async promptTurn(prompt: string): Promise<ReturnType<typeof findPromptTurn>> {
    const p = await this.projection();
    return p === null ? null : promptTurnOf(p, p.threadId, prompt);
  }

  /** Writes the thread's raw projection (evidence when the turn cannot be read back); false without a thread. */
  async saveProjection(file: string): Promise<boolean> {
    if (this.thread === null) return false;
    const p = await (await this.admin()).projection(this.thread);
    writeFileSync(file, JSON.stringify(p, null, 1));
    return true;
  }

  /** Provider approvals (not app approvals) declined during the B4(b) turn (`declineProviderApprovals`). */
  readonly providerDeclines: ProviderRequestEntry[] = [];
  private readonly providerAnswered = new Set<string>();
  private readonly t0 = Date.now();

  override async pendingApprovals(): Promise<string[]> {
    const p = await this.projection();
    if (p === null) return [];
    await declineProviderApprovals({ admin: await this.admin(), threadId: p.threadId, projection: p, answered: this.providerAnswered, into: this.providerDeclines, t0: this.t0, log: this.log });
    return pendingAppApprovals(p).map((r) => r.id);
  }

  override async respond(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (this.thread === null) return;
    await (await this.admin()).respond(this.thread, approvalId, decision === "approve" ? "accept" : "decline");
  }

  override async interrupt(): Promise<void> {
    const p = await this.projection();
    const run = p?.runs.find((r) => !["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(r.status));
    if (p === null || run === undefined) return;
    await (await this.admin()).dispatch({ type: "run.interrupt", threadId: p.threadId, runId: run.id, reason: "B4(b) timeout" });
  }

  /** Opens the run's card with the user's own (trusted) click on its Open: a scripted `.click()` is no user activation for `ui/open-link` (B14). */
  protected override async revealCard(): Promise<boolean> {
    const guest = await embedGuest(this.app, 30_000);
    // The timeline renders only rows near its viewport: look for the card from the end up.
    let last = "";
    for (const f of [1, 0.75, 0.5, 0.25, 0]) {
      await guest.evaluate(scrollTimeline, f);
      await new Promise((r) => setTimeout(r, 300));
      const click = await trustedClickInFrame(this.app, FLIGHT_CARD_OPEN);
      if (click.clicked) {
        this.log(`reveal: clicked the run card's Open ${click.detail}`);
        return true;
      }
      last = click.detail;
    }
    this.log(`reveal: no complete flight run card's Open was clickable (${last})`);
    return false;
  }

  // ---- B16b: W-B2 step 3 (`scripts/bar/mention.ts`) ----

  /** Design > Assembly, as the user gets there (the Design tab, then the Assembly local tab), with the part's leader label shown. */
  private async toAssembly(part: string): Promise<void> {
    const onAssembly = async (): Promise<boolean> => (await byTestId(this.page, "app-shell").first().getAttribute("data-page")) === "assembly";
    if (!(await onAssembly())) {
      await this.page.locator('[data-testid="header.tab"][data-tab="design"]').click();
      if (!(await until(onAssembly, 5_000))) await byTestId(this.page, "workspace.local-tab").filter({ hasText: "Assembly" }).first().click();
      if (!(await until(onAssembly, 15_000))) throw new Error("the window never showed Design > Assembly");
    }
    await this.page.locator(`[data-testid="vp.leader-label"][data-part="${part}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
  }

  async pickPart(part: string): Promise<void> {
    await this.toAssembly(part);
    await this.page.locator(`[data-testid="vp.leader-label"][data-part="${part}"]`).first().click();
    if (!(await until(async () => (await this.selection()).viewport?.join(",") === part, 10_000))) throw new Error(`picking ${part}'s leader label did not select it (${JSON.stringify(await this.selection())})`);
  }

  async mentionFromViewport(part: string): Promise<{ chips: StripChip[]; detail: string }> {
    await this.pickPart(part);
    // The selected part's `@` beside its label: the app's MENTION_EVENT → the pane's insertMention (B12 wiring).
    await this.page.locator(`[data-testid="vp.mention"][data-part="${part}"]`).first().click();
    const guest = await embedGuest(this.app, 30_000);
    const ref = `rw:c/${part}`;
    let chips: StripChip[] = [];
    await until(async () => (chips = await guest.evaluate(readStripChips, null)).some((c) => c.ref === ref), 15_000);
    return { chips, detail: `picked ${part} in the viewport and clicked its @` };
  }

  async selection(): Promise<AppSelection> {
    return this.page.evaluate(readAppSelection);
  }

  async clickReplyChip(ref: string): Promise<TrustedClick> {
    const guest = await embedGuest(this.app, 30_000);
    let last: TrustedClick = { clicked: false, detail: "not tried" };
    // The reply is the timeline's last row; the timeline renders only rows near its viewport.
    for (const f of [1, 0.75, 0.5]) {
      await guest.evaluate(scrollTimeline, f);
      await new Promise((r) => setTimeout(r, 300));
      last = await trustedClickInGuest(this.app, ref);
      if (last.clicked) return last;
    }
    return last;
  }

  override async screenshot(what: "chat-pane" | "results" | "window", file: string): Promise<boolean> {
    if (what !== "chat-pane") return super.screenshot(what, file);
    // The pane is a WebContentsView over the page: its pixels come from the guest's own capturePage.
    const png = await captureGuest(this.app);
    if (png === null) return false;
    writeFileSync(file, png);
    return true;
  }
}

/** How many viewport-high pages the guest's timeline scroller holds (runs in the guest). */
function timelinePages(): number {
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  const el = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  return el === undefined ? 1 : Math.ceil(el.scrollHeight / Math.max(1, el.clientHeight * 0.6));
}

/** Starts the desktop app on `projectDir` and connects to its RPC socket. */
export async function launchB4bApp(o: LaunchOptions): Promise<EmbedSession> {
  const executablePath = createRequire(join(DESKTOP, "package.json"))("electron") as string;
  const fixture = o.rehearse === undefined ? null : mergeTurnFixtures(typeof o.rehearse === "string" ? [o.rehearse] : o.rehearse);
  // Lecturn state in temp dirs (the caller's pair when one is set; fresh ones with the scripted turn), never ~/.lecturn.
  const lecturn = o.lecturn ?? lecturnEnv(o.env, "rw-b4b-lecturn-", fixture !== null ? { scripts: fixture.scripts } : o.model !== undefined ? { defaultModel: o.model } : {});
  const owned = o.lecturn === undefined;
  let app: ElectronApplication;
  try {
    app = await electron.launch({
      executablePath,
      args: [join(DESKTOP, "src/main.ts"), "--project", o.projectDir, "-ApplePersistenceIgnoreState", "YES"],
      env: { ...o.env, ...lecturn.env },
      timeout: 120_000,
    });
  } catch (e) {
    if (owned) lecturn.cleanup();
    throw e;
  }
  if (owned) app.on("close", () => lecturn.cleanup());
  try {
    const page = await app.firstWindow();
    await region(page, "workspace").waitFor({ state: "visible", timeout: 120_000 });
    const header = async (): Promise<string> => ((await byTestId(page, "header.project-switcher").first().textContent()) ?? "").trim();
    const ok = await until(async () => !/^(|Opening…|No project)$/.test(await header()), 120_000);
    if (!ok) throw new Error("the header never showed the project");
    // The server refuses the socket without its per-launch token: the preload's URL carries it; else the
    // page query's `rpc=` plus the fragment's `#token=` (REV-srv).
    const rpcUrl = await page.evaluate(() => {
      const desktop = (window as unknown as { rwDesktop?: { rpcUrl?: string | null } }).rwDesktop?.rpcUrl;
      if (desktop) return desktop;
      const rpc = new URL(location.href).searchParams.get("rpc");
      const token = new URLSearchParams(location.hash.slice(1)).get("token");
      if (rpc === null || token === null) return rpc;
      const u = new URL(rpc);
      u.searchParams.set("token", token);
      return u.toString();
    });
    if (rpcUrl === null || rpcUrl === undefined) throw new Error("no RPC url on the page");
    const rpc = await RpcClient.connect(rpcUrl);
    const project = await rpc.projectFor(o.projectDir);
    o.log?.(`app up: ${page.url().split("?")[0] ?? ""} project ${project.projectId}`);
    if (!(await until(async () => (await byTestId(page, "agent.embed").count()) > 0, 120_000))) throw new Error("the window never showed the embedded Lecturn pane");
    const baseDir = lecturn.env["RW_LECTURN_BASE_DIR"];
    if (baseDir === undefined) throw new Error("no RW_LECTURN_BASE_DIR for the embedded pane's admin session");
    o.log?.(`agent pane: embedded Lecturn${fixture === null ? "" : ` (scripted ${[o.rehearse ?? []].flat().join(" + ")})`}`);
    return new EmbedSession(o.projectDir, app, page, rpc, project.projectId, baseDir, o.log ?? (() => undefined));
  } catch (e) {
    await app.close().catch(() => undefined);
    throw e;
  }
}

/** The embedded pane's session on `o.projectDir` (B16: the follow-up turn and W-B2.4). */
export function launchEmbedApp(o: LaunchOptions): Promise<EmbedSession> {
  return launchB4bApp(o);
}
