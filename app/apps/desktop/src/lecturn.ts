/**
 * The embedded Lecturn agent pane in the RocketWright window (B10; D10, D11,
 * D15, D25). Grown from the B5 spike: the raw `WebContentsView` is now the
 * view `@lecturn/embed/electron`'s `mountEmbedView` builds, and the guest's
 * CDP session is the bridge's `debuggerSession`.
 *
 * - `createPaneController` owns the window's one pane. The page says which
 *   project it shows (`mount`/`unmount` on `lecturn-embed:rw-host`); the
 *   pane is keyed by that project's `workspaceRoot`, never by a Lecturn id.
 *   A different project disposes the old view, its listeners and handlers
 *   and mounts a new one; an `unmount` immediately followed by a `mount` of
 *   the same workspace (a React remount) keeps the view.
 * - Bounds: the page reports the pane rect through the helper's
 *   `reportPaneRect` (`lecturn-embed:pane-rect`). The helper moves the view;
 *   this module tracks the same rect for mounting, overlays and captures.
 * - Host overlays (D11): a WebContentsView always paints above the host
 *   DOM, so when the page reports an overlay (menu, dialog) that intersects
 *   the pane, main snapshots the guest, the page shows the frame as an
 *   `<img>` in the pane rect, and only then is the view hidden. Each snapshot
 *   carries the bridge's `generation` and an overlay epoch and is dropped if
 *   either changed or the guest is gone, before or after the capture;
 *   closing the overlay cancels it. Focus goes back to whichever side (guest
 *   or host) had it when the overlay opened. `overlayMode: "hide"` is the
 *   plain-hiding fallback.
 * - Bridge wiring: the target source goes through main's RPC on the child
 *   (`embed.target`, `embed.refreshToken`; `main.ts`); guest events
 *   (`lecturn/navigate`, `thread.changed`, `turn.state`, `ready`) are
 *   forwarded to the page on `lecturn-embed:rw-to-host`.
 * - Composer placeholder and ref labels (Lecturn pin4): the page sends its
 *   per-page placeholder (`composer.placeholder`); main keeps the last one,
 *   mounts with it (`composerPlaceholder`) and hands changes to the bridge
 *   (`setComposerPlaceholder`). The model lives in the page, so the guest's
 *   `lecturn/appRefs.describe` (the helper's `onDescribeRefs`) is forwarded
 *   to it as `refs.describe` and answered with `refs.labels`; no answer in
 *   time (or a pane gone meanwhile) names nothing, and the guest shows the
 *   refs as written.
 * - Live switch (D25): a `lecturn.status` push with `switched` retargets the
 *   mounted view (`bridge.retarget(projectId, mappedThreadId)`): the view is
 *   kept, only the guest reloads.
 * - Crashes: a dead guest renderer is reloaded in the same view (bounded).
 * - Captures: `captureGuest` shoots the guest over the bridge's session
 *   (`capture` option, the helper's `captureEmbedView` in main) and
 *   `captureComposite` blits it into the window capture at the pane bounds
 *   (`app/e2e/bar/png.ts`). A capture whose guest changed meanwhile is
 *   dropped, never thrown.
 *
 * Electron-free: the bridge, window and IPC come in through the `*Like`
 * interfaces below, so `test/lecturnView.test.ts` drives the real helper
 * against a fake Electron.
 */
import {
  EMBED_PANE_RECT_CHANNEL,
  PANE_EVENTS,
  PANE_HOST_CHANNEL,
  PANE_MAIN_CHANNEL,
  isPaneRect,
  mappedThread,
  parsePaneHostMessage,
  type LecturnStatus,
  type PaneEvent,
  type PaneEvents,
  type PaneMainMessage,
  type PaneRect,
} from "@rw/contracts";
import { decodePng, encodePng } from "../../../e2e/bar/png.ts";
import { screenshot, type DebuggerSession } from "./capture.ts";

export type Rect = PaneRect;

