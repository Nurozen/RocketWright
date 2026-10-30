/**
 * `PatchOp` application (R3.3, M1.23): RFC 6902 on the id-keyed model value,
 * with `rw:` refs accepted as paths (`rw:c/fins/span` → `/c/fins/span`).
 * Mirrors `apply_value` in `crates/rw-model/src/patch.rs`; both run
 * `schema/testdata/patches.json`. The patch is atomic: the input is never
 * modified.
 */
import type { JsonValue, PatchOp } from "./types.ts";
import { modelPointer, parseRef } from "./refs.ts";

export type PatchErrorKind = "invalid_pointer" | "not_found" | "invalid_index" | "test_failed" | "move_into_child";

export interface PatchFailure {
  /** Index of the failing op. */
  op: number;
  kind: PatchErrorKind;
  path: string;
  message: string;
}

export type PatchResult = { ok: JsonValue } | { err: PatchFailure };

class Fail extends Error {
  readonly kind: PatchErrorKind;
  // No parameter properties: Node's strip-only TypeScript loader rejects them.
  constructor(kind: PatchErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

type Container = JsonValue[] | { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a JSON pointer (or an `rw:` ref) into reference tokens. */
export function parsePointer(p: string): string[] {
  if (p.startsWith("rw:")) {
    const r = parseRef(p);
    if ("err" in r) throw new Fail("invalid_pointer", `\`${p}\` is not a valid ref (${r.err})`);
    const ptr = modelPointer(r.ok);
    if (ptr === undefined) throw new Fail("invalid_pointer", `\`${p}\` does not address an editable model field`);
    return parsePointer(ptr);
  }
  if (p === "") return [];
  if (!p.startsWith("/")) throw new Fail("invalid_pointer", `\`${p}\` must start with \`/\``);
  return p
    .slice(1)
    .split("/")
    .map((t) => {
      if (/~[^01]|~$/.test(t)) throw new Fail("invalid_pointer", `bad escape in \`${p}\``);
      return t.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

function index(tok: string, len: number, allowEnd: boolean): number {
  const bad = () => new Fail("invalid_index", `\`${tok}\` is not a valid index for an array of ${len}`);
  if (tok === "-") {
    if (allowEnd) return len;
    throw bad();
  }
  if (!/^(0|[1-9][0-9]*)$/.test(tok)) throw bad();
  const i = Number(tok);
  if (i > len || (i === len && !allowEnd)) throw bad();
  return i;
}

function notFound(toks: string[]): Fail {
  return new Fail("not_found", `\`/${toks.join("/")}\` does not exist`);
}

function get(doc: JsonValue, toks: string[]): JsonValue {
  let v = doc;
  toks.forEach((t, k) => {
    if (Array.isArray(v)) v = v[index(t, v.length, false)] as JsonValue;
    else if (isObject(v) && Object.hasOwn(v, t)) v = v[t] as JsonValue;
    else throw notFound(toks.slice(0, k + 1));
  });
  return v;
}

function parentOf(doc: JsonValue, toks: string[]): [Container, string] {
  const parent = get(doc, toks.slice(0, -1));
  if (!Array.isArray(parent) && !isObject(parent)) throw notFound(toks);
  return [parent, toks[toks.length - 1] as string];
}

function add(root: { doc: JsonValue }, toks: string[], value: JsonValue): void {
  if (toks.length === 0) {
    root.doc = value;
    return;
  }
  const [parent, last] = parentOf(root.doc, toks);
  if (Array.isArray(parent)) parent.splice(index(last, parent.length, true), 0, value);
  else parent[last] = value;
}

function remove(root: { doc: JsonValue }, toks: string[]): JsonValue {
  if (toks.length === 0) throw new Fail("invalid_pointer", "cannot remove the whole document");
  const [parent, last] = parentOf(root.doc, toks);
  if (Array.isArray(parent)) return parent.splice(index(last, parent.length, false), 1)[0] as JsonValue;
  if (!Object.hasOwn(parent, last)) throw notFound(toks);
  const v = parent[last] as JsonValue;
  delete parent[last];
  return v;
}

/** JSON equality, objects regardless of key order. */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i] as JsonValue));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k] as JsonValue, b[k] as JsonValue));
  }
  return a === b;
}

function clone(v: JsonValue): JsonValue {
  return structuredClone(v);
}

function applyOne(root: { doc: JsonValue }, op: PatchOp): void {
  switch (op.op) {
    case "add":
      return add(root, parsePointer(op.path), clone(op.value as JsonValue));
    case "remove":
      remove(root, parsePointer(op.path));
      return;
    case "replace": {
      const t = parsePointer(op.path);
      if (t.length === 0) {
        root.doc = clone(op.value as JsonValue);
        return;
      }
      get(root.doc, t);
      const [parent, last] = parentOf(root.doc, t);
      if (Array.isArray(parent)) parent[index(last, parent.length, false)] = clone(op.value as JsonValue);
      else parent[last] = clone(op.value as JsonValue);
      return;
    }
    case "move": {
      const f = parsePointer(op.from);
      const t = parsePointer(op.path);
      if (f.length === t.length && f.every((x, i) => x === t[i])) {
        get(root.doc, f);
        return;
      }
      if (t.length > f.length && f.every((x, i) => x === t[i])) {
        throw new Fail("move_into_child", `cannot move \`${op.from}\` into its own child \`${op.path}\``);
      }
      return add(root, t, remove(root, f));
    }
    case "copy":
      return add(root, parsePointer(op.path), clone(get(root.doc, parsePointer(op.from))));
    case "test": {
      const cur = get(root.doc, parsePointer(op.path));
      if (!jsonEqual(cur, op.value as JsonValue)) {
        throw new Fail("test_failed", `\`${op.path}\` is ${JSON.stringify(cur)}, not ${JSON.stringify(op.value)}`);
      }
      return;
    }
  }
}

/** Applies `ops` atomically to a JSON document (RFC 6902). */
export function applyPatch(doc: JsonValue, ops: readonly PatchOp[]): PatchResult {
  const root = { doc: clone(doc) };
  for (const [i, op] of ops.entries()) {
    try {
      applyOne(root, op);
    } catch (e) {
      if (e instanceof Fail) return { err: { op: i, kind: e.kind, path: op.path, message: e.message } };
      throw e;
    }
  }
  return { ok: root.doc };
}
