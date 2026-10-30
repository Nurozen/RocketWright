/**
 * A part thumbnail (M3.6): the rendered image when the thumbnail cache has
 * one, else the part's line icon. `data-source` tells captures which one
 * shows (`render` | `icon`).
 */
import { Icon, type IconName } from "../shell/Icon.tsx";

export interface PartThumbProps {
  url: string | undefined;
  icon: IconName;
  /** Box size (px); the image keeps its aspect inside it. */
  size: number;
  testId: string;
  className?: string;
  /** For the inspector card: a wide box. */
  width?: number;
}

export function PartThumb({ url, icon, size, testId, className, width }: PartThumbProps) {
  const cls = ["rw-part-thumb", className].filter(Boolean).join(" ");
  return (
    <span className={cls} data-testid={testId} data-source={url ? "render" : "icon"} style={{ width: width ?? size, height: size }} aria-hidden>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name={icon} size={Math.min(20, size)} className="rw-nav-row__part" />}
    </span>
  );
}
