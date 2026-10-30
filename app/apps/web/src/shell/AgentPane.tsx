/**
 * Agent pane (concepts.md §3): the host-rendered head, then
 * - the Lecturn embed (B10, D10): the RocketWright strip (`AgentExtras`) and
 *   the reserved rect (`embed`, `EmbedPane`), with the provenance footer in
 *   flow below the rect so the embed view never covers it; or
 * - without an embed (the static shell, or while the project connects): a
 *   body with `children` (the static placeholder picture, a hint or an
 *   error) and the page extras under it.
 * The chat itself (timeline, composer, approvals) is Lecturn's; B17 removed
 * the old one.
 */
import type { ReactNode } from "react";
import { AgentExtras } from "./AgentExtras.tsx";
import { Icon } from "./Icon.tsx";

export interface AgentPaneProps {
  title: string;
  /** The body without an embed (static placeholder, hint or error); a hint is shown when empty. Ignored when `embed` is set. */
  children?: ReactNode;
  /** The Lecturn embed's reserved rect (`EmbedPane`). */
  embed?: ReactNode;
  /** Page controls for the RocketWright strip (`AgentExtras`). */
  extras?: ReactNode;
  /**
   * Bottom-right provenance footer (U20; replaces the art's placeholder footer):
   * where the data shown comes from, e.g. `Research vehicle · Rev 07 · Step 12`.
   */
  provenance?: string | null;
  /** The head's Agent settings button (B12: opens Lecturn's providers panel in the embedded pane). */
  onOpenSettings?: () => void;
}

export function AgentPane({ title, children, embed, extras, provenance = null, onOpenSettings }: AgentPaneProps) {
  const embedded = embed !== undefined && embed !== null;
  return (
    <aside className="rw-agent" data-rw-region="agent-pane" data-testid="agent-pane" data-embedded={embedded ? "true" : "false"}>
      <div className="rw-agent__head">
        <Icon name="thread" size={22} />
        <h2 className="rw-agent__title" data-testid="agent.title">
          {title}
        </h2>
        <button type="button" className="rw-button rw-button--quiet" data-testid="agent.model-picker" aria-haspopup="listbox" onClick={onOpenSettings}>
          <Icon name="settings" size={18} />
          Agent
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {embedded ? (
        <>
          <AgentExtras placement="embed">{extras}</AgentExtras>
          {embed}
        </>
      ) : (
        <div className="rw-agent__body" data-testid="agent.body">
          {children === undefined ? <p className="rw-agent__hint">Select any part to ask about it.</p> : children}
          <AgentExtras placement="body">{extras}</AgentExtras>
        </div>
      )}
      {provenance !== null && provenance !== "" && (
        <p className="rw-agent__provenance" data-testid="agent.provenance-footer">
          {provenance}
        </p>
      )}
    </aside>
  );
}
