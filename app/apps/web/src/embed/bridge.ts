/**
 * The embedded agent pane's bridge on the page side (B10; D10, D11, D25).
 *
 * `PaneBridge` is the one surface the app uses to drive the Lecturn embed
 * (`insertMention`, `openThread`, `newThread`, `openProviders`, `setDraft`,
 * `setComposerPlaceholder`), hear it (`lecturn/navigate`, `thread.changed`,
 * `turn.state`, `ready`) and answer its ref-label asks (`onRefLabels`,
 * `lecturn/appRefs.describe`), whichever way the pane is mounted:
 * - desktop (Electron): main mounts the view (`apps/desktop/src/lecturn.ts`).
 *   The page reports the pane rect with `@lecturn/embed/renderer`'s
 *   `reportPaneRect`, sends commands as the helper's `sendBridge` does
 *   (`lecturn-embed:bridge`), tells main which project to show
 *   (`lecturn-embed:rw-host`, also the placeholder and the label answers)
 *   and hears the guest's events, overlay snapshots, protocol opens and
 *   label asks on `lecturn-embed:rw-to-host`.
 * - plain web: the page mounts the iframe itself with
 *   `@lecturn/embed/browser`'s `mountEmbed`, from `{url, token}` of the
 *   child's `embed.target`; a `lecturn.status` live switch retargets it.
 *   The placeholder and the label resolver go to the helper directly.
 *
 * Also here: the host-overlay watcher (D11). The page reports every open
 * menu or dialog to main, which snapshots the guest when one intersects the
 * pane. Only real overlays count (`[role=menu]`, `[role=dialog]`,
 * `[data-rw-overlay]`): the always-present lists (the left rail's threads
 * and the page trees are `role=listbox`) never do (B5 spike note).
 *
 * DOM- and Electron-free where it can be: globals, IPC and the helper come in
 * through the `*Like` slices, so `embed.test.ts` drives it with fakes.
 */
import {
  DESCRIBE_REFS_MAX,
  EMBED_HOST_BRIDGE_CHANNEL,
  embedThemeInput,
  mappedThread,
  PANE_EVENTS,
  PANE_HOST_CHANNEL,
  parsePaneMainMessage,
  type LecturnHostThemeJson,
  type LecturnStatus,
  type LecturnThemeJson,
  type PaneEvent,
  type PaneEvents,
  type PaneHostMessage,
  type PaneMainMessage,
  type PaneRect,
} from "@rw/contracts";
import type { RpcLike } from "../state/rpc.ts";

export interface MentionParams {
  ref: string;
  label: string;
  iconUrl?: string;
}

/** Answers a label request: ref → label for the refs the app knows (`composerHints.ts` `refLabels`). */
export type RefLabelResolver = (refs: readonly string[]) => Record<string, string>;

/** What the app drives the embed with, in both mount modes. */
export interface PaneBridge {
  insertMention(params: MentionParams): void;
  setDraft(text: string): void;
  openThread(threadId: string): void;
  newThread(params?: { title?: string; appData?: string }): void;
  openProviders(): void;
  on<E extends PaneEvent>(event: E, listener: (payload: PaneEvents[E]) => void): () => void;
  /** The guest composer's idle placeholder (≤ 200 chars); null hands it back to Lecturn's. Kept across remounts and retargets. */
  setComposerPlaceholder?(text: string | null): void;
  /** Answers the guest's `rw:` ref-label asks with `resolve` (the last one set wins); returns its stop. */
  onRefLabels?(resolve: RefLabelResolver): () => void;
}

/** `window.lecturnEmbedIpc` (the desktop preload; what `@lecturn/embed/renderer` sends on). */
export interface EmbedIpcLike {
  send(channel: string, payload: unknown): void;
}

/** `window.rwDesktop.lecturn` (the desktop preload): main's pane messages. */
export interface DesktopLecturnLike {
  onMessage(cb: (message: unknown) => void): () => void;
}

/** The desktop pane's globals, when the page runs in the RocketWright window with a server. */
export interface DesktopPaneGlobals {
  ipc: EmbedIpcLike;
  lecturn: DesktopLecturnLike;
}

/** The desktop preload's pane globals, or null in a plain browser (or a window without a server). */
export function desktopPaneGlobals(g: unknown = globalThis): DesktopPaneGlobals | null {
  const w = g as { lecturnEmbedIpc?: Partial<EmbedIpcLike>; rwDesktop?: { lecturn?: Partial<DesktopLecturnLike> } } | null;
  const ipc = w?.lecturnEmbedIpc;
  const lecturn = w?.rwDesktop?.lecturn;
  if (typeof ipc?.send !== "function" || typeof lecturn?.onMessage !== "function") return null;
  return { ipc: ipc as EmbedIpcLike, lecturn: lecturn as DesktopLecturnLike };
}

