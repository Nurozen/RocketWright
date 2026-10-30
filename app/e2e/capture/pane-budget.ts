/**
 * The embedded pane's height budget (CPW1R3A, recalibrated CPW1R4A, B7e): each
 * page's checklist composition has to be in view in the pane's timeline
 * without scrolling. CP-W1 round 2 captured the pane scrolled to the bottom
 * with the user bubble, tool rows and cards above the fold (01, 04, 06).
 *
 * The composition is the turn the capture shows last: the live scripted
 * turn on 01 and 06 (`scripted/visual-0N.json`), the opened thread's last
 * turn of the bundle on 02-05 (`fixtures/threads/0N.json`, which
 * `convert-threads.ts` turns into the bundle).
 *
 * The sizes were measured in Lecturn pin4's CP-W1 round 3 captures
 * (1536 x 1024, 352 px timeline), at Lecturn's desktop type scale in the embed; pin5 (B7e) keeps
 * them and only drops rows (FIXJ, below):
 * - Lecturn keeps the timeline at its bottom: the latest turn's last item
 *   sits a fixed gap above the composer box of `tests/bar/regions.json`
 *   (22 px with the approval card in it on 01 and 06, 69 px on the imported
 *   pages), and the turn fits when its user bubble's text is under the
 *   embed's top (the bubble's 12 px top padding may be cut).
 * - A user bubble's row keeps 50 px under the bubble (the hover row with the
 *   time and copy buttons). A live reply has the agent's name over it.
 * - Pin4 drew a live turn's "Working for" row and, for the call awaiting
 *   approval, its in-progress row. Pin5's embed (Lecturn FIXJ) drops both,
 *   and the thinking row, while an approval waits (the approval card is in
 *   the composer box), so a live turn the harness leaves on its pending
 *   approval (every visual scenario: `scripted.ts` leaves exactly one) has
 *   neither: about 84 px freed on 01, where the step card's row and card
 *   (88 px) now fit.
 * - Lecturn imports a bundle as run-less history and keeps no imported turn
 *   open, so card-less rows next to each other fold into one "Used
 *   RocketWright integration" row (no chevron, no per-tool label): a
 *   problem for the shown turn, whose rows the checklists want one per call
 *   (the agent's text between calls would not help: Lecturn folds an
 *   imported turn's interim text behind a turn fold row).
 *
 * - CP-W1 r4 (measured in the guest's DOM): Lecturn frames every MCP Apps
 *   card at least `MCP_APP_MIN_HEIGHT` (80 px) tall, so the one-row step
 *   card takes 80 px, not the 42 px its content needs (01, 02 and 04 had
 *   their user bubbles pushed out of the pane); the narrow run card's chart
 *   is 90 px (was 130), its card 232 px.
 *
 * These are estimates (about ±5 px a page); the capture's own measurement
 * is `pane-checks.ts` `view.out` (reported in the bar report).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixture, messageText, type ThreadFixture } from "../fixtures/convert-threads.ts";
import { REPO_ROOT, type PageId } from "../bar/paths.ts";
import { TOOL_CARDS, bareTool, type CardKind, type VisualScenario } from "./scripted.ts";

/** One timeline item of a turn, top to bottom. */
export type PaneItem =
  | { kind: "user"; text: string }
  /** A live turn's "Working for" row (pin4; pin5 hides it while an approval waits). */
  | { kind: "working" }
  | { kind: "tool"; name: string }
  | { kind: "card"; card: CardKind }
  | { kind: "reply"; text: string }
  /** A live call awaiting approval: its in-progress row (pin4; pin5 hides it while its approval waits in the composer). */
  | { kind: "pending"; name: string }
  /** A row per try: what a scripted `poll` draws. */
  | { kind: "poll"; name: string; tries: number };

/** Pixel sizes at the desktop type scale (px), measured in the CP-W1 r3 captures. */
export const PX = {
  /** The user bubble: its padding and a line of text (a chip line is as tall). */
  bubblePad: 19,
  bubbleLine: 24,
  /** The user bubble's top padding: cut by the embed's top, the text is still in view. */
  bubbleTopPad: 12,
  /** Under the bubble: the hover row (time, copy) and the gap to the next row; to a live turn's "Working for" row. */
  userGap: 50,
  userGapLive: 56,
  /** The "Working for" row with the gap under it. */
  working: 38,
  /** An app tool row (chevron, icon, label, check); rows follow each other with no gap. */
  toolRow: 28,
  /** A tool row to its card; a card to the next row. */
  rowCard: 8,
  cardRow: 10,
  /** A line of the agent's text, and the gap above it under a row, under a card; a row under text (a live reply, then the pending call). */
  textLine: 21,
  textAfterRow: 11,
  textAfterCard: 33,
  rowAfterText: 12,
  /** A live reply's agent name (with its gaps), above the text instead of the gap. */
  agentName: 31,
  /** The cards' narrow forms at 352 px: run (head, three stat rows, 90 px chart), visual view card, one-row step card (Lecturn's 80 px minimum frame), render card. */
  cards: { flight: 232, engine: 232, visual: 81, step: 80, render: 96 } satisfies Record<CardKind, number>,
  /** How much taller the r3 captures' run cards were (130 px chart), for the calibration against them. */
  r3RunCard: 40,
} as const;

