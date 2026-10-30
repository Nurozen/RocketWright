/** Runtime checks for IF10 request params (the wire is untrusted JSON). */
import type { JsonObject, PageId, PatchOp } from "@rw/contracts";
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
