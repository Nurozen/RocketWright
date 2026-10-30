/**
 * Static shell composition (no server): header/local tab state plus the page
 * slots, fed from a fixed `ShellModel`. The live app uses `ConnectedShell`.
 * Page bodies arrive with their steps (M1.50 Assembly, M1.51 Results, …);
 * until then the Design pages show the viewport slot.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ResultsPage } from "../pages/results/ResultsPage.tsx";
import { RunSnapshots } from "../pages/results/RunSnapshots.tsx";
import { RunsRail } from "../pages/results/RunsRail.tsx";
import type { RunDataSource } from "../pages/results/source.ts";
import type { AppStore } from "../state/store.ts";
import { AppShell } from "./AppShell.tsx";
import { BAR_PAGES, PAGE_TABS, pageOf, type BarPage, type DesignTab, type ShellModel, type TopTab } from "./model.ts";
import { ViewportToolbar, type ViewChip } from "./ViewportToolbar.tsx";

export interface ShellAppProps {
  model: ShellModel;
  /** Initial page (bar page id); `01` is Design > Assembly. */
  page?: BarPage;
  /** The 3D viewport (kept out of the shell so it renders without WebGPU in tests). */
  viewport?: ReactNode;
  /** Agent pane timeline (the canned exchange offline). */
  agent?: ReactNode;
  /** Design > Assembly page slots (M1.50); replaces the bare viewport and toolbar on 01. */
  assembly?: { content: ReactNode; toolbar: ReactNode; nav: ReactNode };
  /** The app store and run data source; with them Results renders from the runs slice (M1.51). */
  app?: AppStore;
  runSource?: RunDataSource | null;
}

/** Design local tabs whose page has a viewport toolbar row (C§4.1, C§4.3). */
const TOOLBAR_TABS: ReadonlySet<DesignTab> = new Set(["assembly", "configurations"]);

export function ShellApp({ model, page = "01", viewport, agent, assembly, app, runSource = null }: ShellAppProps) {
  const start = BAR_PAGES[page];
  const [tab, setTab] = useState<TopTab>(start.tab);
  const [local, setLocal] = useState<DesignTab>(start.local ?? "assembly");
  const [view, setView] = useState<ViewChip>("Iso");
  // With a store, the shell follows `ui.page` (navigation from pages, chat, and the broker) and reports tab changes to it.
  useEffect(() => {
    if (!app) return;
    app.getState().ui.navigate(pageOf(start.tab, start.local ?? "assembly"));
    return app.subscribe((s, prev) => {
      if (s.ui.page === prev.ui.page) return;
      const t = PAGE_TABS[s.ui.page];
      setTab(t.tab);
      if (t.local) setLocal(t.local);
    });
  }, [app, start]);
  const goTab = (t: TopTab) => {
    setTab(t);
    app?.getState().ui.navigate(pageOf(t, local));
  };
  const goLocal = (id: DesignTab) => {
    setLocal(id);
    app?.getState().ui.navigate(pageOf("design", id));
  };
  const results = tab === "results" && app ? app : null;
  const design = tab === "design";
  const onAssembly = design && local === "assembly" && assembly !== undefined;
  const toolbar = onAssembly
    ? assembly.toolbar
    : design && TOOLBAR_TABS.has(local)
      ? <ViewportToolbar view={view} units="mm" onViewChange={setView} />
      : undefined;
  return (
    <AppShell
      model={model}
      activeTab={tab}
      activeLocalTab={design ? local : null}
      onTabChange={goTab}
      onLocalTabChange={(id) => goLocal(id as DesignTab)}
      {...(toolbar ? { toolbar } : {})}
      {...(agent ? { agent } : {})}
      {...(onAssembly ? { navBody: assembly.nav } : {})}
      {...(results ? { railNav: <RunsRail app={results} />, historyExtra: <RunSnapshots app={results} /> } : {})}
    >
      {onAssembly && assembly.content}
      {design && local === "assembly" && !onAssembly && (
        <div className="rw-viewport" data-rw-region="viewport" data-testid="viewport">
          {viewport}
        </div>
      )}
      {results && <ResultsPage app={results} source={runSource} />}
    </AppShell>
  );
}
