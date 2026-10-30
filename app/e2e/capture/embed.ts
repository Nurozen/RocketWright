/**
 * The embedded pane's capture state for pages 01 and 06 (plan B13, W5.1):
 * the page's Lecturn bundle imported (`app_seed_thread {bundle}`), the
 * scenario's live turn staged in its thread with the scripted provider
 * (`scripted.ts`), the host's `insertMention` (the window's mention event,
 * as the viewport's `@` sends it), then the guest checked
 * (`pane-checks.ts`). A failed check throws, which aborts the capture
 * before it is composited.
 *
 * Needs the Lecturn sidecar's base dir (`RW_LECTURN_BASE_DIR`), the scripts
 * file (`LECTURN_SCRIPTED_PROVIDER_SCRIPTS`) and `LECTURN_TEST_PROVIDERS=1`
 * in the desktop's environment (`app/e2e/bar/visual.ts` sets them).
 */
import { bundleTitles, loadBundle, type DriveContext, type GuestLike, type Hooks } from "./hooks.ts";
import { paneFailures, readCardFrame, readPaneMain, type CardFrameFacts, type PaneMainFacts } from "./pane-checks.ts";
import { LecturnAdmin, loadScenario, runScenario } from "./scripted.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls before a mounted guest that never got ready is reloaded once (CPW1R5A). */
export const NOT_READY_RELOAD_MS = 30_000;

/**
 * The mounted, ready guest (polls `ctx.guest`). While a mounted guest is not
 * ready it draws frames for it (the hidden window's view draws none on its
 * own, so a guest whose first paint waits on one would never report ready),
 * and reloads it once after `reloadAfterMs` (CPW1R5A: r4's page 03 waited
 * the whole 90 s). The timeout's message says which state it was stuck in.
 */
export async function readyGuest(ctx: DriveContext, timeoutMs = 120_000, o: { reloadAfterMs?: number; sleepMs?: number } = {}): Promise<GuestLike> {
  if (ctx.guest === undefined) throw new Error("capture: this desktop build hands drive modules no pane guest");
  const start = Date.now();
  const deadline = start + timeoutMs;
  const reloadAfter = o.reloadAfterMs ?? Math.min(NOT_READY_RELOAD_MS, timeoutMs / 3);
  let state = "no pane mounted";
  let reloaded = false;
  let framedAt = 0;
  for (;;) {
    const g = ctx.guest();
    if (g !== null && g.ready) return g;
    if (g !== null) {
      state = `a guest is mounted (generation ${g.generation}) but sent no lecturn/ready`;
      if (Date.now() - framedAt >= 1_000) {
        framedAt = Date.now();
        await g.frame?.();
      }
      if (!reloaded && g.reload !== undefined && Date.now() - start >= reloadAfter) {
        reloaded = true;
        if (g.reload("the guest was not ready")) process.stderr.write(`capture: the pane's guest was not ready after ${Date.now() - start} ms; reloaded it\n`);
      }
    }
    if (Date.now() > deadline) throw new Error(`capture: the embedded pane's guest was not ready after ${timeoutMs} ms (${state}${reloaded ? "; reloaded once" : ""})`);
    await sleep(o.sleepMs ?? 200);
  }
}

/** A child frame's document (runs in each frame): a RocketWright card, or the text of what loaded instead. */
export function readFrameDoc(): { card: boolean; text: string } {
  const root = document.getElementById("root");
  const card = root !== null && (root.hasAttribute("data-phase") || (root.getAttribute("data-testid") ?? "").startsWith("rw."));
  return { card, text: card ? "" : (document.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) };
}

/** Lecturn's asset route answers a card URL it cannot serve with a plain status page (`http.ts`). */
export const HTTP_ERROR_PAGE = /^(Not Found|Bad Request|Forbidden|Unauthorized|Internal Server Error)$/;

/** The texts of card frames that loaded an HTTP error page instead of the card. */
export function failedCardDocs(docs: readonly { card: boolean; text: string }[]): string[] {
  return docs.filter((d) => !d.card && HTTP_ERROR_PAGE.test(d.text)).map((d) => d.text);
}

/** Guest reloads a capture spends on failed card frames before it gives up. */
export const MAX_CARD_RELOADS = 2;