/** The guest webContents slice this module uses (Electron's `WebContents` satisfies it). */
export interface GuestContentsLike {
  isDestroyed(): boolean;
  isCrashed(): boolean;
  isFocused(): boolean;
  focus(): void;
}

/** An `EmbedViewError` as the bridge's `error` event carries it. */
export interface BridgeErrorLike {
  readonly reason?: string;
  readonly message: string;
}

/** The slice of `@lecturn/embed/electron`'s `EmbedBridge` this module uses. */
export interface EmbedBridgeLike {
  readonly webContents: GuestContentsLike;
  readonly debuggerSession: DebuggerSession;
  /** Bumped by the helper on every navigation, reload, crash, thread switch, retarget and destroy. */
  readonly generation: number;
  openThread(threadId: string): void;
  setVisible(visible: boolean): void;
  /** The idle composer prompt; null hands it back to Lecturn's wording. */
  setComposerPlaceholder(placeholder: string | null): void;
  retarget(projectId: string, threadId?: string): Promise<void>;
  on<E extends PaneEvent>(event: E, listener: (payload: PaneEvents[E]) => void): () => void;
  on(event: "error", listener: (error: BridgeErrorLike) => void): () => void;
  destroy(): void;
}

/** The host window: its own webContents (the RocketWright page) and its `closed` event. */
export interface HostWindowLike {
  readonly webContents: { send(channel: string, message: PaneMainMessage): void; focus(): void; isDestroyed(): boolean };
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
  removeListener(event: "closed", listener: () => void): unknown;
}

/** `ipcMain`'s slice. Events from any sender but the host window's webContents are ignored. */
export interface IpcLike {
  on(channel: string, listener: (event: { sender: unknown }, message: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: { sender: unknown }, message: unknown) => void): unknown;
}

export interface MountArgs {
  /** RocketWright's project id (the target source resolves it to the current Lecturn project). */
  projectId: string;
  threadId?: string;
  bounds: Rect;
  /** The page's composer placeholder, when it sent one. */
  composerPlaceholder?: string;
  /** The helper's `onDescribeRefs`: the page's labels for `refs` (those it knows). */
  onDescribeRefs: (refs: readonly string[]) => Promise<Record<string, string>>;
}

export interface PaneControllerOptions {
  win: HostWindowLike;
  ipc?: IpcLike;
  /** Mounts the helper's view (main: `mountEmbedView(win, { target, projectId, theme, bounds, switcher: false, … })`). */
  mount: (args: MountArgs) => EmbedBridgeLike;
  /** RocketWright project id → its workspace root (main: the project's realpath); null when unknown. */
  workspaceRootOf: (projectId: string) => string | null;
  /** DPR-1 PNG of the guest (main: `captureEmbedView`); rejects when the guest changed or died. */
  capture?: (bridge: EmbedBridgeLike) => Promise<Uint8Array>;
  /** D11 handling; `"hide"` is the fallback that blanks the pane under overlays. */
  overlayMode?: "snapshot" | "hide";
  /** Reloads after guest crashes before the pane gives up (default 3). */
  maxReloads?: number;
  /** How long a ref-label ask waits for the page's answer (default 2000 ms). */
  labelTimeoutMs?: number;
  /** Schedules crash reloads and unmounts off the current event (default `setTimeout(fn, 0)`). */
  defer?: (fn: () => void) => void;
  log?: (line: string) => void;
}

/** The mounted pane, as main sees it. */
export interface PaneMount {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly bridge: EmbedBridgeLike;
  /** The guest's current Lecturn thread (from `lecturn/thread.changed`), if known. */
  readonly threadId: string | null;
  /** True once the guest sent `lecturn/ready` for its current document. */
  readonly ready: boolean;
}

export type GuestCapture = { ok: true; png: Uint8Array; bounds: Rect; generation: number } | { ok: false; reason: "stale" | "gone" | "failed"; error?: string };

