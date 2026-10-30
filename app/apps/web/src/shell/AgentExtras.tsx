/**
 * The RocketWright-owned strip of the agent pane (B10, D10): page controls
 * that used to sit inside the chat timeline (02 Changed fields and the
 * thread's steps, 03 Run configurations, 05 Missing inputs and Review
 * inputs) live here, outside the Lecturn embed's rect. A WebContentsView
 * paints above the host DOM, so nothing of RocketWright's may be inside the
 * rect; their checklist rows stay RocketWright DOM rows.
 */
import type { ReactNode } from "react";

export interface AgentExtrasProps {
  children?: ReactNode;
  /** `embed`: a strip between the pane head and the embed rect; `body`: in the pane body when there is no embed (the static shell). */
  placement: "embed" | "body";
}

export function AgentExtras({ children, placement }: AgentExtrasProps) {
  if (children === undefined || children === null || children === false) return null;
  return (
    <section className="rw-agent-extras" data-placement={placement} data-testid="agent.extras" aria-label="Page details">
      {children}
    </section>
  );
}