type Listeners = Map<PaneEvent, Set<(payload: never) => void>>;

function emitter(): { on: PaneBridge["on"]; emit<E extends PaneEvent>(event: E, payload: PaneEvents[E]): void; clear(): void } {
  const listeners: Listeners = new Map();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(listener as (payload: never) => void);
      return () => void set.delete(listener as (payload: never) => void);
    },
    emit(event, payload) {
      for (const l of [...(listeners.get(event) ?? [])]) (l as (p: typeof payload) => void)(payload);
    },
    clear: () => listeners.clear(),
  };
}

// ---- desktop ------------------------------------------------------------------------------

export interface DesktopPaneDeps {
  globals: DesktopPaneGlobals;
  /** `@lecturn/embed/renderer`'s `reportPaneRect` (keeps the view over `el`; returns its stop). */
  reportPaneRect: (el: Element) => () => void;
  /** The pane's own handling of main's snapshot messages (the `<img>` in the rect). */
  onSnapshot?: (m: Extract<PaneMainMessage, { type: "snapshot" | "snapshot.clear" }>) => void;
  /** Main's mount state (`mounting`/`ready`/`error`). */
  onState?: (m: Extract<PaneMainMessage, { type: "state" }>) => void;
}

export interface DesktopPane {
  readonly bridge: PaneBridge;
  /** Acknowledges a snapshot the page has painted (main then hides the view). */
  snapshotShown(token: string): void;
  stop(): void;
}

/** Desktop mode: report the rect, ask main to mount `projectId`, relay commands and events. */
export function startDesktopPane(el: Element, projectId: string, deps: DesktopPaneDeps): DesktopPane {
  const { ipc, lecturn } = deps.globals;
  const events = emitter();
  const host = (m: PaneHostMessage): void => ipc.send(PANE_HOST_CHANNEL, m);
  const bridgeSend = (method: string, params: object): void => ipc.send(EMBED_HOST_BRIDGE_CHANNEL, { method, params });
  let stopped = false;
  // The rect first, so main mounts at the right bounds.
  const stopRect = deps.reportPaneRect(el);
  let resolveLabels: RefLabelResolver | null = null;
  const offMain = lecturn.onMessage((raw) => {
    if (stopped) return;
    const m = parsePaneMainMessage(raw);
    if (m === null) return;
    if (m.type === "event") events.emit(m.event, m.payload as never);
    else if (m.type === "refs.describe") host({ type: "refs.labels", id: m.id, labels: answerLabels(resolveLabels, m.refs) });
    else if (m.type === "snapshot" || m.type === "snapshot.clear") deps.onSnapshot?.(m);
    else if (m.type === "state" && m.projectId === projectId) deps.onState?.(m);
  });
  host({ type: "mount", projectId });
  const bridge: PaneBridge = {
    insertMention: (params) => bridgeSend("lecturn/composer.insertMention", params),
    setDraft: (text) => bridgeSend("lecturn/composer.setDraft", { text }),
    openThread: (threadId) => bridgeSend("lecturn/thread.open", { threadId }),
    newThread: (params = {}) => bridgeSend("lecturn/thread.new", params),
    openProviders: () => bridgeSend("lecturn/providers.open", {}),
    on: events.on,
    setComposerPlaceholder: (text) => {
      if (!stopped) host({ type: "composer.placeholder", text });
    },
    onRefLabels: (resolve) => {
      resolveLabels = resolve;
      return () => {
        if (resolveLabels === resolve) resolveLabels = null;
      };
    },
  };
  return {
    bridge,
    snapshotShown: (token) => {
      if (!stopped) host({ type: "overlay.snapshot-shown", token });
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopRect();
      offMain();
      events.clear();
      resolveLabels = null;
      host({ type: "unmount" });
    },
  };
}

/** The labels `resolve` gives for `refs` (none without a resolver, or when it throws). */
export function answerLabels(resolve: RefLabelResolver | null, refs: readonly string[]): Record<string, string> {
  if (resolve === null) return {};
  try {
    return resolve(refs.slice(0, DESCRIBE_REFS_MAX));
  } catch {
    return {};
  }
}

/** Desktop `rocketwright://open` (main's `open-project`): the page switches to that project. */
export function onOpenProject(globals: DesktopPaneGlobals, cb: (projectId: string, threadId?: string) => void): () => void {
  return globals.lecturn.onMessage((raw) => {
    const m = parsePaneMainMessage(raw);
    if (m?.type === "open-project") cb(m.projectId, m.threadId);
  });
}

