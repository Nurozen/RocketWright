/**
 * Header (concepts.md §3): mark + wordmark, project switcher, save state,
 * centred tabs, Check model with its status, settings, help.
 */
import { useRef, useState } from "react";
import { Menu } from "../ui/Menu.tsx";
import { BRAND } from "./brand.ts";
import { Icon } from "./Icon.tsx";
import { stepLabel, TOP_TABS, type CheckStatus, type ProjectMenuModel, type ShellHistoryStep, type ShellProject, type TopTab } from "./model.ts";
import { projectMenuEntries } from "./projectMenu.ts";

export interface HeaderProps {
  projectName: string;
  saveState: string;
  saveTone?: "muted" | "amber";
  activeTab: TopTab;
  check: { status: CheckStatus; issues: number; label?: string };
  projects?: readonly ShellProject[];
  projectId?: string | null;
  onTabChange?: (tab: TopTab) => void;
  onCheckModel?: () => void;
  /** The switcher opened (refresh the project list). */
  onOpenProjects?: () => void;
  onSwitchProject?: (projectId: string) => void;
  /** Recent, New, Open, Rename and Close; absent (the static shell) leaves only the open projects. */
  projectMenu?: ProjectMenuModel | undefined;
  /** Undo/redo targets (history steps); absent hides the controls. */
  undo?: { undo: ShellHistoryStep | null; redo: ShellHistoryStep | null };
  /** A restore is in flight (both disabled). */
  undoBusy?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Settings (B12: opens Lecturn's providers panel in the embedded pane). */
  onOpenSettings?: () => void;
}

/** `⌘Z` on macOS, `Ctrl+Z` elsewhere. */
export function shortcut(keys: "undo" | "redo", mac: boolean): string {
  if (keys === "undo") return mac ? "⌘Z" : "Ctrl+Z";
  return mac ? "⇧⌘Z" : "Ctrl+Y";
}

/** Tooltip of the undo or redo button: where it goes, or why it cannot. */
export function undoTitle(kind: "undo" | "redo", target: ShellHistoryStep | null, mac: boolean): string {
  if (target === null) return kind === "undo" ? "Nothing to undo" : "Nothing to redo";
  const where = `Step ${stepLabel(target.number)} · ${target.name}`;
  return `${kind === "undo" ? "Undo: back to" : "Redo: forward to"} ${where} (${shortcut(kind, mac)})`;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function checkTitle({ status, issues, label }: HeaderProps["check"]): string {
  switch (status) {
    case "ok":
      return "Model check passed";
    case "issues":
    case "errors":
      return label ?? `${String(issues)} ${issues === 1 ? "issue" : "issues"} found`;
    case "outdated":
      return "The last check ran on an older model revision";
    case "running":
      return "Checking model…";
    case "empty":
      return label ?? "Add parts to begin";
    default:
      return "Model not checked yet";
  }
}

/** Count shown on the Check model button: issues from the CheckReport; none when passed, unchecked, or running. */
export function checkCount({ status, issues }: HeaderProps["check"]): number | null {
  return (status === "issues" || status === "errors") && issues > 0 ? issues : null;
}

/** The header's Settings button (B12: Lecturn's providers panel with the embed). */
export function SettingsButton({ onClick }: { onClick?: () => void }) {
  return (
    <button type="button" className="rw-icon-button" data-testid="header.settings" aria-label="Settings" onClick={onClick}>
      <Icon name="settings" size={22} />
    </button>
  );
}

export function Header({
  projectName,
  saveState,
  saveTone = "muted",
  activeTab,
  check,
  projects = [],
  projectId = null,
  onTabChange,
  onCheckModel,
  onOpenProjects,
  onSwitchProject,
  projectMenu,
  undo,
  undoBusy = false,
  onUndo,
  onRedo,
  onOpenSettings,
}: HeaderProps) {
  const [menu, setMenu] = useState(false);
  const switcher = useRef<HTMLButtonElement>(null);
  return (
    <header className="rw-header" data-rw-region="header" data-testid="header">
      <div className="rw-header__start">
        <div className="rw-brand">
          <img className="rw-brand__mark" src={BRAND.mark} width={26} height={26} alt="" />
          <span className="rw-brand__word" data-testid="header.wordmark">
            {BRAND.name}
          </span>
        </div>
        <span className="rw-header__sep" aria-hidden />
        <button
          ref={switcher}
          type="button"
          className="rw-project"
          data-testid="header.project-switcher"
          title={projectName}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            if (!menu) onOpenProjects?.();
            setMenu(!menu);
          }}
        >
          <span className="rw-project__name" data-testid="header.project-name">
            {projectName}
          </span>
          <Icon name="chevron-down" size={16} />
        </button>
        <Menu
          open={menu}
          anchor={switcher.current}
          onClose={() => setMenu(false)}
          label="Projects"
          testId="header.project-menu"
          items={projectMenuEntries({ projects, projectId, projectName, menu: projectMenu, onSwitch: (id) => onSwitchProject?.(id) })}
        />
        <span className="rw-save" data-testid="header.save-state" data-tone={saveTone} title={saveState}>
          {saveTone === "amber" ? <Icon name="status-dot" size={18} className="rw-save__dot" /> : <Icon name="cloud" size={18} />}
          <span className="rw-save__label">{saveState}</span>
        </span>
      </div>
      <nav className="rw-tabs" role="tablist" aria-label="Workspace">
        {TOP_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="rw-tab"
            data-testid="header.tab"
            data-tab={t.id}
            aria-selected={t.id === activeTab}
            onClick={() => onTabChange?.(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="rw-header__end">
        {undo !== undefined && (
          <>
            <div className="rw-undo" role="group" aria-label="Undo and redo" data-testid="header.undo-redo">
              {(["undo", "redo"] as const).map((k) => {
                const target = undo[k];
                const title = undoTitle(k, target, IS_MAC);
                return (
                  <button
                    key={k}
                    type="button"
                    className="rw-icon-button rw-undo__button"
                    data-testid={`header.${k}`}
                    data-target={target?.id ?? ""}
                    aria-label={title}
                    title={title}
                    aria-keyshortcuts={k === "undo" ? "Meta+Z Control+Z" : "Shift+Meta+Z Control+Y"}
                    disabled={target === null || undoBusy}
                    onClick={k === "undo" ? onUndo : onRedo}
                  >
                    <Icon name={k} size={20} />
                  </button>
                );
              })}
            </div>
            <span className="rw-header__sep" aria-hidden />
          </>
        )}
        {check.status === "empty" ? (
          // R0.3a: no parts to check yet. Neutral text, not a button whose name would promise a check or an add.
          <span className="rw-check-empty" role="status" data-testid="header.check-model" data-check-status="empty">
            {checkTitle(check)}
          </span>
        ) : (
          <button
            type="button"
            className="rw-button rw-button--primary"
            data-testid="header.check-model"
            data-check-status={check.status}
            title={checkTitle(check)}
            aria-busy={check.status === "running" || undefined}
            disabled={check.status === "running"}
            onClick={onCheckModel}
          >
            {check.status === "running" ? (
              <Icon name="spinner" size={18} className="rw-spin" />
            ) : (
              <Icon name="check-disc" size={18} className="rw-check__icon" />
            )}
            Check model
            {checkCount(check) !== null && (
              <span className="rw-badge" data-tone={check.status === "errors" ? "danger" : "amber"} data-testid="header.check-count">
                {checkCount(check)}
              </span>
            )}
            {check.status === "outdated" && <span className="rw-check__dot" data-testid="header.check-outdated" aria-hidden />}
            <span className="rw-visually-hidden" data-testid="header.check-status">
              {checkTitle(check)}
            </span>
          </button>
        )}
        <span className="rw-header__sep" aria-hidden />
        <SettingsButton {...(onOpenSettings ? { onClick: onOpenSettings } : {})} />
        <button type="button" className="rw-icon-button" data-testid="header.help" aria-label="Help">
          <Icon name="help" size={22} />
        </button>
      </div>
    </header>
  );
}
