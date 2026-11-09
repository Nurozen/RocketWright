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
 *
 * Desktop services (`DesktopBridge` in `@rw/contracts` `desktop.ts`): each
 * `rwDesktop` method names one `rw-desktop:*` channel below, so the page can
 * reach only those and never gets `ipcRenderer` itself. `preload.test.ts`
 * holds the channel names to the contract this file cannot import.
 */
(() => {
  const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");
  const PREFIX = "--rw-desktop=";
  const arg = process.argv.find((a: string) => a.startsWith(PREFIX));
  let config: { rpcUrl?: unknown; serverUrl?: unknown; startupError?: unknown } = {};
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
  const INVOKE = {
    boot: "rw-desktop:boot",
    pickFolder: "rw-desktop:pick-folder",
    pickFile: "rw-desktop:pick-file",
    saveAs: "rw-desktop:save-as",
    exportFile: "rw-desktop:export-file",
    recents: "rw-desktop:recents",
    removeRecent: "rw-desktop:remove-recent",
    setActiveProject: "rw-desktop:set-active-project",
    setDirty: "rw-desktop:set-dirty",
    prefs: "rw-desktop:prefs",
    setPrefs: "rw-desktop:set-prefs",
    openProviders: "rw-desktop:open-providers",
    relaunch: "rw-desktop:relaunch",
  };
  const COMMAND = "rw-desktop:command";
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
    startupError: typeof config.startupError === "string" ? config.startupError : null,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    boot: () => ipcRenderer.invoke(INVOKE.boot),
    pickFolder: (options: unknown) => ipcRenderer.invoke(INVOKE.pickFolder, options),
    pickFile: (options: unknown) => ipcRenderer.invoke(INVOKE.pickFile, options),
    saveAs: (options: unknown) => ipcRenderer.invoke(INVOKE.saveAs, options),
    exportFile: (request: unknown) => ipcRenderer.invoke(INVOKE.exportFile, request),
    recents: () => ipcRenderer.invoke(INVOKE.recents),
    removeRecent: (dir: unknown) => ipcRenderer.invoke(INVOKE.removeRecent, dir),
    setActiveProject: (project: unknown) => ipcRenderer.invoke(INVOKE.setActiveProject, project),
    setDirty: (dirty: unknown) => ipcRenderer.invoke(INVOKE.setDirty, dirty),
    prefs: () => ipcRenderer.invoke(INVOKE.prefs),
    setPrefs: (patch: unknown) => ipcRenderer.invoke(INVOKE.setPrefs, patch),
    openProviders: () => ipcRenderer.invoke(INVOKE.openProviders),
    relaunch: () => ipcRenderer.invoke(INVOKE.relaunch),
    onCommand: (cb: (command: unknown) => void) => {
      const listener = (_e: unknown, command: unknown) => cb(command);
      ipcRenderer.on(COMMAND, listener);
      return () => void ipcRenderer.removeListener(COMMAND, listener);
    },
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    lecturn: {
      onMessage: (cb: (message: unknown) => void) => {
        const listener = (_e: unknown, message: unknown) => cb(message);
        ipcRenderer.on(TO_HOST, listener);
        return () => void ipcRenderer.removeListener(TO_HOST, listener);
      },
    },
  });
})();
