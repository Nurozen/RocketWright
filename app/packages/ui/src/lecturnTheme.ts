/**
 * RocketWright dark-studio tokens → Lecturn embed theme (plan B11, D17).
 *
 * Lecturn's embedded chat accepts a fixed allowlist of its own CSS variable
 * names in `hostContext.styles.variables`, plus `@font-face` rules with `data:`
 * URLs in `hostContext.styles.css.fonts` (Lecturn I4). This module holds the
 * map and the pure builders; `scripts/gen-lecturn-theme.ts` reads `tokens.css`
 * and the font files and writes `generated/lecturn-theme.json`, the one file
 * the desktop host (B10) and Lecturn's `examples/embed-host` (A19) both send.
 * Pure: no Node APIs, so the web client can import the map too.
 */

/**
 * The variables of the shared theme file (`generated/lecturn-theme.json`):
 * Lecturn's `EMBED_THEME_VARS` allowlist (Lecturn I4) as of the copy Lecturn
 * keeps (`examples/embed-host/src/rocketwright-theme.json`, compared on every
 * pin, decision 14), in its order. Allowlist entries newer than that copy are
 * `LECTURN_HOST_THEME_VARS`.
 */
export const LECTURN_THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--muted",
  "--muted-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
] as const;

export type LecturnThemeVar = (typeof LECTURN_THEME_VARS)[number];

/**
 * Lecturn variable → the RocketWright custom property in `tokens.css` it takes
 * its value from. Surfaces are flat dark studio (canvas, panel, hairline);
 * primary and ring are the teal accent with canvas-dark text on it (the
 * mockup's Approve button); accent is the user-bubble teal because Lecturn
 * paints its user message surface with `--accent`.
 */
export const LECTURN_THEME_MAP: Readonly<Record<LecturnThemeVar, `--rw-${string}`>> = {
  "--background": "--rw-bg-canvas",
  "--foreground": "--rw-text-primary",
  "--card": "--rw-panel",
  "--card-foreground": "--rw-text-primary",
  "--popover": "--rw-panel",
  "--popover-foreground": "--rw-text-primary",
  "--muted": "--rw-panel",
  "--muted-foreground": "--rw-text-secondary",
  "--secondary": "--rw-panel",
  "--secondary-foreground": "--rw-text-primary",
  "--border": "--rw-line",
  "--input": "--rw-line",
  "--primary": "--rw-accent",
  "--primary-foreground": "--rw-bg-canvas",
  "--accent": "--rw-bubble-user",
  "--accent-foreground": "--rw-text-primary",
  "--ring": "--rw-accent",
  "--radius": "--rw-radius",
  "--font-sans": "--rw-font-sans",
  "--font-mono": "--rw-font-mono",
};

/**
 * Allowlisted variables RocketWright sends on top of the shared file
 * (`generated/lecturn-theme-host.json`), because Lecturn's copy of that file
 * predates them: `--destructive` (Lecturn pin4: the running turn's stop
 * button) and `--success` / `--success-foreground` (Lecturn pin5, FIXG: the
 * check on a finished tool row). Move one into `LECTURN_THEME_VARS` once
 * Lecturn's copy has it.
 */
export const LECTURN_HOST_THEME_VARS = ["--destructive", "--success", "--success-foreground"] as const;

export type LecturnHostThemeVar = (typeof LECTURN_HOST_THEME_VARS)[number];

/**
 * Lecturn's whole allowlist at the pinned commit (pin5, `EMBED_THEME_VARS`
 * in Lecturn's packages/contracts/src/embedBridge.ts), in its order.
 */
export const LECTURN_EMBED_THEME_ALLOWLIST: readonly string[] = [
  ...LECTURN_THEME_VARS.slice(0, LECTURN_THEME_VARS.indexOf("--ring") + 1),
  ...LECTURN_HOST_THEME_VARS,
  ...LECTURN_THEME_VARS.slice(LECTURN_THEME_VARS.indexOf("--ring") + 1),
];

/**
 * Host-only variable → its RocketWright token: the stop button is the app's
 * own danger tone (Failed status and errors), not Lecturn's saturated red;
 * success marks (the tool row check, drawn with `--success-foreground`, and
 * `--success` tints) are the teal accent (#61b5ad), never Lecturn's mint.
 */
export const LECTURN_HOST_THEME_MAP: Readonly<Record<LecturnHostThemeVar, `--rw-${string}`>> = {
  "--destructive": "--rw-danger",
  "--success": "--rw-success",
  "--success-foreground": "--rw-success",
};

/** Resolves `var(--x)` references (one level deep is all tokens.css uses; loops are refused). */
function resolveValue(css: Readonly<Record<string, string>>, name: string, seen: Set<string> = new Set()): string {
  const raw = css[name];
  if (raw === undefined) throw new Error(`tokens.css has no ${name}`);
  if (seen.has(name)) throw new Error(`tokens.css var() loop at ${name}`);
  seen.add(name);
  return raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_m, ref: string) => resolveValue(css, ref, seen));
}

