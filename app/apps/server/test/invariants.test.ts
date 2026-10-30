/**
 * I1: the TS server writes only the disposable part-thumbnail render cache
 * `.rw/cache/thumbs/` (M3.6), through `src/project/ThumbCache.ts`; never a
 * project file. (B17 removed the old chat's `.rw/threads/*.jsonl` store.) Until the ESLint `no-restricted-syntax` rule lands
 * (M1.3 lint), this scan is the enforcement.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const ALLOWED = new Set(["project/ThumbCache.ts"]);
const WRITE_CALL =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|symlink|symlinkSync|chmod|chmodSync|utimes|utimesSync)\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("I1: server writes only the thumbnail cache", () => {
  it("no fs write call outside ThumbCache", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      if (ALLOWED.has(rel) || rel.endsWith(".test.ts")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (WRITE_CALL.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("ThumbCache writes only under .rw/cache/thumbs/<model_hash>", () => {
    const src = readFileSync(join(SRC, "project/ThumbCache.ts"), "utf8");
    expect(src).toContain('THUMBS_DIR = ".rw/cache/thumbs"');
    // Every write goes through `this.dir(modelHash)` (hash-validated) or the THUMBS_DIR root (prune).
    const writes = src.split("\n").filter((l) => WRITE_CALL.test(l) && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
    expect(writes.length).toBe(4);
    for (const w of writes) expect(w, w).toMatch(/\b(dir|tmp|root)\b/);
  });
});
