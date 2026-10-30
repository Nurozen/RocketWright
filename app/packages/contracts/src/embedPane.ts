/**
 * The embedded agent pane's window channel (B10; D10, D11, D25): what the
 * RocketWright page (renderer) and Electron main say to each other about the
 * Lecturn embed view. Not IF10: these travel over Electron IPC only.
 *
 * Every channel is under `lecturn-embed:` (the prefix `@lecturn/embed`'s
 * renderer IPC accepts; the preload sends on these and nothing else):
 * - `lecturn-embed:pane-rect` and `lecturn-embed:bridge` are the helper's
 *   own (`reportPaneRect`, `sendBridge`); main's `mountEmbedView` listens.
 * - `lecturn-embed:rw-host` carries `PaneHostMessage` (renderer → main):
 *   which project the pane shows, the open host overlays (D11), the guest
 *   composer's placeholder, and the answers to the guest's ref-label asks.
 * - `lecturn-embed:rw-to-host` carries `PaneMainMessage` (main → renderer):
 *   overlay snapshots, the guest's bridge events, protocol opens, and the
 *   guest's ref-label asks (`lecturn/appRefs.describe`, which main receives
 *   through the helper's `onDescribeRefs` and the page answers from its model).
 */

/** The helper's pane-rect channel (`@lecturn/embed/renderer` `reportPaneRect`). */
export const EMBED_PANE_RECT_CHANNEL = "lecturn-embed:pane-rect";
/** The helper's host→guest bridge channel (`@lecturn/embed/renderer` `sendBridge`). */
export const EMBED_HOST_BRIDGE_CHANNEL = "lecturn-embed:bridge";
/** Renderer → main: `PaneHostMessage`. */
export const PANE_HOST_CHANNEL = "lecturn-embed:rw-host";
/** Main → renderer: `PaneMainMessage`. */
export const PANE_MAIN_CHANNEL = "lecturn-embed:rw-to-host";
/** The only channels the host preload sends on. */
export const PANE_SEND_CHANNELS: readonly string[] = [EMBED_PANE_RECT_CHANNEL, EMBED_HOST_BRIDGE_CHANNEL, PANE_HOST_CHANNEL];

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Guest → host bridge events (Lecturn I4), forwarded by main in desktop mode. */
export interface PaneEvents {
  "lecturn/navigate": { ref: string };
  "lecturn/thread.changed": { threadId: string | null };
  "lecturn/turn.state": { threadId: string; state: "idle" | "running" | "awaiting-approval" };
  "lecturn/ready": { threadId: string | null };
}
export type PaneEvent = keyof PaneEvents;
export const PANE_EVENTS: readonly PaneEvent[] = ["lecturn/navigate", "lecturn/thread.changed", "lecturn/turn.state", "lecturn/ready"];

/** Lecturn's caps (`EmbedComposerPlaceholder`, `EMBED_DESCRIBE_REFS_MAX`, a ref label's length). */
export const COMPOSER_PLACEHOLDER_MAX = 200;
export const DESCRIBE_REFS_MAX = 64;
export const REF_LABEL_MAX = 256;
/** Lecturn's ref length cap (`EmbedInsertMentionParams.ref`). */
const REF_MAX = 512;

/**
 * Renderer → main. Overlay tokens are renderer-chosen and unique per open
 * overlay; `overlay.snapshot-shown` acknowledges the frame main sent for it.
 */
export type PaneHostMessage =
  | { type: "mount"; projectId: string }
  | { type: "unmount" }
  | { type: "overlay.open"; token: string; rect: PaneRect }
  | { type: "overlay.close"; token: string }
  | { type: "overlay.snapshot-shown"; token: string }
  /** The guest composer's idle placeholder; null hands it back to Lecturn's wording. */
  | { type: "composer.placeholder"; text: string | null }
  /** The page's answer to main's `refs.describe` `id`: labels for the refs it knows. */
  | { type: "refs.labels"; id: string; labels: Record<string, string> };

/**
 * Main → renderer:
 * - `snapshot` / `snapshot.clear`: show this frame of the guest in the pane
 *   rect while an overlay covers it, or remove it (D11);
 * - `event`: a guest bridge event of the mounted pane;
 * - `state`: the mount's lifecycle (`error` carries why it failed);
 * - `open-project`: a `rocketwright://open` asked for this project (the page
 *   switches to it; main opens the thread once the pane mounts);
 * - `refs.describe`: the guest asked for labels of these `refs` (at most
 *   `DESCRIBE_REFS_MAX`); the page answers with `refs.labels` and the same `id`.
 */
export type PaneMainMessage =
  | { type: "snapshot"; token: string; dataUrl: string; rect: PaneRect }
  | { type: "snapshot.clear" }
  | { [E in PaneEvent]: { type: "event"; event: E; payload: PaneEvents[E] } }[PaneEvent]
  | { type: "state"; projectId: string; state: "mounting" | "ready" | "error"; message?: string }
  | { type: "open-project"; projectId: string; threadId?: string }
  | { type: "refs.describe"; id: string; refs: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function isPaneRect(v: unknown): v is PaneRect {
  return isObj(v) && ["x", "y", "width", "height"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));
}

