/**
 * TypeScript wrapper over the rw-wasm wasm-bindgen package (IF9: JSON strings
 * in and out, GLB as Uint8Array, no tsify). `pkg/` is built by `make wasm`.
 *
 * Every export is a pure function of the sidecar state plus a draft (I4):
 * `evalModel` and `applyAndEval` take the `files` of `rw://project/files`,
 * the others take an `EvaluatedModel` (the mirror's `evaluated`). Errors from
 * the core (`{"error": ApiError}`) are thrown as {@link RwWasmError}.
 */
// Contract types by path: the package takes no workspace dependency (SRV owns the lock).
import type { CheckReport, EvaluatedModel, PatchOp } from "../../contracts/src/types.ts";
import type { ThrustCurve } from "../../contracts/src/generated/types.ts";
import init, { apply_and_eval, check_static, core_version, eval_model, mesh_glb, motor_library, profile_svg, thermo_lookup } from "../pkg/rw_wasm.js";
import type { InitInput } from "../pkg/rw_wasm.js";

export const PACKAGE_NAME = "@rw/rw-wasm";

/** Project-relative path → source text (`rw://project/files` `files`). */
export type SourceFiles = Readonly<Record<string, string | undefined>>;

/** rw-geom `MeshOptions` (all optional; defaults 64 segments, explode 0, internals on). */
export interface MeshOptions {
  radial_segments?: number;
  /** 0..1 along each part's explode direction (`extras.rw_explode`). */
  explode?: number;
  internals?: boolean;
  /** Also write cut components as cutter nodes (`extras.rw_cut`, `rw_cut_parent`) for the renderer to subtract. */
  cutters?: boolean;
}

/** `rw-draw` options; `view` defaults to the side profile. */
export interface DrawOptions {
  view?: "profile" | "fin" | "stations" | "anchors";
  width?: number;
  internals?: boolean;
}

/** `motor_library` filters (SI; all optional). */
export interface MotorLibraryQuery {
  /** Case-insensitive substring of the designation or manufacturer. */
  query?: string;
  /** Impulse class letter. */
  class?: string;
  /** Motor diameter (m), matched within 0.5 mm. */
  diameter?: number;
}

/** `apply_and_eval` output: the draft model and its static check. */
export interface DraftEval {
  evaluated: EvaluatedModel;
  check: CheckReport;
}

/** The shipped propellant tables (`data/thermo/<pair>.rwtbl`, copied to `pkg/thermo/` by `make wasm`). */
export const THERMO_PAIRS = ["lox-ethanol", "lox-rp1", "lox-ch4", "lox-ipa", "n2o-ethanol", "n2o-ipa"] as const;
export type ThermoPair = (typeof THERMO_PAIRS)[number];

/** `thermo_lookup` query (SI): `pc` in Pa, `eps` = Ae/At; ids are checked against the table. */
export interface ThermoQuery {
  oxidizer?: string;
  fuel?: string;
  of: number;
  pc: number;
  /** Omit for chamber conditions only. */
  eps?: number;
  /** Frozen (at the chamber) instead of shifting-equilibrium flow. */
  frozen?: boolean;
}

/** `rw_thermo::Chamber` (SI: K, kg/mol, J/(kg K), m/s, kg/m^3, Pa). */
export interface ThermoChamber {
  t_c: number;
  molar_mass_c: number;
  gamma_c: number;
  cp_c: number;
  c_star: number;
  rho_c: number;
  t_t: number;
  p_t: number;
  gamma_t: number;
}

/** `rw_thermo::Nozzle` (SI; `isp` at ambient = exit pressure, m/s). */
export interface ThermoNozzle {
  eps: number;
  pc_pe: number;
  t_e: number;
  gamma_e: number;
  mach_e: number;
  isp: number;
  isp_vac: number;
  cf: number;
  cf_vac: number;
}

/** `rw_thermo::Performance`, the `thermo_lookup` payload. */
export interface ThermoPerformance {
  mode: "equilibrium" | "frozen";
  of: number;
  pc: number;
  chamber: ThermoChamber;
  nozzle: ThermoNozzle | null;
}

