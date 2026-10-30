/**
 * B10 (B5's lifecycle cases, now against the real bridge object): the pane
 * controller (`src/lecturn.ts`) drives the vendored `@lecturn/embed/electron`
 * `mountEmbedView` and `captureEmbedView`, with Electron replaced by fakes of
 * WebContentsView, its webContents, debugger and IPC, the host window and
 * ipcMain (`vi.mock("electron")`; the helper is inlined, vitest.config.ts).
 * Cases: mount and bounds, the remount and project switch, guest events,
 * D11 snapshot-and-hide with its lifecycle contract, captures across a
 * project switch, a live switch (D25), a crash and a window close, the
 * single debugger rule (D15), composites, the protocol's openThread, and
 * Lecturn pin4's composer placeholder and ref labels (B7d).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureEmbedView, mountEmbedView } from "@lecturn/embed/electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_HOST_BRIDGE_CHANNEL,
  EMBED_PANE_RECT_CHANNEL,
  embedThemeInput,
  PANE_HOST_CHANNEL,
  PANE_MAIN_CHANNEL,
  type LecturnHostThemeJson,
  type LecturnStatus,
  type LecturnThemeJson,
  type PaneMainMessage,
} from "@rw/contracts";
import { decodePng, encodePng, fillRect, solidImage } from "../../../e2e/bar/png.ts";
import { captureComposite, compositeAt, createPaneController, droppedCapture, intersects, isGuestUrl, normalizeRect, type EmbedBridgeLike, type MountArgs, type PaneController, type Rect } from "../src/lecturn.ts";

const fx = vi.hoisted(() => {
  type Fn = (...args: never[]) => unknown;
  class Emitter {
    readonly listeners = new Map<string, Set<Fn>>();
    on(event: string, l: Fn): this {
      let set = this.listeners.get(event);
      if (set === undefined) this.listeners.set(event, (set = new Set()));
      set.add(l);
      return this;
    }
    once(event: string, l: Fn): this {
      const wrap = ((...a: never[]) => {
        this.removeListener(event, wrap);
        (l as (...x: unknown[]) => unknown)(...a);
      }) as Fn;
      return this.on(event, wrap);
    }
    removeListener(event: string, l: Fn): this {
      this.listeners.get(event)?.delete(l);
      return this;
    }
    off(event: string, l: Fn): this {
      return this.removeListener(event, l);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const l of [...(this.listeners.get(event) ?? [])]) (l as (...a: unknown[]) => unknown)(...args);
    }
    count(event?: string): number {
      if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
      let n = 0;
      for (const set of this.listeners.values()) n += set.size;
      return n;
    }
  }
  /** A CDP reply per method; `shot` gates Page.captureScreenshot. */
  class FakeDebugger extends Emitter {
    attached = false;
    readonly commands: string[] = [];
    shot: (() => Promise<unknown>) | null = null;
    viewport = { clientWidth: 380, clientHeight: 700 };
    png = "";
    isAttached(): boolean {
      return this.attached;
    }
    attach(): void {
      if (this.attached) throw new Error("Debugger is already attached to the target");
      this.attached = true;
    }
    detach(): void {
      this.attached = false;
      this.emit("detach");
    }
    async sendCommand(method: string): Promise<unknown> {
      if (!this.attached) throw new Error("Debugger is not attached");
      this.commands.push(method);
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: this.viewport };
      if (method === "Page.captureScreenshot") return this.shot !== null ? this.shot() : { data: this.png };
      return {};
    }
  }
  class FakeContents extends Emitter {
    url = "";
    destroyed = false;
    crashed = false;
    focused = false;
    readonly loads: string[] = [];
    readonly sent: [string, unknown][] = [];
    readonly ipc = new Emitter();
    readonly debugger = new FakeDebugger();
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isCrashed(): boolean {
      return this.crashed;
    }
    isFocused(): boolean {
      return this.focused;
    }
    focus(): void {
      this.focused = true;
    }
    isLoading(): boolean {
      return false;
    }
    getURL(): string {
      return this.url;
    }
    setZoomFactor(): void {}
    async loadURL(url: string): Promise<void> {
      if (this.destroyed) throw new Error("Object has been destroyed");
      this.loads.push(url);
      this.url = url;
      this.crashed = false;
      this.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    }
    send(channel: string, message: unknown): void {
      this.sent.push([channel, message]);
    }
    close(): void {
      this.destroyed = true;
      this.emit("destroyed");
    }
    crash(): void {
      this.crashed = true;
      this.emit("render-process-gone", {}, { reason: "crashed" });
    }
  }
  class WebContentsView {
    readonly webContents = new FakeContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    readonly options: { webPreferences: Record<string, unknown> };
    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.options = options;
      views.push(this);
    }
    setBounds(b: { x: number; y: number; width: number; height: number }): void {
      this.bounds = { ...b };
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds };
    }
    setVisible(v: boolean): void {
      this.visible = v;
    }
  }
  class FakeWindow extends Emitter {
    destroyed = false;
    readonly webContents = new FakeContents();
    readonly contentView = {
      children: [] as WebContentsView[],
      addChildView: (v: WebContentsView) => void this.contentView.children.push(v),
      removeChildView: (v: WebContentsView) => {
        this.contentView.children = this.contentView.children.filter((c) => c !== v);
      },
    };
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      this.emit("close", { defaultPrevented: false });
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const views: WebContentsView[] = [];
  const ipcMain = new Emitter();
  return { Emitter, FakeContents, FakeWindow, WebContentsView, views, ipcMain, shell: { openExternal: async () => undefined } };
});

