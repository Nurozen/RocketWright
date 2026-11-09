/**
 * Ids for new model entries. Every `/c`, `/sims`, `/engines`, `/materials`
 * entry the UI creates needs an id matching `ID_PATTERN` (`crates/rw-model/src/types/mod.rs`);
 * `/c` is the only table the patch layer validates, so a bad sim or engine id
 * would otherwise reach the sidecar as a file name.
 */

export const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Long enough for any real name, short enough for a `sims/<id>.rw.toml` file name. */
const MAX_ID_LENGTH = 64;

/**
 * An id from a free-form name: `3" Body Tube` → `part_3_body_tube` (with
 * fallback `part`). `fallback` must itself match `ID_PATTERN`.
 */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug === "") return fallback;
  const id = /^[a-z]/.test(slug) ? slug : `${fallback}_${slug}`;
  return id.slice(0, MAX_ID_LENGTH).replace(/_+$/, "");
}

/** `slugify(name, fallback)`, numbered if needed to be unique among `taken` (`body`, `body_2`, ...). */
export function uniqueId(name: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const base = slugify(name, fallback);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`;
    if (!used.has(id)) return id;
  }
}