/**
 * Where a pair's table lives: beside the wasm in the local bundle (`pkg/thermo/`), never a network URL (D19d, I10).
 * Resolves against this package's `pkg/` so it follows the module wherever the app serves it.
 */
export function thermoTableUrl(pair: ThermoPair): URL {
  return new URL(`../pkg/thermo/${pair}.rwtbl`, import.meta.url);
}

/** The core's `ApiError` (rw-api), thrown by every JSON export. */
export class RwWasmError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly diagnostics: readonly unknown[];
  constructor(e: { code?: string; message?: string; hint?: string; diagnostics?: unknown[] }) {
    super(e.message ?? "rw-wasm error");
    this.name = "RwWasmError";
    this.code = e.code ?? "internal";
    this.hint = e.hint;
    this.diagnostics = e.diagnostics ?? [];
  }
}

export interface RwWasm {
  coreVersion(): string;
  /** `eval_model`: the evaluated model of the sources (default config). */
  evalModel(files: SourceFiles): EvaluatedModel;
  /** `apply_and_eval`: a draft preview (ops applied, evaluated, checked). */
  applyAndEval(req: { files: SourceFiles; ops: readonly PatchOp[] }): DraftEval;
  /** `check_static`: the static check (inputs list only the mounted motors). */
  checkStatic(evaluated: EvaluatedModel): CheckReport;
  /** `mesh_glb`: binary glTF, node name = component id, instances `<id>/<n>`. */
  meshModelGlb(evaluated: EvaluatedModel, opts?: MeshOptions): Uint8Array;
  /** `profile_svg`: the `rw render --view profile` SVG (CG/CP markers from `check`). */
  profileSvg(evaluated: EvaluatedModel, check: CheckReport | null, opts?: DrawOptions): string;
  /** `motor_library`: the built-in generic motors with their thrust curves (smallest impulse first). */
  motorLibrary(query?: MotorLibraryQuery): ThrustCurve[];
  /** `thermo_lookup`: interpolates a `.rwtbl` table (bytes of {@link thermoTableUrl}). */
  thermoLookup(table: Uint8Array, query: ThermoQuery): ThermoPerformance;
}

/** Unwraps a `{"ok"}`/`{"error"}` envelope. */
export function unwrap<T>(json: string): T {
  const v = JSON.parse(json) as { ok?: T; error?: ConstructorParameters<typeof RwWasmError>[0] };
  if (v.error !== undefined) throw new RwWasmError(v.error);
  return v.ok as T;
}

const api: RwWasm = {
  coreVersion: () => core_version(),
  evalModel: (files) => unwrap<EvaluatedModel>(eval_model(JSON.stringify(files))),
  applyAndEval: ({ files, ops }) => unwrap<DraftEval>(apply_and_eval(JSON.stringify(files), JSON.stringify(ops))),
  checkStatic: (evaluated) => unwrap<CheckReport>(check_static(JSON.stringify(evaluated))),
  meshModelGlb: (evaluated, opts = {}) => mesh_glb(JSON.stringify(evaluated), JSON.stringify(opts)),
  profileSvg: (evaluated, check, opts = {}) => unwrap<string>(profile_svg(JSON.stringify(evaluated), JSON.stringify(check), JSON.stringify(opts))),
  motorLibrary: (query = {}) => unwrap<ThrustCurve[]>(motor_library(JSON.stringify(query))),
  thermoLookup: (table, query) => unwrap<ThermoPerformance>(thermo_lookup(table, JSON.stringify(query))),
};

let loading: Promise<RwWasm> | undefined;

/**
 * Instantiates the module once. In a browser the default fetches
 * `rw_wasm_bg.wasm` beside the glue (serve over http, never file://);
 * Node callers pass the bytes.
 */
export function loadRwWasm(source?: InitInput): Promise<RwWasm> {
  loading ??= init(source === undefined ? undefined : { module_or_path: source }).then(() => api);
  return loading;
}

/** True when `bytes` starts with the GLB magic `glTF` and a matching length. */
export function isGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === 0x46546c67 && view.getUint32(8, true) === bytes.byteLength;
}

/** The JSON chunk of a GLB (glTF document), or null. */
export function glbJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (!isGlb(bytes) || bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(12, true);
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as Record<string, unknown>;
  } catch {
    return null;
  }
}
