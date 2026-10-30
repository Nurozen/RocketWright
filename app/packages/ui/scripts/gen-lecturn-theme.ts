/**
 * Generates the Lecturn embed theme file (plan B11, D17, decision 17).
 *
 * Reads `tokens.css` and the source fonts, subsets each face to the required
 * glyph set (`requiredCodePoints`) with the pinned subsetter (subset-font over
 * harfbuzzjs, woff2 by wawoff2; versions in `SUBSETTER_PINS`), and writes:
 * - `generated/fonts/<face>.subset.woff2` (three faces) and the OFL text of
 *   each family beside them;
 * - `generated/lecturn-theme.json`: `{ variables, fontsCss }` (the file
 *   Lecturn keeps a copy of);
 * - `generated/lecturn-theme-host.json`: `{ variables }`, the allowlisted
 *   variables newer than Lecturn's copy (`LECTURN_HOST_THEME_VARS`).
 *
 * Usage: `node scripts/gen-lecturn-theme.ts` writes; `--check` writes nothing
 * and exits 1 when a committed file is missing, changed, or stale.
 * `pnpm -C app --filter @rw/ui gen:lecturn-theme` runs it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";
import {
  LECTURN_FONT_FACES,
  type LecturnHostThemeFile,
  type LecturnThemeFile,
  fontFaceCss,
  lecturnHostVariables,
  lecturnVariables,
  requiredCodePoints,
} from "../src/lecturnTheme.ts";
import { parseCustomProperties } from "../src/tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** `app/packages/ui`. */
export const UI_DIR = resolve(here, "..");
/** `app/`. */
export const APP_DIR = resolve(UI_DIR, "../..");
export const GENERATED_DIR = "generated";
export const THEME_JSON = `${GENERATED_DIR}/lecturn-theme.json`;
export const HOST_THEME_JSON = `${GENERATED_DIR}/lecturn-theme-host.json`;
export const FONTS_DIR = `${GENERATED_DIR}/fonts`;

/** Exact versions of the subsetting chain; generation refuses any other install. */
export const SUBSETTER_PINS = { "subset-font": "2.9.0", harfbuzzjs: "1.6.4", wawoff2: "2.0.1" } as const;

/** OFL text shipped beside the subsets, one per family (relative to `app/`). */
export const FONT_LICENSES = [
  { file: "Inter-OFL.txt", source: "apps/web/public/fonts/OFL.txt" },
  { file: "JetBrainsMono-OFL.txt", source: "packages/ui/fonts/OFL.txt" },
] as const;

/** Version of package `name` as `req` resolves it (walks up from its entry; tolerates strict `exports`). */
function installedVersion(req: NodeJS.Require, name: string, entry: string = name): string {
  let dir = dirname(req.resolve(entry));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version: string };
      if (json.name === name) return json.version;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find ${name}/package.json`);
    dir = up;
  }
}

/** Throws unless the installed subsetter chain matches `SUBSETTER_PINS`. */
export function assertPinnedSubsetter(): void {
  const req = createRequire(join(UI_DIR, "package.json"));
  const subsetReq = createRequire(req.resolve("subset-font"));
  const installed: Record<string, string> = {
    "subset-font": installedVersion(req, "subset-font"),
    harfbuzzjs: installedVersion(subsetReq, "harfbuzzjs", "harfbuzzjs/dist/harfbuzz-subset.wasm"),
    wawoff2: installedVersion(createRequire(subsetReq.resolve("fontverter")), "wawoff2"),
  };
  for (const [name, want] of Object.entries(SUBSETTER_PINS)) {
    if (installed[name] !== want) {
      throw new Error(`subsetter pin: ${name} is ${String(installed[name])}, expected ${want} (run pnpm install)`);
    }
  }
}

/** Every generated file, keyed by path relative to `app/packages/ui`. */
export async function generateLecturnTheme(): Promise<Map<string, Uint8Array>> {
  assertPinnedSubsetter();
  const files = new Map<string, Uint8Array>();
  const text = String.fromCodePoint(...requiredCodePoints());
  const faces = [];
  for (const face of LECTURN_FONT_FACES) {
    const woff2 = new Uint8Array(
      await subsetFont(readFileSync(join(APP_DIR, face.source)), text, { targetFormat: "woff2" }),
    );
    files.set(`${FONTS_DIR}/${face.file}.subset.woff2`, woff2);
    faces.push({ face, woff2Base64: Buffer.from(woff2).toString("base64") });
  }
  for (const lic of FONT_LICENSES) files.set(`${FONTS_DIR}/${lic.file}`, readFileSync(join(APP_DIR, lic.source)));
  const css = parseCustomProperties(readFileSync(join(UI_DIR, "tokens.css"), "utf8"));
  const theme: LecturnThemeFile = { variables: lecturnVariables(css), fontsCss: fontFaceCss(faces) };
  files.set(THEME_JSON, new TextEncoder().encode(`${JSON.stringify(theme, null, 2)}\n`));
  const host: LecturnHostThemeFile = { variables: lecturnHostVariables(css) };
  files.set(HOST_THEME_JSON, new TextEncoder().encode(`${JSON.stringify(host, null, 2)}\n`));
  return files;
}

/** Paths whose committed bytes differ from `files`, plus stale files under `generated/`. */
export function driftedFiles(files: ReadonlyMap<string, Uint8Array>): string[] {
  const drift: string[] = [];
  for (const [rel, bytes] of files) {
    const path = join(UI_DIR, rel);
    if (!existsSync(path) || !Buffer.from(bytes).equals(readFileSync(path))) drift.push(rel);
  }
  const genDir = join(UI_DIR, GENERATED_DIR);
  if (existsSync(genDir)) {
    for (const entry of readdirSync(genDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = join(entry.parentPath, entry.name).slice(UI_DIR.length + 1).split("\\").join("/");
      if (!files.has(rel)) drift.push(`${rel} (stale)`);
    }
  }
  return drift.sort();
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const files = await generateLecturnTheme();
  if (check) {
    const drift = driftedFiles(files);
    if (drift.length > 0) {
      console.error(`gen-lecturn-theme: generated files are out of date (run gen:lecturn-theme):\n  ${drift.join("\n  ")}`);
      process.exit(1);
    }
    console.log("gen-lecturn-theme: up to date");
    return;
  }
  for (const [rel, bytes] of files) {
    const path = join(UI_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  console.log(`gen-lecturn-theme: wrote ${String(files.size)} files under ${GENERATED_DIR}/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
