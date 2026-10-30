/**
 * The app shell driven by the store (M1.49): header (project switcher, save
 * state, tabs, Check model), rail (page threads, Components tree or Runs with
 * eye toggles), history strip (steps, revisions, Compare), and the agent pane.
 * Every action goes through the store or the RPC client (I1, I2); page bodies
 * come from `renderPage` (pages and the viewport belong to their own steps).
 *
 * The agent pane (B10): with a connection and a project the pane body is the
 * Lecturn embed (`EmbedPane`; when Lecturn is unavailable it says so in the
 * rect), and page extras render into the RocketWright strip (`AgentExtras`)
 * outside its rect. B17 removed the old chat that used to stand in for it.
 *
 * The rail (B12) lists the project's Lecturn threads and its
 * actions go through the pane's bridge (`lecturn/thread.open`,
 * `lecturn/thread.new {title, appData}`); Settings opens Lecturn's providers
 * panel; `embed/wiring.ts` handles navigate, mentions, the D12 fallback,
 * run subtitles and the host context.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageId, RwRef } from "@rw/contracts";
import { ensurePageThread, navigatePage, newPageThread, openArtifactThread, openProviders, openThread } from "../embed/rail.ts";
import { setPane } from "../embed/threads.ts";
import { wirePane } from "../embed/wiring.ts";
import { desktopPaneGlobals, onOpenProject, type PaneBridge } from "../embed/bridge.ts";
import { EmbedPane } from "../embed/EmbedPane.tsx";
import { defaultCompare, versionLabel } from "../pages/compare/model.ts";
import type { RpcLike } from "../state/rpc.ts";
import { type AppStore, useAppState } from "../state/store.ts";
import type { ViewId } from "@rw/contracts";
import { AppShell, type ShellHandlers } from "./AppShell.tsx";
import { shellModelFrom } from "./connect.ts";
import { PAGE_TABS, pageOf, type DesignTab, type ShellHistoryStep, type ShellNavRow, type ShellProject } from "./model.ts";
import { undoKey } from "./undo.ts";
import { ViewportToolbar, type ViewChip } from "./ViewportToolbar.tsx";

export interface ConnectedShellProps {
  store: AppStore;
  /** The connection (project list, Check model, Compare); actions that need it are inert without one. */
  client?: RpcLike | null;
  /** The page body for `page` (pages are separate steps). */
  renderPage?: (page: PageId) => ReactNode;
  /**
   * The Compare view (M2.7), shown in the workspace in place of the page
   * while `ui.compare` is set (the strip's Compare, `Show differences ›`).
   */
  renderCompare?: () => ReactNode;
  /** Page controls inside the viewport toolbar row. */
  toolbarControls?: (page: PageId) => ReactNode;
  /**
   * Page-owned shell slots (M1.50 Assembly, M1.51 Results): a whole toolbar
   * row replacing the default one, the body of the rail's navigation section
   * or the whole section, and rows below the history steps.
   */
  pageSlots?: (page: PageId) => PageSlots | null;
  now?: () => number;
  /** Also gets the embedded pane's bridge (the shell itself drives mentions, threads and providers through it, B12). */
  onPaneBridge?: (bridge: PaneBridge | null) => void;
}

/** Shell slots a page may own; absent ones keep the shell defaults. */
export interface PageSlots {
  toolbar?: ReactNode;
  /** Body of the rail's navigation section (keeps the section head). */
  nav?: ReactNode;
  /** The whole rail navigation section (Results: Runs). */
  railNav?: ReactNode;
  /** Rows below the history steps, after any compare result (Results: run snapshots). */
  historyExtra?: ReactNode;
  /** The agent pane's RocketWright strip (`AgentExtras`; 02: Changed fields, thread history; 03: Run configurations; 05: Missing inputs). */
  agentExtra?: ReactNode;
  /** Footer pinned to the rail bottom (02: view chips). */
  railFooter?: ReactNode;
}

/**
 * Window event a page dispatches to open the history-strip Compare for two
 * versions (`step:<n>`; 02 "Compare revisions ›").
 */
export const COMPARE_EVENT = "rw:compare-versions";
export interface CompareEventDetail {
  a: string;
  b: string;
}

/** Pages with a viewport toolbar row (C§4.1, C§4.3). */
const TOOLBAR_PAGES: ReadonlySet<PageId> = new Set(["assembly", "configurations"]);

