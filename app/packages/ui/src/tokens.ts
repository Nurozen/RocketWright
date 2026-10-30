/**
 * Typed handles for the CSS custom properties in `../tokens.css`. Components
 * reference `var(--rw-…)` through these names so a renamed token fails the
 * typecheck instead of silently falling back.
 */

/** Bar colour token (`tests/bar/tokens.json` key) → theme-agnostic CSS custom property. */
export const COLOR_TOKENS = {
  "bg/canvas": "--rw-bg-canvas",
  "bg/viewport-top": "--rw-bg-viewport-top",
  "bg/viewport-bottom": "--rw-bg-viewport-bottom",
  panel: "--rw-panel",
  line: "--rw-line",
  "text/primary": "--rw-text-primary",
  "text/secondary": "--rw-text-secondary",
  "accent/teal": "--rw-accent",
  "accent/teal-fill": "--rw-accent-fill",
  "selection/row": "--rw-selection-row",
  "bubble/user": "--rw-bubble-user",
  "series-b": "--rw-series-b",
  "series-b/row": "--rw-series-b-row",
  "amber/ghost": "--rw-ghost",
  warning: "--rw-warning",
  success: "--rw-success",
  parachute: "--rw-material-parachute",
  fluid: "--rw-material-fluid",
} as const;

export type ColorToken = keyof typeof COLOR_TOKENS;
export type CssVar = (typeof COLOR_TOKENS)[ColorToken];

/** `var(--rw-…)` for a bar colour token. */
export function cssVar(token: ColorToken): `var(${CssVar})` {
  return `var(${COLOR_TOKENS[token]})`;
}

/** Shell layout custom properties (px values live in tokens.css). */
export const LAYOUT_VARS = [
  "--rw-header-h",
  "--rw-rail-w",
  "--rw-agent-w",
  "--rw-toolbar-h",
  "--rw-history-h",
  "--rw-history-row-h",
  "--rw-local-tabs-h",
] as const;

/** Font family stacks (values live in tokens.css). `mono` is not a bar token; the embedded Lecturn pane uses it (D17). */
export const FONT_VARS = {
  sans: "--rw-font-sans",
  mono: "--rw-font-mono",
} as const;

/** Parses `--name: value;` declarations from a CSS text (comments stripped). */
export function parseCustomProperties(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
