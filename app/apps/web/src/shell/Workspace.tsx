/** Workspace column (concepts.md §2 layout): optional local tabs above the page content. */
import type { ReactNode } from "react";

export interface LocalTab {
  id: string;
  label: string;
}

export interface WorkspaceProps {
  localTabs?: readonly LocalTab[];
  activeLocalTab?: string | null;
  onLocalTabChange?: (id: string) => void;
  children?: ReactNode;
}

export function Workspace({ localTabs, activeLocalTab, onLocalTabChange, children }: WorkspaceProps) {
  return (
    <main className="rw-workspace" data-rw-region="workspace" data-testid="workspace">
      {localTabs && localTabs.length > 0 && (
        <nav className="rw-local-tabs" data-rw-region="local-tabs" role="tablist" aria-label="Page">
          {localTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="rw-tab rw-tab--local"
              data-testid="workspace.local-tab"
              aria-selected={t.id === activeLocalTab}
              onClick={() => onLocalTabChange?.(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <div className="rw-workspace__body">{children}</div>
    </main>
  );
}