/** The pane body's hint before the embed mounts (no project yet); concept 06 has none. */
const HINTS: Record<PageId, string | null> = {
  assembly: "Select any part to ask about it.",
  components: "Select any part to ask about it.",
  configurations: "Select a configuration to ask about it.",
  results: "Select a run to ask about it.",
  liquid: "Select a component to ask about it.",
  "propulsion-sim": null,
};

const chipOf = (v: ViewId): ViewChip => (v[0]!.toUpperCase() + v.slice(1)) as ViewChip;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ConnectedShell({ store, client = null, renderPage, renderCompare, toolbarControls, pageSlots, now = Date.now, onPaneBridge }: ConnectedShellProps) {
  const s = useAppState(store, (x) => x);
  const desktop = useMemo(() => desktopPaneGlobals(), []);
  const [clock, setClock] = useState(now());
  const [checking, setChecking] = useState(false);
  const [projects, setProjects] = useState<ShellProject[] | null>(null);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDesign, setLastDesign] = useState<DesignTab>("assembly");

  useEffect(() => {
    const t = setInterval(() => setClock(now()), 30_000);
    return () => clearInterval(t);
  }, [now]);

  const page = s.ui.page;
  const connected = s.project.connection === "open";
  // B12: once Lecturn's list is in and the pane is up to be told (then on page changes only:
  // a deep-linked or guest-made thread is not switched away from when the list changes).
  const lecturnListed = s.chat.lecturn.threads !== null;
  const [bridge, setBridge] = useState<PaneBridge | null>(null);
  useEffect(() => {
    if (connected) ensurePageThread(store).catch((e: unknown) => setError(message(e)));
  }, [store, connected, page, lecturnListed, bridge]);
  useEffect(() => {
    const local = PAGE_TABS[page].local;
    if (local !== null) setLastDesign(local);
  }, [page]);

  // A page asks for a two-version Compare (02 "Compare revisions ›"): the
  // Compare view (M2.7) opens on those versions.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<CompareEventDetail>).detail;
      if (!d?.a || !d.b) return;
      store.getState().ui.setCompare({ old: d.a, new: d.b });
    };
    window.addEventListener(COMPARE_EVENT, on);
    return () => window.removeEventListener(COMPARE_EVENT, on);
  }, [store]);

  const model = useMemo(
    () => shellModelFrom(s, clock, { checking, ...(projects !== null ? { projects } : {}) }),
    [s, clock, checking, projects],
  );
  const { tab, local } = PAGE_TABS[page];
  const projectId = s.project.projectId;
  const slots = pageSlots?.(page) ?? null;
  const embedded = client !== null && projectId !== null;

  // B12: the rail lists Lecturn's threads while the embed is the pane; the
  // mounted pane's bridge drives threads, mentions, navigation, host context.
  useEffect(() => {
    store.getState().chat.setEmbedded(embedded);
  }, [store, embedded]);
  const paneCb = useRef(onPaneBridge);
  paneCb.current = onPaneBridge;
  const onBridge = useCallback(
    (b: PaneBridge | null) => {
      setPane(store, b);
      setBridge(b);
      paneCb.current?.(b);
    },
    [store],
  );
  useEffect(() => {
    if (bridge === null || client === null || projectId === null) return;
    return wirePane(store, client, projectId, bridge, { onError: (e) => setError(message(e)) });
  }, [store, client, projectId, bridge]);
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => setError(message(e)));
  // Revert, undo, and redo are all `history_restore` (never a separate undo stack).
  const restore = (version: string) => {
    if (client === null || projectId === null || reverting) return;
    setReverting(true);
    run(
      client
        .call("history.restore", { projectId, version })
        .then(() => store.getState().ui.setCompare(null))
        .finally(() => setReverting(false)),
    );
  };

  const handlers: ShellHandlers = {
    onCheckModel: () => {
      if (client === null || projectId === null) return;
      setChecking(true);
      run(client.call("check.run", { projectId }).finally(() => setChecking(false)));
    },
    onOpenProjects: () => {
      if (client !== null) run(client.call("project.list", {}).then((r) => setProjects(r.projects.map((p) => ({ id: p.projectId, name: p.name })))));
    },
    onSwitchProject: (id) => {
      if (client === null) return;
      store.getState().ui.setCompare(null);
      run(s.project.connect(client, id));
    },
    onSelectThread: (id) => run(openThread(store, id)),
    onNewThread: () => newPageThread(store),
    onSelectNav: (row: ShellNavRow) => {
      if (row.ref === undefined) return;
      if (page === "results") {
        // A run row: select its latest run and open the run's thread (R6.9).
        const entry = s.project.snapshot?.runs.runs.find((r) => r.sim === row.id);
        const ref: RwRef = entry?.run_id ? `rw:run/${entry.run_id}` : row.ref;
        store.getState().selection.select([ref], "tree");
        run(openArtifactThread(store, row.ref, row.label));
      } else {
        store.getState().selection.select([row.ref], "tree");
      }
    },
    onToggleNav: (row) => (row.status ? store.getState().runs.toggleOverlay(row.id) : store.getState().ui.toggleHidden(row.id)),
    onOpenNavThread: (row) => {
      if (row.ref !== undefined) run(openArtifactThread(store, row.ref, row.label));
    },
    onSelectStep: (step: ShellHistoryStep) => {
      if (step.ref !== undefined) store.getState().selection.select([step.ref], "history");
    },
    onCompare: () => {
      if (model.history.length === 0) return;
      const ui = store.getState().ui;
      // The strip's Compare toggles the view: the selected step (or the one before the latest) against the latest.
      ui.setCompare(ui.compare !== null ? null : defaultCompare(s.project.snapshot, model.currentStepId));
    },
    onRevert: () => {
      const version = model.currentStepId;
      if (version === null || version === model.shownStepId) return;
      restore(version);
    },
    onUndo: () => {
      const t = model.undo?.undo;
      if (t) restore(t.id);
    },
    onRedo: () => {
      const t = model.undo?.redo;
      if (t) restore(t.id);
    },
    // W3.6: with the embed, Settings shows Lecturn's providers panel in the pane.
    onOpenSettings: () => openProviders(store),
  };

  // Undo/redo shortcuts (text fields keep their own undo).
  const keys = useRef(handlers);
  keys.current = handlers;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = undoKey(e);
      if (k === null) return;
      e.preventDefault();
      if (k === "undo") keys.current.onUndo?.();
      else keys.current.onRedo?.();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const snap = s.project.snapshot;
  const compareOpen = s.ui.compare !== null && renderCompare !== undefined;

  // `rocketwright://open` (desktop): main opened a project and asks the page to show it.
  useEffect(() => {
    if (desktop === null || client === null) return;
    return onOpenProject(desktop, (id) => {
      if (store.getState().project.projectId === id) return;
      store.getState().ui.setCompare(null);
      store
        .getState()
        .project.connect(client, id)
        .catch((e: unknown) => setError(message(e)));
    });
  }, [desktop, client, store]);

  const embed = embedded ? <EmbedPane key={projectId} projectId={projectId} client={client} onBridge={onBridge} /> : undefined;
  // Without an embed (no project yet): the page's hint, or what went wrong.
  const hint = error ?? (slots?.agentExtra !== undefined ? null : HINTS[page]);
  const agent = hint === null ? null : (
    <p className="rw-agent__hint" data-testid={error !== null ? "agent.error" : "agent.hint"}>
      {hint}
    </p>
  );

  const toolbar = compareOpen ? undefined : slots?.toolbar !== undefined ? slots.toolbar : TOOLBAR_PAGES.has(page) ? (
    <ViewportToolbar view={chipOf(s.ui.view)} units={s.ui.units} onViewChange={(v) => s.ui.setView({ view: v.toLowerCase() as ViewId })}>
      {toolbarControls?.(page)}
    </ViewportToolbar>
  ) : undefined;

  return (
    <AppShell
      model={model}
      activeTab={tab}
      activeLocalTab={local}
      onTabChange={(t) => run(navigatePage(store, pageOf(t, t === "design" ? lastDesign : null)))}
      onLocalTabChange={(id) => run(navigatePage(store, id as PageId))}
      handlers={handlers}
      agent={agent}
      agentEmbed={embed}
      agentExtras={slots?.agentExtra}
      compareOpen={compareOpen}
      reverting={reverting}
      revertLabel={model.currentStepId !== null && model.currentStepId !== model.shownStepId ? `Revert to ${versionLabel(model.currentStepId, snap)}` : null}
      headStepId={model.headStepId}
      historyExtra={slots?.historyExtra}
      {...(toolbar ? { toolbar } : {})}
      {...(slots?.nav !== undefined ? { navBody: slots.nav } : {})}
      {...(slots?.railNav !== undefined ? { railNav: slots.railNav } : {})}
      {...(slots?.railFooter !== undefined ? { railFooter: slots.railFooter } : {})}
      page={page}
    >
      {compareOpen ? renderCompare() : renderPage?.(page)}
    </AppShell>
  );
}

export { RunComparePanel, runDelta } from "../pages/compare/RunComparePanel.tsx";
