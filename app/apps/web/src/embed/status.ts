/**
 * The child's Lecturn connection as the page sees it (B10): the last
 * `lecturn.status` push of a connection, kept per connection for
 * `useLecturnStatus`. The server sends one right after `hello`; `RpcClient`
 * keeps it (a sticky topic), and `main.tsx` starts tracking as soon as the
 * connection resolves.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { LecturnStatus } from "@rw/contracts";
import type { RpcLike } from "../state/rpc.ts";

interface Tracker {
  status: LecturnStatus | null;
  readonly listeners: Set<() => void>;
}

const trackers = new WeakMap<Pick<RpcLike, "on">, Tracker>();

/** Starts (once per connection) keeping the connection's last `lecturn.status`. */
export function trackLecturnStatus(client: Pick<RpcLike, "on">): { get(): LecturnStatus | null; subscribe(cb: () => void): () => void } {
  let t = trackers.get(client);
  if (t === undefined) {
    const tracker: Tracker = { status: null, listeners: new Set() };
    trackers.set(client, tracker);
    // Lives as long as the connection (`RpcClient` replays the last status to a new listener).
    client.on("lecturn.status", (s) => {
      tracker.status = s;
      for (const l of [...tracker.listeners]) l();
    });
    t = tracker;
  }
  const tr = t;
  return {
    get: () => tr.status,
    subscribe: (cb) => {
      tr.listeners.add(cb);
      return () => void tr.listeners.delete(cb);
    },
  };
}

const NONE = { get: () => null, subscribe: () => () => undefined };

/** The connection's last `lecturn.status` (null without a connection or before the first push). */
export function useLecturnStatus(client: Pick<RpcLike, "on"> | null): LecturnStatus | null {
  const src = useMemo(() => (client === null ? NONE : trackLecturnStatus(client)), [client]);
  return useSyncExternalStore(src.subscribe, src.get, src.get);
}