vi.mock("electron", () => ({ WebContentsView: fx.WebContentsView, ipcMain: fx.ipcMain, shell: fx.shell }));

type View = InstanceType<typeof fx.WebContentsView>;

const generated = <T>(file: string): T => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../packages/ui/generated", file), "utf8")) as T;
const THEME = embedThemeInput(generated<LecturnThemeJson>("lecturn-theme.json"), generated<LecturnHostThemeJson>("lecturn-theme-host.json"));
const ROOTS: Record<string, string> = { p1: "/work/one", p2: "/work/two" };
const PANE: Rect = { x: 1155, y: 125, width: 380, height: 700 };
const GUEST_PNG = Buffer.from(encodePng(solidImage(380, 700, [27, 30, 32]))).toString("base64");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await tick();
  }
}

const panes: PaneController[] = [];
afterEach(() => {
  for (const p of panes.splice(0)) p.destroy();
  fx.views.splice(0);
});

function setup(opts: { overlayMode?: "snapshot" | "hide"; maxReloads?: number; labelTimeoutMs?: number } = {}) {
  const win = new fx.FakeWindow();
  const targets: [string, string | undefined][] = [];
  let env = 1;
  const source = {
    embedTarget: async (projectId: string, threadId?: string) => {
      targets.push([projectId, threadId]);
      return { url: `http://127.0.0.1:${4100 + env}/embed/env-${env}/${projectId}${threadId === undefined ? "" : `/${threadId}`}`, token: `tok-${targets.length}`, expiresAt: "2026-10-25T12:00:00.000Z" };
    },
  };
  const deferQ: (() => void)[] = [];
  const logs: string[] = [];
  const mountArgs: MountArgs[] = [];
  const pane = createPaneController({
    win,
    ipc: fx.ipcMain,
    mount: (a): EmbedBridgeLike => {
      mountArgs.push(a);
      return mountEmbedView(win as never, {
        target: source,
        projectId: a.projectId,
        ...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
        theme: THEME,
        bounds: a.bounds,
        switcher: false,
        ...(a.composerPlaceholder !== undefined ? { composerPlaceholder: a.composerPlaceholder } : {}),
        onDescribeRefs: a.onDescribeRefs,
        webPreferences: { backgroundThrottling: false },
      });
    },
    workspaceRootOf: (p) => ROOTS[p] ?? null,
    capture: (b) => captureEmbedView(b as never, { attempts: 2, retryDelayMs: 1, attemptTimeoutMs: 500 }),
    defer: (fn) => void deferQ.push(fn),
    log: (l) => void logs.push(l),
    ...(opts.overlayMode !== undefined ? { overlayMode: opts.overlayMode } : {}),
    ...(opts.maxReloads !== undefined ? { maxReloads: opts.maxReloads } : {}),
    ...(opts.labelTimeoutMs !== undefined ? { labelTimeoutMs: opts.labelTimeoutMs } : {}),
  });
  panes.push(pane);
  const host = (m: unknown, sender: unknown = win.webContents): void => fx.ipcMain.emit(PANE_HOST_CHANNEL, { sender }, m);
  const rect = (r: Rect, sender: unknown = win.webContents): void => fx.ipcMain.emit(EMBED_PANE_RECT_CHANNEL, { sender }, r);
  const flush = (): void => {
    while (deferQ.length > 0) deferQ.shift()!();
  };
  const view = (): View => {
    const v = fx.views.at(-1);
    if (v === undefined) throw new Error("no view mounted");
    return v;
  };
  /** Mounts p1 over PANE and waits for the guest's first load. */
  const mounted = async (projectId = "p1"): Promise<View> => {
    rect(PANE);
    host({ type: "mount", projectId });
    const v = view();
    await until(() => v.webContents.loads.length > 0);
    v.webContents.debugger.png = GUEST_PNG;
    return v;
  };
  const toHost = (): PaneMainMessage[] => win.webContents.sent.filter(([ch]) => ch === PANE_MAIN_CHANNEL).map(([, m]) => m as PaneMainMessage);
  return { win, pane, host, rect, flush, view, mounted, toHost, targets, logs, mountArgs, setEnv: (n: number) => (env = n) };
}

