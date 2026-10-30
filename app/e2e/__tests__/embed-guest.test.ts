/**
 * B16: the guest-side readers `app/e2e/embed.ts` runs in the Lecturn pane
 * (`executeJavaScript`), on a jsdom page carrying the pin's markup: the app
 * approval card (`[data-app-tool-approval]`, `app-approval-reason`), the
 * card watch, the runtime mode (picker or the embed footer), and the
 * read-only notice of a thread continued in Lecturn (D33).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../bar/paths.ts";
import { approvalCardsSeen, readApprovalCards, readContinued, readRuntimeMode, watchApprovalCards } from "../embed.ts";

// jsdom is the server package's test dependency (not hoisted to app/).
const { JSDOM } = createRequire(join(REPO_ROOT, "app/apps/server/package.json"))("jsdom") as { JSDOM: new (html: string) => { window: unknown } };

const saved: Record<string, unknown> = {};
function page(html: string): Window {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const w = dom.window as unknown as Window & typeof globalThis;
  // jsdom lays nothing out: elements marked data-box are "on screen".
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    const on = this.closest("[data-box]") !== null;
    return { width: on ? 10 : 0, height: on ? 10 : 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  for (const k of ["window", "document", "getComputedStyle", "MutationObserver", "HTMLElement"] as const) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = k === "window" ? w : (w as unknown as Record<string, unknown>)[k];
  }
  return w;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

const CARD = `<div data-composer-banner-row><span aria-label="Approve rw_engine_simulate" data-app-tool-approval="true" role="group" data-box>
  <span data-testid="app-approval-title">Approve rw_engine_simulate</span>
  <span aria-label="Reason" data-testid="app-approval-reason">Burn duration not set   · default 120 s</span></span></div>`;

describe("guest readers (embed.ts)", () => {
  it("reads the app approval card and records cards that come and go", async () => {
    const w = page(`<main id="m"></main>`);
    expect(readApprovalCards()).toEqual([]);
    expect(approvalCardsSeen()).toBeNull();
    expect(watchApprovalCards(true)).toBe(0);
    w.document.getElementById("m")!.innerHTML = CARD;
    await new Promise((r) => setTimeout(r, 0));
    expect(readApprovalCards()).toEqual([{ label: "Approve rw_engine_simulate", reason: "Burn duration not set · default 120 s", visible: true }]);
    w.document.getElementById("m")!.innerHTML = "";
    await new Promise((r) => setTimeout(r, 0));
    expect(approvalCardsSeen()).toEqual(["Approve rw_engine_simulate | Burn duration not set · default 120 s"]);
    expect(watchApprovalCards(true)).toBe(0);
    expect(approvalCardsSeen()).toEqual([]);
  });

  it("counts a card laid out with display: contents (0x0 itself) as on screen when its content is", () => {
    page(`<span aria-label="Approve Simulate engine" data-app-tool-approval="true"><span data-box>Approve Simulate engine</span>
      <span data-testid="app-approval-reason">Burn duration not set · default 120 s</span></span>`);
    expect(readApprovalCards()).toEqual([{ label: "Approve Simulate engine", reason: "Burn duration not set · default 120 s", visible: true }]);
    page(`<span aria-label="Approve Simulate engine" data-app-tool-approval="true"><span>Approve Simulate engine</span></span>`);
    expect(readApprovalCards()[0]?.visible).toBe(false);
  });

  it("reads the runtime mode from the picker, else the embed footer's buttons", () => {
    page(`<button aria-label="Runtime mode"> Full access </button>`);
    expect(readRuntimeMode()).toBe("Full access");
    page(`<div data-testid="embed-composer-footer"><button>Claude</button><button>Auto</button></div>`);
    expect(readRuntimeMode()).toBe("Auto");
    page(`<div data-testid="embed-composer-footer"><button>Claude</button></div>`);
    expect(readRuntimeMode()).toBeNull();
  });

  it("reads the read-only notice of a continued thread", () => {
    page(`<div data-embed-continued="true" data-box>Continued in Lecturn <a href="lecturn://apps/dev.rocketwright.app/threads/u/copy%3Ae%3As">Open in Lecturn</a></div>
      <div data-testid="composer-editor"></div>`);
    expect(readContinued()).toEqual({ marked: true, notice: true, link: "lecturn://apps/dev.rocketwright.app/threads/u/copy%3Ae%3As", composer: false });
    page(`<div data-box><div data-testid="composer-editor"></div></div>`);
    expect(readContinued()).toEqual({ marked: false, notice: false, link: null, composer: true });
  });
});
