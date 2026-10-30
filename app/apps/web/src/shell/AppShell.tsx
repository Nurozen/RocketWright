/**
 * App shell (M1.19, M1.49; concepts.md §2-3): a five-region grid sized by the
 * layout tokens in `@rw/ui/tokens.css`. Header across the top; left rail and
 * workspace above an optional viewport toolbar and the history strip; the
 * agent pane at full height on the right. Every region carries the
 * `data-rw-region` the bar measures (tests/bar/regions.json). Presentational:
 * `ConnectedShell` feeds it from the store; `ShellApp` from a static model.
 */
import type { ReactNode } from "react";
import type { ShellNavRow, ShellHistoryStep } from "./model.ts";
import { AgentPane } from "./AgentPane.tsx";
import { Header } from "./Header.tsx";
import { HistoryStrip } from "./HistoryStrip.tsx";
import { LeftRail } from "./LeftRail.tsx";
import { DESIGN_TABS, TOP_TABS, type ShellModel, type TopTab } from "./model.ts";
import { Workspace } from "./Workspace.tsx";

/** Shell callbacks (all optional; the static shell passes none). */
export interface ShellHandlers {
  onCheckModel?: () => void;
  onOpenProjects?: () => void;
  onSwitchProject?: (projectId: string) => void;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  onSelectNav?: (row: ShellNavRow) => void;
  onToggleNav?: (row: ShellNavRow) => void;
  onOpenNavThread?: (row: ShellNavRow) => void;
  onSelectStep?: (step: ShellHistoryStep) => void;
  onCompare?: () => void;
  /** The strip menu's `Revert to Step NN` (history_restore of the selected step). */
  onRevert?: () => void;
  /** Header undo/redo (history_restore of the step before/after the shown one). */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Header and agent-pane Settings (B12: `lecturn/providers.open` with the embed). */
  onOpenSettings?: () => void;
}

export interface AppShellProps {
  model: ShellModel;
  activeTab: TopTab;
  activeLocalTab?: string | null;
  onTabChange?: (tab: TopTab) => void;
  onLocalTabChange?: (id: string) => void;
  handlers?: ShellHandlers;
  /** Page content inside the workspace. */
  children?: ReactNode;
  /** Row between the workspace and the history strip (the viewport toolbar). */
  toolbar?: ReactNode;
  /** The agent pane's body without an embed (the static placeholder, a hint or an error). */
  agent?: ReactNode;
  /** The Lecturn embed's reserved rect (B10); when set, the pane shows it. */
  agentEmbed?: ReactNode;
  /** Page controls in the pane's RocketWright strip (`AgentExtras`). */
  agentExtras?: ReactNode;
  /** Rows below the history steps (compare result, run snapshots). */
  historyExtra?: ReactNode;
  comparing?: boolean;
  /** The Compare view is open (the strip's Compare shows pressed). */
  compareOpen?: boolean;
  /** `Revert to Step 02` in the strip menu (null: nothing to revert to). */
  revertLabel?: string | null;
  reverting?: boolean;
  headStepId?: string | null;
  /** Page-owned body of the rail's navigation section (the 01 Components tree). */
  navBody?: ReactNode;
  /** Page-owned left rail section replacing `model.nav` (Results: Runs). */
  railNav?: ReactNode;
  /** Page-owned rail footer (02: view chips). */
  railFooter?: ReactNode;
  /** State page id, exposed as `data-page` for page-specific shell sizing. */
  page?: string;
}

export function AppShell({
  model,
  activeTab,
  activeLocalTab,
  onTabChange,
  onLocalTabChange,
  handlers = {},
  children,
  toolbar,
  agent,
  agentEmbed,
  agentExtras,
  historyExtra,
  comparing = false,
  compareOpen = false,
  revertLabel = null,
  reverting = false,
  headStepId = null,
  navBody,
  railNav,
  railFooter,
  page,
}: AppShellProps) {
  const thread = model.threads.find((t) => t.id === model.selectedThreadId);
  const tabLabel = TOP_TABS.find((t) => t.id === activeTab)?.label ?? "";
  const h = handlers;
  return (
    <div className="rw-shell" data-testid="app-shell" data-tab={activeTab} data-page={page} data-has-toolbar={toolbar ? "true" : "false"}>
      <Header
        projectName={model.projectName}
        saveState={model.saveState}
        saveTone={model.saveTone ?? "muted"}
        activeTab={activeTab}
        check={model.check}
        projects={model.projects ?? []}
        projectId={model.projectId ?? null}
        {...(onTabChange ? { onTabChange } : {})}
        {...(h.onCheckModel ? { onCheckModel: h.onCheckModel } : {})}
        {...(h.onOpenProjects ? { onOpenProjects: h.onOpenProjects } : {})}
        {...(h.onSwitchProject ? { onSwitchProject: h.onSwitchProject } : {})}
        {...(model.undo !== undefined ? { undo: model.undo, undoBusy: reverting } : {})}
        {...(h.onUndo ? { onUndo: h.onUndo } : {})}
        {...(h.onRedo ? { onRedo: h.onRedo } : {})}
        {...(h.onOpenSettings ? { onOpenSettings: h.onOpenSettings } : {})}
      />
      <LeftRail
        threads={model.threads}
        selectedThreadId={model.selectedThreadId}
        nav={model.nav}
        selectedNavId={model.selectedNavId}
        {...(h.onSelectThread ? { onSelectThread: h.onSelectThread } : {})}
        {...(h.onNewThread ? { onNewThread: h.onNewThread } : {})}
        {...(h.onSelectNav ? { onSelectNav: h.onSelectNav } : {})}
        {...(h.onToggleNav ? { onToggleNav: h.onToggleNav } : {})}
        {...(h.onOpenNavThread ? { onOpenNavThread: h.onOpenNavThread } : {})}
        {...(navBody !== undefined ? { navBody } : {})}
        {...(railNav ? { navSlot: railNav } : {})}
        {...(railFooter !== undefined ? { footer: railFooter } : {})}
      />
      <Workspace
        {...(activeTab === "design" ? { localTabs: DESIGN_TABS, activeLocalTab: activeLocalTab ?? "assembly" } : {})}
        {...(onLocalTabChange ? { onLocalTabChange } : {})}
      >
        {children}
      </Workspace>
      {toolbar}
      <HistoryStrip
        steps={model.history}
        currentStepId={model.currentStepId}
        headStepId={headStepId}
        comparing={comparing}
        compareOpen={compareOpen}
        revertLabel={revertLabel}
        reverting={reverting}
        {...(h.onSelectStep ? { onSelectStep: h.onSelectStep } : {})}
        {...(h.onCompare ? { onCompare: h.onCompare } : {})}
        {...(h.onRevert ? { onRevert: h.onRevert } : {})}
      >
        {historyExtra}
      </HistoryStrip>
      <AgentPane
        title={thread?.title ?? tabLabel}
        provenance={model.provenance ?? null}
        embed={agentEmbed}
        extras={agentExtras}
        {...(h.onOpenSettings ? { onOpenSettings: h.onOpenSettings } : {})}
      >
        {agent}
      </AgentPane>
    </div>
  );
}
