/**
 * Shared plumbing for the bar capture scripts (`capture/pages/*.ts`, M1.53).
 * A page script is a desktop `--drive` module: it runs in the Electron main
 * process against the hidden window and the live app server, and reaches the
 * window state only through the `app_*` broker test hooks (`test.call`,
 * RW_TEST_HOOKS=1, I12) plus ordinary product RPC (e.g. `sim.run`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrokerArgs, JsonObject, JsonValue, Mention, RpcMethod, RpcParams, RpcResult, RwRef, TestHookOp, ThreadBinding } from "../../packages/contracts/src/index.ts";
import { RpcClient } from "../../apps/web/src/state/rpc.ts";
import { REPO_ROOT } from "../bar/paths.ts";
import type { PageLike } from "../regions.ts";

/**
 * The embedded Lecturn pane's guest as main sees it (B13): its main frame,
 * and every child frame (the MCP Apps cards, sandboxed and out of the main
 * frame's reach) through Electron's own frame API, never a second debugger.
 */
export interface GuestLike {
  /** The bridge's `generation` (bumped on every reload, crash or thread switch). */
  readonly generation: number;
  /** True once the guest sent `lecturn/ready` for its current document. */
  readonly ready: boolean;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** `fn` in every child frame that answers (a frame that throws or detached is skipped). */
  evaluateFrames<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R[]>;
  /**
   * Draws one frame of the view. The hidden capture window produces none on
   * its own, and Lecturn reveals a thread's timeline from a
   * `requestAnimationFrame` callback.
   */
  frame?(): Promise<void>;
  /**
   * Reloads the guest in the same view at its thread (a fresh document:
   * Lecturn mints its card URLs again); false without a mounted guest.
   * CPW1R5A: the recovery when it never got ready or a card frame failed.
   */
  reload?(why: string): boolean;
}

/** What the desktop passes a `--drive` module (`apps/desktop/src/main.ts`). */
export interface DriveContext {
  page: PageLike;
  rpcUrl: string | null;
  serverUrl: string | null;
  /** The mounted pane's guest, or null (no embed mounted yet). */
  guest?: () => GuestLike | null;
}

/**
 * One canned thread of `app/e2e/fixtures/threads/<page>.json`: the source
 * format `fixtures/convert-threads.ts` turns into the Lecturn bundles (B13).
 * Until B17 it was also the old chat's `app_seed_thread` args.
 */
export interface SeedThread {
  /** The thread's title. */
  thread: string;
  messages: SeedMessage[];
  /** What the thread is bound to (default: the Design > Assembly page). */
  binding?: ThreadBinding;
  /** Backdates the thread's timestamps by this many milliseconds (rail ages). */
  ageMs?: number;
}

/**
 * One canned message. Each user message opens a turn; an assistant message
 * closes it. `text` may carry `[@label](rw:ref)` mention links.
 */
export interface SeedMessage {
  role: "user" | "assistant";
  text: string;
  /** User: the chips under the bubble. */
  mentions?: Mention[];
  /** Assistant: the turn's tool calls. */
  steps?: Array<{ tool: string; input: JsonObject; output?: JsonValue; isError?: boolean }>;
  /** Assistant: result cards after the reply. */
  cards?: Array<{ kind: "step" | "run" | "render"; ref: RwRef; title: string }>;
}

export interface ThreadFixture {
  description: string;
  threads: SeedThread[];
}

export const THREAD_FIXTURE_DIR = join(REPO_ROOT, "app/e2e/fixtures/threads");
/** The Lecturn thread bundles (`app/e2e/fixtures/convert-threads.ts`, B13). */
export const BUNDLE_FIXTURE_DIR = join(REPO_ROOT, "tests/fixtures/lecturn");

/** `tests/fixtures/lecturn/<page>.bundle.json` (a templated Lecturn thread bundle). */
export function loadBundle(page: string, dir = BUNDLE_FIXTURE_DIR): JsonObject {
  return JSON.parse(readFileSync(join(dir, `${page}.bundle.json`), "utf8")) as JsonObject;
}

/** The bundle's thread titles, in order (the last one is the thread the seed opens). */
export function bundleTitles(bundle: JsonObject): string[] {
  const projects = (bundle["projects"] ?? []) as { threads: { title: string }[] }[];
  return projects.flatMap((p) => p.threads.map((t) => t.title));
}

