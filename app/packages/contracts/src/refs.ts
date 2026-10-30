/**
 * The `rw:` ref parser (R2.8, M1.23): `rw:<kind>/<id>[#anchor][@version][/pointer]`.
 * Mirrors `crates/rw-model/src/refs.rs`; both run `schema/testdata/refs.json`.
 */

export const REF_KINDS = ["c", "cfg", "sim", "run", "step", "rev", "thread", "eng"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** A parsed ref (same JSON shape as Rust `RefParts`). */
export interface RefParts {
  kind: RefKind;
  id: string;
  anchor?: string;
  version?: string;
  /** JSON pointer after the ref (`/span`), empty when absent. */
  pointer: string;
}

/** Why a ref did not parse (the `err` slugs of `refs.json`). */
export type RefError =
  | "missing_scheme"
  | "resource_uri"
  | "unknown_kind"
  | "empty_id"
  | "empty_anchor"
  | "empty_version"
  | "syntax";

export type RefResult = { ok: RefParts } | { err: RefError };

const ID = /^[A-Za-z0-9_.-]*/;
const ANCHOR = /^[A-Za-z0-9_<>]*/;
const VERSION = /^[A-Za-z0-9_.:-]*/;

function take(s: string, re: RegExp): [string, string] {
  const m = re.exec(s)?.[0] ?? "";
  return [m, s.slice(m.length)];
}

/** Parses an `rw:` ref. */
export function parseRef(input: string): RefResult {
  if (input.startsWith("rw://")) return { err: "resource_uri" };
  if (!input.startsWith("rw:")) return { err: "missing_scheme" };
  let rest = input.slice(3);
  const slash = rest.indexOf("/");
  if (slash < 0) return { err: "syntax" };
  const kind = rest.slice(0, slash);
  if (!(REF_KINDS as readonly string[]).includes(kind)) return { err: "unknown_kind" };
  rest = rest.slice(slash + 1);
  const [id, afterId] = take(rest, ID);
  if (id === "") return { err: "empty_id" };
  rest = afterId;
  const parts: RefParts = { kind: kind as RefKind, id, pointer: "" };
  if (rest.startsWith("#")) {
    const [a, r] = take(rest.slice(1), ANCHOR);
    if (a === "") return { err: "empty_anchor" };
    parts.anchor = a;
    rest = r;
  }
  if (rest.startsWith("@")) {
    const [v, r] = take(rest.slice(1), VERSION);
    if (v === "") return { err: "empty_version" };
    parts.version = v;
    rest = r;
  }
  if (rest !== "") {
    if (!rest.startsWith("/") || /\s/.test(rest)) return { err: "syntax" };
    parts.pointer = rest;
  }
  return { ok: parts };
}

/** The canonical ref text; `parseRef(formatRef(p))` gives `p` back. */
export function formatRef(p: RefParts): string {
  return `rw:${p.kind}/${p.id}${p.anchor !== undefined ? `#${p.anchor}` : ""}${
    p.version !== undefined ? `@${p.version}` : ""
  }${p.pointer}`;
}

const MODEL_COLLECTIONS: Partial<Record<RefKind, string>> = {
  c: "c",
  cfg: "configs",
  sim: "sims",
  eng: "engines",
};

/** The model-value pointer a ref addresses (`rw:c/fins/span` → `/c/fins/span`), if patchable. */
export function modelPointer(p: RefParts): string | undefined {
  const coll = MODEL_COLLECTIONS[p.kind];
  if (coll === undefined || p.anchor !== undefined || p.version !== undefined) return undefined;
  return `/${coll}/${p.id}${p.pointer}`;
}