/** Characters per line: the user bubble (beside the avatar) and the agent's text (full width), 14 px Inter (r3: 06's 101-character reply is two lines). */
export const CHARS = { bubble: 36, reply: 51 } as const;

/** Top of the embed rect per page (r3: under CPW1R3B's strip on 02 and 05; 03 the round-2 bound). */
export const EMBED_TOP: Readonly<Record<PageId, number>> = { "01": 125, "02": 432, "03": 239, "04": 125, "05": 343, "06": 125 };

/** The gap between the latest item and the composer box: with the approval card in it (01, 06), and without (02-05). */
export const BOTTOM_GAP = { live: 22, imported: 69 } as const;

const LIVE_PAGES: readonly PageId[] = ["01", "06"];

const REGIONS = join(REPO_ROOT, "tests/bar/regions.json");

/** The composer box's top (the embed composer rect of `regions.json`). */
export function composerTop(page: PageId, regionsPath = REGIONS): number {
  const r = JSON.parse(readFileSync(regionsPath, "utf8")) as { pages: Record<string, { embed?: { rects?: { composer?: number[] } } }> };
  const box = r.pages[page]?.embed?.rects?.composer;
  if (box === undefined || box.length !== 4) throw new Error(`regions.json: page ${page} has no embed composer rect`);
  return box[1]!;
}

/** The page's timeline height: embed top to the latest item's bottom limit (px). */
export const timelineBudget = (page: PageId, regionsPath?: string): number =>
  composerTop(page, regionsPath) - (LIVE_PAGES.includes(page) ? BOTTOM_GAP.live : BOTTOM_GAP.imported) - EMBED_TOP[page];

