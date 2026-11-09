/** Runtime checks for IF10 request params (the wire is untrusted JSON). */
import type { JsonObject, PageId, PatchOp, schema } from "@rw/contracts";
import { RpcFail } from "./errors.ts";

export const PAGE_IDS: readonly PageId[] = ["assembly", "components", "configurations", "results", "liquid", "propulsion-sim"];

export function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function str(p: JsonObject, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v === "") throw new RpcFail("invalid_params", `${key}: expected a non-empty string`);
  return v;
}

export function optStr(p: JsonObject, key: string): string | undefined {
  return p[key] === undefined || p[key] === null ? undefined : str(p, key);
}

export function optBool(p: JsonObject, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new RpcFail("invalid_params", `${key}: expected a boolean`);
  return v;
}

export function patchOps(p: JsonObject): PatchOp[] {
  const ops = p.ops;
  if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => isObject(o) && typeof o.op === "string" && typeof o.path === "string")) {
    throw new RpcFail("invalid_params", "ops: expected a non-empty array of patch ops");
  }
  return ops as unknown as PatchOp[];
}

const LIB_KINDS = ["component", "material", "preset", "motor"] as const;

/** `library.search` params: optional query, kind, and limit (1..500). */
export function libraryQuery(p: JsonObject): { query?: string; kind?: (typeof LIB_KINDS)[number]; limit?: number } {
  const out: { query?: string; kind?: (typeof LIB_KINDS)[number]; limit?: number } = {};
  if (p.query !== undefined && p.query !== null) {
    if (typeof p.query !== "string") throw new RpcFail("invalid_params", "query: expected a string");
    if (p.query.trim() !== "") out.query = p.query;
  }
  if (p.kind !== undefined && p.kind !== null) {
    if (typeof p.kind !== "string" || !(LIB_KINDS as readonly string[]).includes(p.kind)) throw new RpcFail("invalid_params", `kind: expected ${LIB_KINDS.join("|")}`);
    out.kind = p.kind as (typeof LIB_KINDS)[number];
  }
  if (p.limit !== undefined && p.limit !== null) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 500) throw new RpcFail("invalid_params", "limit: expected an integer 1..500");
    out.limit = p.limit;
  }
  return out;
}

/** `motor.thrustcurveSearch` params: optional strings and a limit (1..100). */
export function thrustcurveSearchQuery(p: JsonObject): { query?: string; manufacturer?: string; diameter?: string; impulse_class?: string; limit?: number } {
  const out: { query?: string; manufacturer?: string; diameter?: string; impulse_class?: string; limit?: number } = {};
  for (const k of ["query", "manufacturer", "diameter", "impulse_class"] as const) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new RpcFail("invalid_params", `${k}: expected a string`);
    if (v.trim() !== "") out[k] = v.trim();
  }
  if (p.limit !== undefined && p.limit !== null) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100) throw new RpcFail("invalid_params", "limit: expected an integer 1..100");
    out.limit = p.limit;
  }
  return out;
}

/** `motor.thrustcurveFetch` params: a motor id or designation, optional manufacturer, format eng|rse, dry_run. */
export function thrustcurveFetchQuery(p: JsonObject): { motor: string; manufacturer?: string; format?: "eng" | "rse"; dry_run?: boolean } {
  const out: { motor: string; manufacturer?: string; format?: "eng" | "rse"; dry_run?: boolean } = { motor: str(p, "motor") };
  const manufacturer = optStr(p, "manufacturer");
  if (manufacturer !== undefined) out.manufacturer = manufacturer;
  if (p.format !== undefined && p.format !== null) {
    if (p.format !== "eng" && p.format !== "rse") throw new RpcFail("invalid_params", "format: expected eng|rse");
    out.format = p.format;
  }
  if (optBool(p, "dry_run") === true) out.dry_run = true;
  return out;
}

/** `component.remove` params for the sidecar's `component_remove`. */
export function componentRemoveArgs(p: JsonObject): schema.ComponentRemoveIn {
  const out: schema.ComponentRemoveIn = { id: str(p, "id") };
  if (optBool(p, "recursive") === true) out.recursive = true;
  if (optBool(p, "dry_run") === true) out.dry_run = true;
  return out;
}

