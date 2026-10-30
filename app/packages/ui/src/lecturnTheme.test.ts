import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Blob as HbBlob, Face } from "harfbuzzjs";
import { describe, expect, it } from "vitest";
import { decompress } from "wawoff2";
import {
  FONTS_DIR,
  HOST_THEME_JSON,
  SUBSETTER_PINS,
  THEME_JSON,
  UI_DIR,
  driftedFiles,
  generateLecturnTheme,
} from "../scripts/gen-lecturn-theme.ts";
import {
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
  type LecturnHostThemeFile,
  type LecturnThemeFile,
  firstFamily,
  lecturnHostVariables,
  lecturnVariables,
  requiredCodePoints,
  uiInitializeResponse,
} from "./lecturnTheme.ts";
import { COLOR_TOKENS, FONT_VARS, parseCustomProperties } from "./tokens.ts";

const css = parseCustomProperties(readFileSync(resolve(UI_DIR, "tokens.css"), "utf8"));
const bar = JSON.parse(readFileSync(resolve(UI_DIR, "../../../tests/bar/tokens.json"), "utf8")) as {
  colors: Record<string, { value: string }>;
  typography: { family: string[] };
  shape: { radiusPx: [number, number] };
};
const theme = JSON.parse(readFileSync(resolve(UI_DIR, THEME_JSON), "utf8")) as LecturnThemeFile;
const hostTheme = JSON.parse(readFileSync(resolve(UI_DIR, HOST_THEME_JSON), "utf8")) as LecturnHostThemeFile;
const subsetPath = (file: string): string => resolve(UI_DIR, `${FONTS_DIR}/${file}.subset.woff2`);
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
/** bar token key for each RocketWright colour custom property. */
const barKeyOf = new Map<string, string>(Object.entries(COLOR_TOKENS).map(([k, v]) => [v, k]));

describe("lecturnTheme map", () => {
  it("covers exactly Lecturn's allowlist", () => {
    expect(Object.keys(LECTURN_THEME_MAP).sort()).toEqual([...LECTURN_THEME_VARS].sort());
    expect(Object.keys(theme.variables)).toEqual([...LECTURN_THEME_VARS]);
    for (const v of LECTURN_THEME_VARS) expect(theme.variables[v], v).toBeTruthy();
  });

  it("splits Lecturn's pin5 allowlist between the shared file and the host-only file", () => {
    expect(LECTURN_EMBED_THEME_ALLOWLIST).toEqual([
      ...LECTURN_THEME_VARS.slice(0, 17),
      "--destructive",
      "--success",
      "--success-foreground",
      ...LECTURN_THEME_VARS.slice(17),
    ]);
    expect([...LECTURN_THEME_VARS, ...LECTURN_HOST_THEME_VARS].sort()).toEqual([...LECTURN_EMBED_THEME_ALLOWLIST].sort());
    expect(Object.keys(LECTURN_HOST_THEME_MAP)).toEqual([...LECTURN_HOST_THEME_VARS]);
    expect(Object.keys(hostTheme.variables)).toEqual([...LECTURN_HOST_THEME_VARS]);
    for (const v of LECTURN_HOST_THEME_VARS) expect(Object.keys(theme.variables)).not.toContain(v);
  });

  it("paints the stop button (--destructive) in the app's own danger tone", () => {
    expect(hostTheme.variables).toEqual(lecturnHostVariables(css));
    expect(hostTheme.variables["--destructive"]).toBe(css["--rw-danger"]);
    expect(hostTheme.variables["--destructive"]).toBe("#e5735c");
  });

  it("paints success marks (the tool row check) in the teal accent, not Lecturn's mint", () => {
    expect(hostTheme.variables["--success"]).toBe(css["--rw-success"]);
    expect(hostTheme.variables["--success-foreground"]).toBe(css["--rw-success"]);
    expect(css["--rw-success"]).toBe(css["--rw-accent"]);
    expect(hostTheme.variables["--success"]).toBe("#61b5ad");
    expect(hostTheme.variables["--success-foreground"]).toBe("#61b5ad");
  });

  it("sets the background to exactly #1b1e20 (bg/canvas)", () => {
    expect(theme.variables["--background"]).toBe("#1b1e20");
    expect(bar.colors["bg/canvas"]!.value.toLowerCase()).toBe("#1b1e20");
  });

  it("takes every colour from tests/bar/tokens.json through tokens.css", () => {
    const vars = lecturnVariables(css);
    let colours = 0;
    for (const v of LECTURN_THEME_VARS) {
      const key = barKeyOf.get(LECTURN_THEME_MAP[v]);
      if (key === undefined) continue;
      colours++;
      expect(vars[v].toLowerCase(), `${v} ← ${key}`).toBe(bar.colors[key]!.value.toLowerCase());
    }
    expect(colours).toBe(17);
  });

  it("uses the teal accent for primary and ring, and the canvas for text on it", () => {
    expect(theme.variables["--primary"]).toBe(bar.colors["accent/teal"]!.value.toLowerCase());
    expect(theme.variables["--ring"]).toBe(theme.variables["--primary"]);
    expect(theme.variables["--primary-foreground"]).toBe(theme.variables["--background"]);
  });

  it("keeps the radius in the bar range and the font stacks from tokens.css", () => {
    const px = /^(\d+)px$/.exec(theme.variables["--radius"])?.[1];
    expect(Number(px)).toBeGreaterThanOrEqual(bar.shape.radiusPx[0]);
    expect(Number(px)).toBeLessThanOrEqual(bar.shape.radiusPx[1]);
    expect(theme.variables["--font-sans"]).toBe(css[FONT_VARS.sans]);
    expect(theme.variables["--font-mono"]).toBe(css[FONT_VARS.mono]);
    expect(firstFamily(theme.variables["--font-sans"])).toBe(bar.typography.family[0]);
  });

  it("names a sent face first in each font stack", () => {
    const families = new Set(LECTURN_FONT_FACES.map((f) => f.family));
    expect(families.has(firstFamily(theme.variables["--font-sans"]))).toBe(true);
    expect(families.has(firstFamily(theme.variables["--font-mono"]))).toBe(true);
  });

  it("refuses a missing token and resolves var() references", () => {
    expect(() => lecturnVariables({})).toThrow(/--rw-bg-canvas/);
    const aliased = { ...css, "--rw-accent": "var(--rw-success)" };
    expect(lecturnVariables(aliased)["--primary"]).toBe(css["--rw-success"]);
    expect(() => lecturnVariables({ ...css, "--rw-line": "var(--rw-line)" })).toThrow(/loop/);
  });
});

