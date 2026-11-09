/**
 * Files dropped on the window (R3.1, D18). A file the page does not take makes
 * the window navigate to it, so `dragover` and `drop` are cancelled for every
 * file; main's `will-navigate` guard is the backstop for a drop that lands
 * before this listens. Only drags that carry files are touched, so text still
 * drags into a field. A drop over the agent pane lands in its guest, not here:
 * `paneDropPreload.ts` hands the imports back through main and `AppRoot` runs
 * them through the same `importPath`.
 */
import { useEffect, useRef } from "react";
import type { HostApi } from "../host/HostApi.ts";

export const DROP_ONE_FILE = "Drop one file at a time.";
export const DROP_NEEDS_DESKTOP = "Dropping a file needs the desktop app. Use Import and type the file's path.";

export type DropResult = { path: string } | { refused: string };

/** What a drop of `files` means: the one path to import, or why not. */
export function readDrop(files: ArrayLike<File>, host: Pick<HostApi, "pathForFile">): DropResult {
  if (files.length !== 1) return { refused: DROP_ONE_FILE };
  const path = host.pathForFile(files[0]!);
  return path === null ? { refused: DROP_NEEDS_DESKTOP } : { path };
}

const carriesFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes("Files") === true;

export function useFileDrop(target: Pick<Window, "addEventListener" | "removeEventListener">, host: Pick<HostApi, "pathForFile">, onPath: (path: string) => void, onRefused: (message: string) => void): void {
  // Registered once: a listener re-added per render could miss a drop in between.
  const latest = useRef({ host, onPath, onRefused });
  latest.current = { host, onPath, onRefused };

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      const now = latest.current;
      const result = readDrop(e.dataTransfer?.files ?? [], now.host);
      if ("path" in result) now.onPath(result.path);
      else now.onRefused(result.refused);
    };
    target.addEventListener("dragover", over as EventListener);
    target.addEventListener("drop", drop as EventListener);
    return () => {
      target.removeEventListener("dragover", over as EventListener);
      target.removeEventListener("drop", drop as EventListener);
    };
  }, [target]);
}