/**
 * CPW1R5A (r4's page 04 once drew its step card as "Not Found"): a card
 * frame keeps the first asset URL Lecturn minted for it and cannot report a
 * failed load, so one URL the asset route refused (on a fresh base dir,
 * Lecturn's asset signing key is created on the first mint, and concurrent
 * first mints can sign with a key not fully written yet) stays an error
 * page. A reloaded guest mints every card URL again. Returns true when it
 * reloaded; throws once `MAX_CARD_RELOADS` reloads did not help.
 */
export async function recoverCardFrames(g: GuestLike, spent: { reloads: number }, label: string): Promise<boolean> {
  const failed = failedCardDocs(await g.evaluateFrames(readFrameDoc, null));
  if (failed.length === 0) return false;
  const what = `${failed.length} card frame(s) show ${JSON.stringify(failed[0])} instead of the card`;
  if (spent.reloads >= MAX_CARD_RELOADS || g.reload === undefined) throw new Error(`capture: ${label}: ${what} after ${spent.reloads} guest reload(s)`);
  spent.reloads += 1;
  process.stderr.write(`capture: ${label}: ${what}; reloading the guest (${spent.reloads}/${MAX_CARD_RELOADS})\n`);
  return g.reload("a card frame failed to load");
}

/** The MCP Apps card frames the timeline holds (runs in the guest). */
export function countCardIframes(): number {
  return document.querySelectorAll('[data-testid="mcp-app-card"] iframe').length;
}

/** The pane's facts now (main frame and card frames). */
export async function readPane(guest: GuestLike): Promise<{ main: PaneMainFacts; cards: (CardFrameFacts | null)[] }> {
  return { main: await guest.evaluate(readPaneMain, null), cards: await guest.evaluateFrames(readCardFrame, null) };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`capture: ${name} is not set (app/e2e/bar/visual.ts sets it for embedded captures)`);
  return v;
}

/**
 * Seeds the page's bundle, stages `scenario` and waits until the pane passes
 * every check; throws with the failures and the last facts otherwise.
 */
