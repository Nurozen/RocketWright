/**
 * Part thumbnails (M3.6, U14) cached by `(model_hash, id)` at
 * `<project>/.rw/cache/thumbs/<model_hash>/<id>.png`.
 *
 * Invariant I1: project files belong to the sidecar's `Session`. `.rw/` is
 * the project's gitignored scratch area; the server owns this disposable
 * render cache there, nothing else.
 * The window renders the thumbnails (it has the GPU and the detail
 * geometry) and hands them here; any window on the same model reuses them.
 *
 * A model hash is the content hash of the evaluated model, so an edit gives
 * new thumbnails and older hashes are pruned (newest `KEEP_HASHES` kept).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const THUMBS_DIR = ".rw/cache/thumbs";
/** Model hashes kept (the current model plus a few recent history steps). */
export const KEEP_HASHES = 6;
/** Largest accepted thumbnail (decoded bytes). */
export const MAX_THUMB_BYTES = 256 * 1024;

const HASH_RE = /^[0-9a-f]{8,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class ThumbCacheError extends Error {}

export class ThumbCache {
  readonly projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  private dir(modelHash: string): string {
    if (!HASH_RE.test(modelHash)) throw new ThumbCacheError(`model_hash: expected a lowercase hex hash, got ${JSON.stringify(modelHash)}`);
    return join(this.projectDir, THUMBS_DIR, modelHash);
  }

  /** Every cached thumbnail of `modelHash`: id -> PNG base64. */
  get(modelHash: string): Record<string, string> {
    const dir = this.dir(modelHash);
    const out: Record<string, string> = {};
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".png")) continue;
      const id = f.slice(0, -4);
      if (!ID_RE.test(id)) continue;
      out[id] = readFileSync(join(dir, f)).toString("base64");
    }
    return out;
  }

  /** Stores one thumbnail (atomic rename) and prunes old hashes. */
  put(modelHash: string, id: string, pngBase64: string): void {
    const dir = this.dir(modelHash);
    if (!ID_RE.test(id)) throw new ThumbCacheError(`id: expected a component id, got ${JSON.stringify(id)}`);
    const bytes = Buffer.from(pngBase64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) throw new ThumbCacheError(`png_base64: ${bytes.length} bytes (1..${MAX_THUMB_BYTES})`);
    if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) throw new ThumbCacheError("png_base64: not a PNG");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(dir, `${id}.png`));
    this.prune(modelHash);
  }

  /** Removes all but the newest `KEEP_HASHES` hash directories (never `current`). */
  prune(current: string): void {
    const root = join(this.projectDir, THUMBS_DIR);
    if (!existsSync(root)) return;
    const dirs = readdirSync(root)
      .filter((d) => HASH_RE.test(d) && d !== current)
      .map((d) => ({ d, t: statSync(join(root, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t || (a.d < b.d ? -1 : 1));
    for (const { d } of dirs.slice(KEEP_HASHES - 1)) rmSync(join(root, d), { recursive: true, force: true });
  }
}
