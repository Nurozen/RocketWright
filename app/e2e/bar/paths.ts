/** Locations of the bar spec data, the exemplar PNGs, and the review artifacts. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The rocketwright repo root (this file is `app/e2e/bar/paths.ts`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `tests/bar/`: tokens, regions, checklists, critic prompt, lint lists. */
export const BAR_DATA_DIR = join(REPO_ROOT, "tests/bar");
export const CHECKLIST_DIR = join(BAR_DATA_DIR, "checklists");
export const TOKENS_PATH = join(BAR_DATA_DIR, "tokens.json");
export const REGIONS_PATH = join(BAR_DATA_DIR, "regions.json");
export const CRITIC_PROMPT_PATH = join(BAR_DATA_DIR, "critic-prompt.md");
export const ART_NUMBERS_PATH = join(BAR_DATA_DIR, "art-numbers.txt");
export const ART_DEFECTS_PATH = join(BAR_DATA_DIR, "art-defects.json");

/** Page ids in bar order. */
export const PAGES = ["01", "02", "03", "04", "05", "06"] as const;
export type PageId = (typeof PAGES)[number];

export function isPageId(s: string): s is PageId {
  return (PAGES as readonly string[]).includes(s);
}

/**
 * The maintainers' gitignored workspace `artifacts/` dir (bar reference images,
 * specs, review outputs): the nearest ancestor of the repo that has one. Absent
 * in a plain clone; see docs/dev/bar-tooling.md.
 */
export function findArtifactsDir(start: string = REPO_ROOT): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, "artifacts");
    if (existsSync(join(candidate, "features/rocketwright"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The exemplar PNG directory (`bar/visual/`). `$RW_BAR_EXEMPLARS` wins; otherwise
 * `artifacts/features/rocketwright/bar/visual` above the repo. Never the
 * clean-room-restricted concept source directory.
 */
export function exemplarDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["RW_BAR_EXEMPLARS"];
  if (fromEnv) return resolve(fromEnv);
  const artifacts = findArtifactsDir();
  if (!artifacts) {
    throw new Error("bar: exemplar PNGs not found (maintainer-only, not in the repository); set RW_BAR_EXEMPLARS to the bar/visual directory");
  }
  return join(artifacts, "features/rocketwright/bar/visual");
}

/**
 * The Lecturn-embed bar assets (D23): the approved mockup
 * `rocketwright-embedded-chat.png` and the no-regression captures
 * `current-01-capture.png` / `current-06-capture.png`.
 * `$RW_BAR_EMBED_ASSETS` wins; otherwise
 * `artifacts/features/rocketwright-lecturn/bar` above the repo.
 */
export function embedAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["RW_BAR_EMBED_ASSETS"];
  if (fromEnv) return resolve(fromEnv);
  const artifacts = findArtifactsDir();
  if (!artifacts) throw new Error("bar: embed bar assets not found (maintainer-only, not in the repository); set RW_BAR_EMBED_ASSETS to the rocketwright-lecturn bar directory");
  return join(artifacts, "features/rocketwright-lecturn/bar");
}

/** `artifacts/reviews/rocketwright_bar/` (the bar checkpoint output root). */
export function reviewsDir(): string | undefined {
  const artifacts = findArtifactsDir();
  return artifacts ? join(artifacts, "reviews/rocketwright_bar") : undefined;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * JSON with sorted object keys and two-space indent, so reports are byte-stable (I8).
 * Numbers must already be rounded by the caller.
 */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/** Rounds to `digits` decimals (fixed significant output for reports). */
export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Where bar outputs go: `artifacts/reviews/rocketwright_bar/` when the workspace
 * has one, else the gitignored `target/bar/` in the repo.
 */
export function barOutDir(): string {
  return reviewsDir() ?? join(REPO_ROOT, "target/bar");
}

/** The Playwright JSON report the e2e run writes and `make bar` reads (B4(a)). */
export function e2eReportPath(): string {
  return join(barOutDir(), "e2e/report.json");
}
