/**
 * The embedded Lecturn pane from a Playwright `_electron` run (plan B14,
 * W5.2): the B4(a) spec and the B4(b) rehearsal drive turns the way the
 * app's own `PaneBridge` does (`apps/web/src/embed/bridge.ts`), never the old
 * chat composer.
 *
 * - The guest is reached by the B5/B13 method (`apps/desktop/src/main.ts`
 *   `guestOf`): in Electron main, the pane's webContents (the loopback
 *   `/embed/` URL the helper loads) runs the function with Electron's own
 *   `executeJavaScript`, and the MCP Apps card frames (sandboxed, possibly
 *   out of process) through `mainFrame.framesInSubtree`. No second debugger
 *   attaches to the guest: its one CDP session stays the bridge's (D15).
 * - Commands go host → guest over the page's preload channel, exactly as
 *   `startDesktopPane` sends them (`lecturn-embed:bridge`:
 *   `lecturn/thread.new`, `lecturn/composer.setDraft`); the guest's events
 *   (`lecturn/thread.changed`, `lecturn/turn.state`, `lecturn/ready`) come
 *   back on `rwDesktop.lecturn.onMessage` and are recorded in the page.
 * - Sending is the user's click on the composer's send button, in the guest.
 *
 * The turn's script comes from the scripted provider's scripts file
 * (`fixtures/scripted/<name>.json` `scripts`, keyed by run ordinal;
 * `lecturnEnv({ scripts })` writes it and makes the scripted model the
 * default).
 */
import type { ElectronApplication, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMBED_HOST_BRIDGE_CHANNEL, PANE_MAIN_CHANNEL } from "../packages/contracts/src/embedPane.ts";
import { readCardFrame, type CardFrameFacts } from "./capture/pane-checks.ts";
import { SCENARIO_DIR, scriptProblems } from "./capture/scripted.ts";
import type { ScriptsFile } from "./lecturn-env.ts";

// ---- scripted turn fixtures -------------------------------------------------------

/** `app/e2e/fixtures/scripted/<name>.json` for a composer-driven turn (B4(a), the B4(b) rehearsal). */
export interface ScriptedTurnFixture {
  description: string;
  /** What the user types (the composer draft). */
  prompt: string;
  /** The scripts file: D22 scripts by 1-based run ordinal. */
  scripts: ScriptsFile;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with a turn fixture (empty when valid). */
export function turnFixtureProblems(v: unknown): string[] {
  if (!isObject(v)) return ["not an object"];
  const out: string[] = [];
  for (const k of ["description", "prompt"]) if (typeof v[k] !== "string" || v[k] === "") out.push(`${k}: a non-empty string`);
  const scripts = v["scripts"];
  if (!isObject(scripts) || Object.keys(scripts).length === 0) return [...out, "scripts: an object keyed by run ordinal"];
  for (const [k, script] of Object.entries(scripts)) {
    if (!/^[1-9]\d*$/.test(k)) out.push(`scripts.${k}: keys are 1-based run ordinals`);
    out.push(...scriptProblems(script).map((p) => `scripts.${k}.${p}`));
  }
  return out;
}

export function loadTurnFixture(name: string, dir = SCENARIO_DIR): ScriptedTurnFixture {
  const v: unknown = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  const problems = turnFixtureProblems(v);
  if (problems.length > 0) throw new Error(`scripted/${name}.json:\n  ${problems.join("\n  ")}`);
  return v as ScriptedTurnFixture;
}

/** The scripts of several turn fixtures in one scripts file (B16b); a run ordinal two of them claim is an error. */
export function mergeTurnFixtures(names: readonly string[], dir = SCENARIO_DIR): ScriptedTurnFixture {
  const fixtures = names.map((n) => loadTurnFixture(n, dir));
  const first = fixtures[0];
  if (first === undefined) throw new Error("no turn fixture to rehearse");
  const scripts: ScriptedTurnFixture["scripts"] = {};
  fixtures.forEach((f, i) => {
    for (const [k, v] of Object.entries(f.scripts)) {
      if (k in scripts) throw new Error(`scripted/${names[i] ?? ""}.json: run ${k} is already scripted by an earlier fixture`);
      scripts[k] = v;
    }
  });
  return { ...first, scripts };
}

// ---- the guest, through Electron main ---------------------------------------------

/** The pane's guest: its main frame and its card frames (B13 `GuestLike` without the bridge state). */
export interface EmbedGuest {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** `fn` in every child frame that answers (a frame that throws or detached is skipped). */
  evaluateFrames<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R[]>;
}

/** True for the embed guest's URL: loopback http(s) under `/embed/` (the helper's guest route). */
export function isEmbedGuestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.pathname.startsWith("/embed/");
  } catch {
    return false;
  }
}

