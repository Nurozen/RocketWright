/**
 * A small JSON Schema (draft 2020-12) validator covering the keywords
 * schemars emits for `schema/**` plus the IF10 frame schemas in
 * `rpc-schema.ts`: $ref (local and by `$id`), type, const, enum, properties,
 * required, additionalProperties, propertyNames, items, prefixItems,
 * min/maxItems, min/maxLength, minimum/maximum (+exclusive), pattern,
 * anyOf/oneOf/allOf/not. `format` and `x-*` are annotations. Used by the mock
 * tests so they need no dependency; not a general validator.
 */
import type { JsonValue } from "../src/types.ts";

export type Schema = boolean | { [k: string]: JsonValue };
type SchemaObj = { [k: string]: JsonValue };

/** Resolves a root schema by absolute `$id` (without fragment). */
export type SchemaLoader = (id: string) => Schema | undefined;

export class Validator {
  private readonly roots = new Map<string, Schema>();
  private readonly loader: SchemaLoader;

  constructor(loader: SchemaLoader = () => undefined) {
    this.loader = loader;
  }

  /** Registers a root schema under its `$id` (or `id`). */
  add(schema: Schema, id?: string): void {
    const key = id ?? (typeof schema === "object" && typeof schema.$id === "string" ? schema.$id : undefined);
    if (key === undefined) throw new Error("schema without $id");
    this.roots.set(key, schema);
  }

  /** Errors of `value` against `schema` or the root with `$id` = `schema` (empty = valid). */
  validate(schema: Schema | string, value: JsonValue): string[] {
    const errs: string[] = [];
    const root: Schema = typeof schema === "string" ? { $ref: schema } : schema;
    this.check(root, root, value, "", errs);
    return errs;
  }

  private root(id: string): Schema {
    let s = this.roots.get(id);
    if (s === undefined) {
      s = this.loader(id);
      if (s === undefined) throw new Error(`unresolved schema ${id}`);
      this.roots.set(id, s);
    }
    return s;
  }

