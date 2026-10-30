/**
 * The embedded agent pane's bounds (CPW1R3B; B10, D10): on every page the
 * rect main mounts the Lecturn `WebContentsView` over is the pane slot, and
 * the slot runs to the bottom of the pane column with only the provenance
 * footer under it. CP-W1 round 2 found the view ending at y 807 on Results
 * (its taller history strip's band stayed in the pane's padding), ~200 px
 * short of the column.
 *
 * Desktop mode without Electron: the page gets the desktop preload's two
 * globals (`window.lecturnEmbedIpc`, `window.rwDesktop.lecturn`) as an init
 * script, so the pane runs `startDesktopPane` and `@lecturn/embed/renderer`'s
 * `reportPaneRect` exactly as in the app; the recorded
 * `lecturn-embed:pane-rect` messages are what main hands the helper's
 * `setBounds`.
 */
import { expect, test, type Page } from "@playwright/test";
import { EMBED_PANE_RECT_CHANNEL } from "../packages/contracts/src/embedPane.ts";

const WEB = process.env["RW_E2E_WEB_URL"] ?? "";
const RPC = process.env["RW_E2E_RPC_URL"] ?? "";
const HTTP = process.env["RW_E2E_HTTP_URL"] ?? "";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The desktop preload's globals, recording every embed IPC send. */
function fakeDesktopPreload(): void {
  const sent: [string, unknown][] = [];
  const w = window as unknown as Record<string, unknown>;
  w["__paneIpc"] = sent;
  w["lecturnEmbedIpc"] = { send: (channel: string, payload: unknown) => void sent.push([channel, payload]) };
  w["rwDesktop"] = { desktop: true, platform: "test", rpcUrl: null, serverUrl: null, lecturn: { onMessage: () => () => undefined } };
}

async function measure(page: Page): Promise<{ reported: Rect | null; slot: Rect; pane: Rect; footer: Rect | null; viewportHeight: number }> {
  return page.evaluate((channel) => {
    const box = (el: Element | null): Rect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const sent = (window as unknown as { __paneIpc: [string, Rect][] }).__paneIpc.filter(([c]) => c === channel);
    return {
      reported: sent.at(-1)?.[1] ?? null,
      slot: box(document.querySelector('[data-testid="agent.embed"]'))!,
      pane: box(document.querySelector('[data-testid="agent-pane"]'))!,
      footer: box(document.querySelector('[data-testid="agent.provenance-footer"]')),
      viewportHeight: window.innerHeight,
    };
  }, EMBED_PANE_RECT_CHANNEL);
}

test.beforeAll(() => {
  expect(WEB, "RW_E2E_WEB_URL from global-setup").not.toBe("");
});

for (const [id, name] of [
  ["01", "Design > Assembly"],
  ["02", "Design > Components"],
  ["03", "Design > Configurations"],
  ["04", "Results"],
  ["05", "Propulsion > Liquid"],
  ["06", "Simulate > Propulsion"],
] as const) {
  test(`page ${id} (${name}): the embed view's bounds are the pane slot, which runs to the pane bottom`, async ({ page }) => {
    await page.addInitScript(fakeDesktopPreload);
    await page.goto(`${WEB}?rpc=${encodeURIComponent(RPC)}&http=${encodeURIComponent(HTTP)}&page=${id}`);
    await page.waitForFunction(() => (window as { __rwShell?: { status: string } }).__rwShell?.status === "ready");
    const pane = page.getByTestId("agent-pane");
    await expect(pane).toHaveAttribute("data-embedded", "true");
    await expect(pane.getByTestId("agent.embed")).toHaveAttribute("data-mode", "desktop");
    // The page settles (history, rail and strip data arrive), and the last reported rect is the slot's.
    await expect
      .poll(async () => {
        const m = await measure(page);
        return JSON.stringify(m.reported) === JSON.stringify(m.slot);
      }, { timeout: 30_000 })
      .toBe(true);
    const m = await measure(page);
    expect(m.reported, "the bounds main mounts the view at").toEqual(m.slot);
    // The pane column is full height, and the slot fills it to the bottom: the provenance footer
    // (when shown) sits directly under the slot at the pane's bottom edge, nothing else below.
    expect(m.pane.y + m.pane.height).toBe(m.viewportHeight);
    const below = m.footer !== null ? m.footer.height : 0;
    expect(m.slot.y + m.slot.height, `slot bottom vs pane bottom ${String(m.pane.y + m.pane.height)}`).toBeGreaterThanOrEqual(m.pane.y + m.pane.height - below - 1);
    if (m.footer !== null) {
      expect(Math.abs(m.footer.y - (m.slot.y + m.slot.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(m.footer.y + m.footer.height - (m.pane.y + m.pane.height))).toBeLessThanOrEqual(1);
    }
    // The slot spans the column's width (inside its hairline border).
    expect(m.slot.width).toBeGreaterThanOrEqual(m.pane.width - 2);
  });
}
