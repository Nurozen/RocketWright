/**
 * Read-only view of the project sources the editor needs beside the
 * evaluated model (M2.9): which source value a component field holds (a
 * literal like `"140 mm"` or an expression like `"= params.fin_span"`), and a
 * param's limits. The evaluated model resolves expressions, so it cannot say
 * that editing Span should edit `params.fin_span`.
 *
 * A deliberately small reader over the mirror's `files` (I1: the UI never
 * writes them): tables, dotted keys, and inline tables, read token by token
 * so an expression's commas stay inside its string. Arrays and multi-line
 * values are skipped (the editor reads none here). JSON sources merge in the
 * same shape. Every write still goes through `model.patch` on the id-keyed
 * model (I2).
 */

import { parse as parseToml } from "smol-toml";

export type SourceScalar = string | number | boolean;
export type SourceFilesLike = Readonly<Record<string, string | undefined>>;

/** A table's values; arrays read as `null` (present, not editable here). */
type SourceValue = SourceScalar | SourceTable | null;
interface SourceTable {
  [key: string]: SourceValue;
}

const isTable = (v: SourceValue | undefined): v is SourceTable => typeof v === "object" && v !== null;

/** A source is TOML or its JSON twin (`.rw.json`, `rocketwright.json`), which parses to the same types. */
const isJsonSource = (name: string): boolean => name.endsWith(".rw.json") || name === "rocketwright.json" || name.endsWith("/rocketwright.json");

/** A cursor over one TOML value: strings are read whole, so an expression's commas and braces are just text. */
class Cursor {
  i = 0;
  constructor(readonly text: string) {}
  ws() {
    while (this.text[this.i] === " " || this.text[this.i] === "\t") this.i++;
  }
  eat(c: string): boolean {
    this.ws();
    if (this.text[this.i] !== c) return false;
    this.i++;
    return true;
  }
  /** A basic or literal string; null when it does not close on this line. */
  string(): string | null {
    const quote = this.text[this.i];
    let out = "";
    for (let j = this.i + 1; j < this.text.length; j++) {
      const c = this.text[j]!;
      if (c === quote) {
        this.i = j + 1;
        return out;
      }
      if (quote === '"' && c === "\\") {
        const next = this.text[++j];
        out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      } else out += c;
    }
    return null;
  }
  /** `a.b."c"`; null when the text there is no key. */
  key(): string[] | null {
    const out: string[] = [];
    do {
      this.ws();
      const c = this.text[this.i];
      if (c === '"' || c === "'") {
        const s = this.string();
        if (s === null) return null;
        out.push(s);
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.i));
        if (m === null) return null;
        out.push(m[0]);
        this.i += m[0].length;
      }
    } while (this.eat("."));
    return out;
  }
  /** One value; undefined when it is malformed or runs past this line. */
  value(): SourceValue | undefined {
    this.ws();
    const c = this.text[this.i];
    if (c === '"' || c === "'") return this.string() ?? undefined;
    if (c === "{") return this.inlineTable();
    if (c === "[") return this.array() ? null : undefined;
    const m = /^[^\s,}\]#]+/.exec(this.text.slice(this.i));
    if (m === null) return undefined;
    this.i += m[0].length;
    if (m[0] === "true" || m[0] === "false") return m[0] === "true";
    if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(m[0])) return Number(m[0].replace(/_/g, ""));
    return null;
  }
  private inlineTable(): SourceTable | undefined {
    const out: SourceTable = {};
    this.i++;
    if (this.eat("}")) return out;
    for (;;) {
      const key = this.key();
      if (key === null || !this.eat("=")) return undefined;
      const v = this.value();
      if (v === undefined) return undefined;
      assign(out, key, v);
      if (this.eat("}")) return out;
      if (!this.eat(",")) return undefined;
    }
  }
  /** Consumes a whole array; false when it does not close on this line. */
  private array(): boolean {
    this.i++;
    for (;;) {
      if (this.eat("]")) return true;
      if (this.value() === undefined) return false;
      if (!this.eat(",") && !this.eat("]")) return false;
      if (this.text[this.i - 1] === "]") return true;
    }
  }
}

