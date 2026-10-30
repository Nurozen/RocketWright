/**
 * Where the assembly GLB comes from. Preferred: rw-wasm meshes the evaluated
 * model in the renderer (IF9 `mesh_glb`, M1.32; a pure function of the
 * mirror, I4; D5: committed model and draft previews alike). When the wasm
 * pkg cannot load or rejects the model, the viewport falls back to the
 * contract-fixture GLB (`public/fixtures/contract-vehicle.glb`, written by
 * rw-geom from `fixtures/contracts/evaluated-model.json`; regenerate with
 * `scripts/fixture-glb`). The source is surfaced in the DOM so a capture can
 * never pass a fixture off as the live model.
 */
import type { EvaluatedModel } from "@rw/contracts";

export type GlbSource = "rw-wasm" | "contract-fixture";

/** rw-geom `MeshOptions`. */
export interface MeshOptions {
  radial_segments: number;
  explode: number;
  internals: boolean;
  /** Cut components as tagged cutter nodes (`extras.rw_cut`); `cuts.ts` subtracts them after parsing. */
  cutters: boolean;
}

/** The `@rw/rw-wasm` method this module feature-detects (M1.32). */
export interface ModelMesher {
  meshModelGlb(evaluated: EvaluatedModel, opts: MeshOptions): Uint8Array;
}

export interface LoadedGlb {
  bytes: Uint8Array;
  source: GlbSource;
}

export const MESH_OPTIONS: MeshOptions = { radial_segments: 64, explode: 0, internals: true, cutters: true };

/** Path of the fixture under the web root. */
export const FIXTURE_GLB_PATH = "fixtures/contract-vehicle.glb";

export interface GlbDeps {
  loadWasm: () => Promise<unknown>;
  fetchFixture: () => Promise<Uint8Array>;
}

function isMesher(v: unknown): v is ModelMesher {
  return v !== null && typeof v === "object" && typeof (v as Partial<ModelMesher>).meshModelGlb === "function";
}

/** Meshes `evaluated` with rw-wasm when it can, else loads the contract fixture. Never throws for a missing wasm. */
export async function loadAssemblyGlb(evaluated: EvaluatedModel | null, deps: GlbDeps): Promise<LoadedGlb> {
  if (evaluated !== null) {
    try {
      const rw = await deps.loadWasm();
      if (isMesher(rw)) return { bytes: rw.meshModelGlb(evaluated, MESH_OPTIONS), source: "rw-wasm" };
    } catch {
      // Fall through to the fixture: the wasm pkg is optional for the viewport.
    }
  }
  return { bytes: await deps.fetchFixture(), source: "contract-fixture" };
}

/** Browser defaults: `@rw/rw-wasm`, and the fixture beside the bundle (http, never file://). */
export function browserGlbDeps(base: string): GlbDeps {
  return {
    loadWasm: async () => {
      const { loadRwWasm } = await import("@rw/rw-wasm");
      return loadRwWasm();
    },
    fetchFixture: async () => {
      const res = await fetch(new URL(FIXTURE_GLB_PATH, new URL(base, window.location.href)));
      if (!res.ok) throw new Error(`fixture GLB: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** `asset.extras.model_hash` from a GLB's JSON chunk, or null. */
export function glbModelHash(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return null;
  const len = view.getUint32(12, true);
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as { asset?: { extras?: { model_hash?: unknown } } };
    const h = doc.asset?.extras?.model_hash;
    return typeof h === "string" ? h : null;
  } catch {
    return null;
  }
}