export interface PaneController {
  readonly mounted: PaneMount | null;
  readonly bounds: Rect;
  /** True while the view is hidden under an overlay. */
  readonly hidden: boolean;
  /** The `lecturn-embed:rw-host` entry point (also wired to `ipc`). Malformed messages are ignored. */
  handleHostMessage(message: unknown): void;
  /** The `lecturn-embed:pane-rect` entry point (bounds tracking; the helper moves the view itself). */
  handlePaneRect(rect: unknown): void;
  /** Main's `lecturn.status` pushes: a live switch retargets the mounted view (D25). */
  onStatus(status: LecturnStatus): void;
  /** `rocketwright://open`: show `threadId` of `projectId` (now if mounted there, else once the page mounts it). */
  openThread(projectId: string, threadId: string): void;
  /** Resolves true once the mounted guest is ready (false on timeout, unmount or no mount). */
  whenReady(timeoutMs: number): Promise<boolean>;
  /** A PNG of the guest at the pane bounds; `ok:false` if it changed or died meanwhile. */
  captureGuest(): Promise<GuestCapture>;
  /**
   * Reloads the mounted guest in the same view at its thread (the crash
   * reload's path: a fresh target, `ready` again only on the next
   * `lecturn/ready`); false without a live mount. Bar captures use it when
   * the guest never got ready or a card frame failed to load (CPW1R5A).
   */
  reload(why: string): boolean;
  destroy(): void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Guest URLs the pane loads: loopback http(s) only (registration `embedOrigins`, D9). */
export function isGuestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Integer, non-negative bounds, rounded as the helper rounds the view's (Electron rejects fractional rects). */
export function normalizeRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) };
}

/** Blits `guest` (PNG) into `host` (PNG) with its top-left at `at`, clipped to both; returns the composite PNG. */
export function compositeAt(host: Uint8Array, guest: Uint8Array, at: Rect): Uint8Array {
  const base = decodePng(host);
  const top = decodePng(guest);
  const w = Math.min(top.width, at.width);
  const h = Math.min(top.height, at.height);
  for (let y = 0; y < h; y++) {
    const dy = at.y + y;
    if (dy < 0 || dy >= base.height) continue;
    const x0 = Math.max(0, -at.x);
    const x1 = Math.min(w, base.width - at.x);
    if (x1 <= x0) continue;
    const src = (y * top.width + x0) * 4;
    base.data.set(top.data.subarray(src, src + (x1 - x0) * 4), (dy * base.width + at.x + x0) * 4);
  }
  return encodePng(base);
}

/**
 * The window capture with the guest composited at its bounds: guest first,
 * then `captureHost`; dropped (`ok:false`) if the guest changed in between.
 */
export async function captureComposite(pane: PaneController, captureHost: () => Promise<Uint8Array>): Promise<{ ok: true; png: Uint8Array; bounds: Rect } | { ok: false; reason: string; error?: string }> {
  const guest = await pane.captureGuest();
  if (!guest.ok) return guest;
  const host = await captureHost();
  const m = pane.mounted;
  if (m === null || m.bridge.generation !== guest.generation) return { ok: false, reason: "stale" };
  return { ok: true, png: compositeAt(host, guest.png, guest.bounds), bounds: guest.bounds };
}

/** Why a composite was dropped, for the probe's `lecturnError`: a stale one names what moved the guest, so a race in a drive explains itself. */
export function droppedCapture(dropped: { reason: string; error?: string }): string {
  const why =
    dropped.reason === "stale"
      ? "the guest navigated, reloaded or switched threads during the capture (a drive that returns before the pane settles races the capture)"
      : dropped.reason === "gone"
        ? "the guest closed or crashed"
        : (dropped.error ?? "the capture failed");
  return `the agent pane's capture was dropped (${dropped.reason}): ${why}`;
}

const SNAPSHOT_TIMEOUT_MS = 2_000;
const LABEL_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface MountState {
  projectId: string;
  workspaceRoot: string;
  bridge: EmbedBridgeLike;
  threadId: string | null;
  ready: boolean;
  reloads: number;
  offs: (() => void)[];
  readyWaiters: Set<(ok: boolean) => void>;
}

