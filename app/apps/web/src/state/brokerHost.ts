/**
 * The `app_*` test hook bodies (IF11) the bar capture scripts drive
 * (`app/e2e/capture/pages/*.ts`). The window's viewport host
 * (`../broker/host.ts`) serves them; the server forwards them only when it
 * runs with `RW_TEST_HOOKS=1` (I12).
 */
import { parseRef, type BrokerArgs, type BrokerOp, type JsonObject } from "@rw/contracts";
import { navigatePage, openThread } from "../embed/rail.ts";
import { revealRun } from "./navigation.ts";
import { activeViewport, settle } from "../viewport/registry.ts";
import type { AppStore } from "./store.ts";

type Handlers = { [O in BrokerOp]?: (args: BrokerArgs[O]) => Promise<JsonObject> };

/** The op bodies against the store (exported for tests). */
export function hookHandlers(store: AppStore): Handlers {
  return {
    async app_navigate(a) {
      await navigatePage(store, a.page, a.tab);
      return {};
    },
    async app_select(a) {
      const p = parseRef(a.ref);
      if (!("ok" in p)) throw new Error(`app_select: malformed ref ${a.ref}`);
      if (p.ok.kind === "thread") await openThread(store, p.ok.id);
      else if (p.ok.kind === "run" || p.ok.kind === "sim") await revealRun(store, a.ref);
      else store.getState().selection.select([a.ref], "agent");
      return {};
    },
    async app_set_view(a) {
      const v: { view?: typeof a.view; explode?: number; animate?: boolean; section?: boolean } = {};
      if (a.view !== undefined) v.view = a.view;
      if (a.explode !== undefined) v.explode = a.explode;
      if (a.animate !== undefined) v.animate = a.animate;
      if (a.section !== undefined) v.section = a.section;
      store.getState().ui.setView(v);
      if (a.explode_t !== undefined) {
        // After the state reaches the engine (the tween starts there), pin its time.
        await settle();
        const vp = activeViewport();
        if (!vp?.seekExplode) throw new Error("app_set_view: explode_t needs the assembly viewport");
        vp.seekExplode(a.explode_t);
        await settle();
      }
      return {};
    },
    // The server already imported the Lecturn bundle; `thread` is the
    // thread to open, and it opens in the embedded pane.
    async app_seed_thread(a) {
      if (!("thread" in a)) throw new Error("app_seed_thread: the window opens a thread id");
      await openThread(store, a.thread);
      return { threadId: a.thread };
    },
  };
}