type GuestAnswer<R> = { ok: true; value: R } | { ok: false };

/** Runs `src(arg)` in the guest (main frame, or every child frame) from Electron main; `ok:false` without a live guest. */
async function inGuest<R>(app: ElectronApplication, src: string, arg: unknown, frames: boolean): Promise<GuestAnswer<R>> {
  return (await app.evaluate(
    async ({ webContents }, a: { src: string; arg: unknown; frames: boolean }) => {
      // `isEmbedGuestUrl`, inlined: this body runs in Electron main.
      const isGuest = (url: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(url);
      // The newest guest: a page navigation remounts the pane, and the old view may linger a moment.
      const wc = webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && isGuest(w.getURL()))
        .sort((x, y) => y.id - x.id)[0];
      if (wc === undefined) return { ok: false };
      const code = `(${a.src})(${JSON.stringify(a.arg)})`;
      if (!a.frames) return { ok: true, value: await wc.executeJavaScript(code, true) };
      const out: unknown[] = [];
      for (const f of wc.mainFrame.framesInSubtree) {
        if (f === wc.mainFrame || f.detached) continue;
        try {
          out.push(await f.executeJavaScript(code, true));
        } catch {
          /* a frame mid-navigation or gone */
        }
      }
      return { ok: true, value: out };
    },
    { src, arg, frames },
  )) as GuestAnswer<R>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `get` until it returns a value other than undefined; throws `what` (plus the last `diag`) on timeout. */
export async function until<T>(what: string, timeoutMs: number, get: () => Promise<T | undefined>, diag?: () => Promise<unknown>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await get().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`embed: timed out after ${timeoutMs} ms waiting for ${what}${diag ? ` ${JSON.stringify(await diag().catch((e: unknown) => String(e)))}` : ""}`);
    await sleep(250);
  }
}

/** The mounted pane's guest; waits until Electron main has one. */
export async function embedGuest(app: ElectronApplication, timeoutMs = 120_000): Promise<EmbedGuest> {
  const guest: EmbedGuest = {
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => {
      const r = await inGuest<R>(app, fn.toString(), arg, false);
      if (!r.ok) throw new Error("embed: no embedded Lecturn pane is mounted");
      return r.value;
    },
    evaluateFrames: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => {
      const r = await inGuest<R[]>(app, fn.toString(), arg, true);
      if (!r.ok) throw new Error("embed: no embedded Lecturn pane is mounted");
      return r.value;
    },
  };
  await until("the embedded Lecturn pane's guest", timeoutMs, async () => ((await inGuest<boolean>(app, "() => true", null, false)).ok ? true : undefined));
  return guest;
}

/** A PNG of the pane's guest (Electron's own `capturePage`; the view's pixels are not in the page's screenshot); null without one. */
export async function captureGuest(app: ElectronApplication): Promise<Buffer | null> {
  const png = await app.evaluate(async ({ webContents }) => {
    const wc = webContents
      .getAllWebContents()
      .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
      .sort((x, y) => y.id - x.id)[0];
    return wc === undefined ? null : (await wc.capturePage()).toPNG().toString("base64");
  });
  return png === null ? null : Buffer.from(png, "base64");
}

// ---- what the guest shows (run in the guest; nothing outside their bodies) ---------

export interface GuestView {
  /** "No threads in this project yet." (the embed's empty project). */
  empty: boolean;
  /** The composer is mounted (`setDraft` lands). */
  composer: boolean;
  /** The composer's text. */
  draft: string;
  /** The send button is enabled. */
  canSend: boolean;
  users: string[];
  assistants: string[];
  /** The view's whole text (a turn's later assistant texts render without their own message role). */
  text: string;
  /** The thread the guest's route shows (`/embed/<env>/<project>/<thread>`), or null. */
  threadId: string | null;
}

