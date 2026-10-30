/**
 * B10: `pnpm -C app --filter @rw/web test -- embed`. The embedded agent
 * pane on the page side: which pane shows, the desktop channel (rect, mount,
 * commands, main's events and snapshots), the plain-web iframe mount with
 * token refresh and a live-switch retarget (fakes, then the contracts mock
 * over a real socket), the D11 overlay scan (menus and dialogs, never the
 * rail's listboxes), the status store, and the pane markup with the
 * RocketWright strip outside the rect.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBED_HOST_BRIDGE_CHANNEL,
  PANE_HOST_CHANNEL,
  type EmbedTarget,
  type LecturnStatus,
  type PaneEvents,
  type PaneMainMessage,
  type RpcMethod,
  type RpcTopic,
  type RpcTopics,
} from "@rw/contracts";
import { SEED_PROJECT_ID, startMockServer, type MockServer } from "@rw/contracts/mock";
import { RpcClient } from "../state/rpc.ts";
import { AgentPane } from "../shell/AgentPane.tsx";
import {
  desktopPaneGlobals,
  OVERLAY_SELECTOR,
  overlayDiff,
  startBrowserPane,
  startDesktopPane,
  type BrowserEmbedLike,
  type DesktopPaneGlobals,
  type MountEmbedOptionsLike,
} from "./bridge.ts";
import { EmbedPane, loadBrowserEmbed } from "./EmbedPane.tsx";
import { trackLecturnStatus } from "./status.ts";

const connected: LecturnStatus = { state: "connected", mode: "sidecar", pairing: "none" };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeDesktop() {
  const sent: [string, unknown][] = [];
  const listeners = new Set<(m: unknown) => void>();
  const globals: DesktopPaneGlobals = {
    ipc: { send: (ch, p) => void sent.push([ch, p]) },
    lecturn: {
      onMessage: (cb) => {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    },
  };
  const fromMain = (m: PaneMainMessage | unknown): void => {
    for (const l of [...listeners]) l(m);
  };
  return { globals, sent, fromMain, listeners };
}

/** A fake `RpcLike` slice: `embed.target` per env, `embed.refreshToken`, and pushes. */
function fakeClient() {
  const calls: [RpcMethod, unknown][] = [];
  const topics = new Map<RpcTopic, Set<(p: never) => void>>();
  let env = 1;
  let n = 0;
  const target = (projectId: string, threadId?: string): EmbedTarget => ({
    url: `http://127.0.0.1:${4200 + env}/embed/env-${env}/lp-${projectId}${threadId === undefined ? "" : `/${threadId}`}`,
    token: `tok-${++n}`,
    expiresAt: "2026-10-25T12:00:00.000Z",
  });
  const client = {
    call: (async (method: RpcMethod, params: { projectId: string; threadId?: string }) => {
      calls.push([method, params]);
      if (method === "embed.target" || method === "embed.refreshToken") return target(params.projectId, params.threadId);
      throw new Error(`unexpected ${method}`);
    }) as unknown as RpcClient["call"],
    on: (<T extends RpcTopic>(topic: T, fn: (p: RpcTopics[T]) => void) => {
      let set = topics.get(topic);
      if (set === undefined) topics.set(topic, (set = new Set()));
      set.add(fn as (p: never) => void);
      return () => void set.delete(fn as (p: never) => void);
    }) as RpcClient["on"],
  };
  const push = <T extends RpcTopic>(topic: T, payload: RpcTopics[T]): void => {
    for (const l of [...(topics.get(topic) ?? [])]) (l as (p: RpcTopics[T]) => void)(payload);
  };
  return { client, calls, push, topics, setEnv: (e: number) => (env = e) };
}

