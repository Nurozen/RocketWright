/**
 * What the embedded pane must show before a page 01 or 06 capture is
 * composited (plan B13, W5.1; D22 no-switcher row): read in the Lecturn
 * guest (`readPaneMain`, its main frame) and in each MCP Apps card frame
 * (`readCardFrame`), then judged by `paneFailures`. Any failure aborts the
 * capture.
 *
 * The selectors are Lecturn's own (`scripts/bar/checklists/embed.json` at
 * the pin): `mcp-app-card`, `app-approval-card`, `app-ref-chip-strip` /
 * `app-ref-chip[data-app-ref]`, `embed-composer-footer`,
 * `embed-thread-switcher`. Inside the run card: B3's `#root` with
 * `data-phase`, `data-kind`, `data-card-layout`, `data-card-chip`,
 * `data-card-stat` and the `data-card-chart` polyline (B3b); the step and
 * render cards' roots (`rw.step-card`, `rw.render-card`) report too.
 *
 * In view (CPW1R3A): `readPaneMain` also measures the live turn (the last
 * user bubble, the card rows after it and the last reply) against the
 * timeline's scroll box. That is reported (`view.out`), not failed: the
 * budget is `pane-budget.ts`, and the pin's type scale decides the rest.
 *
 * `readPaneMain` and `readCardFrame` run in the guest through
 * `executeJavaScript` (stringified), so they use nothing outside their body.
 */

import type { CardKind } from "./scripted.ts";

export interface PaneMainFacts {
  /** `[data-testid="mcp-app-card"]` rows. */
  cards: number;
  approvals: { title: string; buttons: string[]; visible: boolean }[];
  /** Chips in the composer strip, by `data-app-ref`, with a remove button or not. */
  chips: { ref: string; removable: boolean }[];
  footerButtons: string[];
  switcher: boolean;
  assistantMessages: number;
  /** The live turn against the timeline's scroll box (null: no scroll box found). */
  view: { box: [number, number]; out: string[] } | null;
}

export interface CardFrameFacts {
  /** flight | engine | visual (run card), step, render; null for another frame. */
  kind: string | null;
  phase: string | null;
  layout: string | null;
  chip: string | null;
  title: string | null;
  stats: number;
  /** Points of the chart polyline (0 without a chart). */
  points: number;
  /** A step or render card still waiting: its text, for the failure message. */
  text?: string;
}