export function readGuestView(): GuestView {
  const text = (e: Element | null): string => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const editor = document.querySelector('[data-testid="composer-editor"]');
  const send = document.querySelector("button.lecturn-composer-send");
  return {
    empty: /No threads in this project yet/.test(document.body?.textContent ?? ""),
    composer: editor !== null,
    draft: text(editor),
    canSend: send instanceof HTMLButtonElement && !send.disabled,
    users: Array.from(document.querySelectorAll('[data-message-role="user"]')).map(text),
    assistants: Array.from(document.querySelectorAll('[data-message-role="assistant"]')).map(text),
    text: text(document.body),
    threadId: /^\/embed\/[^/]+\/[^/]+\/([^/?#]+)$/.exec(location.pathname)?.[1] ?? null,
  };
}

/** Clicks the composer's send button (the user's click); false when it is missing or disabled. */
export function clickSend(): boolean {
  const send = document.querySelector("button.lecturn-composer-send");
  if (!(send instanceof HTMLButtonElement) || send.disabled) return false;
  send.click();
  return true;
}

/** Scrolls the guest's timeline (its tallest scroller) to `fraction` of its range (0 top, 1 bottom); false without one. */
export function scrollTimeline(fraction: number): boolean {
  const scrollers = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  const el = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (el === undefined) return false;
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * fraction);
  return true;
}

/** A RocketWright step card frame's title (runs in the card frames); null for other frames. */
export function readStepCard(): string | null {
  const root = document.querySelector('[data-testid="rw.step-card"]');
  return root === null ? null : (root.querySelector('[data-testid="rw.step-card.title"]')?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** What the pane showed across its timeline (the timeline renders only rows near its viewport). */
export interface PaneScan {
  text: string[];
  stepCards: string[];
  runCards: (CardFrameFacts | null)[];
}

/**
 * Scrolls the guest's timeline bottom to top, collecting its text and its
 * cards (step titles, run card facts) at each stop, until `done` holds for
 * what was seen (then leaves it at the bottom); throws with the scan on
 * timeout.
 */
export async function scanPane(guest: EmbedGuest, done: (seen: PaneScan) => boolean, timeoutMs = 60_000): Promise<PaneScan> {
  const seen: PaneScan = { text: [], stepCards: [], runCards: [] };
  return until(
    "the pane's reply and cards",
    timeoutMs,
    async () => {
      for (const f of [1, 0.75, 0.5, 0.25, 0]) {
        await guest.evaluate(scrollTimeline, f);
        await sleep(300);
        seen.text.push((await guest.evaluate(readGuestView, null)).text);
        seen.stepCards.push(...(await guest.evaluateFrames(readStepCard, null)).filter((t): t is string => t !== null));
        seen.runCards.push(...(await guest.evaluateFrames(readCardFrame, null)).filter((c) => c !== null));
        if (done(seen)) {
          await guest.evaluate(scrollTimeline, 1);
          return seen;
        }
      }
      return undefined;
    },
    async () => ({ stepCards: seen.stepCards, runCards: seen.runCards.slice(-6), text: seen.text.at(-1) }),
  );
}

// ---- the host side: the page's bridge -----------------------------------------------

/** A guest event as the page heard it (main's `lecturn-embed:rw-to-host` `{type:"event"}`). */
export interface PaneEventRecord {
  event: string;
  payload: Record<string, unknown>;
  at: number;
}

interface PaneLog {
  __rwB14PaneEvents?: PaneEventRecord[];
}

/** Starts recording the guest's events in the page (again after a navigation: the page's listeners go with it). */
export async function recordPaneEvents(page: Page): Promise<void> {
  await page.evaluate((channel) => {
    const w = window as unknown as PaneLog & { rwDesktop?: { lecturn?: { onMessage?: (cb: (m: unknown) => void) => () => void } } };
    if (w.__rwB14PaneEvents !== undefined) return;
    const onMessage = w.rwDesktop?.lecturn?.onMessage;
    if (typeof onMessage !== "function") throw new Error(`no desktop preload in this page: ${channel} is unreachable`);
    const log: PaneEventRecord[] = (w.__rwB14PaneEvents = []);
    onMessage((m) => {
      const msg = m as { type?: unknown; event?: unknown; payload?: unknown };
      if (msg?.type === "event" && typeof msg.event === "string") log.push({ event: msg.event, payload: (msg.payload ?? {}) as Record<string, unknown>, at: Date.now() });
    });
  }, PANE_MAIN_CHANNEL);
}

export async function paneEvents(page: Page): Promise<PaneEventRecord[]> {
  return page.evaluate(() => [...((window as unknown as PaneLog).__rwB14PaneEvents ?? [])]);
}

/** One host → guest bridge command, sent as the page's `PaneBridge` sends it. */
export async function bridgeSend(page: Page, method: string, params: object): Promise<void> {
  await page.evaluate(
    ({ channel, message }) => {
      const ipc = (window as unknown as { lecturnEmbedIpc?: { send(c: string, p: unknown): void } }).lecturnEmbedIpc;
      if (ipc === undefined) throw new Error("no lecturnEmbedIpc in this page");
      ipc.send(channel, message);
    },
    { channel: EMBED_HOST_BRIDGE_CHANNEL, message: { method, params } },
  );
}

/** The turn states the guest reported for `threadId`, in order. */
export function turnStates(events: readonly PaneEventRecord[], threadId: string): string[] {
  return events.filter((e) => e.event === "lecturn/turn.state" && e.payload["threadId"] === threadId).map((e) => String(e.payload["state"]));
}

/** The turn is over: the thread went running (or awaiting approval) and is idle again. */
export function turnSettled(states: readonly string[]): boolean {
  const busy = states.findIndex((s) => s !== "idle");
  return busy >= 0 && states.slice(busy + 1).includes("idle") && states.at(-1) === "idle";
}

export interface SentTurn {
  threadId: string;
  /** The guest's turn states for the thread, in order. */
  states: string[];
  /** ms from the click on Send to the idle state. */
  durationMs: number;
}

/** Whitespace-collapsed text, as `readGuestView` reads the composer. */
const squash = (t: string): string => t.replace(/\s+/g, " ").trim();

/**
 * A new thread in the pane (`lecturn/thread.new`, created by the Lecturn
 * server for the app, D32): its id from the guest's `lecturn/thread.changed`
 * or route, once it differs from the thread shown before. A command that
 * lands before the guest's handshake settles is dropped, so it is resent
 * (at most `tries` times, 15 s apart).
 */
export async function newThread(app: ElectronApplication, page: Page, o: { title: string; tries?: number; timeoutMs?: number; log?: (line: string) => void }): Promise<string> {
  const guest = await embedGuest(app);
  await recordPaneEvents(page);
  const before = (await paneEvents(page)).length;
  const prev = (await guest.evaluate(readGuestView, null)).threadId;
  let sent = 0;
  let lastSend = 0;
  const threadId = await until(
    "the new thread (lecturn/thread.new)",
    o.timeoutMs ?? 90_000,
    async () => {
      const e = (await paneEvents(page)).slice(before).find((x) => x.event === "lecturn/thread.changed" && typeof x.payload["threadId"] === "string" && x.payload["threadId"] !== prev);
      if (e !== undefined) return e.payload["threadId"] as string;
      const v = await guest.evaluate(readGuestView, null);
      if (v.threadId !== null && v.threadId !== prev) return v.threadId;
      if (sent < (o.tries ?? 4) && Date.now() - lastSend > 15_000) {
        await bridgeSend(page, "lecturn/thread.new", { title: o.title });
        sent++;
        lastSend = Date.now();
      }
      return undefined;
    },
    async () => ({ events: await paneEvents(page), sent }),
  );
  o.log?.(`embed: thread ${threadId}`);
  return threadId;
}

/**
 * The prompt as the open thread's draft (`lecturn/composer.setDraft`,
 * resent until the composer shows it), then the user's click on Send.
 */
export async function draftAndSend(app: ElectronApplication, page: Page, prompt: string): Promise<void> {
  const guest = await embedGuest(app);
  const want = squash(prompt);
  // setDraft reaches only a mounted composer: resend until the draft shows.
  await until(
    "the prompt in the composer",
    60_000,
    async () => {
      const v = await guest.evaluate(readGuestView, null);
      if (v.composer && v.draft.includes(want) && v.canSend) return true;
      if (v.composer && !v.draft.includes(want)) await bridgeSend(page, "lecturn/composer.setDraft", { text: prompt });
      return undefined;
    },
    () => guest.evaluate(readGuestView, null),
  );
  if (!(await guest.evaluate(clickSend, null))) throw new Error("embed: the composer's send button is disabled");
}

/**
 * The user's B4 turn through the pane: a new thread (`newThread`), the
 * prompt as its draft and the send button (`draftAndSend`), then
 * `lecturn/turn.state` until the thread is idle again (unless `wait:
 * false`). The page must show the embed with no thread open yet (a fresh
 * project). `beforeSend` runs once the thread exists (B16 sets Supervised
 * there and waits for the composer to show it).
 */
export async function sendTurn(
  app: ElectronApplication,
  page: Page,
  o: { prompt: string; title: string; timeoutMs?: number; wait?: boolean; log?: (line: string) => void; beforeSend?: (threadId: string) => Promise<void> },
): Promise<SentTurn> {
  const log = o.log ?? (() => undefined);
  const guest = await embedGuest(app);
  await recordPaneEvents(page);
  // The view subscribes to host commands as it renders the project; before that a command is dropped.
  await until("the embed's empty project", 120_000, async () => ((await guest.evaluate(readGuestView, null)).empty ? true : undefined), () => guest.evaluate(readGuestView, null));
  const threadId = await newThread(app, page, { title: o.title, log });
  await o.beforeSend?.(threadId);
  await draftAndSend(app, page, o.prompt);
  const t0 = Date.now();
  log("embed: sent");
  if (o.wait === false) return { threadId, states: turnStates(await paneEvents(page), threadId), durationMs: 0 };
  const states = await until(
    "the turn to settle (lecturn/turn.state idle)",
    o.timeoutMs ?? 180_000,
    async () => {
      const s = turnStates(await paneEvents(page), threadId);
      return turnSettled(s) ? s : undefined;
    },
    async () => ({ states: turnStates(await paneEvents(page), threadId), view: await guest.evaluate(readGuestView, null) }),
  );
  return { threadId, states, durationMs: Date.now() - t0 };
}

// ---- B16: approvals, modes, the copied thread, trusted clicks ---------------------

/** An app approval card as the guest shows it (`[data-app-tool-approval]`, Lecturn's composer banner). */
export interface ApprovalCardView {
  /** `Approve Simulate engine` (the tool title). */
  label: string;
  /** The mono reason line (`app-approval-reason`), or "". */
  reason: string;
  visible: boolean;
}

/** The app approval cards on screen now (runs in the guest). */
export function readApprovalCards(): ApprovalCardView[] {
  // The embedded banner lays the card out with `display: contents` (pin6), so its own box is 0x0: any rendered descendant counts.
  const shows = (e: Element): boolean => {
    const r = e.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) || Array.from(e.children).some(shows);
  };
  return Array.from(document.querySelectorAll("[data-app-tool-approval]")).map((e) => {
    return {
      label: e.getAttribute("aria-label") ?? "",
      reason: (e.querySelector('[data-testid="app-approval-reason"]')?.textContent ?? "").replace(/\s+/g, " ").trim(),
      visible: shows(e),
    };
  });
}

/**
 * Records every app approval card that appears from now on, however
 * briefly, until the guest reloads (runs in the guest; `reset` clears what
 * was recorded). Read back with `approvalCardsSeen`.
 */
export function watchApprovalCards(reset: boolean): number {
  const w = window as unknown as { __rwB16Cards?: string[]; __rwB16Watch?: MutationObserver };
  w.__rwB16Cards ??= [];
  if (reset) w.__rwB16Cards.length = 0;
  const record = (): void => {
    for (const e of document.querySelectorAll("[data-app-tool-approval]")) {
      const key = `${e.getAttribute("aria-label") ?? ""} | ${(e.querySelector('[data-testid="app-approval-reason"]')?.textContent ?? "").replace(/\s+/g, " ").trim()}`;
      if (!w.__rwB16Cards!.includes(key)) w.__rwB16Cards!.push(key);
    }
  };
  record();
  if (w.__rwB16Watch === undefined) {
    w.__rwB16Watch = new MutationObserver(record);
    w.__rwB16Watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  return w.__rwB16Cards.length;
}

/** The cards `watchApprovalCards` recorded (`<aria-label> | <reason>`; runs in the guest); null when no watch runs (the guest reloaded). */
export function approvalCardsSeen(): string[] | null {
  const w = window as unknown as { __rwB16Cards?: string[] };
  return w.__rwB16Cards === undefined ? null : [...w.__rwB16Cards];
}

/** The composer's runtime mode label (`Supervised`, `Full access`, `Auto`; runs in the guest), or null. */
export function readRuntimeMode(): string | null {
  const text = (e: Element): string => (e.textContent ?? "").replace(/\s+/g, " ").trim();
  const picker = document.querySelector('[aria-label="Runtime mode"]');
  if (picker !== null) return text(picker);
  // The embed's footer (`embed-composer-footer`) shows the mode as one of its buttons.
  const labels = ["Supervised", "Auto-accept edits", "Full access", "Auto"];
  for (const b of document.querySelectorAll('[data-testid="embed-composer-footer"] button')) if (labels.includes(text(b))) return text(b);
  return null;
}

/** A sidecar thread that was copied to the user's server (Lecturn D33), as the guest shows it (runs in the guest). */
export interface ContinuedView {
  /** `[data-embed-continued="true"]` is on the page. */
  marked: boolean;
  /** "Continued in Lecturn" is shown. */
  notice: boolean;
  /** The notice's "Open in Lecturn" link. */
  link: string | null;
  /** A visible composer (a read-only thread has none). */
  composer: boolean;
}

export function readContinued(): ContinuedView {
  const visible = (e: Element): boolean => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  };
  const link = Array.from(document.querySelectorAll("a")).find((a) => /Open in Lecturn/.test(a.textContent ?? "") || a.getAttribute("aria-label") === "Open in Lecturn");
  return {
    marked: document.querySelector('[data-embed-continued="true"]') !== null,
    notice: /Continued in Lecturn/.test(document.body?.textContent ?? ""),
    link: link?.getAttribute("href") ?? null,
    composer: Array.from(document.querySelectorAll('[data-testid="composer-editor"]')).some(visible),
  };
}

/** The live guest webContents (loopback `/embed/` URLs), newest first. */
export async function guestContents(app: ElectronApplication): Promise<{ id: number; url: string }[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
      .sort((x, y) => y.id - x.id)
      .map((w) => ({ id: w.id, url: w.getURL() })),
  );
}

export interface TrustedClick {
  clicked: boolean;
  /** Where the click landed in the guest (DIP), or why it did not. */
  detail: string;
}

/**
 * Clicks `selector` inside an MCP Apps card frame with trusted input
 * (B14: a scripted `.click()` there is not a user activation, so the card's
 * `ui/open-link` never fires). In Electron main: the element's centre in its
 * frame, plus the frame's `<iframe>` box in the guest (matched by URL, then
 * by size; scrolled into view), hit-tested, then `sendInputEvent`
 * mouseDown/mouseUp on the guest's webContents. Newest frames first.
 */
export async function trustedClickInFrame(app: ElectronApplication, selector: string): Promise<TrustedClick> {
  return app.evaluate(async ({ webContents }, sel: string) => {
    const wc = webContents
      .getAllWebContents()
      .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
      .sort((x, y) => y.id - x.id)[0];
    if (wc === undefined) return { clicked: false, detail: "no embedded Lecturn pane" };
    const frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame && !f.detached && f.parent === wc.mainFrame).reverse();
    for (const f of frames) {
      let inner: { x: number; y: number; w: number; h: number } | null = null;
      try {
        inner = (await f.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!(el instanceof HTMLElement)) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight }; })()`,
          true,
        )) as typeof inner;
      } catch {
        continue;
      }
      if (inner === null) continue;
      const at = (await wc.executeJavaScript(
        `(() => {
          const want = ${JSON.stringify(f.url)}, inner = ${JSON.stringify(inner)};
          const all = Array.from(document.querySelectorAll("iframe"));
          const byUrl = all.filter((e) => e.src === want);
          const bySize = (list) => list.filter((e) => Math.abs(e.clientWidth - inner.w) <= 1 && Math.abs(e.clientHeight - inner.h) <= 1);
          const pick = byUrl.length === 1 ? byUrl[0] : (bySize(byUrl.length > 0 ? byUrl : all).length === 1 ? bySize(byUrl.length > 0 ? byUrl : all)[0] : null);
          if (!pick) return { error: "no unique iframe for " + want + " (" + byUrl.length + " by url)" };
          pick.scrollIntoView({ block: "center" });
          const r = pick.getBoundingClientRect();
          const x = Math.round(r.left + pick.clientLeft + inner.x), y = Math.round(r.top + pick.clientTop + inner.y);
          return { x, y, hit: document.elementFromPoint(x, y) === pick };
        })()`,
        true,
      )) as { x: number; y: number; hit: boolean } | { error: string };
      if ("error" in at) return { clicked: false, detail: at.error };
      if (!at.hit) return { clicked: false, detail: `(${at.x}, ${at.y}) does not hit the card's iframe` };
      wc.focus();
      wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
      wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
      return { clicked: true, detail: `(${at.x}, ${at.y}) in ${f.url.split("?")[0] ?? ""}` };
    }
    return { clicked: false, detail: `no card frame shows ${sel}` };
  }, selector);
}

