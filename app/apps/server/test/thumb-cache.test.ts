/** M3.6: part thumbnails cached by (model_hash, id) under `.rw/cache/thumbs/`. */
import { existsSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEEP_HASHES, ThumbCache, ThumbCacheError, THUMBS_DIR } from "../src/project/ThumbCache.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
const H1 = "1ceb288e422bb33c662e66c9265157be29a006761136f05776dd3891e9ea8822";

describe("ThumbCache", () => {
  it("round-trips thumbnails per model hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-thumbs-"));
    const c = new ThumbCache(dir);
    expect(c.get(H1)).toEqual({});
    c.put(H1, "recovery_bay", PNG);
    c.put(H1, "recovery_bay--card", PNG);
    expect(c.get(H1)).toEqual({ recovery_bay: PNG, "recovery_bay--card": PNG });
    expect(existsSync(join(dir, THUMBS_DIR, H1, "recovery_bay.png"))).toBe(true);
    // No temp files left behind.
    expect(readdirSync(join(dir, THUMBS_DIR, H1)).sort()).toEqual(["recovery_bay--card.png", "recovery_bay.png"]);
  });

  it("rejects bad hashes, ids, and non-PNG data", () => {
    const c = new ThumbCache(mkdtempSync(join(tmpdir(), "rw-thumbs-")));
    expect(() => c.put("../x", "a", PNG)).toThrow(ThumbCacheError);
    expect(() => c.put(H1, "../../rocket", PNG)).toThrow(ThumbCacheError);
    expect(() => c.put(H1, "a", Buffer.from("not a png").toString("base64"))).toThrow(/not a PNG/);
    expect(() => c.get("ZZZ")).toThrow(ThumbCacheError);
  });

  it(`keeps the newest ${KEEP_HASHES} model hashes`, () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-thumbs-"));
    const c = new ThumbCache(dir);
    const hashes = Array.from({ length: KEEP_HASHES + 3 }, (_, i) => i.toString(16).padStart(8, "0"));
    hashes.forEach((h, i) => {
      c.put(h, "nose", PNG);
      const t = new Date(Date.now() - (hashes.length - i) * 60_000);
      utimesSync(join(dir, THUMBS_DIR, h), t, t);
    });
    c.put(hashes.at(-1)!, "nose", PNG);
    const left = readdirSync(join(dir, THUMBS_DIR)).sort();
    expect(left).toEqual(hashes.slice(-KEEP_HASHES).sort());
  });
});
