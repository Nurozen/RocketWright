/**
 * Test harness for the mock RPC server: a WebSocket client that validates
 * every server frame against the IF10 schemas (`rpc-schema.ts`) and the
 * registry schemas under `schema/` (or `$RW_SCHEMA_DIR`). Until M1.6 writes
 * `schema/**`, a registry type falls back to the shape of its contract
 * fixtures (`inferSchema`); `schemaMode` says which applied.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcError, RpcMethod, RpcParams, RpcResult, RpcTopic, RpcTopics, ServerFrame } from "../src/rpc.ts";
import type { JsonValue } from "../src/types.ts";
import { type FixtureSet, loadFixtures, REPO_ROOT } from "./fixtures.ts";
import { inferSchema, type Schema, Validator } from "./jsonschema.ts";
import { RPC_SCHEMA, resultRef, SCHEMA_ID_BASE, SERVER_FRAME_REF } from "./rpc-schema.ts";

export const SCHEMA_DIR = process.env.RW_SCHEMA_DIR ?? join(REPO_ROOT, "schema");

/** `generated` once M1.6 has written `schema/check-report.json`, else `fixture-shape`. */
export const schemaMode: "generated" | "fixture-shape" = existsSync(join(SCHEMA_DIR, "check-report.json")) ? "generated" : "fixture-shape";

/**
 * Registry names that share one Rust type (`rw_api` command catalogue), so a
 * fixture-shape fallback for one accepts the shapes of all.
 */
const SAME_RUST_TYPE: string[][] = [
  ["tools/model_patch.output", "tools/history_restore.output", "tools/component_add.output", "tools/component_move.output", "tools/component_remove.output", "tools/project_create.output"],
  ["job-info", "tools/job_status.output", "tools/job_cancel.output"],
  ["check-report", "tools/design_check.output"],
  ["tools/simulate.output", "tools/engine_simulate.output"],
  ["render-result", "tools/render.output"],
];

export function makeValidator(fixtures: FixtureSet = loadFixtures()): Validator {
  const v = new Validator((id) => {
    if (!id.startsWith(SCHEMA_ID_BASE)) return undefined;
    const name = id.slice(SCHEMA_ID_BASE.length).replace(/\.json$/, "");
    if (schemaMode === "generated") {
      const file = join(SCHEMA_DIR, `${name}.json`);
      if (!existsSync(file)) throw new Error(`missing generated schema ${file}`);
      return JSON.parse(readFileSync(file, "utf8")) as Schema;
    }
    const group = SAME_RUST_TYPE.find((g) => g.includes(name)) ?? [name];
    const examples = group.flatMap((n) => fixtures.ofType(n));
    if (examples.length === 0) throw new Error(`no schema and no fixture for registry type ${name}`);
    return inferSchema(examples);
  });
  v.add(RPC_SCHEMA);
  return v;
}

type Response<M extends RpcMethod> = { ok: true; result: RpcResult<M> } | { ok: false; error: RpcError };
type Push = Extract<ServerFrame, { kind: "push" }>;

export class TestClient {
  readonly frames: ServerFrame[] = [];
  /** Schema violations seen on any frame (tests assert this stays empty). */
  readonly violations: string[] = [];
  private nextId = 1;
  private readonly waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  private readonly pendingMethods = new Map<number, RpcMethod>();

  private readonly ws: WebSocket;
  private readonly validator: Validator;

  private constructor(ws: WebSocket, validator: Validator) {
    this.ws = ws;
    this.validator = validator;
  }

  static async connect(url: string, validator: Validator): Promise<TestClient> {
    const ws = new WebSocket(url);
    const c = new TestClient(ws, validator);
    ws.addEventListener("message", (e) => c.onFrame(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    await c.waitFor((f) => f.kind === "hello");
    return c;
  }

  private onFrame(text: string): void {
    const f = JSON.parse(text) as ServerFrame;
    const errs = this.validator.validate(SERVER_FRAME_REF, f as unknown as JsonValue);
    if (f.kind === "response" && f.ok) {
      const m = this.pendingMethods.get(f.id);
      if (m !== undefined) errs.push(...this.validator.validate(resultRef(m), f.result as unknown as JsonValue).map((e) => `${m} result: ${e}`));
    }
    if (errs.length > 0) this.violations.push(`${JSON.stringify(f).slice(0, 160)}: ${errs.slice(0, 5).join("; ")}`);
    this.frames.push(f);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.pred(f)) {
        this.waiters.splice(i, 1);
        w.resolve(f);
      }
    }
  }

  /**
   * Resolves with the first frame (already received or future) matching `pred`.
   * The 15 s default is for a loaded `make check`: 3 s timed out on real
   * sidecar calls. Nothing relies on the timeout firing.
   */
  waitFor(pred: (f: ServerFrame) => boolean, timeoutMs = 15_000, since = 0): Promise<ServerFrame> {
    const seen = this.frames.slice(since).find(pred);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for a frame (${pred.toString().slice(0, 120)})`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      });
    });
  }

  /** Waits for a push on `topic` received after frame index `since` that satisfies `pred`. */
  async push<T extends RpcTopic>(topic: T, pred: (p: RpcTopics[T]) => boolean = () => true, since = 0, timeoutMs = 15_000): Promise<RpcTopics[T]> {
    const f = (await this.waitFor((x) => x.kind === "push" && x.topic === topic && pred(x.payload as RpcTopics[T]), timeoutMs, since)) as Push;
    return f.payload as RpcTopics[T];
  }

  pushes<T extends RpcTopic>(topic: T, since = 0): RpcTopics[T][] {
    return this.frames.slice(since).flatMap((f) => (f.kind === "push" && f.topic === topic ? [f.payload as RpcTopics[T]] : []));
  }

  /** Sends a request and resolves with its response (ok or not). */
  async request<M extends RpcMethod>(method: M, params: RpcParams<M> | Record<string, unknown>): Promise<Response<M>> {
    const id = this.nextId++;
    this.pendingMethods.set(id, method);
    this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    const f = await this.waitFor((x) => x.kind === "response" && x.id === id);
    return f as unknown as Response<M>;
  }

  /** Sends a request and returns its result, failing on an error response. */
  async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const r = await this.request(method, params);
    if (!r.ok) throw new Error(`${method} failed: ${r.error.code}: ${r.error.message}`);
    return r.result;
  }

  /** Sends raw text (malformed-frame tests). */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  close(): void {
    this.ws.close();
  }
}
