/**
 * Design > Assembly (concept 01, M1.50). Three slots the shell places:
 * the workspace (viewport + inspector), the toolbar row, and the Components
 * tree in the left rail. All three read one store, so a selection made in the
 * tree, the viewport, or a label shows up in the other two (C §5.1), and every
 * toolbar control drives `ui` state the viewport applies.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { ViewId } from "@rw/contracts";
import { MENTION_EVENT } from "../../embed/mention.ts";
import { componentRef, useAppState, type AppStore, type Units } from "../../state/index.ts";
import { selectedComponentIds } from "../../state/slices/selection.ts";
import { AssemblyViewport } from "../../viewport/AssemblyViewport.tsx";
import type { EngineState, FitMargin } from "../../viewport/engine.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import { AssemblyToolbar } from "./AssemblyToolbar.tsx";
import { thumbKey } from "../../render/thumbnails.ts";
import { ComponentTree, iconFor, treeRows } from "./ComponentTree.tsx";
import { INSPECTOR_WIDTH, Inspector } from "./Inspector.tsx";
import { inspectorView } from "./inspector-model.ts";
import "./assembly.css";

export interface AssemblySlots {
  content: ReactNode;
  toolbar: ReactNode;
  nav: ReactNode;
}

export function assemblySlots(store: AppStore, glbDeps: GlbDeps): AssemblySlots {
  return {
    content: <AssemblyWorkspace store={store} glbDeps={glbDeps} />,
    toolbar: <AssemblyToolbarSlot store={store} />,
    nav: <ComponentTreeSlot store={store} />,
  };
}

/** Inspector strip inset: width plus its 8 px margin. */
const INSPECTOR_INSET = INSPECTOR_WIDTH + 8;

/**
 * Page 01's fit margins: a little tighter than the viewport default, so the
 * exploded stack (whose gaps keep every pair clear on screen) stays as chunky
 * as concept 01; the right keeps room for the one-sided leader labels.
 */
export const ASSEMBLY_FIT_MARGIN: FitMargin = { left: 20, top: 12, right: 22, bottom: 24, labelRoom: 0.12 };

/** Sends a component to the chat composer as an `@` mention chip. */
export function mentionInChat(id: string, label: string): void {
  window.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: { ref: componentRef(id), label } }));
}

export function AssemblyWorkspace({ store, glbDeps }: { store: AppStore; glbDeps: GlbDeps }) {
  // D5: the viewport meshes the committed model (the sidecar's mirror) with
  // rw-wasm; while a draft is open it meshes the wasm preview instead (I4).
  const committed = useAppState(store, (s) => s.project.snapshot?.evaluated ?? null);
  const preview = useAppState(store, (s) => s.draft.preview);
  const evaluated = preview ?? committed;
  const check = useAppState(store, (s) => s.project.snapshot?.check ?? null);
  const ui = useAppState(store, (s) => s.ui);
  const refs = useAppState(store, (s) => s.selection.refs);
  const selected = useMemo(() => selectedComponentIds(refs), [refs]);
  const state: EngineState = useMemo(
    () => ({
      view: ui.view,
      explode: ui.explode,
      explodeAnimate: ui.explodeAnimate,
      section: ui.section,
      showInternals: ui.showInternals,
      shadows: ui.shadows,
      hidden: ui.hidden,
      selected,
    }),
    [ui.view, ui.explode, ui.explodeAnimate, ui.section, ui.showInternals, ui.shadows, ui.hidden, selected],
  );
  const first = selected[0] ?? null;
  const view = useMemo(() => (first === null ? null : inspectorView(first, evaluated, check, ui.units)), [first, evaluated, check, ui.units]);
  const cardUrl = useAppState(store, (s) => (first === null ? undefined : s.thumbs.urls[thumbKey(first, "card")]));
  const firstComponent = first === null ? undefined : evaluated?.components.find((c) => c.id === first);
  const thumb = firstComponent ? { url: cardUrl, icon: iconFor(firstComponent as Parameters<typeof iconFor>[0]) } : null;
  const ref = useRef<HTMLDivElement>(null);
  // Read at framing time (layout is current then), not tracked: the camera does not chase the inspector.
  const measureInsetHeight = useCallback(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-testid="inspector"]');
    return el ? el.offsetTop + el.offsetHeight : undefined;
  }, []);
  return (
    <div className="rw-asm" data-testid="assembly" ref={ref}>
      <AssemblyViewport
        state={state}
        evaluated={evaluated as Parameters<typeof AssemblyViewport>[0]["evaluated"]}
        glbDeps={glbDeps}
        insetRight={INSPECTOR_INSET}
        measureInsetHeight={measureInsetHeight}
        fitMargin={ASSEMBLY_FIT_MARGIN}
        onMention={mentionInChat}
        onPick={(id) => store.getState().selection.select(id === null ? [] : [componentRef(id)], "viewport")}
      />
      <Inspector view={view} thumb={thumb} />
    </div>
  );
}

export function AssemblyToolbarSlot({ store }: { store: AppStore }) {
  const ui = useAppState(store, (s) => s.ui);
  const set = (v: Parameters<typeof ui.setView>[0]) => store.getState().ui.setView(v);
  return (
    <AssemblyToolbar
      view={ui.view}
      explode={ui.explode}
      section={ui.section}
      showInternals={ui.showInternals}
      shadows={ui.shadows}
      units={ui.units}
      onView={(view: ViewId) => set({ view })}
      onExplode={(explode, animate) => set({ explode, animate: animate === true })}
      onSection={(section) => set({ section })}
      onShowInternals={(showInternals) => set({ showInternals })}
      onShadows={(shadows) => set({ shadows })}
      onUnits={(u: Units) => store.getState().ui.setUnits(u)}
    />
  );
}

export function ComponentTreeSlot({ store }: { store: AppStore }) {
  const components = useAppState(store, (s) => s.project.snapshot?.evaluated?.components ?? null);
  const hidden = useAppState(store, (s) => s.ui.hidden);
  const refs = useAppState(store, (s) => s.selection.refs);
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  const thumbs = useAppState(store, (s) => s.thumbs.urls);
  const rows = useMemo(
    () => treeRows(components ?? [], hidden, selectedComponentIds(refs), collapsed).map((r) => {
        const url = thumbs[thumbKey(r.id)];
        return url === undefined ? r : { ...r, thumb: url };
      }),
    [components, hidden, refs, collapsed, thumbs],
  );
  return (
    <ComponentTree
      rows={rows}
      onSelect={(id, additive) => {
        const ref = componentRef(id);
        const cur = store.getState().selection.refs.filter((r) => r.startsWith("rw:c/"));
        const next = !additive ? [ref] : cur.includes(ref) ? cur.filter((r) => r !== ref) : [...cur, ref];
        store.getState().selection.select(next, "tree");
      }}
      onToggleHidden={(id) => store.getState().ui.toggleHidden(id)}
      onToggleCollapsed={(id) => setCollapsed((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
    />
  );
}
