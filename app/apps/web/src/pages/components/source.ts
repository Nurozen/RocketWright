/**
 * Read-only view of the project sources the editor needs beside the
 * evaluated model (M2.9): which source value a component field holds (a
 * literal like `"140 mm"` or an expression like `"= params.fin_span"`), and a
 * param's limits. The evaluated model resolves expressions, so it cannot say
 * that editing Span should edit `params.fin_span`.
 *
 * A deliberately small reader over the mirror's `files` (I1: the UI never
 * writes them): `[c.<id>]` / `[params.<name>]` tables and their
 * `key = "string" | number | true/false` lines. Inline tables and arrays are
 * skipped (the editor never needs them). Every write still goes through
 * `model.patch` on the id-keyed model (I2).
 */

export type SourceScalar = string | number | boolean;
export type SourceFilesLike = Readonly<Record<string, string | undefined>>;

/** `[a.b]` or `[a."b"]` header → `["a", "b"]`; null for other lines. */
function header(line: string): string[] | null {
  const m = /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
  if (m === null) return null;
  return m[1]!.split(".").map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
}

/** One `key = value` scalar line, or null. */
function scalarLine(line: string): [string, SourceScalar] | null {
  const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
  if (m === null) return null;
  const key = m[1]!;
  let raw = m[2]!;
  if (raw.startsWith('"')) {
    const s = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    return s === null ? null : [key, s[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
  }
  if (raw.startsWith("'")) {
    const s = /^'([^']*)'/.exec(raw);
    return s === null ? null : [key, s[1]!];
  }
  raw = raw.replace(/\s+#.*$/, "");
  if (raw === "true" || raw === "false") return [key, raw === "true"];
  if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return [key, Number(raw.replace(/_/g, ""))];
  return null;
}

/** Scalar keys of the table `[path...]` across every source file (later files win). */
export function tableScalars(files: SourceFilesLike, path: readonly string[]): Record<string, SourceScalar> {
  const out: Record<string, SourceScalar> = {};
  for (const name of Object.keys(files).sort()) {
    if (!name.endsWith(".toml")) continue;
    const text = files[name] ?? "";
    let inTable = false;
    for (const line of text.split(/\r?\n/)) {
      const h = header(line);
      if (h !== null) {
        inTable = h.length === path.length && h.every((p, i) => p === path[i]);
        continue;
      }
      if (/^\s*\[\[/.test(line)) {
        inTable = false;
        continue;
      }
      if (!inTable) continue;
      const kv = scalarLine(line);
      if (kv !== null) out[kv[0]] = kv[1];
    }
  }
  return out;
}

/** Top-level scalar fields of `[c.<id>]`. */
export function componentSource(files: SourceFilesLike, id: string): Record<string, SourceScalar> {
  return tableScalars(files, ["c", id]);
}

export interface ParamSource {
  name: string;
  value: SourceScalar | undefined;
  min?: string;
  max?: string;
  step?: string;
  doc?: string;
  group?: string;
}

/** `[params.<name>]` (value and limits as written). */
export function paramSource(files: SourceFilesLike, name: string): ParamSource | null {
  const t = tableScalars(files, ["params", name]);
  if (Object.keys(t).length === 0) return null;
  const str = (k: string) => (typeof t[k] === "string" ? (t[k] as string) : typeof t[k] === "number" ? String(t[k]) : undefined);
  const out: ParamSource = { name, value: t["value"] };
  for (const k of ["min", "max", "step", "doc", "group"] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** `= params.fin_span` → `fin_span`; any other value → null. */
export function paramRef(v: SourceScalar | undefined): string | null {
  if (typeof v !== "string") return null;
  const m = /^\s*=\s*params\.([A-Za-z0-9_]+)\s*$/.exec(v);
  return m === null ? null : m[1]!;
}

export interface FieldTarget {
  /** The id-keyed patch path an edit of this field writes. */
  path: string;
  /** The field is `= params.<name>`: the edit writes the param's value. */
  param: ParamSource | null;
  /** The source value as written (literal or expression), if any. */
  written: SourceScalar | undefined;
  /** An expression other than a plain param reference (edits replace it with a literal). */
  expression: string | null;
}

/**
 * Where an edit of `c.<id>.<field>` (dotted for nested, e.g. `override.mass`)
 * goes: the param a `= params.x` field references, else the field itself.
 */
export function fieldTarget(files: SourceFilesLike, id: string, field: string): FieldTarget {
  const parts = field.split(".");
  const table = parts.length > 1 ? tableScalarsNested(files, id, parts.slice(0, -1)) : componentSource(files, id);
  const written = table[parts.at(-1)!];
  const name = paramRef(written);
  const param = name !== null ? paramSource(files, name) : null;
  if (param !== null) return { path: `/params/${name}/value`, param, written, expression: null };
  const expression = typeof written === "string" && /^\s*=/.test(written) ? written : null;
  return { path: `/c/${id}/${parts.join("/")}`, param: null, written, expression };
}

/** Scalars of a nested table: `[c.<id>.<sub>]` or the inline table `sub = { k = v }` on the component. */
function tableScalarsNested(files: SourceFilesLike, id: string, sub: readonly string[]): Record<string, SourceScalar> {
  const t = tableScalars(files, ["c", id, ...sub]);
  if (Object.keys(t).length > 0 || sub.length !== 1) return t;
  // Inline table on the component line: `override = { mass = "20 g" }`.
  for (const name of Object.keys(files).sort()) {
    const text = files[name] ?? "";
    let inTable = false;
    for (const line of text.split(/\r?\n/)) {
      const h = header(line);
      if (h !== null) {
        inTable = h.length === 2 && h[0] === "c" && h[1] === id;
        continue;
      }
      if (!inTable) continue;
      const m = new RegExp(`^\\s*${sub[0]}\\s*=\\s*\\{(.*)\\}\\s*$`).exec(line);
      if (m === null) continue;
      for (const part of m[1]!.split(",")) {
        const kv = scalarLine(part);
        if (kv !== null) t[kv[0]] = kv[1];
      }
    }
  }
  return t;
}