export function createPaneController(opts: PaneControllerOptions): PaneController {
  const { win, ipc } = opts;
  const overlayMode = opts.overlayMode ?? "snapshot";
  const maxReloads = opts.maxReloads ?? 3;
  const defer = opts.defer ?? ((fn: () => void) => void setTimeout(fn, 0));
  const log = opts.log ?? (() => {});

  let bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let mount: MountState | null = null;
  let destroyed = false;
  /** Threads to open once the page mounts their workspace (`rocketwright://open`). */
  const pendingThreads = new Map<string, string>();
  /** An `unmount` waiting one tick for a `mount` of the same workspace. */
  let pendingUnmount = 0;

  // D11 overlay state: open intersecting overlays, an epoch bumped on every
  // open/close transition (a snapshot from an older epoch is dropped), and
  // the snapshot waiting for the page's `snapshot-shown`.
  const overlays = new Map<string, Rect>();
  let overlayEpoch = 0;
  let pending: { token: string; epoch: number; generation: number } | null = null;
  let hidden = false;
  let focusOwner: "guest" | "host" | null = null;
  let captureQueue: Promise<unknown> = Promise.resolve();
  /** The page's last composer placeholder (null: Lecturn's own). */
  let placeholder: string | null = null;
  /** Ref-label asks forwarded to the page, by id. */
  const labelAsks = new Map<string, { refs: readonly string[]; owner: MountState | null; settle: (labels: Record<string, string>) => void }>();
  let labelSeq = 0;
  const labelTimeoutMs = opts.labelTimeoutMs ?? LABEL_TIMEOUT_MS;

  const send = (m: PaneMainMessage): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(PANE_MAIN_CHANNEL, m);
  };
  const guestGone = (m: MountState | null): boolean => m === null || m.bridge.webContents.isDestroyed() || m.bridge.webContents.isCrashed();
  const rootOf = (projectId: string): string => opts.workspaceRootOf(projectId) ?? `project:${projectId}`;
  /** The mount shows this project: same RocketWright id, or (a reopened spelling) the same workspace root. */
  const shows = (m: MountState, projectId: string, root: string): boolean => m.projectId === projectId || m.workspaceRoot === root;

  /** The guest changed under a snapshot on screen: take the frame down (the view stays hidden while the overlay is open). */
  function invalidateSnapshot(): void {
    if (pending === null) return;
    pending = null;
    send({ type: "snapshot.clear" });
  }

  /** Forwards one ask to the page; resolves with its labels for `refs`, or none on timeout or unmount. */
  function describeRefs(owner: () => MountState | null, refs: readonly string[]): Promise<Record<string, string>> {
    const m = owner();
    if (destroyed || m === null || mount !== m || refs.length === 0) return Promise.resolve({});
    const id = `refs-${++labelSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle({}), labelTimeoutMs);
      const settle = (labels: Record<string, string>): void => {
        clearTimeout(timer);
        if (!labelAsks.delete(id)) return;
        resolve(labels);
      };
      labelAsks.set(id, { refs, owner: m, settle });
      send({ type: "refs.describe", id, refs: [...refs] });
    });
  }

  function answerLabels(id: string, labels: Readonly<Record<string, string>>): void {
    const ask = labelAsks.get(id);
    if (ask === undefined) return;
    if (ask.owner !== mount) return ask.settle({});
    const out: Record<string, string> = {};
    for (const ref of ask.refs) if (Object.hasOwn(labels, ref)) out[ref] = labels[ref]!;
    ask.settle(out);
  }

  function setPlaceholder(text: string | null): void {
    placeholder = text;
    const m = mount;
    if (m === null || m.bridge.webContents.isDestroyed()) return;
    try {
      m.bridge.setComposerPlaceholder(text);
    } catch (e) {
      log(`lecturn pane: setComposerPlaceholder failed: ${errText(e)}`);
    }
  }

  function settleReady(m: MountState, ok: boolean): void {
    for (const w of m.readyWaiters) w(ok);
    m.readyWaiters.clear();
  }

  function setVisible(visible: boolean): void {
    hidden = !visible;
    const m = mount;
    if (m !== null && !m.bridge.webContents.isDestroyed()) m.bridge.setVisible(visible);
  }

  function reload(m: MountState, why: string): void {
    m.ready = false;
    invalidateSnapshot();
    const threadId = m.threadId ?? undefined;
    m.bridge.retarget(m.projectId, threadId).catch((e: unknown) => {
      if (mount === m) log(`lecturn pane: ${why} failed: ${errText(e)}`);
    });
  }

  function wire(m: MountState): void {
    const b = m.bridge;
    for (const event of PANE_EVENTS) {
      m.offs.push(
        b.on(event, (payload: PaneEvents[typeof event]) => {
          if (mount !== m) return;
          if (event === "lecturn/thread.changed") {
            const next = (payload as PaneEvents["lecturn/thread.changed"]).threadId;
            if (next !== m.threadId) invalidateSnapshot();
            m.threadId = next;
          } else if (event === "lecturn/ready") {
            const t = (payload as PaneEvents["lecturn/ready"]).threadId;
            if (t !== null) m.threadId = t;
            m.ready = true;
            settleReady(m, true);
            send({ type: "state", projectId: m.projectId, state: "ready" });
          }
          send({ type: "event", event, payload } as PaneMainMessage);
        }),
      );
    }
    m.offs.push(
      b.on("error", (e: BridgeErrorLike) => {
        if (mount !== m) return;
        log(`lecturn pane: ${e.reason ?? "error"}: ${e.message}`);
        if (e.reason === "renderer-gone") {
          m.ready = false;
          invalidateSnapshot();
          if (m.reloads >= maxReloads) {
            log(`lecturn pane: not reloading after ${m.reloads} reloads`);
            send({ type: "state", projectId: m.projectId, state: "error", message: "The agent pane stopped responding." });
            return;
          }
          m.reloads += 1;
          defer(() => {
            if (mount === m && !destroyed) reload(m, "crash reload");
          });
        } else if (e.reason === "load-failed") {
          send({ type: "state", projectId: m.projectId, state: "error", message: e.message });
        }
      }),
    );
  }

  function dispose(): void {
    const m = mount;
    if (m === null) return;
    mount = null;
    overlayEpoch += 1;
    if (hidden || pending !== null) send({ type: "snapshot.clear" });
    pending = null;
    hidden = false;
    overlays.clear();
    focusOwner = null;
    for (const off of m.offs) off();
    m.offs = [];
    settleReady(m, false);
    for (const ask of [...labelAsks.values()]) if (ask.owner === m) ask.settle({});
    m.bridge.destroy();
  }

  function mountProject(projectId: string): void {
    pendingUnmount += 1; // cancels a deferred unmount
    const workspaceRoot = rootOf(projectId);
    if (mount !== null && shows(mount, projectId, workspaceRoot)) return;
    dispose();
    const threadId = pendingThreads.get(workspaceRoot) ?? pendingThreads.get(`project:${projectId}`);
    pendingThreads.delete(workspaceRoot);
    pendingThreads.delete(`project:${projectId}`);
    let bridge: EmbedBridgeLike;
    let mounted: MountState | null = null;
    try {
      bridge = opts.mount({
        projectId,
        bounds: { ...bounds },
        ...(threadId !== undefined ? { threadId } : {}),
        ...(placeholder !== null ? { composerPlaceholder: placeholder } : {}),
        onDescribeRefs: (refs) => describeRefs(() => mounted, refs),
      });
    } catch (e) {
      log(`lecturn pane: mount failed: ${errText(e)}`);
      send({ type: "state", projectId, state: "error", message: errText(e) });
      return;
    }
    const m: MountState = { projectId, workspaceRoot, bridge, threadId: threadId ?? null, ready: false, reloads: 0, offs: [], readyWaiters: new Set() };
    mounted = m;
    mount = m;
    wire(m);
    send({ type: "state", projectId, state: "mounting" });
  }

  function unmountSoon(): void {
    const seq = ++pendingUnmount;
    defer(() => {
      if (seq === pendingUnmount && !destroyed) dispose();
    });
  }

  async function snapshotFor(token: string, epoch: number): Promise<void> {
    const m = mount;
    if (m === null) return;
    const gen = m.bridge.generation;
    const stale = (): boolean => destroyed || mount !== m || epoch !== overlayEpoch || gen !== m.bridge.generation || guestGone(m);
    let png: Buffer | null = null;
    try {
      if (!stale()) png = await withTimeout(screenshot(m.bridge.debuggerSession), SNAPSHOT_TIMEOUT_MS);
    } catch (e) {
      log(`lecturn pane: overlay snapshot failed: ${errText(e)}`);
    }
    if (stale()) return; // overlay closed, guest changed or died, or pane disposed: drop it
    if (png === null) {
      setVisible(false); // D11 fallback: plain hiding
      return;
    }
    pending = { token, epoch, generation: gen };
    send({ type: "snapshot", token, dataUrl: `data:image/png;base64,${png.toString("base64")}`, rect: { ...bounds } });
  }

  function overlayOpen(token: string, rect: Rect): void {
    if (mount === null || overlays.has(token) || !intersects(rect, bounds)) return;
    overlays.set(token, rect);
    if (overlays.size > 1) return; // already snapshotted or hidden
    overlayEpoch += 1;
    focusOwner = !guestGone(mount) && mount.bridge.webContents.isFocused() ? "guest" : "host";
    if (overlayMode === "hide") {
      setVisible(false);
      return;
    }
    void snapshotFor(token, overlayEpoch);
  }

  function overlayClose(token: string): void {
    if (!overlays.delete(token) || overlays.size > 0) return;
    overlayEpoch += 1; // cancels a snapshot still in flight
    const hadSnapshot = pending !== null || hidden;
    pending = null;
    if (hidden) setVisible(true);
    if (hadSnapshot) send({ type: "snapshot.clear" });
    restoreFocus();
  }

  function restoreFocus(): void {
    const owner = focusOwner;
    focusOwner = null;
    if (owner === "guest" && mount !== null && !guestGone(mount)) mount.bridge.webContents.focus();
    else if (owner === "host" && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
  }

  function snapshotShown(token: string): void {
    const p = pending;
    const m = mount;
    if (p === null || m === null || p.token !== token || p.epoch !== overlayEpoch || p.generation !== m.bridge.generation || guestGone(m)) return;
    pending = { ...p, token: "" }; // shown: later `snapshot-shown` repeats are no-ops, a close still clears it
    setVisible(false);
  }

  function handleHostMessage(raw: unknown): void {
    if (destroyed) return;
    const msg = parsePaneHostMessage(raw);
    if (msg === null) return;
    switch (msg.type) {
      case "mount":
        mountProject(msg.projectId);
        return;
      case "unmount":
        unmountSoon();
        return;
      case "overlay.open":
        overlayOpen(msg.token, normalizeRect(msg.rect));
        return;
      case "overlay.close":
        overlayClose(msg.token);
        return;
      case "overlay.snapshot-shown":
        snapshotShown(msg.token);
        return;
      case "composer.placeholder":
        setPlaceholder(msg.text);
        return;
      case "refs.labels":
        answerLabels(msg.id, msg.labels);
        return;
    }
  }

  function handlePaneRect(raw: unknown): void {
    if (destroyed || !isPaneRect(raw)) return;
    bounds = normalizeRect(raw);
  }

  function onStatus(status: LecturnStatus): void {
    const m = mount;
    const sw = status.switched;
    // Every `switched` push is one switch: a sidecar started again on another port keeps its environment id (Lecturn pin21).
    if (destroyed || m === null || sw === undefined) return;
    // `projects` names every open project's new Lecturn id; one not in it is not on the new server yet.
    if (Object.keys(sw.projects).length > 0 && sw.projects[m.projectId] === undefined) return;
    const threadId = mappedThread(m.threadId, sw.threadIdMap);
    m.threadId = threadId ?? null;
    m.ready = false;
    invalidateSnapshot();
    m.bridge.retarget(m.projectId, threadId).catch((e: unknown) => {
      if (mount === m) log(`lecturn pane: retarget after the live switch failed: ${errText(e)}`);
    });
  }

  function openThread(projectId: string, threadId: string): void {
    if (destroyed) return;
    const root = rootOf(projectId);
    const m = mount;
    if (m !== null && shows(m, projectId, root) && !m.bridge.webContents.isDestroyed()) {
      try {
        m.bridge.openThread(threadId);
      } catch (e) {
        log(`lecturn pane: openThread failed: ${errText(e)}`);
      }
      return;
    }
    pendingThreads.set(root, threadId);
  }

  function whenReady(timeoutMs: number): Promise<boolean> {
    const m = mount;
    if (m === null) return Promise.resolve(false);
    if (m.ready) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        m.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      m.readyWaiters.add(done);
    });
  }

  function captureGuest(): Promise<GuestCapture> {
    const run = async (): Promise<GuestCapture> => {
      const m = mount;
      if (destroyed || m === null || guestGone(m)) return { ok: false, reason: "gone" };
      if (opts.capture === undefined) return { ok: false, reason: "failed", error: "no capture function" };
      const at = { ...bounds };
      if (at.width === 0 || at.height === 0) return { ok: false, reason: "failed", error: "the pane rect is empty" };
      const gen = m.bridge.generation;
      const changed = (): GuestCapture | null => (mount !== m || guestGone(m) ? { ok: false, reason: "gone" } : gen !== m.bridge.generation ? { ok: false, reason: "stale" } : null);
      try {
        const png = await opts.capture(m.bridge);
        return changed() ?? { ok: true, png, bounds: at, generation: gen };
      } catch (e) {
        const reason = (e as BridgeErrorLike | null)?.reason;
        if (reason === "stale-capture") return { ok: false, reason: "stale" };
        if (reason === "guest-gone") return { ok: false, reason: "gone" };
        return changed() ?? { ok: false, reason: "failed", error: errText(e) };
      }
    };
    const next = captureQueue.then(run, run);
    captureQueue = next;
    return next;
  }

  const onHostIpc = (event: { sender: unknown }, message: unknown): void => {
    if (event.sender === win.webContents) handleHostMessage(message);
  };
  const onRectIpc = (event: { sender: unknown }, message: unknown): void => {
    if (event.sender === win.webContents) handlePaneRect(message);
  };

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    pendingUnmount += 1;
    dispose();
    for (const ask of [...labelAsks.values()]) ask.settle({});
    pendingThreads.clear();
    win.removeListener("closed", destroy);
    ipc?.removeListener(PANE_HOST_CHANNEL, onHostIpc);
    ipc?.removeListener(EMBED_PANE_RECT_CHANNEL, onRectIpc);
  }

  win.once("closed", destroy);
  ipc?.on(PANE_HOST_CHANNEL, onHostIpc);
  ipc?.on(EMBED_PANE_RECT_CHANNEL, onRectIpc);

  return {
    get mounted(): PaneMount | null {
      const m = mount;
      return m === null ? null : { projectId: m.projectId, workspaceRoot: m.workspaceRoot, bridge: m.bridge, threadId: m.threadId, ready: m.ready };
    },
    get bounds() {
      return { ...bounds };
    },
    get hidden() {
      return hidden;
    },
    handleHostMessage,
    handlePaneRect,
    onStatus,
    openThread,
    whenReady,
    captureGuest,
    reload: (why: string): boolean => {
      const m = mount;
      if (destroyed || m === null || guestGone(m)) return false;
      log(`lecturn pane: reload (${why})`);
      reload(m, why);
      return true;
    },
    destroy,
  };
}
