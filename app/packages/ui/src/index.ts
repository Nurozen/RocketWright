/** Shared UI primitives and design tokens (`@rw/ui/tokens.css`). */
export const PACKAGE_NAME = "@rw/ui";
export { COLOR_TOKENS, FONT_VARS, LAYOUT_VARS, cssVar, parseCustomProperties } from "./tokens.ts";
export type { ColorToken, CssVar } from "./tokens.ts";
export {
  APP_SYMBOLS,
  BRIDGE_MESSAGE_MAX_BYTES,
  FONTS_CSS_MAX_BYTES,
  FONT_FILES_MAX_BYTES,
  LECTURN_EMBED_THEME_ALLOWLIST,
  LECTURN_FONT_FACES,
  LECTURN_HOST_THEME_MAP,
  LECTURN_HOST_THEME_VARS,
  LECTURN_THEME_MAP,
  LECTURN_THEME_VARS,
  firstFamily,
  fontFaceCss,
  lecturnHostVariables,
  lecturnVariables,
  requiredCodePoints,
  uiInitializeResponse,
} from "./lecturnTheme.ts";
export type { LecturnFontFace, LecturnHostThemeFile, LecturnHostThemeVar, LecturnThemeFile, LecturnThemeVar } from "./lecturnTheme.ts";