/** The table at `path` under `table`, created where missing. */
function descend(table: SourceTable, path: readonly string[]): SourceTable {
  let cur = table;
  for (const k of path) {
    const next: SourceValue | undefined = cur[k];
    if (isTable(next)) cur = next;
    else cur = cur[k] = {};
  }
  return cur;
}

function assign(table: SourceTable, key: readonly string[], value: SourceValue): void {
  const cur = descend(table, key.slice(0, -1));
  const leaf = key.at(-1)!;
  const old = cur[leaf];
  if (isTable(old) && isTable(value)) merge(old, value);
  else cur[leaf] = value;
}

/** Later keys win, leaf by leaf. */
function merge(into: SourceTable, from: SourceTable): void {
  for (const [k, v] of Object.entries(from)) assign(into, [k], v);
}

/** Does this value leave a multi-line array or string open? Returns the text that closes it, or null. */
function opensMultiline(raw: string): string | null {
  const t = raw.trimStart();
  for (const q of ['"""', "'''"]) {
    if (t.startsWith(q)) return t.indexOf(q, 3) === -1 ? q : null;
  }
  return t.startsWith("[") ? "]" : null;
}

function parseFile(text: string, into: SourceTable): void {
  let current: SourceTable | null = into;
  const elements = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\s*\[\[/.test(line)) {
      // Each element of an array of tables reads as a table keyed by its position (`feed.edge.0`).
      const elementCursor = new Cursor(line);
      elementCursor.eat("[");
      elementCursor.eat("[");
      const path = elementCursor.key();
      if (path === null || !elementCursor.eat("]") || !elementCursor.eat("]")) {
        current = null;
        continue;
      }
      const name = path.join(".");
      const index = elements.get(name) ?? 0;
      elements.set(name, index + 1);
      current = descend(into, [...path, String(index)]);
      continue;
    }
    const headerCursor = new Cursor(line);
    if (headerCursor.eat("[")) {
      const path = headerCursor.key();
      if (path === null || !headerCursor.eat("]")) {
        current = null;
        continue;
      }
      current = descend(into, path);
      continue;
    }
    if (current === null) continue;
    const cursor = new Cursor(line);
    const key = cursor.key();
    if (key === null || !cursor.eat("=")) continue;
    const start = cursor.i;
    const value = cursor.value();
    if (value !== undefined) {
      assign(current, key, value);
      continue;
    }
    // A value that runs over several lines: skip to where it closes, so its body is not read as keys or headers.
    const closer = opensMultiline(line.slice(start));
    if (closer === null) continue;
    if (closer === "]") {
      let depth = 0;
      for (let m = n; m < lines.length; m++) {
        depth += bracketDelta(m === n ? line.slice(start) : lines[m]!);
        n = m;
        if (depth <= 0) break;
      }
    } else {
      while (n + 1 < lines.length && !lines[++n]!.includes(closer));
    }
    assign(current, key, null);
  }
}

/** Net `[` minus `]` on a line, outside strings and comments. */
function bracketDelta(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") break;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth;
}

/** A JSON value as the TOML reader leaves it: an array of tables is keyed by position, any other array reads as `null`. */
function jsonValue(v: unknown): SourceValue {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    if (v.length === 0 || !v.every((e) => typeof e === "object" && e !== null && !Array.isArray(e))) return null;
    return Object.fromEntries(v.map((e, i) => [String(i), jsonValue(e)]));
  }
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, jsonValue(e)]));
  return null;
}

/** A JSON source's keys merged into `into`; one that does not parse adds nothing (the model reports it). */
function parseJsonFile(text: string, into: SourceTable): void {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return;
  }
  const value = jsonValue(root);
  if (isTable(value)) merge(into, value);
}