describe("lecturn-theme.json", () => {
  it("equals a fresh generation (stale-file check)", { timeout: 60_000 }, async () => {
    const files = await generateLecturnTheme();
    expect(driftedFiles(files)).toEqual([]);
    expect([...files.keys()].filter((k) => k.endsWith(".woff2")).length).toBe(3);
  });

  it("pins the subsetter exactly in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(UI_DIR, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(SUBSETTER_PINS)) expect(pkg.devDependencies[name], name).toBe(version);
  });

  it("keeps the three woff2 subsets under 150 KB in total", () => {
    const total = LECTURN_FONT_FACES.reduce((n, f) => n + readFileSync(subsetPath(f.file)).byteLength, 0);
    expect(total).toBeLessThan(FONT_FILES_MAX_BYTES);
  });

  it("keeps fontsCss at most 200 KB, data: @font-face rules for exactly the three subsets", () => {
    expect(utf8Bytes(theme.fontsCss)).toBeLessThanOrEqual(FONTS_CSS_MAX_BYTES);
    const rules = theme.fontsCss.split("\n");
    expect(rules).toHaveLength(LECTURN_FONT_FACES.length);
    LECTURN_FONT_FACES.forEach((face, i) => {
      const rule = rules[i]!;
      expect(rule).toMatch(/^@font-face\{[^{}]*\}$/);
      expect(rule).toContain(`font-family:"${face.family}";`);
      expect(rule).toContain(`font-weight:${String(face.weight)};`);
      const b64 = /src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\) format\("woff2"\);/.exec(rule)?.[1];
      expect(b64, face.file).toBeDefined();
      expect(Buffer.from(b64!, "base64").equals(readFileSync(subsetPath(face.file))), face.file).toBe(true);
    });
  });

  it("fits a ui/initialize response under the 256 KB bridge cap", () => {
    const bytes = utf8Bytes(JSON.stringify(uiInitializeResponse(theme)));
    expect(bytes).toBeLessThan(BRIDGE_MESSAGE_MAX_BYTES);
  });

  it("covers Basic Latin, Latin-1 and the app symbols in every subset", async () => {
    const required = requiredCodePoints();
    expect(required).toContain(0x41);
    expect(required).toContain(0xe9);
    for (const ch of APP_SYMBOLS) expect(required).toContain(ch.codePointAt(0));
    for (const face of LECTURN_FONT_FACES) {
      const sfnt = await decompress(readFileSync(subsetPath(face.file)));
      const have = new Set(new Face(new HbBlob(sfnt), 0).collectUnicodes());
      const missing = required.filter((c) => !have.has(c)).map((c) => String.fromCodePoint(c));
      expect(missing, face.file).toEqual([]);
    }
  });
});