const IMPORT_KINDS: readonly schema.ImportKind[] = ["ork", "motor"];

/** `import.file` params. `path` may be anywhere: an import only reads it (D18). */
export function importFileArgs(p: JsonObject): schema.ImportFileIn {
  const kind = p.kind;
  if (typeof kind !== "string" || !(IMPORT_KINDS as readonly string[]).includes(kind)) throw new RpcFail("invalid_params", `kind: expected ${IMPORT_KINDS.join("|")}`);
  const out: schema.ImportFileIn = { path: str(p, "path"), kind: kind as schema.ImportKind };
  if (optBool(p, "dry_run") === true) out.dry_run = true;
  return out;
}

const EXPORT_FORMATS: readonly schema.ExportFormat[] = ["ork", "rasp", "glb", "stl", "csv"];

/** `export.file` params; whether this socket may set `allow_outside` is the handler's call. */
export function exportFileArgs(p: JsonObject): schema.ExportFileIn {
  const format = p.format;
  if (typeof format !== "string" || !(EXPORT_FORMATS as readonly string[]).includes(format)) throw new RpcFail("invalid_params", `format: expected ${EXPORT_FORMATS.join("|")}`);
  const out: schema.ExportFileIn = { format: format as schema.ExportFormat, path: str(p, "path") };
  const config = optStr(p, "config");
  if (config !== undefined) out.config = config;
  const run = optStr(p, "run");
  if (run !== undefined) out.run = run;
  if (optBool(p, "allow_outside") === true) out.allow_outside = true;
  return out;
}

const RENDER_VIEWS: readonly schema.View[] = ["profile", "fin", "stations", "anchors", "iso", "top", "side", "front", "rear", "exploded", "section"];
const RENDER_SCHEMES: readonly schema.RenderScheme[] = ["pbr", "check"];

function optDimension(p: JsonObject, key: "width" | "height"): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new RpcFail("invalid_params", `${key}: expected a positive integer`);
  return v;
}

/** `render` params for the sidecar's `render`. */
export function renderArgs(p: JsonObject): schema.RenderIn {
  const view = p.view;
  if (typeof view !== "string" || !(RENDER_VIEWS as readonly string[]).includes(view)) throw new RpcFail("invalid_params", `view: expected ${RENDER_VIEWS.join("|")}`);
  const out: schema.RenderIn = { view: view as schema.View };
  const config = optStr(p, "config");
  if (config !== undefined) out.config = config;
  const compare = optStr(p, "compare");
  if (compare !== undefined) out.compare = compare;
  if (p.explode !== undefined && p.explode !== null) {
    if (typeof p.explode !== "number" || p.explode < 0 || p.explode > 1) throw new RpcFail("invalid_params", "explode: expected a number 0..1");
    out.explode = p.explode;
  }
  const width = optDimension(p, "width");
  if (width !== undefined) out.width = width;
  const height = optDimension(p, "height");
  if (height !== undefined) out.height = height;
  if (p.scheme !== undefined && p.scheme !== null) {
    if (typeof p.scheme !== "string" || !(RENDER_SCHEMES as readonly string[]).includes(p.scheme)) throw new RpcFail("invalid_params", `scheme: expected ${RENDER_SCHEMES.join("|")}`);
    out.scheme = p.scheme as schema.RenderScheme;
  }
  return out;
}

/** `motor.search` params: blanks are ignored; quantities are unit strings (or `0`), as in `rw motor search`. */
export function motorSearchArgs(p: JsonObject): schema.MotorSearchIn {
  const out: schema.MotorSearchIn = {};
  for (const k of ["query", "class"] as const) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new RpcFail("invalid_params", `${k}: expected a string`);
    if (v.trim() !== "") out[k] = v.trim();
  }
  for (const k of ["diameter", "min_impulse", "max_impulse"] as const) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (v !== 0 && typeof v !== "string") throw new RpcFail("invalid_params", `${k}: expected a quantity string`);
    if (v === 0) out[k] = 0;
    else if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  if (p.limit !== undefined && p.limit !== null) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > 500) throw new RpcFail("invalid_params", "limit: expected an integer 1..500");
    out.limit = p.limit;
  }
  return out;
}
