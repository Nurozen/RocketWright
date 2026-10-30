/**
 * One Lecturn WebSocket RPC call with a bearer (plan B13, test hooks and
 * harnesses only): the app's `apps.importThreads` (the pinned helper's
 * `LecturnConnection` does not expose it) and the bar's admin
 * orchestration calls (`orchestration.dispatchCommand`,
 * `orchestration.getThreadProjection`).
 *
 * The wire is Lecturn's: `POST /api/auth/websocket-ticket` with the bearer
 * for a one-time ticket, then `/ws?orchestrationProtocol=2&wsTicket=…`
 * speaking Effect RPC's JSON serialization (one message per text frame: a
 * `Request {id, tag, payload, headers}` out, an `Exit {requestId, exit}`
 * back). The server decodes the payload, so nothing here knows Lecturn's
 * schemas.
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
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  socket?: (url: string) => SocketLike;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A one-time socket ticket for `bearer` (Lecturn `issueWebSocketTicket`). */
export async function websocketTicket(origin: string, bearer: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string> {
  const res = await fetchImpl(new URL("/api/auth/websocket-ticket", origin), { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
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
  const ticket = await websocketTicket(origin, bearer, o.fetch);
  const url = socketUrl(origin, ticket);
  const ws = o.socket?.(url) ?? (new WebSocket(url) as unknown as SocketLike);
  const id = "1";
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, value?: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err === null) resolve(value);
      else reject(err);
    };
    const timer = setTimeout(() => finish(new LecturnRpcError(`${tag}: no answer within ${o.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`)), o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    ws.onerror = () => finish(new LecturnRpcError(`${tag}: the socket failed`));
    ws.onclose = () => finish(new LecturnRpcError(`${tag}: the socket closed before the answer`));
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
