/**
 * One Lecturn WebSocket RPC call with a bearer. Production: the thread launch
 * behind the project tools (`LecturnLink.startThreadInProject`, R1.3), which
 * runs each call under embed tokens. Test hooks and harnesses: the app's
 * `apps.importThreads` (the pinned helper's `LecturnConnection` does not
 * expose it) and the bar's admin orchestration calls.
 *
 * The wire is Lecturn's: `POST /api/auth/websocket-ticket` with the bearer
 * for a one-time ticket, then `/ws?orchestrationProtocol=2&wsTicket=…`
 * speaking Effect RPC's JSON serialization (one message per text frame: a
 * `Request {id, tag, payload, headers}` out, an `Exit {requestId, exit}`
 * back). The server decodes the payload, so nothing here knows Lecturn's
 * schemas.
 *
 * Limits: `timeoutMs` and `signal` cover the whole call, ticket fetch
 * included, so a stalled Lecturn cannot hold the caller past its deadline. A
 * failure says whether the request went out unanswered (`ambiguous`): Lecturn
 * may have acted on it, so the caller has to find out rather than assume.
 *
 * Where the sidecar's state lives (`<baseDir>`): the app's session
 * (`embed-app-session.json`, written by the helper when it starts the
 * sidecar) and the server's runtime record (`userdata/server-runtime.json`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lecturn `ORCHESTRATION_PROTOCOL_QUERY_PARAM` / `_VERSION_TEXT`. */
const PROTOCOL_PARAM = "orchestrationProtocol";
const PROTOCOL_VERSION = "2";
const DEFAULT_TIMEOUT_MS = 60_000;

/** A refused ticket, a failed call or a dropped socket. */
export class LecturnRpcError extends Error {
  override readonly name = "LecturnRpcError";
  /** The request was sent and no answer came back: Lecturn may have acted on it. */
  readonly ambiguous: boolean;
  /** Cut short by `signal` or the time limit. */
  readonly aborted: boolean;

  constructor(message: string, detail: { ambiguous?: boolean; aborted?: boolean } = {}) {
    super(message);
    this.ambiguous = detail.ambiguous ?? false;
    this.aborted = detail.aborted ?? false;
  }
}

/** The WebSocket slice used (the global `WebSocket` of Node 24 and Electron satisfies it). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LecturnRpcOptions {
  /** Covers the ticket fetch and the socket together (default 60 s). */
  timeoutMs?: number;
  /** Ends the call at once, wherever it has got to. */
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  socket?: (url: string) => SocketLike;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Settles as `work` does, or rejects when `signal` fires, even if `work` never settles. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal, what = "the call"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new LecturnRpcError(`${what} was cut short`, { aborted: true }));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A one-time socket ticket for `bearer` (Lecturn `issueWebSocketTicket`). */
export async function websocketTicket(origin: string, bearer: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch, signal?: AbortSignal): Promise<string> {
  const res = await fetchImpl(new URL("/api/auth/websocket-ticket", origin), { method: "POST", headers: { authorization: `Bearer ${bearer}` }, ...(signal === undefined ? {} : { signal }) });
  if (!res.ok) throw new LecturnRpcError(`Lecturn refused a socket ticket: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const body: unknown = await res.json();
  if (!isObject(body) || typeof body["ticket"] !== "string") throw new LecturnRpcError("Lecturn answered the ticket request without a ticket");
  return body["ticket"];
}

/** `ws(s)://<origin>/ws` with the protocol version and the ticket. */
export function socketUrl(origin: string, ticket: string): string {
  const u = new URL("/ws", origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set(PROTOCOL_PARAM, PROTOCOL_VERSION);
  u.searchParams.set("wsTicket", ticket);
  return u.toString();
}

/** The text of an Effect RPC failure cause (`[{_tag: "Fail", error}, …]`). */
function causeText(cause: unknown): string {
  if (!Array.isArray(cause)) return JSON.stringify(cause);
  return cause
    .map((c: unknown) => {
      if (!isObject(c)) return JSON.stringify(c);
      if (c["_tag"] === "Fail") return JSON.stringify(c["error"]);
      if (c["_tag"] === "Die") return `defect ${JSON.stringify(c["defect"])}`;
      return String(c["_tag"]);
    })
    .join("; ");
}

/** One call on its own socket: the result value, or `LecturnRpcError`. */
export async function lecturnRpc(origin: string, bearer: string, tag: string, payload: unknown, o: LecturnRpcOptions = {}): Promise<unknown> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = AbortSignal.timeout(timeoutMs);
  const signal = o.signal === undefined ? limit : AbortSignal.any([limit, o.signal]);
  const outOfTime = (sent: boolean): LecturnRpcError =>
    new LecturnRpcError(limit.aborted ? `${tag}: no answer within ${timeoutMs} ms` : `${tag}: cut short before the answer`, { ambiguous: sent, aborted: true });
  let ticket: string;
  try {
    ticket = await untilAborted(websocketTicket(origin, bearer, o.fetch, signal), signal, `${tag}: the socket ticket request`);
  } catch (e) {
    if (signal.aborted) throw outOfTime(false);
    throw e;
  }
  if (signal.aborted) throw outOfTime(false);
  const url = socketUrl(origin, ticket);
  const ws = o.socket?.(url) ?? (new WebSocket(url) as unknown as SocketLike);
  const id = "1";
  return new Promise((resolve, reject) => {
    let done = false;
    let sent = false;
    const onAbort = (): void => finish(outOfTime(sent));
    const finish = (err: Error | null, value?: unknown): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err === null) resolve(value);
      else reject(err);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ws.onopen = () => {
      if (done) return;
      sent = true;
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    };
    ws.onerror = () => finish(new LecturnRpcError(`${tag}: the socket failed`, { ambiguous: sent }));
    ws.onclose = () => finish(new LecturnRpcError(`${tag}: the socket closed before the answer`, { ambiguous: sent }));
    ws.onmessage = (ev) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
      } catch {
        return;
      }
      for (const m of Array.isArray(decoded) ? decoded : [decoded]) {
        if (!isObject(m)) continue;
        if (m["_tag"] === "Defect") return finish(new LecturnRpcError(`${tag}: defect ${JSON.stringify(m["defect"])}`));
        if (m["_tag"] === "ClientProtocolError") return finish(new LecturnRpcError(`${tag}: protocol error ${JSON.stringify(m["error"])}`));
        if (m["_tag"] !== "Exit" || String(m["requestId"]) !== id) continue;
        const exit = m["exit"];
        if (isObject(exit) && exit["_tag"] === "Success") return finish(null, exit["value"]);
        return finish(new LecturnRpcError(`${tag} failed: ${isObject(exit) ? causeText(exit["cause"]) : JSON.stringify(exit)}`));
      }
    };
  });
}

/** The app's sidecar session (`<baseDir>/embed-app-session.json`), or null when the helper has not written one. */
export function readSidecarAppSession(baseDir: string): { appId: string; environmentId: string; accessToken: string } | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(baseDir, "embed-app-session.json"), "utf8"));
    if (isObject(v) && typeof v["appId"] === "string" && typeof v["environmentId"] === "string" && typeof v["accessToken"] === "string") {
      return { appId: v["appId"], environmentId: v["environmentId"], accessToken: v["accessToken"] };
    }
  } catch {
    /* no session yet */
  }
  return null;
}

/** The origin the sidecar in `baseDir` serves on (`userdata/server-runtime.json`), or null. */
export function readServerOrigin(baseDir: string): string | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8"));
    return isObject(v) && typeof v["origin"] === "string" ? v["origin"] : null;
  } catch {
    return null;
  }
}