// ---- plain web ----------------------------------------------------------------------------

/** The slice of `@lecturn/embed/browser`'s `EmbedBridge` this module uses. */
export interface BrowserEmbedLike {
  insertMention(params: MentionParams): void;
  setDraft(text: string): void;
  openThread(threadId: string): void;
  newThread(params?: { title?: string; appData?: string }): void;
  openProviders(): void;
  setComposerPlaceholder(text: string | null): void;
  retarget(target: { url: string; token: string }): void;
  on<E extends PaneEvent>(event: E, listener: (payload: PaneEvents[E]) => void): () => void;
  on(event: "error", listener: (error: { readonly reason?: string; readonly message: string }) => void): () => void;
  destroy(): void;
}

export interface MountEmbedOptionsLike {
  url: string;
  token: string;
  theme: ReturnType<typeof embedThemeInput>;
  switcher: boolean;
  composerPlaceholder?: string;
  onTokenRefresh: () => Promise<{ token: string; expiresAt: string }>;
  onDescribeRefs?: (refs: readonly string[]) => Record<string, string>;
}

export interface BrowserPaneDeps {
  client: Pick<RpcLike, "call" | "on">;
  /** `@lecturn/embed/browser`'s `mountEmbed` and B11's theme files (loaded lazily in the app). */
  load: () => Promise<{ mountEmbed: (container: HTMLElement, options: MountEmbedOptionsLike) => BrowserEmbedLike; theme: LecturnThemeJson; hostTheme?: LecturnHostThemeJson }>;
  onState?: (state: "mounting" | "ready" | "error", message?: string) => void;
}

export interface BrowserPane {
  readonly bridge: PaneBridge;
  /** Settles once the iframe is mounted (or the mount failed: `onState("error")`). */
  readonly mounted: Promise<void>;
  stop(): void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Plain-web mode: fetch `embed.target`, mount the iframe in `el`, refresh
 * the token through `embed.refreshToken`, and retarget the same frame on a
 * live switch (D25). Commands before the frame exists are queued.
 */
export function startBrowserPane(el: HTMLElement, projectId: string, deps: BrowserPaneDeps): BrowserPane {
  const events = emitter();
  let embed: BrowserEmbedLike | null = null;
  let stopped = false;
  let threadId: string | null = null;
  /** The placeholder set so far (the mount takes it; later sets go to the helper). */
  let placeholder: string | null = null;
  let resolveLabels: RefLabelResolver | null = null;
  const queued: ((e: BrowserEmbedLike) => void)[] = [];
  const offs: (() => void)[] = [];
  const run = (fn: (e: BrowserEmbedLike) => void): void => {
    if (stopped) return;
    if (embed !== null) fn(embed);
    else queued.push(fn);
  };
  deps.onState?.("mounting");

  // Every `switched` push is one switch: a sidecar started again on another port keeps its environment id (Lecturn pin21).
  const retarget = (switched: NonNullable<LecturnStatus["switched"]>): void => {
    if (Object.keys(switched.projects).length > 0 && switched.projects[projectId] === undefined) return;
    const mapped = mappedThread(threadId, switched.threadIdMap);
    threadId = mapped ?? null;
    deps.client.call("embed.target", mapped === undefined ? { projectId } : { projectId, threadId: mapped }).then(
      (t) => run((e) => e.retarget({ url: t.url, token: t.token })),
      (e: unknown) => deps.onState?.("error", errText(e)),
    );
  };
  offs.push(
    deps.client.on("lecturn.status", (s) => {
      if (!stopped && s.switched !== undefined) retarget(s.switched);
    }),
  );

  const mounted = (async () => {
    try {
      const [target, { mountEmbed, theme, hostTheme }] = await Promise.all([deps.client.call("embed.target", { projectId }), deps.load()]);
      if (stopped) return;
      const e = mountEmbed(el, {
        url: target.url,
        token: target.token,
        theme: embedThemeInput(theme, hostTheme),
        switcher: false,
        ...(placeholder !== null ? { composerPlaceholder: placeholder } : {}),
        onTokenRefresh: async () => {
          const t = await deps.client.call("embed.refreshToken", { projectId });
          return { token: t.token, expiresAt: t.expiresAt };
        },
        onDescribeRefs: (refs) => answerLabels(stopped ? null : resolveLabels, refs),
      });
      embed = e;
      for (const event of PANE_EVENTS) {
        offs.push(
          e.on(event, (payload: PaneEvents[typeof event]) => {
            if (event === "lecturn/thread.changed") threadId = (payload as PaneEvents["lecturn/thread.changed"]).threadId;
            if (event === "lecturn/ready") {
              const t = (payload as PaneEvents["lecturn/ready"]).threadId;
              if (t !== null) threadId = t;
              deps.onState?.("ready");
            }
            events.emit(event, payload as never);
          }),
        );
      }
      offs.push(e.on("error", (err) => (err.reason === "load-failed" ? deps.onState?.("error", err.message) : undefined)));
      for (const fn of queued.splice(0)) fn(e);
    } catch (err) {
      if (!stopped) deps.onState?.("error", errText(err));
    }
  })();

  const bridge: PaneBridge = {
    insertMention: (params) => run((e) => e.insertMention(params)),
    setDraft: (text) => run((e) => e.setDraft(text)),
    openThread: (id) => run((e) => e.openThread(id)),
    newThread: (params = {}) => run((e) => e.newThread(params)),
    openProviders: () => run((e) => e.openProviders()),
    on: events.on,
    setComposerPlaceholder: (text) => {
      if (stopped || text === placeholder) return;
      placeholder = text;
      // Before the frame exists the mount takes it (`composerPlaceholder`).
      if (embed !== null) embed.setComposerPlaceholder(text);
    },
    onRefLabels: (resolve) => {
      resolveLabels = resolve;
      return () => {
        if (resolveLabels === resolve) resolveLabels = null;
      };
    },
  };
  return {
    bridge,
    mounted,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const off of offs.splice(0)) off();
      queued.length = 0;
      events.clear();
      resolveLabels = null;
      embed?.destroy();
      embed = null;
    },
  };
}

