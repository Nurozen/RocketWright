/**
 * Waits until the embedded pane's guest is laid out at its bounds before a
 * hidden run measures or captures it (CP-W1 r4, CPW2B).
 *
 * The guest's viewport follows the pane rect asynchronously, and the hidden
 * window draws no frames of its own: a pane that grew after its first
 * layout (page 02: the guest 381x522, its bounds 381x568) can keep its old
 * viewport until something draws. So every poll that does not match draws
 * one guest frame, and about once a second the bounds are re-applied (one
 * pixel off, then back) so the view resizes the guest again. After the
 * bounded wait it fails with both sizes.
 */
import type { Rect } from "./lecturn.ts";

/** The guest's viewport and document height (CSS px). */
export interface GuestViewport {
  w: number;
  h: number;
  doc: number;
}

export interface GuestSizeDeps {
  /** The pane's current bounds (the latest pane rect). */
  bounds(): Rect;
  /** The guest's viewport; null without a live guest. Rejects while it navigates. */
  read(): Promise<GuestViewport | null>;
  /** Draws one guest frame (a capture); never rejects. */
  frame(): Promise<void>;
  /** Re-applies `bounds` to the view, forcing a resize; absent: frames only. */
  setBounds?(bounds: Rect): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** Default bound of the wait. */
export const GUEST_SIZE_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
/** Polls between bounds re-applications. */
const NUDGE_EVERY = 10;

/** True when the guest's viewport equals `b` (1 px slack) and its document fits. */
export function sizedAt(v: GuestViewport, b: Rect): boolean {
  return Math.abs(v.w - b.width) <= 1 && Math.abs(v.h - b.height) <= 1 && v.doc <= v.h + 1;
}

export function describeSize(v: GuestViewport, b: Rect): string {
  return `the guest is ${v.w}x${v.h} (document ${v.doc} px tall), its bounds ${b.width}x${b.height}`;
}

/** Null once the guest is laid out at its bounds; otherwise, after `timeoutMs`, why not (both sizes). */
export async function waitGuestSized(deps: GuestSizeDeps, timeoutMs = GUEST_SIZE_TIMEOUT_MS): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let last = "no guest";
  for (let poll = 1; ; poll++) {
    const b = deps.bounds();
    if (b.width > 0 && b.height > 0) {
      let v: GuestViewport | null = null;
      try {
        v = await deps.read();
        if (v === null) last = "no guest";
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (v !== null) {
        if (sizedAt(v, b)) return null;
        last = describeSize(v, b);
        if (deps.setBounds !== undefined && poll % NUDGE_EVERY === 0) {
          deps.setBounds({ ...b, height: b.height - 1 });
          deps.setBounds(b);
        }
        await deps.frame();
      }
    } else {
      last = "the pane has no bounds yet";
    }
    if (now() > deadline) return `the agent pane's guest is not laid out at its bounds after ${timeoutMs} ms: ${last}`;
    await sleep(POLL_MS);
  }
}