// ---- B16b: the composer strip's chips and the reply's ref chips (W-B2 step 3) -----

/** The composer strip's chips (`[data-testid="app-ref-chip"]`, Lecturn `AppRefChipStrip`; runs in the guest). */
export function readStripChips(): { ref: string; label: string }[] {
  return Array.from(document.querySelectorAll('[data-testid="app-ref-chip"]')).map((e) => ({
    ref: e.getAttribute("data-app-ref") ?? "",
    label: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** Where the reply's `ref` chip is, in guest DIP (runs in the guest). */
export type ChipPoint = { x: number; y: number; hit: boolean; count: number } | { error: string };

/**
 * The last activatable `ref` chip in the timeline (`button[data-app-ref]`,
 * Lecturn `AppRefChip` in message text), outside the user's own message
 * and the composer strip, scrolled into view: its centre and whether that
 * point hits it (runs in the guest).
 */
export function replyChipPoint(ref: string): ChipPoint {
  const all = Array.from(document.querySelectorAll("button[data-app-ref]")).filter(
    (e) => e.getAttribute("data-app-ref") === ref && e.closest('[data-message-role="user"]') === null && e.closest('[data-testid="app-ref-chip-strip"]') === null,
  );
  const el = all[all.length - 1];
  if (!(el instanceof HTMLElement)) return { error: `no ${ref} chip in the reply` };
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { error: `the reply's ${ref} chip has no box` };
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const at = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
  return { x, y, hit: at !== null && (at === el || el.contains(at)), count: all.length };
}

/**
 * The user's click on the reply's `ref` chip with trusted input (B16b, as
 * `trustedClickInFrame` for card frames): `replyChipPoint` in the guest's
 * main frame from Electron main, then `sendInputEvent` mouseDown/mouseUp on
 * the guest's webContents at that point.
 */
export async function trustedClickInGuest(app: ElectronApplication, ref: string): Promise<TrustedClick> {
  return app.evaluate(
    async ({ webContents }, a: { src: string; ref: string }) => {
      const wc = webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/embed\//.test(w.getURL()))
        .sort((x, y) => y.id - x.id)[0];
      if (wc === undefined) return { clicked: false, detail: "no embedded Lecturn pane" };
      const at = (await wc.executeJavaScript(`(${a.src})(${JSON.stringify(a.ref)})`, true)) as { x: number; y: number; hit: boolean; count: number } | { error: string };
      if ("error" in at) return { clicked: false, detail: at.error };
      if (!at.hit) return { clicked: false, detail: `(${at.x}, ${at.y}) does not hit the reply's chip` };
      wc.focus();
      wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
      wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
      return { clicked: true, detail: `(${at.x}, ${at.y}), the last of ${at.count}` };
    },
    { src: replyChipPoint.toString(), ref },
  );
}
