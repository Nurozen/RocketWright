/**
 * The agent pane's body once Lecturn runs the chat (B10; D10, D11): a
 * reserved rect the Lecturn embed fills.
 * - Desktop: the rect is reported to main (`@lecturn/embed/renderer`
 *   `reportPaneRect`), which mounts its `WebContentsView` over it. Host
 *   overlays are reported (`watchOverlays`); while one covers the pane, main's
 *   snapshot of the guest shows here as an `<img>` and the view is hidden.
 * - Plain web: the iframe is mounted inside the rect (`mountEmbed`, from the
 *   child's `embed.target`).
 * Either way the parent gets the `PaneBridge` (`onBridge`) to drive it.
 */
import { reportPaneRect } from "@lecturn/embed/renderer";
import type { LecturnHostThemeJson, LecturnThemeJson } from "@rw/contracts";
import { useEffect, useRef, useState } from "react";
import type { RpcLike } from "../state/rpc.ts";
import {
  desktopPaneGlobals,
  startBrowserPane,
  startDesktopPane,
  watchOverlays,
  type BrowserPaneDeps,
  type DesktopPane,
  type DesktopPaneGlobals,
  type PaneBridge,
} from "./bridge.ts";

/** `@lecturn/embed/browser` and B11's theme files, loaded only when the web pane mounts. */
export const loadBrowserEmbed: BrowserPaneDeps["load"] = async () => {
  const [{ mountEmbed }, theme, hostTheme] = await Promise.all([
    import("@lecturn/embed/browser"),
    import("../../../../packages/ui/generated/lecturn-theme.json"),
    import("../../../../packages/ui/generated/lecturn-theme-host.json"),
  ]);
  return { mountEmbed, theme: theme.default as LecturnThemeJson, hostTheme: hostTheme.default as LecturnHostThemeJson };
};

export interface EmbedPaneProps {
  /** RocketWright's project id (main and the child resolve its Lecturn project). */
  projectId: string;
  client: Pick<RpcLike, "call" | "on">;
  /** Gets the pane's bridge once it is mounted, and null when it goes. */
  onBridge?: (bridge: PaneBridge | null) => void;
  /** Test seams: the desktop globals (null forces web mode) and the helper. */
  desktop?: DesktopPaneGlobals | null;
  load?: BrowserPaneDeps["load"];
}

type PaneState = { state: "mounting" | "ready" | "error"; message?: string };

export function EmbedPane({ projectId, client, onBridge, desktop: desktopProp, load = loadBrowserEmbed }: EmbedPaneProps) {
  const rect = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const desktopPane = useRef<DesktopPane | null>(null);
  const [state, setState] = useState<PaneState>({ state: "mounting" });
  const [snapshot, setSnapshot] = useState<{ token: string; dataUrl: string } | null>(null);
  const desktop = desktopProp === undefined ? desktopPaneGlobals() : desktopProp;
  const bridgeCb = useRef(onBridge);
  bridgeCb.current = onBridge;

  useEffect(() => {
    const el = rect.current;
    const holder = frame.current;
    if (el === null || holder === null) return;
    setState({ state: "mounting" });
    if (desktop !== null) {
      const pane = startDesktopPane(el, projectId, {
        globals: desktop,
        reportPaneRect,
        onSnapshot: (m) => setSnapshot(m.type === "snapshot" ? { token: m.token, dataUrl: m.dataUrl } : null),
        onState: (m) => setState(m.message !== undefined ? { state: m.state, message: m.message } : { state: m.state }),
      });
      desktopPane.current = pane;
      const stopOverlays = watchOverlays(el.ownerDocument, el, desktop.ipc);
      bridgeCb.current?.(pane.bridge);
      return () => {
        stopOverlays();
        pane.stop();
        desktopPane.current = null;
        setSnapshot(null);
        bridgeCb.current?.(null);
      };
    }
    const pane = startBrowserPane(holder, projectId, {
      client,
      load,
      onState: (s, message) => setState(message !== undefined ? { state: s, message } : { state: s }),
    });
    bridgeCb.current?.(pane.bridge);
    return () => {
      pane.stop();
      bridgeCb.current?.(null);
    };
  }, [projectId, client, desktop === null, load]);

  return (
    <div ref={rect} className="rw-embed" data-testid="agent.embed" data-rw-region="agent-embed" data-mode={desktop !== null ? "desktop" : "web"} data-state={state.state}>
      <div ref={frame} className="rw-embed__frame" />
      {snapshot !== null && (
        <img className="rw-embed__snapshot" data-testid="agent.embed-snapshot" src={snapshot.dataUrl} alt="" onLoad={() => desktopPane.current?.snapshotShown(snapshot.token)} />
      )}
      {state.state === "error" && (
        <p className="rw-embed__error" role="status" data-testid="agent.embed-error">
          {state.message ?? "The agent pane could not load."}
        </p>
      )}
    </div>
  );
}
