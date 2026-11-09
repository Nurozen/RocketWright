/**
 * Where the agent pane is in a B3 surface capture (Electron-free). Three cases:
 * no pane at all (Welcome, New project), a visible guest (composited as on any
 * page), or an overlay over the pane. The page draws the last one itself: main
 * snapshots the guest and the page shows the frame as `agent.embed-snapshot`
 * (`lecturn.ts`, D11). A composite there would paint the guest over the overlay.
 */
import { intersects, type Rect } from "./lecturn.ts";

export type PaneCase = "absent" | "visible" | "overlay";

/** The DOM facts the classification needs. */
export interface PaneDomView {
  embed: Rect | null;
  overlays: Rect[];
}

/** The page's own overlay selector (`W/embed/bridge.ts` `OVERLAY_SELECTOR`; a test keeps them equal). */
export const PANE_OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [data-rw-overlay]';

/** Run in the page: the embed's rect and every overlay outside it, as `bridge.ts`'s scanner sees them. */
export const PANE_DOM_VIEW_SCRIPT = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const embed = document.querySelector('[data-testid="agent.embed"]');
  if (embed === null) return { embed: null, overlays: [] };
  return { embed: box(embed), overlays: [...document.querySelectorAll(${JSON.stringify(PANE_OVERLAY_SELECTOR)})].filter((e) => !embed.contains(e)).map(box) };
})()`;

export function classifyPane(view: PaneDomView): PaneCase {
  const { embed } = view;
  if (embed === null) return "absent";
  return view.overlays.some((o) => intersects(o, embed)) ? "overlay" : "visible";
}

/** Run in the page: true once the snapshot `<img>` has loaded. */
export const SNAPSHOT_SHOWN_SCRIPT = `(() => {
  const img = document.querySelector('[data-testid="agent.embed-snapshot"]');
  return img !== null && img.complete && img.naturalWidth > 0;
})()`;

/** Waits for the overlay's guest snapshot on the page. Null once shown; otherwise why not. */
export async function waitOverlaySnapshot(shown: () => Promise<boolean>, deadline: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | null> {
  for (;;) {
    if (await shown()) return null;
    if (Date.now() > deadline) return "an overlay covers the agent pane but its guest snapshot never appeared";
    await sleep(100);
  }
}