const parsed = new WeakMap<object, SourceTable>();

/** Every source merged into one tree, in file-name order (later files win). */
function sourceTree(files: SourceFilesLike): SourceTable {
  const cached = parsed.get(files);
  if (cached !== undefined) return cached;
  const tree: SourceTable = {};
  for (const name of Object.keys(files).sort()) {
    if (name.endsWith(".toml")) parseFile(files[name] ?? "", tree);
    else if (isJsonSource(name)) parseJsonFile(files[name] ?? "", tree);
  }
  parsed.set(files, tree);
  return tree;
}

function tableAt(files: SourceFilesLike, path: readonly string[]): SourceTable | undefined {
  let cur: SourceValue | undefined = sourceTree(files);
  for (const k of path) {
    if (!isTable(cur)) return undefined;
    cur = cur[k];
  }
  return isTable(cur) ? cur : undefined;
}

/** Scalar keys of the table at `path`, whichever way it is written (`[a.b]`, inline, dotted keys). */
export function tableScalars(files: SourceFilesLike, path: readonly string[]): Record<string, SourceScalar> {
  const out: Record<string, SourceScalar> = {};
  for (const [k, v] of Object.entries(tableAt(files, path) ?? {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Scalar keys of the table at `path` in one file, or null when the file has no
 * such table. For files whose top level is their entity (`sims/<id>.rw.toml`),
 * which the merged tree cannot tell apart.
 */
export function fileTable(text: string, path: readonly string[]): Record<string, SourceScalar> | null {
  const tree: SourceTable = {};
  parseFile(text, tree);
  let cur: SourceValue | undefined = tree;
  for (const k of path) {
    if (!isTable(cur)) return null;
    cur = cur[k];
  }
  if (!isTable(cur)) return null;
  const out: Record<string, SourceScalar> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Ids of the materials the project's own sources write (materials merged from its library are not among them). */
export function sourceMaterialIds(files: SourceFilesLike): string[] {
  return Object.entries(tableAt(files, ["materials"]) ?? {})
    .filter(([, v]) => isTable(v))
    .map(([k]) => k);
}

/** One place the sources name a material: the patch path that holds it, and what a person calls that place. */
export interface MaterialUse {
  path: string;
  label: string;
}

type Doc = Record<string, unknown>;

const isDoc = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** One source, parsed whole; null when it does not parse (the model reports that and leaves it out). */
function readDoc(name: string, text: string | undefined): Doc | null {
  if (text === undefined) return null;
  try {
    const value: unknown = name.endsWith(".json") ? JSON.parse(text) : parseToml(text);
    return isDoc(value) ? value : null;
  } catch {
    return null;
  }
}

/** The parent directory of a source: `doc_kind` in `rw-model` decides what it holds by this alone. */
const parentDir = (name: string): string => name.split("/").at(-2) ?? "";

const isRocketFile = (name: string): boolean => /\.rw\.(toml|json)$/.test(name) && !["configs", "sims", "engines"].includes(parentDir(name));

interface ModelFiles {
  /** The main model file and everything it includes, in the order `merge` in `rw-model` reads them. */
  rockets: { name: string; doc: Doc }[];
  /** Each engine file under its id (`engines/<id>.rw.toml` or `.rw.json`). */
  engines: { id: string; doc: Doc }[];
}

const modelCache = new WeakMap<object, ModelFiles>();

/** The files `merge` in `rw-model` builds the model from: what a patch can reach and what evaluation reads. */
function modelFiles(files: SourceFilesLike): ModelFiles {
  const cached = modelCache.get(files);
  if (cached !== undefined) return cached;
  const names = Object.keys(files).sort();
  const docs = new Map<string, Doc>();
  for (const name of names) {
    if (!/\.rw\.(toml|json)$/.test(name) && !/(^|\/)rocketwright\.(toml|json)$/.test(name)) continue;
    const doc = readDoc(name, files[name]);
    if (doc !== null) docs.set(name, doc);
  }
  const isRocket = (name: string) => isRocketFile(name) && docs.has(name);
  const manifestModel = ["rocketwright.json", "rocketwright.toml"].map((m) => docs.get(m)?.["model"]).find((m) => typeof m === "string") as string | undefined;
  const main = manifestModel !== undefined && isRocket(manifestModel) ? manifestModel : isRocket("rocket.rw.toml") ? "rocket.rw.toml" : names.find((n) => isRocket(n) && !n.startsWith("parts/"));

  const rockets: ModelFiles["rockets"] = [];
  const seen = new Set<string>();
  const includesOf = (doc: Doc): string[] => (Array.isArray(doc["include"]) ? doc["include"].filter((i): i is string => typeof i === "string") : []);
  const queue = main === undefined ? [] : [main];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const doc = docs.get(name);
    if (doc === undefined || !isRocketFile(name)) continue;
    rockets.push({ name, doc });
    queue.unshift(...includesOf(doc));
  }

  const engines: ModelFiles["engines"] = [];
  for (const name of names) {
    const id = /([^/]+)\.rw\.(toml|json)$/.exec(name)?.[1];
    const doc = docs.get(name);
    if (id !== undefined && doc !== undefined && parentDir(name) === "engines") engines.push({ id, doc });
  }
  const out = { rockets, engines };
  modelCache.set(files, out);
  return out;
}

/**
 * Everywhere the model names this material: a part's `material` and
 * `line_material`, and a feed-graph tank's wall `material` in an engine's own
 * file. These are the only references the model has (`check_ref` and the
 * engine's tank check), so a material with none can go, and a rename rewrites
 * exactly these. Reads the same files, in the same forms, as the model does:
 * a reference in an included JSON part counts, one in a file nothing includes
 * does not (the model has no such part to patch).
 */
export function materialUses(files: SourceFilesLike, material: string): MaterialUse[] {
  const out: MaterialUse[] = [];
  const model = modelFiles(files);
  const seen = new Set<string>();
  for (const { doc } of model.rockets) {
    if (!isDoc(doc["c"])) continue;
    for (const [id, part] of Object.entries(doc["c"])) {
      // Ids are unique across included files; a duplicate is reported and the first one is the model's.
      if (seen.has(id) || !isDoc(part)) continue;
      seen.add(id);
      const label = typeof part["name"] === "string" ? part["name"] : id;
      for (const key of ["material", "line_material"]) {
        if (part[key] === material) out.push({ path: `/c/${id}/${key}`, label });
      }
    }
  }
  for (const { id: engine, doc } of model.engines) {
    const feed = doc["feed"];
    const nodes = isDoc(feed) ? feed["node"] : undefined;
    if (!isDoc(nodes)) continue;
    const engineName = typeof doc["name"] === "string" ? doc["name"] : engine;
    for (const [node, value] of Object.entries(nodes)) {
      if (isDoc(value) && value["material"] === material) out.push({ path: `/engines/${engine}/feed/node/${node}/material`, label: `${engineName} ${node}` });
    }
  }
  return out;
}

/** The component has this nested table in its sources. */
export function sourceHasTable(files: SourceFilesLike, id: string, sub: readonly string[]): boolean {
  return tableAt(files, ["c", id, ...sub]) !== undefined;
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
  const table = tableScalars(files, ["c", id, ...parts.slice(0, -1)]);
  const written = table[parts.at(-1)!];
  const name = paramRef(written);
  const param = name !== null ? paramSource(files, name) : null;
  if (param !== null) return { path: `/params/${name}/value`, param, written, expression: null };
  const expression = typeof written === "string" && /^\s*=/.test(written) ? written : null;
  return { path: `/c/${id}/${parts.join("/")}`, param: null, written, expression };
}