/** A fake `mountEmbed`: records options, commands and retargets; `emit` plays guest events. */
function fakeEmbed() {
  const mounts: MountEmbedOptionsLike[] = [];
  const commands: [string, unknown][] = [];
  const retargets: { url: string; token: string }[] = [];
  const placeholders: (string | null)[] = [];
  const listeners = new Map<string, Set<(p: never) => void>>();
  let destroyed = 0;
  const embed: BrowserEmbedLike = {
    insertMention: (p) => void commands.push(["insertMention", p]),
    setDraft: (t) => void commands.push(["setDraft", t]),
    openThread: (t) => void commands.push(["openThread", t]),
    newThread: (p) => void commands.push(["newThread", p]),
    openProviders: () => void commands.push(["openProviders", null]),
    setComposerPlaceholder: (t) => void placeholders.push(t),
    retarget: (t) => void retargets.push(t),
    on: ((event: string, l: (p: never) => void) => {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(l);
      return () => void set.delete(l);
    }) as BrowserEmbedLike["on"],
    destroy: () => void destroyed++,
  };
  const theme = { variables: { "--background": "#1b1e20" }, fontsCss: "@font-face{}" };
  const load = async () => ({ mountEmbed: (_c: HTMLElement, o: MountEmbedOptionsLike) => (mounts.push(o), embed), theme });
  const emit = <E extends keyof PaneEvents>(event: E, payload: PaneEvents[E]): void => {
    for (const l of [...(listeners.get(event) ?? [])]) (l as (p: PaneEvents[E]) => void)(payload);
  };
  return { load, mounts, commands, retargets, placeholders, emit, listeners, destroyed: () => destroyed };
}

const servers: MockServer[] = [];
const clients: RpcClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("desktop pane globals", () => {
  it("finds the desktop preload's pane globals, and none in a plain browser", () => {
    expect(desktopPaneGlobals({})).toBeNull();
    expect(desktopPaneGlobals({ rwDesktop: { lecturn: { onMessage: () => () => undefined } } })).toBeNull();
    expect(desktopPaneGlobals({ lecturnEmbedIpc: { send: () => undefined }, rwDesktop: { lecturn: { onMessage: () => () => undefined } } })).not.toBeNull();
  });
});