/** A guest → host bridge message from `v`'s top frame. */
function guest(v: View, method: string, params: Record<string, unknown>): void {
  v.webContents.ipc.emit("lecturn-embed:from-guest", { senderFrame: { parent: null, url: v.webContents.url } }, { jsonrpc: "2.0", method, params });
}

/** A guest → host request from `v`'s top frame; resolves with the host's reply. */
async function guestRequest(v: View, id: number, method: string, params: Record<string, unknown>): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const replies = (): { id?: unknown; result?: Record<string, unknown>; error?: unknown }[] => v.webContents.sent.filter(([ch]) => ch === "lecturn-embed:to-guest").map(([, m]) => m as { id?: unknown });
  v.webContents.ipc.emit("lecturn-embed:from-guest", { senderFrame: { parent: null, url: v.webContents.url } }, { jsonrpc: "2.0", id, method, params });
  await until(() => replies().some((m) => m.id === id));
  return replies().find((m) => m.id === id)!;
}

const INIT_PARAMS = { protocolVersion: "2026-01-26", appCapabilities: { experimental: { lecturn: { version: 1 } } } };

const status = (switched?: LecturnStatus["switched"]): LecturnStatus => ({ state: "connected", mode: "user-server", pairing: "none", ...(switched !== undefined ? { switched } : {}) });

