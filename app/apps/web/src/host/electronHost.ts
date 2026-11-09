/** `HostApi` over the preload's `window.rwDesktop`. Main owns the dialogs and the Recents file. */
import type { DesktopBridge } from "@rw/contracts";
import type { HostApi } from "./HostApi.ts";

export function createElectronHost(bridge: DesktopBridge): HostApi {
  return {
    kind: "desktop",
    boot: () => bridge.boot(),
    pickFolder: (options) => bridge.pickFolder(options),
    pickFile: (options) => bridge.pickFile(options),
    saveAs: (options) => bridge.saveAs(options),
    exportFile: (request) => bridge.exportFile(request),
    recents: () => bridge.recents(),
    removeRecent: (dir) => bridge.removeRecent(dir),
    setActiveProject: (project) => bridge.setActiveProject(project),
    relaunch: () => bridge.relaunch(),
    onCommand: (listener) => bridge.onCommand(listener),
    pathForFile: (file) => {
      // `webUtils.getPathForFile` returns "" for a File that is not on disk (e.g. built by script).
      const path = bridge.pathForFile(file);
      return path === "" ? null : path;
    },
  };
}