/**
 * Waits up to `timeoutMs` for the agent pane's Lecturn embed rect (B10; the
 * only pane since B17, mounted once the window has its project) and throws
 * without it.
 */
export async function requireEmbed(page: PageLike, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(() => document.querySelector('[data-testid="agent.embed"]') !== null, null)) return;
    if (Date.now() > deadline) throw new Error("capture: the agent pane never mounted the Lecturn embed");
    await sleep(200);
  }
}

/** `app/e2e/fixtures/threads/<page>.json`, checked for shape. */
export function loadThreads(page: string, dir = THREAD_FIXTURE_DIR): ThreadFixture {
  const f = JSON.parse(readFileSync(join(dir, `${page}.json`), "utf8")) as ThreadFixture;
  if (!Array.isArray(f.threads) || f.threads.length === 0) throw new Error(`threads/${page}.json: no threads`);
  for (const t of f.threads) {
    if (typeof t.thread !== "string" || !Array.isArray(t.messages) || t.messages.length === 0) {
      throw new Error(`threads/${page}.json: each thread needs a title and messages`);
    }
    for (const m of t.messages) {
      if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") throw new Error(`threads/${page}.json: bad message in ${t.thread}`);
    }
  }
  return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `pred` in the page until it returns true; throws `what` (plus the last `diag`) on timeout. */
export async function waitFor<A>(
  page: PageLike,
  what: string,
  pred: (arg: A) => boolean,
  arg: A,
  opts: { timeoutMs?: number; diag?: (arg: A) => unknown } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (await page.evaluate(pred, arg)) return;
    if (Date.now() > deadline) {
      const diag = opts.diag ? JSON.stringify(await page.evaluate(opts.diag, arg)) : "";
      throw new Error(`capture: timed out waiting for ${what} ${diag}`);
    }
    await sleep(100);
  }
}

/** Two animation frames plus `ms` (lets three.js and uPlot draw the final state). */
export async function settle(page: PageLike, ms = 300): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))), null);
  await sleep(ms);
}

/** An RPC connection to the live server, scoped to its (only) project. */
export class Hooks {
  readonly client: RpcClient;
  readonly projectId: string;

  private constructor(client: RpcClient, projectId: string) {
    this.client = client;
    this.projectId = projectId;
  }

  static async open(rpcUrl: string | null): Promise<Hooks> {
    if (rpcUrl === null) throw new Error("capture: no live server (run the desktop with --project)");
    const client = await RpcClient.connect(rpcUrl);
    if (!client.hello.testHooks) {
      client.close();
      throw new Error("capture: the server runs without RW_TEST_HOOKS=1; app_* hooks are off (I12)");
    }
    const { projects } = await client.call("project.list", {});
    const projectId = projects[0]?.projectId;
    if (projectId === undefined) {
      client.close();
      throw new Error("capture: the server has no open project");
    }
    return new Hooks(client, projectId);
  }

  rpc<M extends RpcMethod>(method: M, params: Omit<RpcParams<M>, "projectId">): Promise<RpcResult<M>> {
    return this.client.call(method, { ...params, projectId: this.projectId } as RpcParams<M>);
  }

  /** One `app_*` hook. Retries while the window has not registered as the viewport host yet. */
  async call<O extends TestHookOp>(op: O, args: BrokerArgs[O], timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return (await this.rpc("test.call", { op, args } as Omit<RpcParams<"test.call">, "projectId">)) as Record<string, unknown>;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no_host/.test(msg) || Date.now() > deadline) throw new Error(`capture: ${op} failed: ${msg}`, { cause: e });
        await sleep(200);
      }
    }
  }

  /**
   * Imports the page's Lecturn bundle through the app's Lecturn connection
   * (`app_seed_thread {bundle}`, B13) and opens its last thread in the pane;
   * returns the imported threads' Lecturn ids in bundle order.
   */
  async seedBundle(page: string, opts: { now?: number; timeoutMs?: number } = {}): Promise<{ threadId: string; threadIds: string[] }> {
    const args = { bundle: loadBundle(page), ...(opts.now === undefined ? {} : { now: opts.now }) };
    const r = await this.call("app_seed_thread", args, opts.timeoutMs ?? 90_000);
    const ids = r["threadIds"];
    if (typeof r["threadId"] !== "string" || !Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new Error(`capture: app_seed_thread bundle ${page}: no thread ids`);
    return { threadId: r["threadId"], threadIds: ids as string[] };
  }

  close(): void {
    this.client.close();
  }
}