/** An `rw:` ref's chip label as the host resolver gives it (a title-cased last segment). */
export function chipLabel(ref: string): string {
  const last = ref.replace(/^rw:/, "").split("/").filter((s) => !/^\d+$/.test(s)).at(-1) ?? ref;
  return last.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Lines a text wraps to: each `rw:` ref is a chip (its label plus the chip's icon and padding). */
export function lines(text: string, perLine: number): number {
  const width = text.replace(/rw:[^\s)]+/g, (ref) => `${chipLabel(ref)}#####`).trim().length;
  return Math.max(1, Math.ceil(width / perLine));
}

/** The item's height with the gap above it (which depends on the item before it). */
export function itemHeight(item: PaneItem, prev: PaneItem | undefined): number {
  const afterUser = prev?.kind === "user";
  switch (item.kind) {
    case "user":
      return PX.bubblePad + lines(item.text, CHARS.bubble) * PX.bubbleLine;
    case "working":
      return PX.userGapLive + PX.working;
    case "tool":
    case "pending":
      return (afterUser ? PX.userGap : prev?.kind === "card" ? PX.cardRow : prev?.kind === "reply" ? PX.rowAfterText : 0) + PX.toolRow;
    case "poll":
      return (afterUser ? PX.userGap : 0) + item.tries * (PX.toolRow + PX.rowCard + PX.cards.flight + PX.cardRow);
    case "card":
      return PX.rowCard + PX.cards[item.card];
    case "reply": {
      const lead = afterUser ? PX.userGap : prev?.kind === "card" ? PX.textAfterCard : PX.textAfterRow;
      return lead + lines(item.text, CHARS.reply) * PX.textLine;
    }
  }
}

/** The turn's height, bubble top to the latest item's bottom; a live reply carries the agent's name. */
export function compositionHeight(items: readonly PaneItem[], live = false): number {
  return items.reduce((h, item, i) => {
    const prev = items[i - 1];
    // The agent's name sits over a live reply: 31 px under a card, 3 px more under a row.
    if (live && item.kind === "reply") return h + PX.agentName + (prev?.kind === "card" ? 0 : PX.textAfterRow - PX.rowCard) + lines(item.text, CHARS.reply) * PX.textLine;
    return h + itemHeight(item, prev);
  }, 0);
}

/** Which Lecturn draws the live turn: pin4 (the "Working for" and pending-call rows) or pin5 (FIXJ: neither while the approval waits). */
export type LiveRows = "pin4" | "pin5";

/**
 * The live turn of a scenario, held on its last call's approval: the user
 * message, a row per completed call (its card under it) and the reply. The
 * last call's approval card is in the composer; pin5 (the vendored pin)
 * draws nothing else, pin4 drew the "Working for" row under the bubble and
 * the held call's in-progress row last.
 */
export function scenarioItems(s: Pick<VisualScenario, "user" | "script" | "cards">, rows: LiveRows = "pin5"): PaneItem[] {
  const items: PaneItem[] = [{ kind: "user", text: s.user }];
  if (rows === "pin4") items.push({ kind: "working" });
  const cards = [...s.cards];
  const calls = s.script.filter((st) => "toolCall" in st || "poll" in st);
  const pending = calls.at(-1);
  for (const st of s.script) {
    if (st === pending) {
      if (rows === "pin4") items.push({ kind: "pending", name: "toolCall" in st ? st.toolCall.name : "poll" in st ? st.poll.toolCall.name : "" });
      break;
    }
    if ("assistantText" in st) items.push({ kind: "reply", text: st.assistantText });
    else if ("poll" in st) items.push({ kind: "poll", name: st.poll.toolCall.name, tries: st.poll.maxTries ?? 2 });
    else if ("toolCall" in st) {
      items.push({ kind: "tool", name: st.toolCall.name });
      if (TOOL_CARDS[bareTool(st.toolCall.name)] !== undefined) {
        const card = cards.shift();
        if (card !== undefined) items.push({ kind: "card", card });
      }
    }
  }
  return items;
}

/**
 * The opened (last) thread's last turn of a bundle fixture, as the
 * converter imports it: a row per step (its card under it), then a row and
 * card per message card (render cards stay plain rows), the reply.
 */
export function bundleTurnItems(fixture: ThreadFixture): PaneItem[] {
  const t = fixture.threads.at(-1);
  if (t === undefined) return [];
  const users = t.messages.filter((m) => m.role === "user");
  const user = users.at(-1);
  if (user === undefined) return [];
  const reply = t.messages.at(-1)?.role === "assistant" ? t.messages.at(-1)! : null;
  const items: PaneItem[] = [{ kind: "user", text: messageText(user) }];
  if (reply === null) return items;
  for (const s of reply.steps ?? []) {
    items.push({ kind: "tool", name: s.tool });
    if (s.card !== undefined) items.push({ kind: "card", card: s.card.kind === "run" ? "flight" : s.card.kind });
  }
  for (const c of reply.cards ?? []) {
    items.push({ kind: "tool", name: c.kind === "run" ? "simulate" : c.kind === "step" ? "model_patch" : "render" });
    if (c.kind === "run") items.push({ kind: "card", card: "flight" });
    else if (c.kind === "step") items.push({ kind: "card", card: "step" });
  }
  items.push({ kind: "reply", text: messageText(reply) });
  return items;
}

/** Rows Lecturn folds into one "Used …" row in an imported (run-less) turn: runs of card-less rows next to each other. */
export function foldedRows(items: readonly PaneItem[]): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  items.forEach((item, i) => {
    const plain = item.kind === "tool" && items[i + 1]?.kind !== "card";
    if (plain) run.push(item.name);
    // A row that heads its card ends a run, as anything else does.
    if (!plain || i === items.length - 1) {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  });
  return runs;
}

export interface PaneBudget {
  page: PageId;
  /** A live scripted turn (01, 06) or an imported bundle turn (02-05). */
  live: boolean;
  items: PaneItem[];
  height: number;
  budget: number;
}

/** A page's composition against its timeline (01 and 06: `visual-01`/`visual-06`; 02-05: the bundle fixture). */
export function pageBudget(page: PageId, o: { scenario?: Pick<VisualScenario, "user" | "script" | "cards">; fixture?: ThreadFixture; regionsPath?: string; rows?: LiveRows } = {}): PaneBudget {
  const live = o.scenario !== undefined;
  const items = live ? scenarioItems(o.scenario!, o.rows) : bundleTurnItems(o.fixture ?? loadFixture(page));
  return { page, live, items, height: compositionHeight(items, live), budget: timelineBudget(page, o.regionsPath) };
}

/** Why a composition does not fit or does not show a row per call (empty: it does). */
export function budgetProblems(b: PaneBudget): string[] {
  const out: string[] = [];
  for (const i of b.items) if (i.kind === "poll") out.push(`${b.page}: ${i.name} polls (${i.tries} rows and cards); one row per call`);
  if (!b.live) for (const run of foldedRows(b.items)) out.push(`${b.page}: ${run.join(", ")} fold into one "Used RocketWright integration" row (an imported turn); keep a card or the agent's text between them`);
  if (b.height - PX.bubbleTopPad > b.budget) out.push(`${b.page}: the turn needs about ${b.height} px, the pane's timeline has ${b.budget} px (the user bubble's text out of view)`);
  return out;
}
