/**
 * CPW1R5A: the capture's guest waits (`capture/embed.ts`). r4 saw page 03's
 * guest never get ready (90 s) and page 04's step card frame load
 * "Not Found" once; the waits now draw frames for a mounted guest that is
 * not ready, reload it once, and reload the guest when a card frame loaded
 * an error page instead of its card.
 */
import { describe, expect, it } from "vitest";
import { failedCardDocs, MAX_CARD_RELOADS, readyGuest, recoverCardFrames } from "../capture/embed.ts";
import type { DriveContext, GuestLike } from "../capture/hooks.ts";

function fakeGuest(o: { ready?: boolean; docs?: { card: boolean; text: string }[] } = {}) {
  const log = { frames: 0, reloads: [] as string[] };
  const g = {
    generation: 1,
    ready: o.ready ?? false,
    docs: o.docs ?? [],
    evaluate: async () => {
      throw new Error("not used");
    },
    evaluateFrames: async () => g.docs as never,
    frame: async () => void log.frames++,
    reload: (why: string) => {
      log.reloads.push(why);
      g.ready = false;
      return true;
    },
  };
  return { g: g as typeof g & GuestLike, log };
}

const ctxOf = (guest: () => GuestLike | null): DriveContext => ({ page: null as never, rpcUrl: null, serverUrl: null, guest });

describe("readyGuest (CPW1R5A)", () => {
  it("returns the ready guest at once", async () => {
    const { g } = fakeGuest({ ready: true });
    expect(await readyGuest(ctxOf(() => g), 1_000)).toBe(g);
  });

  it("draws frames for a mounted guest that is not ready, reloads it once, and is ready after", async () => {
    const { g, log } = fakeGuest();
    let polls = 0;
    const ctx = ctxOf(() => {
      polls++;
      // Ready on the document after the reload.
      if (log.reloads.length > 0 && polls > 6) g.ready = true;
      return g;
    });
    expect(await readyGuest(ctx, 2_000, { reloadAfterMs: 20, sleepMs: 10 })).toBe(g);
    expect(log.frames).toBeGreaterThanOrEqual(1);
    expect(log.reloads).toEqual(["the guest was not ready"]);
  });

  it("names the stuck state when it times out", async () => {
    await expect(readyGuest(ctxOf(() => null), 50, { sleepMs: 10 })).rejects.toThrow(/not ready after 50 ms \(no pane mounted\)/);
    const { g, log } = fakeGuest();
    await expect(readyGuest(ctxOf(() => g), 80, { reloadAfterMs: 10, sleepMs: 10 })).rejects.toThrow(/mounted \(generation 1\) but sent no lecturn\/ready; reloaded once/);
    expect(log.reloads).toHaveLength(1);
  });
});

describe("card frames that loaded an error page (CPW1R5A)", () => {
  it("finds HTTP error pages, never cards or frames still blank", () => {
    expect(
      failedCardDocs([
        { card: true, text: "" },
        { card: false, text: "Not Found" },
        { card: false, text: "" },
        { card: false, text: "Some other page" },
      ]),
    ).toEqual(["Not Found"]);
  });

  it("reloads the guest for a failed card frame, at most MAX_CARD_RELOADS times, then fails loudly", async () => {
    const { g, log } = fakeGuest({ docs: [{ card: true, text: "" }, { card: false, text: "Not Found" }] });
    const spent = { reloads: 0 };
    for (let i = 0; i < MAX_CARD_RELOADS; i++) expect(await recoverCardFrames(g, spent, "page 04")).toBe(true);
    expect(log.reloads).toHaveLength(MAX_CARD_RELOADS);
    await expect(recoverCardFrames(g, spent, "page 04")).rejects.toThrow(/page 04: 1 card frame\(s\) show "Not Found" instead of the card after 2 guest reload\(s\)/);
    // All cards loaded: nothing to do.
    g.docs = [{ card: true, text: "" }];
    expect(await recoverCardFrames(g, { reloads: 0 }, "page 04")).toBe(false);
  });
});