  private resolve(ref: string, root: Schema): [Schema, Schema] {
    const hash = ref.indexOf("#");
    const base = hash < 0 ? ref : ref.slice(0, hash);
    const frag = hash < 0 ? "" : ref.slice(hash + 1);
    const r = base === "" ? root : this.root(base);
    let s: JsonValue = r as JsonValue;
    for (const raw of frag.split("/").filter((p) => p !== "")) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      if (s === null || typeof s !== "object" || Array.isArray(s) || !(key in s)) throw new Error(`unresolved $ref ${ref}`);
      s = s[key]!;
    }
    return [s as Schema, r];
  }

  private check(schema: Schema, root: Schema, v: JsonValue, at: string, errs: string[]): void {
    if (schema === true) return;
    if (schema === false) {
      errs.push(`${at || "/"}: not allowed`);
      return;
    }
    const s = schema as SchemaObj;
    if (typeof s.$ref === "string") {
      const [target, targetRoot] = this.resolve(s.$ref, root);
      this.check(target, targetRoot, v, at, errs);
    }
    const here = at || "/";
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeOk(t as string, v))) errs.push(`${here}: expected ${types.join("|")}, got ${typeName(v)}`);
    }
    if ("const" in s && !deepEqual(s.const!, v)) errs.push(`${here}: expected const ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) errs.push(`${here}: ${JSON.stringify(v)} not in enum`);

    if (typeof v === "string") {
      const n = [...v].length;
      if (typeof s.maxLength === "number" && n > s.maxLength) errs.push(`${here}: longer than ${s.maxLength}`);
      if (typeof s.minLength === "number" && n < s.minLength) errs.push(`${here}: shorter than ${s.minLength}`);
      if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) errs.push(`${here}: ${JSON.stringify(v)} !~ ${s.pattern}`);
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) errs.push(`${here}: below minimum ${s.minimum}`);
      if (typeof s.maximum === "number" && v > s.maximum) errs.push(`${here}: above maximum ${s.maximum}`);
      if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) errs.push(`${here}: not above ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) errs.push(`${here}: not below ${s.exclusiveMaximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) errs.push(`${here}: fewer than ${s.minItems} items`);
      if (typeof s.maxItems === "number" && v.length > s.maxItems) errs.push(`${here}: more than ${s.maxItems} items`);
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
      v.forEach((item, i) => {
        const sub = i < prefix.length ? prefix[i] : (s.items as Schema | undefined);
        if (sub !== undefined) this.check(sub, root, item, `${at}/${i}`, errs);
      });
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const props = (s.properties ?? {}) as { [k: string]: Schema };
      if (Array.isArray(s.required)) {
        for (const k of s.required as string[]) if (!(k in v)) errs.push(`${here}: missing ${k}`);
      }
      for (const [k, item] of Object.entries(v)) {
        const p = `${at}/${k}`;
        if (k in props) this.check(props[k]!, root, item, p, errs);
        else if (s.additionalProperties !== undefined) this.check(s.additionalProperties as Schema, root, item, p, errs);
        if (s.propertyNames !== undefined) this.check(s.propertyNames as Schema, root, k, p, errs);
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) this.check(sub, root, v, at, errs);
    if (Array.isArray(s.anyOf)) {
      const branches = (s.anyOf as Schema[]).map((sub) => this.branch(sub, root, v, at));
      if (!branches.some((e) => e.length === 0)) errs.push(`${here}: no anyOf branch matches (${closest(branches)})`);
    }
    if (Array.isArray(s.oneOf)) {
      const branches = (s.oneOf as Schema[]).map((sub) => this.branch(sub, root, v, at));
      const n = branches.filter((e) => e.length === 0).length;
      if (n !== 1) errs.push(`${here}: ${n} oneOf branches match${n === 0 ? ` (${closest(branches)})` : ""}`);
    }
    if (s.not !== undefined && this.branch(s.not as Schema, root, v, at).length === 0) errs.push(`${here}: matches not`);
  }

  private branch(schema: Schema, root: Schema, v: JsonValue, at: string): string[] {
    const errs: string[] = [];
    this.check(schema, root, v, at, errs);
    return errs;
  }
}

function closest(branches: string[][]): string {
  const best = [...branches].sort((a, b) => a.length - b.length)[0] ?? [];
  return best.slice(0, 3).join("; ");
}

function typeOk(t: string, v: JsonValue): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    default:
      return false;
  }
}

function typeName(v: JsonValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!));
  const ao = a as { [k: string]: JsonValue };
  const bo = b as { [k: string]: JsonValue };
  const ka = Object.keys(ao);
  if (ka.length !== Object.keys(bo).length) return false;
  return ka.every((k) => k in bo && deepEqual(ao[k]!, bo[k]!));
}

/**
 * A structural schema inferred from example values: only keys the examples
 * use, with the same JSON types (presence is not checked: optional fields
 * vary between steps, runs, and jobs). The mock
 * tests fall back to it for a registry type while `schema/<type>.json` is not
 * generated yet (M1.6): mock output must then keep the shape of a fixture the
 * Rust contract test validated.
 */
export function inferSchema(examples: JsonValue[]): Schema {
  if (examples.length === 0) return true;
  const kinds = new Map<string, JsonValue[]>();
  for (const e of examples) {
    const k = typeName(e);
    kinds.set(k, [...(kinds.get(k) ?? []), e]);
  }
  const branches: Schema[] = [];
  for (const [k, vals] of kinds) {
    if (k === "object") {
      const objs = vals as { [key: string]: JsonValue }[];
      const keys = new Set(objs.flatMap((o) => Object.keys(o)));
      const properties: { [key: string]: JsonValue } = {};
      for (const key of [...keys].sort()) properties[key] = inferSchema(objs.filter((o) => key in o).map((o) => o[key]!)) as JsonValue;
      branches.push({ type: "object", properties, additionalProperties: false });
    } else if (k === "array") {
      const items = (vals as JsonValue[][]).flat();
      branches.push(items.length === 0 ? { type: "array" } : { type: "array", items: inferSchema(items) as JsonValue });
    } else {
      branches.push({ type: k === "number" ? "number" : k });
    }
  }
  return branches.length === 1 ? branches[0]! : { anyOf: branches as JsonValue[] };
}