/** The guest's main frame (runs in the guest). */
export function readPaneMain(): PaneMainFacts {
  const visible = (e: Element): boolean => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const text = (e: Element | null): string => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const strip = document.querySelector('[data-testid="app-ref-chip-strip"]');
  return {
    cards: document.querySelectorAll('[data-testid="mcp-app-card"]').length,
    approvals: Array.from(document.querySelectorAll('[data-testid="app-approval-card"]')).map((c) => ({
      title: text(c.querySelector('[data-testid="app-approval-title"]')),
      buttons: Array.from(c.querySelectorAll("button")).map((b) => text(b)).filter((t) => t !== ""),
      visible: visible(c),
    })),
    chips:
      strip === null
        ? []
        : Array.from(strip.querySelectorAll('[data-testid="app-ref-chip"]')).map((c) => ({
            ref: c.getAttribute("data-app-ref") ?? text(c),
            removable: c.querySelector('[data-testid="app-ref-chip-remove"]') !== null,
          })),
    footerButtons: Array.from(document.querySelectorAll('[data-testid="embed-composer-footer"] button')).map((b) => text(b)),
    switcher: document.querySelector('[data-testid="embed-thread-switcher"]') !== null,
    assistantMessages: document.querySelectorAll('[data-message-role="assistant"]').length,
    view: (() => {
      const box = document.querySelector(".messages-timeline-scroll");
      if (box === null) return null;
      const b = box.getBoundingClientRect();
      const users = Array.from(box.querySelectorAll('[data-message-role="user"]'));
      const user = users.at(-1) ?? null;
      const after = (e: Element) => user === null || (user.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const items: [string, Element][] = [];
      if (user !== null) items.push(["user bubble", user.querySelector("[data-chat-user-message-bubble]") ?? user]);
      Array.from(box.querySelectorAll('[data-testid="mcp-app-card"]'))
        .filter(after)
        .forEach((c, i) => items.push([`card ${i + 1}`, c]));
      const reply = Array.from(box.querySelectorAll('[data-message-role="assistant"]')).filter(after).at(-1);
      if (reply !== undefined) items.push(["reply", reply]);
      const out = items.flatMap(([name, e]) => {
        const r = e.getBoundingClientRect();
        return r.top < b.top - 1 || r.bottom > b.bottom + 1 ? [`${name} (${Math.round(r.top - b.top)}..${Math.round(r.bottom - b.top)} of ${Math.round(b.height)})`] : [];
      });
      return { box: [Math.round(b.top), Math.round(b.bottom)] as [number, number], out };
    })(),
  };
}

/** One card frame (runs in the frame): null unless it is a RocketWright card. */
export function readCardFrame(): CardFrameFacts | null {
  const root = document.getElementById("root");
  if (root === null) return null;
  const testid = root.getAttribute("data-testid");
  if (testid === "rw.step-card" || testid === "rw.render-card") {
    const step = testid === "rw.step-card";
    const compare = root.querySelector<HTMLButtonElement>('[data-testid="rw.step-card.compare"]');
    const ready = step ? compare !== null && !compare.disabled : root.querySelector('[data-testid="rw.render-card.thumb"]') !== null;
    return {
      kind: step ? "step" : "render",
      phase: ready ? "complete" : "waiting",
      layout: root.getAttribute("data-card-layout") ?? root.getAttribute("data-form"),
      chip: root.querySelector("[data-card-chip]")?.textContent?.trim() ?? null,
      title: root.querySelector("[data-card-title]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      stats: 0,
      points: 0,
      ...(ready ? {} : { text: (root.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160) }),
    };
  }
  if (!root.hasAttribute("data-phase")) return null;
  const line = root.querySelector("[data-card-chart] polyline");
  const pts = (line?.getAttribute("points") ?? "").trim();
  return {
    kind: root.getAttribute("data-kind"),
    phase: root.getAttribute("data-phase"),
    layout: root.getAttribute("data-card-layout"),
    chip: root.querySelector("[data-card-chip]")?.textContent?.trim() ?? null,
    title: root.querySelector("[data-card-title]")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    stats: root.querySelectorAll("[data-card-stat]").length,
    points: pts === "" ? 0 : pts.split(/\s+/).length,
  };
}

export interface PaneWant {
  /** The live turn's cards (`VisualScenario.cards`). */
  cards: readonly CardKind[];
  mention: string;
}

const RUN_KINDS: readonly string[] = ["flight", "engine", "visual"];

/** Why one wanted card is not ready (empty: it is). Run cards are counted: one, not a duplicate per poll. */
function cardFailures(kind: CardKind, frames: readonly CardFrameFacts[], rows: number): string[] {
  const mine = frames.filter((c) => c.kind === kind);
  const label = RUN_KINDS.includes(kind) ? `${kind} run card` : `${kind} card`;
  if (mine.length === 0) return [`no ${label} frame reports in (mcp-app-card rows: ${rows})`];
  if (RUN_KINDS.includes(kind) && mine.length > 1) return [`${mine.length} ${label}s, not one`];
  if (kind === "flight" || kind === "engine") {
    const done = mine.find((c) => c.phase === "complete" && c.points >= 2);
    if (done === undefined) return [`the ${label} is not ready: ${JSON.stringify(mine)}`];
    const f: string[] = [];
    if (done.layout !== "narrow") f.push(`the run card is in the ${String(done.layout)} form, not narrow`);
    if (done.chip !== "Saved") f.push(`the run card chip reads ${JSON.stringify(done.chip)}, not Saved`);
    if (done.stats !== 3) f.push(`the run card shows ${done.stats} stats, not 3`);
    return f;
  }
  return mine.some((c) => c.phase === "complete" && (c.title ?? "") !== "") ? [] : [`the ${label} is not ready: ${JSON.stringify(mine)}`];
}

/** Why the pane is not ready for the capture (empty: it is). */
export function paneFailures(main: PaneMainFacts | null, frames: readonly (CardFrameFacts | null)[], want: PaneWant): string[] {
  if (main === null) return ["no embedded Lecturn pane"];
  const f: string[] = [];
  const cards = frames.filter((c): c is CardFrameFacts => c !== null);
  for (const kind of new Set(want.cards)) f.push(...cardFailures(kind, cards, main.cards));
  const shown = main.approvals.filter((a) => a.visible);
  if (shown.length !== 1) f.push(`${shown.length} app approval cards are visible, not 1`);
  else if (!shown[0]!.buttons.includes("Decline") || !shown[0]!.buttons.includes("Approve")) f.push(`the approval card's buttons are ${JSON.stringify(shown[0]!.buttons)}`);
  const chip = main.chips.find((c) => c.ref === want.mention);
  if (chip === undefined) f.push(`no ${want.mention} chip in the composer strip (${JSON.stringify(main.chips)})`);
  else if (!chip.removable) f.push(`the ${want.mention} chip has no remove button`);
  if (!main.footerButtons.includes("Supervised")) f.push(`the composer does not show Supervised (${JSON.stringify(main.footerButtons)})`);
  if (main.switcher) f.push("the pane renders a thread switcher");
  return f;
}
