/**
 * The window's link to the app server (D19). A dropped socket retries on this
 * schedule; when it runs out the server is gone, and since a respawned server
 * has a new port and token, only a relaunch brings it back.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 8000];

export type LinkStatus =
  | { kind: "online" }
  | { kind: "reconnecting" }
  /** No reconnect worked: the server is gone. */
  | { kind: "lost"; reason: string };