describe("desktop pane", () => {
  it("reports the rect before asking main to mount, sends commands on the helper's bridge channel, and unmounts on stop", () => {
    const d = fakeDesktop();
    const order: string[] = [];
    let stoppedRect = 0;
    const el = {} as Element;
    const pane = startDesktopPane(el, "p1", {
      globals: d.globals,
      reportPaneRect: (got) => {
        expect(got).toBe(el);
        order.push(`rect (sent so far: ${d.sent.length})`);
        return () => void stoppedRect++;
      },
    });
    expect(order).toEqual(["rect (sent so far: 0)"]);
    expect(d.sent).toEqual([[PANE_HOST_CHANNEL, { type: "mount", projectId: "p1" }]]);
    pane.bridge.insertMention({ ref: "rw:c/fins", label: "Fins" });
    pane.bridge.openThread("lt-1");
    pane.bridge.newThread({ title: "Fin study", appData: '{"page":"components"}' });
    pane.bridge.openProviders();
    pane.bridge.setDraft("hi");
    expect(d.sent.slice(1)).toEqual([
      [EMBED_HOST_BRIDGE_CHANNEL, { method: "lecturn/composer.insertMention", params: { ref: "rw:c/fins", label: "Fins" } }],
      [EMBED_HOST_BRIDGE_CHANNEL, { method: "lecturn/thread.open", params: { threadId: "lt-1" } }],
      [EMBED_HOST_BRIDGE_CHANNEL, { method: "lecturn/thread.new", params: { title: "Fin study", appData: '{"page":"components"}' } }],
      [EMBED_HOST_BRIDGE_CHANNEL, { method: "lecturn/providers.open", params: {} }],
      [EMBED_HOST_BRIDGE_CHANNEL, { method: "lecturn/composer.setDraft", params: { text: "hi" } }],
    ]);
    pane.snapshotShown("ov-1");
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "overlay.snapshot-shown", token: "ov-1" }]);
    pane.stop();
    pane.stop();
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "unmount" }]);
    expect(d.sent.filter(([, m]) => (m as { type?: string }).type === "unmount")).toHaveLength(1);
    expect(stoppedRect).toBe(1);
    expect(d.listeners.size).toBe(0);
    pane.snapshotShown("ov-2");
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "unmount" }]);
  });

  it("delivers main's guest events, snapshots and its own state; ignores malformed messages and other projects", () => {
    const d = fakeDesktop();
    const snaps: unknown[] = [];
    const states: unknown[] = [];
    const pane = startDesktopPane({} as Element, "p1", { globals: d.globals, reportPaneRect: () => () => undefined, onSnapshot: (m) => void snaps.push(m), onState: (m) => void states.push(m) });
    const nav: string[] = [];
    const off = pane.bridge.on("lecturn/navigate", (p) => void nav.push(p.ref));
    d.fromMain({ type: "event", event: "lecturn/navigate", payload: { ref: "rw:run/42" } });
    d.fromMain({ type: "event", event: "lecturn/bogus", payload: {} });
    d.fromMain({ type: "snapshot", token: "ov-1", dataUrl: "javascript:alert(1)", rect: { x: 0, y: 0, width: 1, height: 1 } });
    d.fromMain({ type: "snapshot", token: "ov-1", dataUrl: "data:image/png;base64,AA", rect: { x: 0, y: 0, width: 1, height: 1 } });
    d.fromMain({ type: "snapshot.clear" });
    d.fromMain({ type: "state", projectId: "p2", state: "ready" });
    d.fromMain({ type: "state", projectId: "p1", state: "error", message: "nope" });
    d.fromMain(null);
    expect(nav).toEqual(["rw:run/42"]);
    expect(snaps).toEqual([{ type: "snapshot", token: "ov-1", dataUrl: "data:image/png;base64,AA", rect: { x: 0, y: 0, width: 1, height: 1 } }, { type: "snapshot.clear" }]);
    expect(states).toEqual([{ type: "state", projectId: "p1", state: "error", message: "nope" }]);
    off();
    d.fromMain({ type: "event", event: "lecturn/navigate", payload: { ref: "rw:c/fins" } });
    expect(nav).toEqual(["rw:run/42"]);
    pane.stop();
  });

  it("sends the composer placeholder to main and answers main's ref-label asks from the resolver (Lecturn pin4)", () => {
    const d = fakeDesktop();
    const pane = startDesktopPane({} as Element, "p1", { globals: d.globals, reportPaneRect: () => () => undefined });
    pane.bridge.setComposerPlaceholder?.("Ask about this design…");
    pane.bridge.setComposerPlaceholder?.(null);
    expect(d.sent.slice(1)).toEqual([
      [PANE_HOST_CHANNEL, { type: "composer.placeholder", text: "Ask about this design…" }],
      [PANE_HOST_CHANNEL, { type: "composer.placeholder", text: null }],
    ]);
    // No resolver yet: the ask is answered with no labels (the guest shows the refs).
    d.fromMain({ type: "refs.describe", id: "refs-1", refs: ["rw:c/fins"] });
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "refs.labels", id: "refs-1", labels: {} }]);
    const asked: string[][] = [];
    const off = pane.bridge.onRefLabels!((refs) => (asked.push([...refs]), refs.includes("rw:c/fins") ? { "rw:c/fins": "Fins" } : {}));
    d.fromMain({ type: "refs.describe", id: "refs-2", refs: ["rw:c/fins", "rw:c/nope"] });
    d.fromMain({ type: "refs.describe", id: "", refs: ["rw:c/fins"] });
    expect(asked).toEqual([["rw:c/fins", "rw:c/nope"]]);
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "refs.labels", id: "refs-2", labels: { "rw:c/fins": "Fins" } }]);
    // A throwing resolver names nothing; a stopped one is gone.
    const offBad = pane.bridge.onRefLabels!(() => {
      throw new Error("model gone");
    });
    d.fromMain({ type: "refs.describe", id: "refs-3", refs: ["rw:c/fins"] });
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "refs.labels", id: "refs-3", labels: {} }]);
    off(); // not the current resolver: no effect
    offBad();
    d.fromMain({ type: "refs.describe", id: "refs-4", refs: ["rw:c/fins"] });
    expect(d.sent.at(-1)).toEqual([PANE_HOST_CHANNEL, { type: "refs.labels", id: "refs-4", labels: {} }]);
    pane.stop();
    const n = d.sent.length;
    pane.bridge.setComposerPlaceholder?.("late");
    expect(d.sent).toHaveLength(n);
  });
});

