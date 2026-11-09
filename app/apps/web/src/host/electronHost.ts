/** `HostApi` over the preload's `window.rwDesktop`. Main owns the dialogs and the Recents file. */
import type { DesktopBridge } from "@rw/contracts";
import type { HostApi } from "./HostApi.ts";

export function createElectronHost(bridge: DesktopBridge): HostApi {
  return {
    kind: "desktop",
    boot: () => bridge.boot(),
    pickFolder: (options) => bridge.pickFolder(options),
    pickFile: (options) => bridge.pickFile(options),
    exportFile: (request) => bridge.exportFile(request),
    saveCsv: (request) => bridge.saveCsv(request),
    recents: () => bridge.recents(),
    removeRecent: (dir) => bridge.removeRecent(dir),
    setActiveProject: (project) => bridge.setActiveProject(project),
    setDirty: (dirty) => bridge.setDirty(dirty),
    onFlush: (flush) =>
      bridge.onFlush((id) => {
        // A flush that throws has not saved, so it is reported as a problem rather than as silence.
        void flush()
          .catch((e: unknown) => [e instanceof Error ? e.message : String(e)])
          .then((problems) => bridge.flushDone({ id, problems }))
          .catch((e: unknown) => console.error("flushDone", e));
      }),
    onDirtyCheck: (isDirty) =>
      bridge.onDirtyCheck((id) => {
        // A check that throws cannot say the page is clean, so it reads as dirty and the person is asked.
        let dirty = true;
        try {
          dirty = isDirty();
        } catch (e) {
          console.error("dirtyCheck", e);
        }
        void bridge.dirtyAnswer({ id, dirty }).catch((e: unknown) => console.error("dirtyAnswer", e));
      }),
    relaunch: () => bridge.relaunch(),
    prefs: () => bridge.prefs(),
    setPrefs: (patch) => bridge.setPrefs(patch),
    openProviders: () => bridge.openProviders(),
    onCommand: (listener) => bridge.onCommand(listener),
    pathForFile: (file) => {
      // `webUtils.getPathForFile` returns "" for a File that is not on disk (e.g. built by script).
      const path = bridge.pathForFile(file);
      return path === "" ? null : path;
    },
  };
}
