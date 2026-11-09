/**
 * `HostApi` for a plain browser tab (R0.12): the person types paths, there is
 * no Recents, no reopen-last and no native menu, and no server-side store
 * stands in for them.
 *
 * The prompt is injected because a `Modal` belongs in React. `createPathPrompts`
 * is the seam between the two: whoever renders the prompt subscribes with
 * `useSyncExternalStore` and answers through `submit` and `cancel`.
 */
import type { PickFileOptions, PickFolderOptions } from "@rw/contracts";
import type { HostApi, PathPrompt, PathPromptKind, PathPromptRequest } from "./HostApi.ts";

function request(kind: PathPromptKind, fallbackTitle: string, options: PickFolderOptions & PickFileOptions = {}): PathPromptRequest {
  const { title, defaultPath, filters } = options;
  return { kind, title: title ?? fallbackTitle, ...(defaultPath !== undefined ? { defaultPath } : {}), ...(filters !== undefined ? { filters } : {}) };
}

/** A browser may not write outside the project (D18). */
const IN_PROJECT_HINT = "A path inside the project. The desktop app can save anywhere.";

export function createBrowserHost(prompt: PathPrompt): HostApi {
  return {
    kind: "browser",
    boot: () => Promise.resolve({ activeProjectId: null, notice: null }),
    pickFolder: (options) => prompt(request("folder", "Choose a folder", options)),
    pickFile: (options) => prompt(request("file", "Choose a file", options)),
    saveAs: (options) => prompt(request("save", "Save as", options)),
    exportFile: async ({ defaultName }, writeInProject) => {
      const path = await prompt({ ...request("save", "Export", { defaultPath: `exports/${defaultName ?? "export"}` }), hint: IN_PROJECT_HINT });
      return path === null ? { canceled: true } : { canceled: false, out: await writeInProject(path) };
    },
    recents: () => Promise.resolve([]),
    removeRecent: () => Promise.resolve(),
    setActiveProject: () => Promise.resolve(),
    onCommand: () => () => undefined,
    pathForFile: () => null,
  };
}

export interface PathPrompts {
  prompt: PathPrompt;
  /** The question showing now. A stable object until it is answered. */
  current(): PathPromptRequest | null;
  subscribe(listener: () => void): () => void;
  /** Answers with the typed path; a blank one is a cancel. */
  submit(path: string): void;
  cancel(): void;
}

/** One question at a time: a newer one cancels the one showing, so no caller is left waiting on a prompt nobody can see. */
export function createPathPrompts(): PathPrompts {
  let showing: { request: PathPromptRequest; resolve: (path: string | null) => void } | null = null;
  const listeners = new Set<() => void>();
  const settle = (path: string | null): void => {
    const was = showing;
    showing = null;
    was?.resolve(path);
  };
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const finish = (path: string | null): void => {
    if (showing === null) return;
    settle(path);
    changed();
  };
  return {
    prompt: (req) =>
      new Promise((resolve) => {
        settle(null);
        showing = { request: req, resolve };
        changed();
      }),
    current: () => showing?.request ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    submit: (path) => finish(path.trim() === "" ? null : path.trim()),
    cancel: () => finish(null),
  };
}
