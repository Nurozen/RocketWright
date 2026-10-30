/** The status vocabulary's icon and tone (C §5.2, `state/status.ts`) as an inline glyph. */
import type { StatusIcon as StatusIconId, StatusTone, StatusView } from "../state/status.ts";
import { Icon, type IconName } from "./Icon.tsx";

const GLYPH: Record<StatusIconId, IconName> = {
  check: "check-circle",
  warning: "alert",
  dot: "status-dot",
  circle: "status-circle",
  spinner: "spinner",
  error: "error-circle",
  cloud: "cloud",
};

export interface StatusBadgeProps {
  status: Pick<StatusView, "icon" | "tone" | "label"> & { reason?: string };
  size?: number;
  /** Show the label next to the icon. */
  withLabel?: boolean;
  testId?: string;
}

export function statusGlyph(icon: StatusIconId): IconName {
  return GLYPH[icon];
}

export function StatusBadge({ status, size = 16, withLabel = false, testId }: StatusBadgeProps) {
  const tone: StatusTone = status.tone;
  return (
    <span className="rw-status" data-tone={tone} data-testid={testId} title={status.reason ?? status.label}>
      <Icon name={GLYPH[status.icon]} size={size} className={status.icon === "spinner" ? "rw-spin" : undefined} {...(withLabel ? {} : { label: status.label })} />
      {withLabel && <span className="rw-status__label">{status.label}</span>}
    </span>
  );
}
