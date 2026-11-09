/**
 * View zoom (R0.10, D7): CSS `zoom` on the document element, so everything,
 * body-level overlays included, scales together and the agent pane's rect stays
 * matched to what is painted.
 *
 * Steps stop at 1.25 on purpose: at the 1024 minimum window that is 819 CSS px
 * wide, still above the 792 where the header loses the project menu.
 */
import type { ZoomDirection } from "@rw/contracts";

export const ZOOM_DEFAULT = 1;
export const ZOOM_LEVELS: readonly number[] = [0.8, 0.9, ZOOM_DEFAULT, 1.1, 1.25];

export function nextZoom(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return ZOOM_DEFAULT;
  const at = ZOOM_LEVELS.indexOf(current);
  const next = at + (direction === "in" ? 1 : -1);
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, next))]!;
}

/** The pane reports its rect only on a resize or scroll, and a zoom change alone fires neither (U05). */
export function applyZoom(win: Window, level: number): void {
  win.document.documentElement.style.setProperty("zoom", String(level));
  win.dispatchEvent(new Event("resize"));
}
