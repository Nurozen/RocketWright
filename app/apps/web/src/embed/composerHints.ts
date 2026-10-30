/**
 * The host side of two embed options Lecturn pin4 adds (Lecturn FIXD host
 * placeholder, FIXF ref labels; CPW1R3B, wired in B7d):
 * - the composer placeholder per page (checklists `*.composer.placeholder`:
 *   `Ask about this design…` on the Design pages and 05, `Ask about this
 *   configuration…` on 03, `Ask about these results…` on 04, `Ask about this
 *   simulation…` on 06), the same text the old composer showed
 *   (`shell/model.ts` `composerPlaceholder`);
 * - labels for `rw:` refs the guest shows as chips, from the app's model:
 *   `rw:c/<id>` the component's name, `rw:cfg/<id>` the configuration's,
 *   `rw:sim/<id>` (and `rw:run/<id>`) the run's, `rw:eng/<id>[/feed/…]` the
 *   engine part's (a feed node or line as the diagram names it, else the
 *   engine). An id the model does not have gets no label, so the guest keeps
 *   its own (the stored label, else the ref).
 *
 * Both mount modes offer them (`bridge.ts`): `startBrowserPane` hands them to
 * the helper's `mountEmbed` (`composerPlaceholder`, `setComposerPlaceholder`,
 * `onDescribeRefs`); `startDesktopPane` sends the placeholder to main and
 * answers main's forwarded `lecturn/appRefs.describe` asks
 * (`apps/desktop/src/lecturn.ts`). Still feature-checked: a `PaneBridge`
 * without them (a test fake) gets neither, and `startComposerHints` does
 * nothing for it.
 */
import { parseRef, type PageId, type ProjectSnapshot } from "@rw/contracts";
import { composerPlaceholder } from "../shell/model.ts";
import { nodeLabel } from "../pages/liquid/model.ts";
import type { AppStore } from "../state/store.ts";
import type { DeepReadonly } from "../state/types.ts";
import type { PaneBridge, RefLabelResolver } from "./bridge.ts";

type Snapshot = DeepReadonly<ProjectSnapshot>;

/** The guest's composer placeholder on `page` (the old composer's text). */
export function embedComposerPlaceholder(page: PageId): string {
  return composerPlaceholder(page);
}

/** The label of an `rw:` ref from the model, or null when it names nothing the model has. */
export function refLabel(snap: Snapshot | null, ref: string): string | null {
  const parsed = parseRef(ref);
  if (!("ok" in parsed) || snap === null) return null;
  const { kind, id, pointer } = parsed.ok;
  const ev = snap.evaluated ?? null;
  switch (kind) {
    case "c":
      return ev?.components.find((c) => c.id === id)?.name ?? null;
    case "cfg":
      return ev?.configs[id]?.name ?? null;
    case "sim":
      return snap.runs.runs.find((r) => r.sim === id)?.sim_name ?? ev?.sims[id]?.name ?? null;
    case "run":
      return snap.runs.runs.find((r) => r.run_id === id)?.sim_name ?? null;
    case "eng": {
      const engine = ev?.engines?.[id];
      if (engine === undefined) return null;
      const node = /^\/feed\/node\/([^/]+)$/.exec(pointer)?.[1];
      if (node !== undefined) return engine.nodes[node] !== undefined ? nodeLabel(node) : null;
      const edge = /^\/feed\/edge\/(\d+)$/.exec(pointer)?.[1];
      if (edge !== undefined) {
        const e = engine.edges[Number(edge)];
        return e !== undefined ? `${nodeLabel(e.from)} → ${nodeLabel(e.to)}` : null;
      }
      return pointer === "" || pointer === "/feed" ? engine.name : null;
    }
    default:
      return null;
  }
}

/** Most refs one label request is answered for. */
export const REF_LABELS_MAX = 200;

/** Labels for the refs the model knows (others are left out, so the guest keeps its own). */
export function refLabels(snap: Snapshot | null, refs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs.slice(0, REF_LABELS_MAX)) {
    if (typeof ref !== "string" || ref in out) continue;
    const label = refLabel(snap, ref);
    if (label !== null && label !== "") out[ref] = label;
  }
  return out;
}

export type { RefLabelResolver } from "./bridge.ts";

/** The two options, as a mounted pane offers them once its helper has them. */
export interface PaneBridgeHints {
  /** Sets the guest composer's placeholder (in the embed's host context); null hands it back to Lecturn's. */
  setComposerPlaceholder(text: string | null): void;
  /** Answers the guest's label requests for `rw:` refs with `resolve`; returns its stop. */
  onRefLabels(resolve: RefLabelResolver): () => void;
}

/** The options `bridge` offers (the feature check). */
export function paneHints(bridge: PaneBridge): Partial<PaneBridgeHints> {
  const b = bridge as Partial<PaneBridgeHints>;
  const out: Partial<PaneBridgeHints> = {};
  if (typeof b.setComposerPlaceholder === "function") out.setComposerPlaceholder = b.setComposerPlaceholder.bind(bridge);
  if (typeof b.onRefLabels === "function") out.onRefLabels = b.onRefLabels.bind(bridge);
  return out;
}

/**
 * Keeps the guest's placeholder on the page's text (now and on every page
 * change, once per change) and answers its label requests from the current
 * model, when the pane offers either option. Returns the stop.
 */
export function startComposerHints(store: AppStore, bridge: PaneBridge): () => void {
  const hints = paneHints(bridge);
  const offs: (() => void)[] = [];
  const setPlaceholder = hints.setComposerPlaceholder;
  if (setPlaceholder !== undefined) {
    let last: string | null = null;
    const push = (page: PageId): void => {
      const text = embedComposerPlaceholder(page);
      if (text === last) return;
      last = text;
      setPlaceholder(text);
    };
    push(store.getState().ui.page);
    offs.push(
      store.subscribe((s, prev) => {
        if (s.ui.page !== prev.ui.page) push(s.ui.page);
      }),
    );
  }
  if (hints.onRefLabels !== undefined) offs.push(hints.onRefLabels((refs) => refLabels(store.getState().project.snapshot, refs)));
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