/** The Lecturn variables from parsed `tokens.css` custom properties (`parseCustomProperties`). */
export function lecturnVariables(css: Readonly<Record<string, string>>): Record<LecturnThemeVar, string> {
  const out = {} as Record<LecturnThemeVar, string>;
  for (const v of LECTURN_THEME_VARS) out[v] = resolveValue(css, LECTURN_THEME_MAP[v]);
  return out;
}

/** The host-only variables from parsed `tokens.css` custom properties. */
export function lecturnHostVariables(css: Readonly<Record<string, string>>): Record<LecturnHostThemeVar, string> {
  const out = {} as Record<LecturnHostThemeVar, string>;
  for (const v of LECTURN_HOST_THEME_VARS) out[v] = resolveValue(css, LECTURN_HOST_THEME_MAP[v]);
  return out;
}

/** The committed host-only file (`generated/lecturn-theme-host.json`). */
export interface LecturnHostThemeFile {
  variables: Record<LecturnHostThemeVar, string>;
}

/** The first family of a CSS `font-family` stack, unquoted. */
export function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

// ---- fonts -----------------------------------------------------------------

/**
 * Non-Latin-1 characters the app, its MCP tool text and agent replies use
 * (arrows, typographic punctuation, comparison and math signs, Greek
 * symbols for aero and propulsion terms, status marks, shortcut keys). Every
 * subset must cover them; every source font has them.
 */
export const APP_SYMBOLS =
  "→←↑↓↔⇒…—–‘’“”•‹›≥≤≈≠−√∞∂∑αβγδεηθκλμνπρστφωΔΩ▶▲▼✓✗⚠⌘⇧€";

/**
 * Code point ranges every subset covers: Basic Latin and Latin-1 Supplement
 * (printable). U+00AD SOFT HYPHEN is left out: it is default-ignorable (never
 * drawn mid-line) and Inter has no glyph for it.
 */
export const LATIN_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0xff],
];

/** The required glyph set, sorted ascending, no duplicates. */
export function requiredCodePoints(): number[] {
  const set = new Set<number>();
  for (const [lo, hi] of LATIN_RANGES) for (let c = lo; c <= hi; c++) set.add(c);
  for (const ch of APP_SYMBOLS) set.add(ch.codePointAt(0)!);
  return [...set].sort((a, b) => a - b);
}

/** One embedded face. `file` is the basename under `generated/fonts/` (`<file>.subset.woff2`). */
export interface LecturnFontFace {
  file: string;
  family: string;
  weight: 400 | 600;
  /** Source font, relative to the `app/` directory. */
  source: string;
}

/** The three faces `fontsCss` embeds (decision 17): Inter Regular and SemiBold, JetBrains Mono Regular. */
export const LECTURN_FONT_FACES: readonly LecturnFontFace[] = [
  { file: "Inter-Regular", family: "Inter", weight: 400, source: "apps/web/public/fonts/Inter-Regular.ttf" },
  { file: "Inter-SemiBold", family: "Inter", weight: 600, source: "apps/web/public/fonts/Inter-SemiBold.ttf" },
  {
    file: "JetBrainsMono-Regular",
    family: "JetBrains Mono",
    weight: 400,
    source: "packages/ui/fonts/JetBrainsMono-Regular.ttf",
  },
];

/** Caps (decision 17, Lecturn I4): subset files in total, the `css.fonts` string, one bridge message. */
export const FONT_FILES_MAX_BYTES = 150 * 1024;
export const FONTS_CSS_MAX_BYTES = 200 * 1024;
export const BRIDGE_MESSAGE_MAX_BYTES = 256 * 1024;

/** `@font-face` rules with base64 `data:` woff2 sources, one per face, in face order. */
export function fontFaceCss(faces: readonly { face: LecturnFontFace; woff2Base64: string }[]): string {
  return faces
    .map(
      ({ face, woff2Base64 }) =>
        `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${String(face.weight)};` +
        `font-display:block;src:url(data:font/woff2;base64,${woff2Base64}) format("woff2");}`,
    )
    .join("\n");
}

/** The committed token file (`generated/lecturn-theme.json`). */
export interface LecturnThemeFile {
  variables: Record<LecturnThemeVar, string>;
  fontsCss: string;
}

/**
 * A `ui/initialize` JSON-RPC response carrying the theme as Lecturn's host
 * sends it (`hostContext.styles.variables` and `styles.css.fonts`). Used to
 * check the whole message against the 256 KB bridge cap.
 */
export function uiInitializeResponse(theme: LecturnThemeFile, id: number | string = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2026-01-26",
      hostInfo: { name: "lecturn", version: "0.0.0" },
      hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
      hostContext: {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        locale: "en-US",
        timeZone: "UTC",
        platform: "desktop",
        containerDimensions: { width: 381, maxHeight: 6000 },
        styles: { variables: theme.variables, css: { fonts: theme.fontsCss } },
      },
    },
  };
}