// ---- D11 overlays -------------------------------------------------------------------------

/** What counts as a host overlay: menus, dialogs and anything marked `data-rw-overlay` (never the rail's or pages' listboxes). */
export const OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [data-rw-overlay]';

/** One overlay element as the scanner sees it. */
export interface OverlayCandidate {
  readonly key: object;
  readonly rect: PaneRect;
}

/**
 * Diffs the open overlays against the last scan: `overlay.open` for new
 * visible ones, `overlay.close` for gone or collapsed ones. Tokens are stable
 * per element (`tokens`), so reopening the same menu reuses its token.
 */
export function overlayDiff(candidates: Iterable<OverlayCandidate>, open: ReadonlyMap<string, PaneRect>, tokens: WeakMap<object, string>, nextToken: () => string): { open: Map<string, PaneRect>; messages: PaneHostMessage[] } {
  const now = new Map<string, PaneRect>();
  const messages: PaneHostMessage[] = [];
  for (const c of candidates) {
    if (c.rect.width <= 0 || c.rect.height <= 0) continue;
    let t = tokens.get(c.key);
    if (t === undefined) tokens.set(c.key, (t = nextToken()));
    now.set(t, c.rect);
    if (!open.has(t)) messages.push({ type: "overlay.open", token: t, rect: c.rect });
  }
  for (const t of open.keys()) if (!now.has(t)) messages.push({ type: "overlay.close", token: t });
  return { open: now, messages };
}

/**
 * Watches the document for host overlays and reports them to main
 * (`lecturn-embed:rw-host`). Overlays inside `pane` (the reserved rect) do
 * not count. Returns its stop, which closes whatever is still open.
 */
export function watchOverlays(doc: Document, pane: Element, ipc: EmbedIpcLike): () => void {
  const tokens = new WeakMap<object, string>();
  let open = new Map<string, PaneRect>();
  let seq = 0;
  let frame: number | null = null;
  const view = doc.defaultView;
  const scan = (): void => {
    frame = null;
    const candidates: OverlayCandidate[] = [];
    for (const el of doc.querySelectorAll(OVERLAY_SELECTOR)) {
      if (pane.contains(el)) continue;
      const r = el.getBoundingClientRect();
      candidates.push({ key: el, rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
    }
    const d = overlayDiff(candidates, open, tokens, () => `ov-${++seq}`);
    open = d.open;
    for (const m of d.messages) ipc.send(PANE_HOST_CHANNEL, m);
  };
  const schedule = (): void => {
    if (frame === null && view !== null) frame = view.requestAnimationFrame(scan);
  };
  // Synchronous on mutation: a menu must be reported before the frame it paints in.
  const observer = new MutationObserver(scan);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["role", "data-rw-overlay", "hidden", "class", "open"] });
  view?.addEventListener("resize", schedule);
  scan();
  return () => {
    observer.disconnect();
    view?.removeEventListener("resize", schedule);
    if (frame !== null) view?.cancelAnimationFrame(frame);
    for (const t of open.keys()) ipc.send(PANE_HOST_CHANNEL, { type: "overlay.close", token: t });
    open = new Map();
  };
}
