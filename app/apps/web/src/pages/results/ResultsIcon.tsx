/**
 * Results page glyphs not in the brand set or the shell glyphs, hand-authored
 * for RocketWright in the same style (20x20, 1.5 px currentColor stroke,
 * round caps). Shell names delegate to the shell `Icon`.
 */
import { Icon, type IconName } from "../../shell/Icon.tsx";

export const RESULTS_GLYPHS = {
  warning: '<path d="M10 3.2l7.3 12.8H2.7z"/><path d="M10 8.2v3.6M10 13.9h.01"/>',
  "plot-line": '<path d="M2.5 13.5l3.5-5 3 4 3-7 3 6 2.5-3"/>',
  download: '<path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M3.5 15.5h13"/>',
  external: '<path d="M11.5 3.5h5v5M16.5 3.5l-7 7M14 11.5v4.5H4V6h4.5"/>',
  circle: '<circle cx="10" cy="10" r="6"/>',
  "check-circle": '<circle cx="10" cy="10" r="7"/><path d="M6.8 10.2l2.2 2.2 4.2-4.6"/>',
  document: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5"/>',
  cube: '<path d="M10 2.5l6.5 3.5v8L10 17.5 3.5 14V6z"/><path d="M3.5 6L10 9.5 16.5 6M10 9.5v8"/>',
  sort: '<path d="M7 8l3-3 3 3M7 12l3 3 3-3"/>',
} as const;

export type ResultsGlyph = keyof typeof RESULTS_GLYPHS;

export interface ResultsIconProps {
  name: ResultsGlyph | IconName;
  size?: number;
  label?: string | undefined;
  className?: string | undefined;
}

export function ResultsIcon({ name, size = 20, label, className }: ResultsIconProps) {
  if (!(name in RESULTS_GLYPHS)) {
    return <Icon name={name as IconName} size={size} {...(label ? { label } : {})} {...(className ? { className } : {})} />;
  }
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
      dangerouslySetInnerHTML={{ __html: RESULTS_GLYPHS[name as ResultsGlyph] }}
    />
  );
}