describe("plain-web pane", () => {
  it("mounts the iframe from embed.target with B11's theme and no switcher, refreshes through embed.refreshToken, and queues early commands", async () => {
    const c = fakeClient();
    const e = fakeEmbed();
    const states: string[] = [];
    const pane = startBrowserPane({} as HTMLElement, "p1", { client: c.client, load: e.load, onState: (s) => void states.push(s) });
    pane.bridge.insertMention({ ref: "rw:c/fins", label: "Fins" });
    await pane.mounted;
    expect(c.calls[0]).toEqual(["embed.target", { projectId: "p1" }]);
    expect(e.mounts).toHaveLength(1);
    expect(e.mounts[0]).toMatchObject({ url: "http://127.0.0.1:4201/embed/env-1/lp-p1", token: "tok-1", switcher: false, theme: { theme: "dark", styles: { variables: { "--background": "#1b1e20" }, css: { fonts: "@font-face{}" } } } });
    expect(e.commands).toEqual([["insertMention", { ref: "rw:c/fins", label: "Fins" }]]);
    await expect(e.mounts[0]!.onTokenRefresh()).resolves.toEqual({ token: "tok-2", expiresAt: "2026-10-25T12:00:00.000Z" });
    expect(c.calls[1]).toEqual(["embed.refreshToken", { projectId: "p1" }]);
    pane.bridge.openProviders();
    expect(e.commands.at(-1)).toEqual(["openProviders", null]);
    e.emit("lecturn/ready", { threadId: null });
    expect(states).toEqual(["mounting", "ready"]);
    pane.stop();
    expect(e.destroyed()).toBe(1);
    expect([...c.topics.values()].every((s) => s.size === 0)).toBe(true);
    expect([...e.listeners.values()].every((s) => s.size === 0)).toBe(true);
  });

  it("retargets the same frame on a live switch at the mapped thread, on every switch, and only for its project (D25)", async () => {
    const c = fakeClient();
    const e = fakeEmbed();
    const pane = startBrowserPane({} as HTMLElement, "p1", { client: c.client, load: e.load });
    await pane.mounted;
    e.emit("lecturn/thread.changed", { threadId: "lt-1-a" });
    c.setEnv(2);
    const switched = { environmentId: "env-2", projects: { p1: "lp-2-p1" }, threadIdMap: { "lt-1-a": "lt-2-a" } };
    c.push("lecturn.status", { ...connected, mode: "user-server", switched });
    await until(() => e.retargets.length === 1);
    expect(c.calls.at(-1)).toEqual(["embed.target", { projectId: "p1", threadId: "lt-2-a" }]);
    expect(e.retargets[0]).toEqual({ url: "http://127.0.0.1:4202/embed/env-2/lp-p1/lt-2-a", token: expect.any(String) });
    // A sidecar started again on another port keeps its environment and ids: it reloads all the same (Lecturn pin21).
    c.push("lecturn.status", { ...connected, switched: { environmentId: "env-2", projects: { p1: "lp-2-p1" }, threadIdMap: { "lt-2-a": "lt-2-a" } } });
    await until(() => e.retargets.length === 2);
    expect(c.calls.at(-1)).toEqual(["embed.target", { projectId: "p1", threadId: "lt-2-a" }]);
    // A switch that leaves this project out, or a status without one: no reload.
    c.push("lecturn.status", { ...connected, switched: { environmentId: "env-3", projects: { p2: "x" }, threadIdMap: {} } });
    c.push("lecturn.status", connected);
    await tick();
    expect(e.retargets).toHaveLength(2);
    expect(e.mounts).toHaveLength(1);
    pane.stop();
  });

  it("mounts with the placeholder set before the frame, hands later ones to the helper, and answers onDescribeRefs (Lecturn pin4)", async () => {
    const c = fakeClient();
    const e = fakeEmbed();
    const pane = startBrowserPane({} as HTMLElement, "p1", { client: c.client, load: e.load });
    pane.bridge.setComposerPlaceholder?.("Ask about this design…");
    await pane.mounted;
    expect(e.mounts[0]!.composerPlaceholder).toBe("Ask about this design…");
    expect(e.placeholders).toEqual([]);
    pane.bridge.setComposerPlaceholder?.("Ask about these results…");
    pane.bridge.setComposerPlaceholder?.("Ask about these results…");
    pane.bridge.setComposerPlaceholder?.(null);
    expect(e.placeholders).toEqual(["Ask about these results…", null]);
    const describe = e.mounts[0]!.onDescribeRefs!;
    expect(describe(["rw:c/fins"])).toEqual({});
    const off = pane.bridge.onRefLabels!((refs) => Object.fromEntries(refs.filter((r) => r === "rw:cfg/baseline").map((r) => [r, "Baseline"])));
    expect(describe(["rw:cfg/baseline", "rw:c/x"])).toEqual({ "rw:cfg/baseline": "Baseline" });
    off();
    expect(describe(["rw:cfg/baseline"])).toEqual({});
    pane.bridge.onRefLabels!(() => ({ "rw:c/fins": "Fins" }));
    pane.stop();
    expect(describe(["rw:c/fins"])).toEqual({});
  });

  it("reports a failed target as an error state and mounts nothing", async () => {
    const e = fakeEmbed();
    const states: [string, string | undefined][] = [];
    const client = { call: (async () => Promise.reject(new Error("internal: Lecturn is unavailable"))) as unknown as RpcClient["call"], on: (() => () => undefined) as unknown as RpcClient["on"] };
    const pane = startBrowserPane({} as HTMLElement, "p1", { client, load: e.load, onState: (s, m) => void states.push([s, m]) });
    await pane.mounted;
    expect(e.mounts).toHaveLength(0);
    expect(states.at(-1)).toEqual(["error", "internal: Lecturn is unavailable"]);
    pane.stop();
  });

  it("against the contracts mock over a real socket: mounts from embed.target and follows its live switch", async () => {
    const srv = await startMockServer({ tickMs: 5 });
    servers.push(srv);
    const client = await RpcClient.connect(srv.url);
    clients.push(client);
    const status = trackLecturnStatus(client);
    await until(() => status.get() !== null);
    expect(status.get()).toMatchObject({ state: "connected" });
    const e = fakeEmbed();
    const pane = startBrowserPane({} as HTMLElement, SEED_PROJECT_ID, { client, load: e.load });
    await pane.mounted;
    expect(new URL(e.mounts[0]!.url).pathname).toMatch(/^\/embed\/mock-env-\d+\//);
    srv.mock.lecturnSwitch("user-server");
    await until(() => e.retargets.length === 1);
    expect(e.retargets[0]!.url).not.toBe(e.mounts[0]!.url);
    expect(status.get()).toMatchObject({ mode: "user-server", switched: { projects: { [SEED_PROJECT_ID]: expect.any(String) } } });
    pane.stop();
  });

  it("loads the real browser helper and B11's generated theme files (the host-only --destructive on top)", async () => {
    const { mountEmbed, theme, hostTheme } = await loadBrowserEmbed();
    expect(typeof mountEmbed).toBe("function");
    expect(theme.variables["--background"]).toBe("#1b1e20");
    expect(theme.fontsCss).toMatch(/@font-face/);
    expect(hostTheme?.variables["--destructive"]).toBe("#e5735c");
  });
});

describe("D11 overlay scan", () => {
  it("opens and closes overlays by element with stable tokens, skipping collapsed ones", () => {
    const tokens = new WeakMap<object, string>();
    let n = 0;
    const next = () => `ov-${++n}`;
    const menu = {};
    const dialog = {};
    const r = { x: 1200, y: 100, width: 200, height: 160 };
    let d = overlayDiff([{ key: menu, rect: r }, { key: dialog, rect: { ...r, width: 0 } }], new Map(), tokens, next);
    expect(d.messages).toEqual([{ type: "overlay.open", token: "ov-1", rect: r }]);
    d = overlayDiff([{ key: menu, rect: r }, { key: dialog, rect: r }], d.open, tokens, next);
    expect(d.messages).toEqual([{ type: "overlay.open", token: "ov-2", rect: r }]);
    d = overlayDiff([{ key: dialog, rect: r }], d.open, tokens, next);
    expect(d.messages).toEqual([{ type: "overlay.close", token: "ov-1" }]);
    d = overlayDiff([{ key: menu, rect: r }, { key: dialog, rect: r }], d.open, tokens, next);
    expect(d.messages).toEqual([{ type: "overlay.open", token: "ov-1", rect: r }]);
  });

  it("counts menus and dialogs, never the rail's or pages' listboxes (B5 spike note)", () => {
    expect(OVERLAY_SELECTOR).toContain('[role="menu"]');
    expect(OVERLAY_SELECTOR).toContain('[role="dialog"]');
    expect(OVERLAY_SELECTOR).not.toContain("listbox");
  });
});

describe("pane markup", () => {
  it("embedded: the head, the RocketWright strip, then the reserved rect; no composer, footer in flow", () => {
    const d = fakeDesktop();
    const html = renderToStaticMarkup(
      <AgentPane title="Assembly review" provenance="Research vehicle · Rev 07" extras={<p data-testid="agent.changed-fields">Span</p>} embed={<EmbedPane projectId="p1" client={fakeClient().client} desktop={d.globals} />} />,
    );
    expect(html).toContain('data-embedded="true"');
    const head = html.indexOf('data-testid="agent.title"');
    const strip = html.indexOf('data-testid="agent.extras"');
    const rect = html.indexOf('data-testid="agent.embed"');
    const footer = html.indexOf('data-testid="agent.provenance-footer"');
    expect(head).toBeGreaterThan(-1);
    expect(head < strip && strip < rect && rect < footer).toBe(true);
    expect(html.indexOf('data-testid="agent.changed-fields"')).toBeLessThan(rect);
    expect(html).toContain('data-mode="desktop"');
    expect(html).not.toContain('data-testid="agent.composer"');
    expect(html).not.toContain('data-testid="agent.body"');
    // The rect holds nothing of RocketWright's until main sends a snapshot.
    expect(/data-testid="agent\.embed"[^>]*><div class="rw-embed__frame"><\/div><\/div>/.test(html)).toBe(true);
  });

  it("without an embed (the static shell): the body, then the strip; never a composer (B17)", () => {
    const html = renderToStaticMarkup(
      <AgentPane title="Components" extras={<p data-testid="agent.missing-inputs">Missing</p>}>
        <img data-testid="agent.placeholder" alt="canned exchange" />
      </AgentPane>,
    );
    expect(html).toContain('data-embedded="false"');
    expect(html.indexOf('data-testid="agent.placeholder"')).toBeLessThan(html.indexOf('data-testid="agent.extras"'));
    expect(html).toContain('data-placement="body"');
    expect(html).not.toContain('data-testid="agent.composer"');
    expect(renderToStaticMarkup(<AgentPane title="x" />)).not.toContain("agent.extras");
  });

  it("plain web: the rect has no desktop globals", () => {
    const html = renderToStaticMarkup(<EmbedPane projectId="p1" client={fakeClient().client} desktop={null} />);
    expect(html).toContain('data-mode="web"');
    expect(html).toContain('data-state="mounting"');
  });
});
