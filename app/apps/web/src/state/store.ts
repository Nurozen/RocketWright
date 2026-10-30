/**
 * The app store (M1.48): zustand slices `project` (read-only mirror),
 * `draft` (WASM preview), `selection`, `ui`, `chat`, `runs`, `thumbs` (M3.6). Slices are
 * namespaced objects; each owns its actions. Model changes only leave
 * through RPC (`draft.commit`, `runs.run`, chat turns); the mirror changes
 * only from server pushes.
 */
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { createChatSlice, EMPTY_LECTURN } from "./slices/chat.ts";
import { createDraftSlice, EMPTY_DRAFT } from "./slices/draft.ts";
import { createProjectSlice } from "./slices/project.ts";
import { createRunsSlice } from "./slices/runs.ts";
import { createSelectionSlice } from "./slices/selection.ts";
import { createUiSlice } from "./slices/ui.ts";
import { createThumbsSlice, EMPTY_THUMBS } from "./slices/thumbs.ts";
import type { AppState, SliceCtx } from "./types.ts";
import { loadDefaultCore, type PreviewCore } from "./wasm.ts";

export type AppStore = StoreApi<AppState>;

export interface AppStoreOptions {
  /** Loads the wasm core (default: `@rw/rw-wasm`). */
  loadWasm?: () => Promise<PreviewCore>;
  now?: () => number;
}

export function createAppStore(opts: AppStoreOptions = {}): AppStore {
  return createStore<AppState>()((set, get) => {
    const ctx: SliceCtx = {
      get,
      patch(key, partial) {
        set((s) => {
          const add = typeof partial === "function" ? partial(s[key]) : partial;
          return { [key]: { ...s[key], ...add } } as Partial<AppState>;
        });
      },
      conn() {
        if (ctx.client === null || ctx.projectId === null) throw new Error("not connected to a project");
        return { client: ctx.client, projectId: ctx.projectId };
      },
      client: null,
      projectId: null,
      core: null,
      loadCore: opts.loadWasm ?? loadDefaultCore,
      now: opts.now ?? Date.now,
      cleanup: [],
    };
    const project = createProjectSlice(ctx);
    const disconnect = project.disconnect;
    project.disconnect = () => {
      disconnect();
      // Project-scoped data goes with the connection; ui and wasm core stay.
      ctx.patch("draft", { ...EMPTY_DRAFT, ops: [] });
      ctx.patch("chat", (c) => ({ lecturn: { ...EMPTY_LECTURN, embedded: c.lecturn.embedded } }));
      ctx.patch("runs", { overlay: [], started: {}, error: null });
      ctx.patch("thumbs", { ...EMPTY_THUMBS, urls: {}, rendered: [] });
      if (get().selection.refs.length > 0) ctx.patch("selection", (s) => ({ refs: [], source: null, seq: s.seq + 1 }));
    };
    return {
      project,
      draft: createDraftSlice(ctx),
      selection: createSelectionSlice(ctx),
      ui: createUiSlice(ctx),
      chat: createChatSlice(ctx),
      runs: createRunsSlice(ctx),
      thumbs: createThumbsSlice(ctx),
    };
  });
}

/** React binding: `useAppState(store, (s) => s.selection.refs)`. */
export function useAppState<T>(store: AppStore, selector: (s: AppState) => T): T {
  return useStore(store, selector);
}
