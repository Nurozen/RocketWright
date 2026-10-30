/**
 * Typed inline icon: the RocketWright line icons (public/brand/icons via
 * icons.generated.ts) plus the interface glyphs. Inlined so the stroke follows
 * the CSS `color` of the host.
 */
import { GLYPH_BODIES, type GlyphName } from "./glyphs.ts";
import { ICON_BODIES, type IconName as BrandIconName } from "./icons.generated.ts";

export type IconName = BrandIconName | GlyphName;

export const ICON_NAMES: readonly IconName[] = [
  ...(Object.keys(ICON_BODIES) as BrandIconName[]),
  ...(Object.keys(GLYPH_BODIES) as GlyphName[]),
];

export function iconMarkup(name: IconName): string {
  return name in ICON_BODIES ? ICON_BODIES[name as BrandIconName] : GLYPH_BODIES[name as GlyphName];
}

export interface IconProps {
  name: IconName;
  /** Rendered size in px (the artwork is drawn on a 20 px grid). */
  size?: number;
  /** Accessible label; without it the icon is decorative (`aria-hidden`). */
  label?: string;
  className?: string | undefined;
}

export function Icon({ name, size = 20, label, className }: IconProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg
      className={className ? `rw-icon ${className}` : "rw-icon"}
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
      dangerouslySetInnerHTML={{ __html: iconMarkup(name) }}
    />
  );
}
