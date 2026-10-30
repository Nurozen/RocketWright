/**
 * Electron preload (M1.52). Exposes `window.rwDesktop` to the web bundle:
 * the app server's RPC and HTTP URLs, so a page whose query lost `?rpc=`
 * (e.g. a `?page=04` navigation) still reaches the local server. `rpcUrl`
 * carries the server's per-launch token (`?token=`), which the socket
 * upgrade requires.
 *
 * Sandboxed preloads run as plain CommonJS scripts, so this file has no
 * imports or exports and uses only erasable TypeScript: `main.ts` strips the
 * types (`buildPreload` in `backend.ts`) and loads the result. The config
 * comes in through `webPreferences.additionalArguments` as
 * `--rw-desktop=<uri-encoded JSON>` (`desktopArg`).
 *
 * The embedded agent pane (B10, `@rw/contracts` `embedPane.ts`) gets a
 * narrow `lecturn-embed:*` channel and nothing else:
 * - `window.lecturnEmbedIpc.send(channel, payload)` is what
 *   `@lecturn/embed/renderer` (`reportPaneRect`, `sendBridge`) calls; it
 *   sends only on `lecturn-embed:pane-rect`, `lecturn-embed:bridge` and
 *   `lecturn-embed:rw-host` (mount and overlay reports) and drops any other
 *   channel. (`exposeEmbedRendererIpc` does the same, but a sandboxed
 *   preload cannot import it.)
 * - `rwDesktop.lecturn.onMessage` receives main's `lecturn-embed:rw-to-host`
 *   messages (overlay snapshots, guest events, protocol opens).
 */
(() => {
  const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
  const PREFIX = "--rw-desktop=";
  const arg = process.argv.find((a: string) => a.startsWith(PREFIX));
  let config: { rpcUrl?: unknown; serverUrl?: unknown } = {};
  if (arg !== undefined) {
    try {
      config = JSON.parse(decodeURIComponent(arg.slice(PREFIX.length))) as typeof config;
    } catch {
      config = {};
    }
  }
  const url = (v: unknown): string | null => (typeof v === "string" && /^(wss?|https?):\/\//.test(v) ? v : null);
  const SEND = ["lecturn-embed:pane-rect", "lecturn-embed:bridge", "lecturn-embed:rw-host"];
  const TO_HOST = "lecturn-embed:rw-to-host";
  contextBridge.exposeInMainWorld("lecturnEmbedIpc", {
    send: (channel: unknown, payload: unknown) => {
      if (typeof channel === "string" && SEND.includes(channel)) ipcRenderer.send(channel, payload);
    },
  });
  contextBridge.exposeInMainWorld("rwDesktop", {
    desktop: true,
    platform: process.platform,
    rpcUrl: url(config.rpcUrl),
    serverUrl: url(config.serverUrl),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    lecturn: {
      onMessage: (cb: (message: unknown) => void) => {
        const listener = (_e: unknown, message: unknown) => cb(message);
        ipcRenderer.on(TO_HOST, listener);
        return () => void ipcRenderer.removeListener(TO_HOST, listener);
      },
    },
  });
})();
