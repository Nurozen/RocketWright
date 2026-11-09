/**
 * The server's one path to Electron main for consent (D11): a `host.request`
 * push answered by `host.respond`, on the socket that claimed the channel with
 * the stdout secret. The renderer holds the RPC token too, so holding that
 * token must never be enough to answer.
 *
 * No timer: a dialog waits on a person, and the deadline belongs to the caller
 * (D10), which passes a `signal`. One request at a time: the second is refused
 * as `busy`, never queued behind a dialog the agent would time out on.
 */
import { randomUUID } from "node:crypto";
import type { HostRequest, HostResponse } from "@rw/contracts";

export type HostChannelFailure =
  /** No main socket holds the channel. */
  | "no_host"
  /** Another request is waiting for its answer. */
  | "busy"
  /** The main socket went away (or the server is closing) before answering. */
  | "disconnected"
  /** The caller's `signal` fired. */
  | "aborted";

export class HostChannelError extends Error {
  readonly code: HostChannelFailure;
  constructor(code: HostChannelFailure, message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (response: HostResponse) => void;
  reject: (e: HostChannelError) => void;
}

export class HostChannel<Owner> {
  private owner: Owner | null = null;
  private send: ((request: HostRequest) => void) | null = null;
  /** Stays true after the owner leaves: one registration per launch, however it ends. */
  private claimed = false;
  private readonly pending = new Map<string, Pending>();

  /** Binds the channel to `owner` unless it was ever claimed; false means refused. */
  claim(owner: Owner, send: (request: HostRequest) => void): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    this.owner = owner;
    this.send = send;
    return true;
  }

  /** Pushes one request to the owner and resolves with its answer; rejects with a `HostChannelError`. */
  request(request: Omit<HostRequest, "requestId">, signal?: AbortSignal): Promise<HostResponse> {
    const send = this.send;
    if (send === null) return Promise.reject(new HostChannelError("no_host", "no main window holds the host channel"));
    if (this.pending.size > 0) return Promise.reject(new HostChannelError("busy", "another host request is waiting for its answer"));
    if (signal?.aborted === true) return Promise.reject(new HostChannelError("aborted", "the host request was aborted"));
    const requestId = randomUUID();
    return new Promise<HostResponse>((resolve, reject) => {
      const onAbort = (): void => {
        // A late answer now finds nothing pending, so it cannot act on a request the caller gave up on.
        this.pending.delete(requestId);
        reject(new HostChannelError("aborted", "the host request was aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = (): void => signal?.removeEventListener("abort", onAbort);
      this.pending.set(requestId, {
        resolve: (response) => {
          done();
          resolve(response);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      send({ ...request, requestId });
    });
  }

  /** Settles the request `response` answers; false if none is pending under that id. */
  respond(response: HostResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (entry === undefined) return false;
    this.pending.delete(response.requestId);
    entry.resolve(response);
    return true;
  }

  /** The owner's socket closed: nothing can answer any more. */
  dropOwner(owner: Owner): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.send = null;
    this.failAll("the main window's socket closed before answering");
  }

  /** Fails every waiting request (the owner left, or the server is closing). */
  failAll(why: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(new HostChannelError("disconnected", why));
  }
}
