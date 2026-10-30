/**
 * `--measure` module for the desktop hidden window (`make bar-visual`): DOM
 * token report of the loaded shell page. The page id comes from the page
 * itself (`window.__rwShell.page`, set by the web entry from `?page=`).
 *
 * D31: with the Lecturn embed as the agent pane, the desktop also hands the
 * embed's webContents (`embed`, a `PageLike` over the guest). A second pass
 * reads the `embed` selectors of tests/bar/tokens.json and regions.json in
 * it (Lecturn's `data-slot`, `data-message-role`, `data-timeline-row-id` and
 * test-id hooks; nothing RocketWright-owned is inside the pane), offset by the
 * embed rect (`[data-testid="agent.embed"]`, the rect the view is mounted
 * over), and locates the pane probes. `measureCapture` then samples those
 * probes from the composite capture.
 */
import type { PageLike } from "../regions.ts";
import { measureDom, measurePanePixels, type EmbedContext, type TokenReport } from "../visual-tokens.ts";
import { isPageId } from "./paths.ts";
import { decodePng } from "./png.ts";

function shellPage(): string | null {
  const s = (window as unknown as { __rwShell?: { status: string; page?: string } }).__rwShell;
  return s?.status === "ready" ? (s.page ?? null) : null;
}

/** The embed rect's top-left in the main page, or null when the page shows no embed (the old chat). */
function embedOrigin(): { x: number; y: number } | null {
  const el = document.querySelector('[data-testid="agent.embed"]');
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: Math.round(r.x), y: Math.round(r.y) } : null;
}

/** The embed context for the second pass: null without a guest or without an embed rect. */
export async function embedContext(page: PageLike, embed: PageLike | null): Promise<EmbedContext | null> {
  if (embed === null) return null;
  const origin = await page.evaluate(embedOrigin, null);
  return origin === null ? null : { page: embed, origin };
}

export default async function measure(page: PageLike, embed: PageLike | null = null): Promise<TokenReport> {
  const id = await page.evaluate(shellPage, null);
  if (id === null || !isPageId(id)) throw new Error(`shell page not ready or unknown: ${String(id)}`);
  return measureDom(page, id, undefined, undefined, await embedContext(page, embed));
}

/** D31: the pane probes sampled from the composite capture (PNG bytes); a report without them is returned as is. */
export function measureCapture(report: TokenReport, png: Uint8Array): TokenReport {
  return report.panePixels === undefined ? report : measurePanePixels(report, decodePng(png));
}
