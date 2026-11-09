/**
 * A one-line notice with an optional action. Set `floating` to pin it over the
 * window; that marks it as an overlay, so the agent pane cannot paint over it.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../shell/Icon.tsx";
import { CloseButton } from "./Popover.tsx";
import "./ui.css";

export type BannerTone = "info" | "success" | "warning" | "danger";

const TONE_ICON: Record<BannerTone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert",
  danger: "error-circle",
};

export interface BannerProps {
  tone?: BannerTone | undefined;
  /** Replaces the tone's icon. */
  icon?: IconName | undefined;
  action?: ReactNode;
  /** Adds a dismiss button. */
  onDismiss?: (() => void) | undefined;
  floating?: boolean | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}

export function Banner({ tone = "info", icon, action, onDismiss, floating = false, className, testId, children }: BannerProps) {
  return (
    <div
      className={className ? `rw-ui-banner ${className}` : "rw-ui-banner"}
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      data-floating={floating ? "true" : undefined}
      data-rw-overlay={floating ? "" : undefined}
      data-testid={testId}
    >
      <span className="rw-ui-banner__icon">
        <Icon name={icon ?? TONE_ICON[tone]} size={20} />
      </span>
      <span className="rw-ui-banner__text">{children}</span>
      {action}
      {onDismiss !== undefined && <CloseButton onClick={onDismiss} label="Dismiss" />}
    </div>
  );
}
