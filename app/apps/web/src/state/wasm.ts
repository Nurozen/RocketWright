/**
 * WASM loader with a version handshake (D19c, I4). The renderer uses rw-wasm
 * for live previews of a draft (and meshes the committed model, D5); a
 * preview is a pure function of the sidecar state, so it is valid only when
 * the wasm core and the sidecar are the same build. On a mismatch the draft falls back to sidecar dry runs and
 * the UI says why; it never shows a preview from a different core.
 */
import type { CheckReport, EvaluatedModel, PatchOp, ProjectFiles } from "@rw/contracts";

/** The preview surface the draft slice needs from rw-wasm (IF9 via `@rw/rw-wasm`). */
export interface PreviewCore {
  coreVersion(): string;
  /**
   * Applies `ops` to the project sources and evaluates (M1.32 `apply_and_eval`).
   * Optional so a core without it previews through sidecar dry runs only.
   */
  applyAndEval?(req: { files: ProjectFiles["files"]; ops: readonly PatchOp[] }): EvaluatedModel;
  /** The same draft with its static check (live CG/CP while editing, M2.9); optional for older cores. */
  applyAndCheck?(req: { files: ProjectFiles["files"]; ops: readonly PatchOp[] }): { evaluated: EvaluatedModel; check: CheckReport };
}

export type WasmStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; coreVersion: string; preview: boolean }
  | { state: "mismatch"; wasmVersion: string; serverVersion: string }
  | { state: "failed"; error: string };

export interface WasmHandle {
  status: WasmStatus;
  /** Set only when `status.state === "ready"`. */
  core: PreviewCore | null;
}

/** Exact equality: the preview must equal the sidecar's evaluation (I4). */
export function versionsMatch(wasmVersion: string, serverVersion: string): boolean {
  return wasmVersion.trim() !== "" && wasmVersion === serverVersion;
}

/** Re-checks an already loaded core against a (possibly restarted) sidecar's version. */
export function handshake(core: PreviewCore, serverVersion: string): WasmHandle {
  const wasmVersion = core.coreVersion();
  if (!versionsMatch(wasmVersion, serverVersion)) return { status: { state: "mismatch", wasmVersion, serverVersion }, core: null };
  return { status: { state: "ready", coreVersion: wasmVersion, preview: typeof core.applyAndEval === "function" }, core };
}

/**
 * Loads the core with `load` (default: `@rw/rw-wasm`, fetched beside the
 * bundle over http, never file://) and handshakes against `serverVersion`
 * (the RPC hello `coreVersion`). Never throws: failures become a status.
 */
export async function loadWasm(serverVersion: string, load: () => Promise<PreviewCore> = loadDefaultCore): Promise<WasmHandle> {
  let core: PreviewCore;
  try {
    core = await load();
  } catch (e) {
    return { status: { state: "failed", error: e instanceof Error ? e.message : String(e) }, core: null };
  }
  try {
    return handshake(core, serverVersion);
  } catch (e) {
    return { status: { state: "failed", error: e instanceof Error ? e.message : String(e) }, core: null };
  }
}

/** `@rw/rw-wasm`, imported lazily so the shell renders before the module arrives. */
export async function loadDefaultCore(): Promise<PreviewCore> {
  const { loadRwWasm } = await import("@rw/rw-wasm");
  return fromRwWasm(await loadRwWasm());
}

/**
 * Adapts the `@rw/rw-wasm` wrapper (M1.32): the draft preview is the
 * `evaluated` half of `apply_and_eval` (the sidecar's dry run supplies the delta).
 */
export function fromRwWasm(rw: {
  coreVersion(): string;
  applyAndEval?: (req: { files: ProjectFiles["files"]; ops: readonly PatchOp[] }) => { evaluated: EvaluatedModel; check?: CheckReport };
}): PreviewCore {
  const core: PreviewCore = { coreVersion: () => rw.coreVersion() };
  if (typeof rw.applyAndEval === "function") {
    const apply = rw.applyAndEval.bind(rw);
    core.applyAndEval = (req) => apply(req).evaluated;
    core.applyAndCheck = (req) => {
      const d = apply(req);
      if (d.check === undefined) throw new Error("this core's apply_and_eval returns no check");
      return { evaluated: d.evaluated, check: d.check };
    };
  }
  return core;
}