/** Validates a renderer message; null for anything malformed. */
export function parsePaneHostMessage(v: unknown): PaneHostMessage | null {
  if (!isObj(v)) return null;
  const token = typeof v.token === "string" && v.token !== "" ? v.token : null;
  switch (v.type) {
    case "mount":
      return typeof v.projectId === "string" && v.projectId !== "" ? { type: "mount", projectId: v.projectId } : null;
    case "unmount":
      return { type: "unmount" };
    case "overlay.open":
      return token !== null && isPaneRect(v.rect) ? { type: "overlay.open", token, rect: { x: v.rect.x, y: v.rect.y, width: v.rect.width, height: v.rect.height } } : null;
    case "overlay.close":
      return token !== null ? { type: "overlay.close", token } : null;
    case "overlay.snapshot-shown":
      return token !== null ? { type: "overlay.snapshot-shown", token } : null;
    case "composer.placeholder":
      return v.text === null ? { type: "composer.placeholder", text: null } : isPlaceholder(v.text) ? { type: "composer.placeholder", text: v.text } : null;
    case "refs.labels":
      return typeof v.id === "string" && v.id !== "" && isObj(v.labels) ? { type: "refs.labels", id: v.id, labels: refLabelRecord(v.labels) } : null;
    default:
      return null;
  }
}

/** A placeholder Lecturn accepts: 1 to `COMPOSER_PLACEHOLDER_MAX` characters. */
export function isPlaceholder(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= COMPOSER_PLACEHOLDER_MAX;
}

/** The string → non-empty string entries of `labels` (labels cut to `REF_LABEL_MAX`); anything else is dropped. */
export function refLabelRecord(labels: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, label] of Object.entries(labels)) {
    if (typeof label !== "string") continue;
    const name = label.trim().slice(0, REF_LABEL_MAX);
    if (name !== "") out[ref] = name;
  }
  return out;
}

/** Validates a main message (the renderer trusts only well-formed ones). */
export function parsePaneMainMessage(v: unknown): PaneMainMessage | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case "snapshot":
      return typeof v.token === "string" && typeof v.dataUrl === "string" && v.dataUrl.startsWith("data:image/") && isPaneRect(v.rect)
        ? { type: "snapshot", token: v.token, dataUrl: v.dataUrl, rect: v.rect }
        : null;
    case "snapshot.clear":
      return { type: "snapshot.clear" };
    case "event":
      return typeof v.event === "string" && (PANE_EVENTS as readonly string[]).includes(v.event) && isObj(v.payload) ? (v as unknown as PaneMainMessage) : null;
    case "state":
      return typeof v.projectId === "string" && (v.state === "mounting" || v.state === "ready" || v.state === "error")
        ? { type: "state", projectId: v.projectId, state: v.state, ...(typeof v.message === "string" ? { message: v.message } : {}) }
        : null;
    case "open-project":
      return typeof v.projectId === "string" ? { type: "open-project", projectId: v.projectId, ...(typeof v.threadId === "string" ? { threadId: v.threadId } : {}) } : null;
    case "refs.describe":
      return typeof v.id === "string" &&
        v.id !== "" &&
        Array.isArray(v.refs) &&
        v.refs.length >= 1 &&
        v.refs.length <= DESCRIBE_REFS_MAX &&
        v.refs.every((r) => typeof r === "string" && r !== "" && r.length <= REF_MAX)
        ? { type: "refs.describe", id: v.id, refs: [...(v.refs as string[])] }
        : null;
    default:
      return null;
  }
}

/** B11's generated theme file (`app/packages/ui/generated/lecturn-theme.json`). */
export interface LecturnThemeJson {
  variables: Record<string, string>;
  fontsCss: string;
}

/**
 * B11's host-only theme file (`app/packages/ui/generated/lecturn-theme-host.json`):
 * allowlisted variables newer than the theme file Lecturn keeps a copy of
 * (`--destructive`, Lecturn pin4; `--success`, `--success-foreground`, pin5),
 * sent by RocketWright on top of it.
 */
export interface LecturnHostThemeJson {
  variables: Record<string, string>;
}

/**
 * The embed's theme input (`EmbedThemeInput`): dark mode, the allowlisted
 * variables (the theme file's, then the host-only file's) and the
 * `@font-face` fonts.
 */
export function embedThemeInput(file: LecturnThemeJson, host?: LecturnHostThemeJson): { theme: "dark"; styles: { variables: Record<string, string>; css: { fonts: string } } } {
  return { theme: "dark", styles: { variables: { ...file.variables, ...host?.variables }, css: { fonts: file.fontsCss } } };
}

/**
 * The thread a pane shows after a live switch (D25): the old thread's mapped
 * id, else none (the guest then opens the project's newest thread).
 */
export function mappedThread(threadId: string | null | undefined, threadIdMap: Readonly<Record<string, string>>): string | undefined {
  if (threadId === null || threadId === undefined) return undefined;
  return threadIdMap[threadId] ?? undefined;
}