describe("pane mount (B10)", () => {
  it("mounts the helper's view over the reported rect with the embed's options", async () => {
    const t = setup();
    const v = await t.mounted();
    expect(t.targets).toEqual([["p1", undefined]]);
    expect(v.bounds).toEqual(PANE);
    expect(t.win.contentView.children).toEqual([v]);
    expect(v.options.webPreferences).toMatchObject({ backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
    const url = new URL(v.webContents.loads[0]!);
    expect(url.origin).toBe("http://127.0.0.1:4101");
    expect(new URLSearchParams(url.hash.slice(1)).get("switcher")).toBe("0");
    expect(new URLSearchParams(url.hash.slice(1)).get("embedToken")).toBe("tok-1");
    expect(url.search).not.toContain("tok-");
    expect(t.toHost()).toContainEqual({ type: "state", projectId: "p1", state: "mounting" });
  });

  it("follows pane-rect reports from the host page only (the helper moves the view, the controller tracks it)", async () => {
    const t = setup();
    const v = await t.mounted();
    t.rect({ x: 1100.4, y: 120, width: 400.2, height: 650 });
    expect(v.bounds).toEqual({ x: 1100, y: 120, width: 400, height: 650 });
    expect(t.pane.bounds).toEqual(normalizeRect({ x: 1100.4, y: 120, width: 400.2, height: 650 }));
    t.rect({ x: 0, y: 0, width: 10, height: 10 }, {});
    expect(v.bounds).toEqual({ x: 1100, y: 120, width: 400, height: 650 });
    expect(t.pane.bounds.width).toBe(400);
    t.host({ type: "mount", projectId: "p2" }, {});
    expect(fx.views).toHaveLength(1);
  });

  it("keeps the view across an unmount and remount of the same workspace", async () => {
    const t = setup();
    const v = await t.mounted();
    t.host({ type: "unmount" });
    t.host({ type: "mount", projectId: "p1" });
    t.flush();
    expect(fx.views).toEqual([v]);
    expect(v.webContents.destroyed).toBe(false);
    expect(t.pane.mounted?.workspaceRoot).toBe("/work/one");
    t.host({ type: "unmount" });
    t.flush();
    expect(t.pane.mounted).toBeNull();
    expect(v.webContents.destroyed).toBe(true);
    expect(t.win.contentView.children).toEqual([]);
  });

  it("forwards the guest's bridge events to the page and resolves whenReady", async () => {
    const t = setup();
    const v = await t.mounted();
    const ready = t.pane.whenReady(1_000);
    guest(v, "lecturn/thread.changed", { threadId: "lt-1" });
    guest(v, "lecturn/turn.state", { threadId: "lt-1", state: "running" });
    guest(v, "lecturn/navigate", { ref: "rw:c/fins" });
    guest(v, "lecturn/ready", { threadId: "lt-1" });
    await expect(ready).resolves.toBe(true);
    const events = t.toHost().filter((m) => m.type === "event");
    expect(events).toEqual([
      { type: "event", event: "lecturn/thread.changed", payload: { threadId: "lt-1" } },
      { type: "event", event: "lecturn/turn.state", payload: { threadId: "lt-1", state: "running" } },
      { type: "event", event: "lecturn/navigate", payload: { ref: "rw:c/fins" } },
      { type: "event", event: "lecturn/ready", payload: { threadId: "lt-1" } },
    ]);
    expect(t.pane.mounted).toMatchObject({ threadId: "lt-1", ready: true });
    expect(t.toHost()).toContainEqual({ type: "state", projectId: "p1", state: "ready" });
  });

  it("relays the page's sendBridge messages to the guest (the helper's bridge channel)", async () => {
    const t = setup();
    const v = await t.mounted();
    guest(v, "ui/notifications/initialized", {});
    fx.ipcMain.emit(EMBED_HOST_BRIDGE_CHANNEL, { sender: t.win.webContents }, { method: "lecturn/composer.insertMention", params: { ref: "rw:c/fins", label: "Fins" } });
    expect(v.webContents.sent.at(-1)).toEqual(["lecturn-embed:to-guest", { jsonrpc: "2.0", method: "lecturn/composer.insertMention", params: { ref: "rw:c/fins", label: "Fins" } }]);
  });

  it("accepts loopback guest URLs only, and rejects malformed page messages", () => {
    expect(isGuestUrl("http://127.0.0.1:5199/embed/x")).toBe(true);
    expect(isGuestUrl("http://localhost:1/embed")).toBe(true);
    expect(isGuestUrl("https://lecturn.example/embed")).toBe(false);
    expect(isGuestUrl("data:text/html,x")).toBe(false);
    const t = setup();
    for (const m of [null, 7, { type: "mount" }, { type: "mount", projectId: "" }, { type: "overlay.open", token: "a" }, { type: "nope" }]) t.host(m);
    expect(fx.views).toHaveLength(0);
    expect(intersects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe("composer placeholder and ref labels (Lecturn pin4, B7d)", () => {
  it("mounts with the page's placeholder, hands later ones to the bridge, and keeps it across a project switch", async () => {
    const t = setup();
    t.host({ type: "composer.placeholder", text: "Ask about this design…" });
    const v = await t.mounted();
    const init = await guestRequest(v, 1, "ui/initialize", INIT_PARAMS);
    expect((init.result as { hostContext: Record<string, unknown> }).hostContext).toMatchObject({ composerPlaceholder: "Ask about this design…", styles: { variables: { "--destructive": "#e5735c", "--success": "#61b5ad", "--success-foreground": "#61b5ad", "--background": "#1b1e20" } } });
    guest(v, "ui/notifications/initialized", {});
    t.host({ type: "composer.placeholder", text: "Ask about these results…" });
    expect(v.webContents.sent.at(-1)).toEqual(["lecturn-embed:to-guest", { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: expect.objectContaining({ composerPlaceholder: "Ask about these results…" }) }]);
    t.host({ type: "composer.placeholder", text: null });
    expect(v.webContents.sent.at(-1)).toEqual(["lecturn-embed:to-guest", { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: expect.objectContaining({ composerPlaceholder: null }) }]);
    t.host({ type: "composer.placeholder", text: "Ask about this configuration…" });
    t.host({ type: "composer.placeholder", text: "" }); // malformed: ignored
    t.host({ type: "mount", projectId: "p2" });
    const v2 = t.view();
    expect(v2).not.toBe(v);
    await until(() => v2.webContents.loads.length > 0);
    const init2 = await guestRequest(v2, 1, "ui/initialize", INIT_PARAMS);
    expect((init2.result as { hostContext: Record<string, unknown> }).hostContext).toMatchObject({ composerPlaceholder: "Ask about this configuration…" });
  });

  it("forwards the guest's appRefs.describe to the page and returns the page's labels for the refs asked", async () => {
    const t = setup();
    const v = await t.mounted();
    const asked = guestRequest(v, 7, "lecturn/appRefs.describe", { refs: ["rw:c/fins", "rw:cfg/baseline"] });
    await until(() => t.toHost().some((m) => m.type === "refs.describe"));
    const ask = t.toHost().find((m) => m.type === "refs.describe") as Extract<PaneMainMessage, { type: "refs.describe" }>;
    expect(ask.refs).toEqual(["rw:c/fins", "rw:cfg/baseline"]);
    t.host({ type: "refs.labels", id: "bogus", labels: { "rw:c/fins": "Wrong" } });
    t.host({ type: "refs.labels", id: ask.id, labels: { "rw:c/fins": "Fins", "rw:c/other": "Not asked" } });
    await expect(asked).resolves.toMatchObject({ result: { labels: { "rw:c/fins": "Fins" } } });
    // A repeated answer is a no-op.
    t.host({ type: "refs.labels", id: ask.id, labels: { "rw:c/fins": "Again" } });
  });

  it("names nothing when the page does not answer in time, or the pane goes away while it asks", async () => {
    const t = setup({ labelTimeoutMs: 20 });
    const v = await t.mounted();
    await expect(guestRequest(v, 8, "lecturn/appRefs.describe", { refs: ["rw:c/fins"] })).resolves.toMatchObject({ result: { labels: {} } });
    // The helper's onDescribeRefs for this mount: an ask in flight when the pane unmounts names nothing.
    const describeRefs = t.mountArgs.at(-1)!.onDescribeRefs;
    const pending = describeRefs(["rw:c/fins"]);
    const ask = t.toHost().filter((m) => m.type === "refs.describe").at(-1) as Extract<PaneMainMessage, { type: "refs.describe" }>;
    t.host({ type: "unmount" });
    t.flush();
    t.host({ type: "refs.labels", id: ask.id, labels: { "rw:c/fins": "Fins" } });
    await expect(pending).resolves.toEqual({});
    expect(t.pane.mounted).toBeNull();
    // Once unmounted, the old mount's asks are not forwarded at all.
    const n = t.toHost().length;
    await expect(describeRefs(["rw:c/fins"])).resolves.toEqual({});
    expect(t.toHost()).toHaveLength(n);
  });
});

describe("D11 overlay snapshot-and-hide", () => {
  const MENU: Rect = { x: 1200, y: 100, width: 200, height: 160 };

  it("shows the snapshot, hides the view once it is shown, and restores both on close", async () => {
    const t = setup();
    const v = await t.mounted();
    t.host({ type: "overlay.open", token: "m1", rect: MENU });
    await until(() => t.toHost().some((m) => m.type === "snapshot"));
    const snap = t.toHost().find((m) => m.type === "snapshot");
    expect(snap).toMatchObject({ token: "m1", rect: PANE, dataUrl: `data:image/png;base64,${GUEST_PNG}` });
    expect(v.visible).toBe(true); // not hidden before the page shows the frame
    t.host({ type: "overlay.snapshot-shown", token: "m1" });
    expect(v.visible).toBe(false);
    expect(t.pane.hidden).toBe(true);
    t.host({ type: "overlay.close", token: "m1" });
    expect(v.visible).toBe(true);
    expect(t.toHost().at(-1)).toEqual({ type: "snapshot.clear" });
    expect(t.win.webContents.focused).toBe(true); // the host opened it
  });

  it("ignores overlays that miss the pane, and overlays before any mount", async () => {
    const t = setup();
    t.host({ type: "overlay.open", token: "early", rect: MENU });
    const v = await t.mounted();
    t.host({ type: "overlay.open", token: "far", rect: { x: 10, y: 10, width: 100, height: 100 } });
    await tick();
    expect(t.toHost().some((m) => m.type === "snapshot")).toBe(false);
    expect(v.visible).toBe(true);
    expect(v.webContents.debugger.commands).not.toContain("Page.captureScreenshot");
  });

  it("drops the snapshot when the overlay closes before it lands", async () => {
    const t = setup();
    const v = await t.mounted();
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    t.host({ type: "overlay.open", token: "m1", rect: MENU });
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    t.host({ type: "overlay.close", token: "m1" });
    shot.resolve({ data: GUEST_PNG });
    await tick();
    await tick();
    expect(t.toHost().some((m) => m.type === "snapshot")).toBe(false);
    expect(v.visible).toBe(true);
  });

  it("drops a snapshot whose guest navigated while it was taken", async () => {
    const t = setup();
    const v = await t.mounted();
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    t.host({ type: "overlay.open", token: "m1", rect: MENU });
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    v.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }); // bumps the bridge's generation
    shot.resolve({ data: GUEST_PNG });
    await tick();
    await tick();
    expect(t.toHost().some((m) => m.type === "snapshot")).toBe(false);
  });

  it("drops a shown snapshot's acknowledgement after a thread switch, and clears the frame", async () => {
    const t = setup();
    const v = await t.mounted();
    t.host({ type: "overlay.open", token: "m1", rect: MENU });
    await until(() => t.toHost().some((m) => m.type === "snapshot"));
    guest(v, "lecturn/thread.changed", { threadId: "lt-9" }); // generation bump: the frame is stale
    expect(t.toHost().at(-2)).toEqual({ type: "snapshot.clear" });
    t.host({ type: "overlay.snapshot-shown", token: "m1" });
    expect(v.visible).toBe(true);
  });

  it("falls back to hiding when the snapshot fails, and in hide mode", async () => {
    const t = setup();
    const v = await t.mounted();
    v.webContents.debugger.shot = async () => ({ data: "" });
    t.host({ type: "overlay.open", token: "m1", rect: MENU });
    await until(() => !v.visible);
    expect(t.logs.some((l) => /overlay snapshot failed/.test(l))).toBe(true);
    t.host({ type: "overlay.close", token: "m1" });
    expect(v.visible).toBe(true);

    const h = setup({ overlayMode: "hide" });
    const hv = await h.mounted();
    h.host({ type: "overlay.open", token: "x", rect: MENU });
    expect(hv.visible).toBe(false);
    expect(hv.webContents.debugger.commands).not.toContain("Page.captureScreenshot");
    h.host({ type: "overlay.close", token: "x" });
    expect(hv.visible).toBe(true);
  });

  it("keeps the view hidden until the last of nested overlays closes", async () => {
    const t = setup({ overlayMode: "hide" });
    const v = await t.mounted();
    t.host({ type: "overlay.open", token: "a", rect: MENU });
    t.host({ type: "overlay.open", token: "b", rect: { ...MENU, y: 300 } });
    t.host({ type: "overlay.close", token: "a" });
    expect(v.visible).toBe(false);
    t.host({ type: "overlay.close", token: "b" });
    expect(v.visible).toBe(true);
  });

  it("returns focus to the guest when it had focus before the overlay opened", async () => {
    const t = setup({ overlayMode: "hide" });
    const v = await t.mounted();
    v.webContents.focused = true;
    t.host({ type: "overlay.open", token: "a", rect: MENU });
    v.webContents.focused = false;
    t.win.webContents.focused = true;
    t.host({ type: "overlay.close", token: "a" });
    expect(v.webContents.focused).toBe(true);
  });

  it("clears the frame and forgets overlays on a project switch", async () => {
    const t = setup({ overlayMode: "hide" });
    await t.mounted();
    t.host({ type: "overlay.open", token: "a", rect: MENU });
    t.host({ type: "mount", projectId: "p2" });
    expect(t.toHost()).toContainEqual({ type: "snapshot.clear" });
    expect(t.pane.hidden).toBe(false);
    expect(fx.views.at(-1)!.visible).toBe(true);
  });
});

describe("guest lifecycle during capture", () => {
  it("captures the guest at the pane bounds over the bridge's session", async () => {
    const t = setup();
    const v = await t.mounted();
    const shot = await t.pane.captureGuest();
    expect(shot).toMatchObject({ ok: true, bounds: PANE });
    expect(v.webContents.debugger.commands).toEqual(expect.arrayContaining(["Page.getLayoutMetrics", "Emulation.setDeviceMetricsOverride", "Page.captureScreenshot"]));
  });

  it("drops a capture across a project switch and removes the old listeners", async () => {
    const t = setup();
    const before = fx.ipcMain.count();
    const v = await t.mounted();
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    const cap = t.pane.captureGuest();
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    t.host({ type: "mount", projectId: "p2" });
    shot.resolve({ data: GUEST_PNG });
    expect(await cap).toMatchObject({ ok: false });
    expect(v.webContents.destroyed).toBe(true);
    expect(v.webContents.ipc.count()).toBe(0);
    expect(t.win.contentView.children).toEqual([fx.views.at(-1)]);
    expect(t.targets.at(-1)).toEqual(["p2", undefined]);
    // The helper's pane-rect and bridge handlers of the old view are gone; the new view's are in.
    expect(fx.ipcMain.count()).toBe(before + 2);
  });

  it("retargets on a live switch in the same view with its bounds, mapping the thread and dropping a capture in flight (D25)", async () => {
    const t = setup();
    const v = await t.mounted();
    guest(v, "lecturn/thread.changed", { threadId: "lt-1-a" });
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    const cap = t.pane.captureGuest();
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    t.setEnv(2);
    t.pane.onStatus(status({ environmentId: "env-2", projects: { p1: "lp-2-p1" }, threadIdMap: { "lt-1-a": "lt-2-a" } }));
    await until(() => v.webContents.loads.length === 2);
    shot.resolve({ data: GUEST_PNG });
    expect(await cap).toMatchObject({ ok: false, reason: "stale" });
    expect(fx.views).toEqual([v]);
    expect(v.bounds).toEqual(PANE);
    expect(t.targets.at(-1)).toEqual(["p1", "lt-2-a"]);
    expect(new URL(v.webContents.loads[1]!).origin).toBe("http://127.0.0.1:4102");
    expect(t.pane.mounted).toMatchObject({ threadId: "lt-2-a", ready: false });
    // A sidecar started again on another port keeps its environment and ids: it reloads all the same (Lecturn pin21).
    t.pane.onStatus(status({ environmentId: "env-2", projects: { p1: "lp-2-p1" }, threadIdMap: { "lt-2-a": "lt-2-a" } }));
    await until(() => v.webContents.loads.length === 3);
    expect(t.targets.at(-1)).toEqual(["p1", "lt-2-a"]);
    // A status without one, or a switch that leaves this project out: no reload.
    t.pane.onStatus(status());
    t.pane.onStatus(status({ environmentId: "env-3", projects: { p2: "lp-3-p2" }, threadIdMap: {} }));
    await tick();
    expect(v.webContents.loads).toHaveLength(3);
    v.webContents.debugger.shot = null;
    expect(await t.pane.captureGuest()).toMatchObject({ ok: true });
  });

  it("survives a guest crash during capture and reloads the guest in the same view", async () => {
    const t = setup();
    const v = await t.mounted();
    guest(v, "lecturn/thread.changed", { threadId: "lt-7" });
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    const cap = t.pane.captureGuest();
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    v.webContents.crash();
    shot.reject(new Error("Target crashed"));
    expect(await cap).toMatchObject({ ok: false, reason: "gone" });
    t.flush();
    await until(() => v.webContents.loads.length === 2);
    expect(fx.views).toEqual([v]);
    expect(t.targets.at(-1)).toEqual(["p1", "lt-7"]);
  });

  it("reload() reloads the guest in the same view at its thread, not ready until it says so again (CPW1R5A)", async () => {
    const t = setup();
    const v = await t.mounted();
    guest(v, "lecturn/ready", { threadId: "lt-3" });
    expect(t.pane.mounted).toMatchObject({ ready: true });
    expect(t.pane.reload("a card frame failed to load")).toBe(true);
    expect(t.pane.mounted).toMatchObject({ ready: false, threadId: "lt-3" });
    await until(() => v.webContents.loads.length === 2);
    expect(fx.views).toEqual([v]);
    expect(t.targets.at(-1)).toEqual(["p1", "lt-3"]);
    expect(t.logs).toContain("lecturn pane: reload (a card frame failed to load)");
    guest(v, "lecturn/ready", { threadId: "lt-3" });
    expect(t.pane.mounted).toMatchObject({ ready: true });
  });

  it("reload() without a mount does nothing", () => {
    const t = setup();
    expect(t.pane.reload("nothing mounted")).toBe(false);
  });

  it("stops reloading after maxReloads crashes and tells the page", async () => {
    const t = setup({ maxReloads: 1 });
    const v = await t.mounted();
    v.webContents.crash();
    t.flush();
    await until(() => v.webContents.loads.length === 2);
    v.webContents.crash();
    t.flush();
    await tick();
    expect(v.webContents.loads).toHaveLength(2);
    expect(t.toHost().at(-1)).toMatchObject({ type: "state", state: "error" });
  });

  it("leaks nothing when the window closes during capture", async () => {
    const t = setup();
    const before = fx.ipcMain.count();
    const v = await t.mounted();
    const shot = deferred<unknown>();
    v.webContents.debugger.shot = () => shot.promise;
    const cap = t.pane.captureGuest();
    await until(() => v.webContents.debugger.commands.includes("Page.captureScreenshot"));
    t.win.close();
    shot.resolve({ data: GUEST_PNG });
    expect(await cap).toMatchObject({ ok: false });
    expect(v.webContents.destroyed).toBe(true);
    expect(fx.ipcMain.count()).toBe(before - 2); // the controller's own two handlers are gone too
    expect(t.win.count()).toBe(0);
    expect(t.pane.mounted).toBeNull();
    t.host({ type: "mount", projectId: "p1" });
    expect(fx.views).toEqual([v]);
  });
});

describe("single debugger per guest (D15)", () => {
  it("uses the bridge's one session, and a guest someone else attached to fails the capture instead of sharing it", async () => {
    const t = setup();
    const v = await t.mounted();
    v.webContents.debugger.attach(); // another client took the slot first
    const shot = await t.pane.captureGuest();
    expect(shot).toMatchObject({ ok: false, reason: "failed" });
    expect(shot.ok === false && shot.error).toMatch(/CDP client|attach/i);
  });
});

describe("composite capture", () => {
  it("blits the guest at the pane bounds, clipped to the window", () => {
    const host = solidImage(40, 30, [0, 0, 0]);
    const guestImg = solidImage(20, 20, [255, 0, 0]);
    fillRect(guestImg, [0, 0, 5, 5], [0, 255, 0]);
    const out = decodePng(compositeAt(encodePng(host), encodePng(guestImg), { x: 30, y: 15, width: 20, height: 20 }));
    const px = (x: number, y: number) => [...out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3)];
    expect(px(29, 15)).toEqual([0, 0, 0]);
    expect(px(30, 15)).toEqual([0, 255, 0]);
    expect(px(39, 29)).toEqual([255, 0, 0]);
  });

  it("composites the guest into the host capture, and drops it if the guest changed in between", async () => {
    const t = setup();
    const v = await t.mounted();
    t.rect({ x: 10, y: 5, width: 380, height: 700 });
    const hostPng = encodePng(solidImage(400, 720, [0, 0, 0]));
    const ok = await captureComposite(t.pane, async () => hostPng);
    expect(ok).toMatchObject({ ok: true, bounds: { x: 10, y: 5, width: 380, height: 700 } });
    const img = decodePng((ok as { png: Uint8Array }).png);
    expect([...img.data.subarray((5 * 400 + 10) * 4, (5 * 400 + 10) * 4 + 3)]).toEqual([27, 30, 32]);
    const stale = await captureComposite(t.pane, async () => {
      v.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      return hostPng;
    });
    expect(stale).toEqual({ ok: false, reason: "stale" });
  });

  it("explains a dropped composite for the probe", () => {
    expect(droppedCapture({ reason: "stale" })).toMatch(/^the agent pane's capture was dropped \(stale\): the guest navigated, reloaded or switched threads/);
    expect(droppedCapture({ reason: "gone" })).toBe("the agent pane's capture was dropped (gone): the guest closed or crashed");
    expect(droppedCapture({ reason: "failed", error: "the pane rect is empty" })).toBe("the agent pane's capture was dropped (failed): the pane rect is empty");
  });
});

describe("rocketwright://open into the pane", () => {
  it("opens the thread in the mounted view, or mounts the project at that thread", async () => {
    const t = setup();
    const v = await t.mounted();
    guest(v, "ui/notifications/initialized", {});
    t.pane.openThread("p1", "lt-5");
    expect(v.webContents.sent.at(-1)).toEqual(["lecturn-embed:to-guest", { jsonrpc: "2.0", method: "lecturn/thread.open", params: { threadId: "lt-5" } }]);
    t.pane.openThread("p2", "lt-9");
    expect(t.targets).toHaveLength(1);
    t.host({ type: "mount", projectId: "p2" });
    await until(() => t.targets.length === 2);
    expect(t.targets.at(-1)).toEqual(["p2", "lt-9"]);
    expect(t.pane.mounted).toMatchObject({ workspaceRoot: "/work/two", threadId: "lt-9" });
  });
});