export async function stageEmbedPane(ctx: DriveContext, hooks: Hooks, o: { page: string; scenario: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
  const scenario = loadScenario(o.scenario);
  const titles = bundleTitles(loadBundle(o.page));
  if (titles.at(-1) !== scenario.thread) throw new Error(`capture: ${o.scenario} runs in ${scenario.thread}, but the ${o.page} bundle opens ${String(titles.at(-1))}`);
  // The pane's bridge is up before the seed, so the window can open the bundle's last thread in it.
  const guest = await readyGuest(ctx);
  const seeded = await hooks.seedBundle(o.page);
  const admin = await LecturnAdmin.open(env("RW_LECTURN_BASE_DIR"));
  const run = await runScenario({ admin, threadId: seeded.threadId, scenario, scriptsFile: env("LECTURN_SCRIPTED_PROVIDER_SCRIPTS"), log: (l) => process.stderr.write(`${l}\n`) });
  // The host's insertMention: the same window event the viewport's `@` sends (B12 wiring).
  await ctx.page.evaluate((m) => void window.dispatchEvent(new CustomEvent("rw:mention", { detail: m })), scenario.mention);
  const pane = await verifyEmbedPane(ctx, o.scenario, o.timeoutMs ?? 90_000);
  return { threads: seeded.threadIds, opened: seeded.threadId, scenario: o.scenario, run, ...pane, startGeneration: guest.generation };
}

/**
 * What a seeded (bundle-only) thread shows in the guest: its messages, the
 * open-thread switcher's absence, the composer (a Settled thread shows a
 * banner instead), and the timeline revealed with its fade-in done.
 */
export function readSeededThread(): { users: number; assistants: number; switcher: boolean; composer: boolean; revealed: boolean } {
  const revealed =
    document.querySelector(".lecturn-timeline-reveal[data-timeline-ready]") !== null &&
    !document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
  return {
    users: document.querySelectorAll('[data-message-role="user"]').length,
    assistants: document.querySelectorAll('[data-message-role="assistant"]').length,
    switcher: document.querySelector('[data-testid="embed-thread-switcher"]') !== null,
    composer: document.querySelector('[data-slot="composer-shell"]') !== null,
    revealed,
  };
}

/** Lecturn's timeline is revealed (`data-timeline-ready`) and no finite animation still runs (runs in the guest). */
export function timelineRevealed(): boolean {
  if (document.querySelector(".lecturn-timeline-reveal[data-timeline-ready]") === null) return false;
  return !document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
}

/** Each MCP Apps card row's iframe (src origin, size) or its text, for a failed check's message (runs in the guest). */
export function readCardRows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="mcp-app-card"]')).map((row) => {
    const f = row.querySelector("iframe");
    if (f === null) return `no iframe: ${(row.textContent ?? "").trim().slice(0, 120)}`;
    const r = f.getBoundingClientRect();
    return `iframe ${f.src.slice(0, 60)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  });
}

/**
 * Pages 02-05 (and 06's Engineering tier) with the embed (B15, D31): imports
 * the page's Lecturn bundle (`hooks.seedBundle`, B13), opens
 * its last thread in the pane, and waits until the guest renders that
 * thread's exchange. No live turn: these pages show the bundle only.
 */
export async function seedEmbedThreads(ctx: DriveContext, hooks: Hooks, page: string, timeoutMs = 90_000): Promise<{ threads: string[]; opened: string; generation: number }> {
  await readyGuest(ctx, timeoutMs);
  const seeded = await hooks.seedBundle(page);
  const deadline = Date.now() + timeoutMs;
  const spent = { reloads: 0 };
  for (;;) {
    const g = await readyGuest(ctx, Math.max(1_000, deadline - Date.now()));
    await g.frame?.();
    const facts = await g.evaluate(readSeededThread, null);
    // Every card frame has loaded its card (CPW1R5A: a frame that loaded an error page reloads the guest).
    const docs = await g.evaluateFrames(readFrameDoc, null);
    const cards = { frames: await g.evaluate(countCardIframes, null), loaded: docs.filter((d) => d.card).length };
    const shown = facts.users > 0 && facts.assistants > 0 && !facts.switcher && facts.composer && facts.revealed;
    if (shown && failedCardDocs(docs).length > 0 && (await recoverCardFrames(g, spent, `page ${page}`))) continue;
    if (shown && cards.loaded >= cards.frames) return { threads: seeded.threadIds, opened: seeded.threadId, generation: g.generation };
    if (Date.now() > deadline) throw new Error(`capture: the embedded pane does not show the ${page} bundle's thread: ${JSON.stringify({ ...facts, cards })}`);
    await sleep(500);
  }
}

/**
 * Waits until the pane passes every check for `scenarioName` (the state
 * `stageEmbedPane` staged; a capture that ran long re-checks it right
 * before the still); throws with the failures and the last facts.
 */
export async function verifyEmbedPane(ctx: DriveContext, scenarioName: string, timeoutMs = 30_000): Promise<{ pane: Awaited<ReturnType<typeof readPane>>; generation: number }> {
  const scenario = loadScenario(scenarioName);
  const want = { cards: scenario.cards, mention: scenario.mention.ref };
  const deadline = Date.now() + timeoutMs;
  const spent = { reloads: 0 };
  for (;;) {
    const g = await readyGuest(ctx, Math.max(1_000, deadline - Date.now()));
    await g.frame?.();
    if (await recoverCardFrames(g, spent, scenarioName)) continue;
    const facts = await readPane(g);
    const failures = paneFailures(facts.main, facts.cards, want);
    if (!(await g.evaluate(timelineRevealed, null))) failures.push("the timeline is not revealed yet");
    if (failures.length === 0) {
      // Reported, not failed (pane-checks.ts): what of the live turn is scrolled out of the pane.
      const out = facts.main.view?.out ?? [];
      if (out.length > 0) process.stderr.write(`capture: ${scenarioName}: out of view in the pane: ${out.join("; ")}\n`);
      return { pane: facts, generation: g.generation };
    }
    if (Date.now() > deadline) {
      const cardRows = await g.evaluate(readCardRows, null).catch((e: unknown) => [String(e)]);
      throw new Error(`capture: the embedded pane is not in the ${scenarioName} state:\n  ${failures.join("\n  ")}\n${JSON.stringify(facts)}\ncard rows: ${JSON.stringify(cardRows)}`);
    }
    await sleep(500);
  }
}
