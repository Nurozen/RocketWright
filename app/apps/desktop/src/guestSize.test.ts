/**
 * CPW2B: `pnpm --filter @rw/desktop test -- guestSize`. The pane guest's
 * sizing wait (page 02's first-layout race: the guest 381x522, its bounds
 * 381x568) draws frames and re-applies the bounds until the viewport
 * matches, and fails with both sizes after its bound.
 */
import { describe, expect, it } from "vitest";
import { sizedAt, waitGuestSized, type GuestSizeDeps, type GuestViewport } from "./guestSize.ts";
import type { Rect } from "./lecturn.ts";

const B: Rect = { x: 1157, y: 57, width: 381, height: 568 };

/** A fake clock and guest: the viewport follows the bounds only after `framesToFollow` frames. */
function fake(framesToFollow: number, opts: { nudgeOnly?: boolean } = {}) {
  let t = 0;
  let frames = 0;
  const applied: Rect[] = [];
  let v: GuestViewport = { w: 381, h: 522, doc: 522 };
  const deps: GuestSizeDeps = {
    bounds: () => B,
    read: () => Promise.resolve(v),
    frame: () => {
      frames++;
      if (!opts.nudgeOnly && frames >= framesToFollow) v = { w: B.width, h: B.height, doc: B.height };
      return Promise.resolve();
    },
    setBounds: (b) => {
      applied.push(b);
      if (opts.nudgeOnly && b.height === B.height) v = { w: b.width, h: b.height, doc: b.height };
    },
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
  return { deps, applied, frames: () => frames };
}

describe("guest sizing wait (CPW2B)", () => {
  it("matches a viewport at its bounds within a pixel, with the document fitting", () => {
    expect(sizedAt({ w: 381, h: 568, doc: 568 }, B)).toBe(true);
    expect(sizedAt({ w: 382, h: 567, doc: 568 }, B)).toBe(true);
    expect(sizedAt({ w: 381, h: 522, doc: 522 }, B)).toBe(false);
    expect(sizedAt({ w: 381, h: 568, doc: 600 }, B)).toBe(false);
  });

  it("draws guest frames until the viewport follows the bounds, then passes", async () => {
    const f = fake(3);
    expect(await waitGuestSized(f.deps, 5_000)).toBeNull();
    expect(f.frames()).toBe(3);
  });

  it("re-applies the bounds (one pixel off, then back) when frames alone do not resize the guest", async () => {
    const f = fake(Number.POSITIVE_INFINITY, { nudgeOnly: true });
    expect(await waitGuestSized(f.deps, 5_000)).toBeNull();
    expect(f.applied).toEqual([{ ...B, height: B.height - 1 }, B]);
  });

  it("fails after its bound naming both sizes", async () => {
    const f = fake(Number.POSITIVE_INFINITY);
    const { setBounds: _, ...framesOnly } = f.deps;
    const why = await waitGuestSized(framesOnly, 2_000);
    expect(why).toBe("the agent pane's guest is not laid out at its bounds after 2000 ms: the guest is 381x522 (document 522 px tall), its bounds 381x568");
  });

  it("keeps waiting through a guest mid-navigation or not mounted yet", async () => {
    let n = 0;
    const f = fake(1);
    const why = await waitGuestSized(
      {
        ...f.deps,
        read: () => {
          n++;
          if (n === 1) return Promise.resolve(null);
          if (n === 2) return Promise.reject(new Error("navigating"));
          return f.deps.read();
        },
      },
      5_000,
    );
    expect(why).toBeNull();
    expect(n).toBe(4);
  });
});
