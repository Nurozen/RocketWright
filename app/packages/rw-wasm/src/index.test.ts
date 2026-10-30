/**
 * M1.32: the wasm32 build, run in Node, equals the native sidecar's JSON on
 * `fixtures/research-vehicle` (I4). Native answers come from the real CLI
 * (`rocketwright call … model_get|design_check|model_patch`) on temp copies.
 * Requires `make wasm` (make check-fast runs it before pnpm test). The CLI is
 * `$RW_SIDECAR_BIN` (`make check-ts` prebuilds it once); without it, one
 * `cargo build` in `beforeAll`, never a `cargo run` per call (concurrent
 * suites made those fail with no stderr).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckReport, EvaluatedModel, PatchOp } from "../../contracts/src/types.ts";
import { glbJson, isGlb, loadRwWasm, PACKAGE_NAME, RwWasmError } from "./index.ts";
import type { RwWasm, SourceFiles } from "./index.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE = join(ROOT, "fixtures/research-vehicle");
const CARGO = process.env.CARGO ?? (existsSync(join(homedir(), ".cargo/bin/cargo")) ? join(homedir(), ".cargo/bin/cargo") : "cargo");

/**
 * The `rocketwright` binary: `$RW_SIDECAR_BIN`, else one debug build with `doubles` (the same artifact the server
 * tests use, so neither rebuild clobbers the other; the Session answers these tools for real).
 */
function sidecarBin(): string {
  const pre = process.env.RW_SIDECAR_BIN;
  if (pre !== undefined && pre !== "") return pre;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(CARGO, ["build", "-q", "--manifest-path", join(ROOT, "Cargo.toml"), "-p", "rw-cli", "--features", "doubles", "--bin", "rocketwright"], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const meta = JSON.parse(execFileSync(CARGO, ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", join(ROOT, "Cargo.toml")], { env, encoding: "utf8" })) as {
    target_directory: string;
  };
  return join(meta.target_directory, "debug", "rocketwright");
}

let bin = "";

const tmps: string[] = [];
function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rw-wasm-"));
  tmps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** The CLI's JSON answer for one tool call (in-process Session on `project`). */
function native<T>(project: string, tool: string, args: unknown = {}): T {
  try {
    const out = execFileSync(bin, ["call", "--project", project, tool, JSON.stringify(args)], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RW_OFFLINE: "1" },
    });
    return JSON.parse(out) as T;
  } catch (e) {
    const x = e as { status?: number | null; signal?: string | null; stderr?: string; stdout?: string };
    throw new Error(`${bin} call ${tool}: exit ${String(x.status)} signal ${String(x.signal)}\n${x.stderr ?? ""}${String(x.stdout ?? "").slice(0, 2000)}`, { cause: e });
  }
}

/** Source texts the way the sidecar serves them (`rw://project/files`). */
function sourceFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/(^rocketwright\.toml|\.rw\.(toml|json))$/.test(name)) out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const withoutInputs = (r: CheckReport) => ({ ...r, inputs: {} });

let rw: RwWasm;
let files: SourceFiles;
let nativeModel: EvaluatedModel;
let nativeCheck: CheckReport;

beforeAll(async () => {
  rw = await loadRwWasm(readFileSync(new URL("../pkg/rw_wasm_bg.wasm", import.meta.url)));
  bin = sidecarBin();
  const dir = copyFixture();
  files = sourceFiles(dir);
  nativeModel = native<{ model: EvaluatedModel }>(dir, "model_get").model;
  nativeCheck = native<CheckReport>(dir, "design_check");
}, 900_000);

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("@rw/rw-wasm", () => {
  it("exports its package name and the core version", () => {
    expect(PACKAGE_NAME).toBe("@rw/rw-wasm");
    expect(rw.coreVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("eval_model equals the native evaluated model", () => {
    const m = rw.evalModel(files);
    expect(m.components.length).toBe(14);
    expect(m).toEqual(nativeModel);
    expect(m.model_hash).toBe(nativeModel.model_hash);
  });

  it("apply_and_eval with no ops equals native model and check", () => {
    const d = rw.applyAndEval({ files, ops: [] });
    expect(d.evaluated).toEqual(nativeModel);
    expect(d.check).toEqual(nativeCheck);
  });

  it("check_static equals the native check (inputs aside)", () => {
    expect(withoutInputs(rw.checkStatic(nativeModel))).toEqual(withoutInputs(nativeCheck));
  });

  it("a draft preview equals the model the sidecar commits (I4)", () => {
    const ops: PatchOp[] = [
      { op: "replace", path: "/params/fin_span/value", value: "100 mm" },
      { op: "replace", path: "/c/airframe/length", value: "320 mm" },
    ];
    const preview = rw.applyAndEval({ files, ops });
    const dir = copyFixture();
    native(dir, "model_patch", { ops });
    const committed = native<{ model: EvaluatedModel }>(dir, "model_get").model;
    expect(preview.evaluated).toEqual(committed);
    expect(preview.evaluated.model_hash).not.toBe(nativeModel.model_hash);
    expect(withoutInputs(preview.check)).toEqual(withoutInputs(native<CheckReport>(dir, "design_check")));
  }, 60_000);

  it("mesh_glb: one root node per component id, instances, explode dirs", () => {
    const glb = rw.meshModelGlb(nativeModel, { radial_segments: 32 });
    expect(isGlb(glb)).toBe(true);
    const doc = glbJson(glb) as { scenes: { nodes: number[] }[]; nodes: { name: string; children?: number[]; extras?: Record<string, unknown> }[] };
    const roots = doc.scenes[0]!.nodes.map((i) => doc.nodes[i]!);
    expect(roots.map((n) => n.name)).toEqual(nativeModel.components.map((c) => c.id));
    for (const n of roots) expect(n.extras?.["rw_explode"]).toHaveLength(3);
    expect(roots.find((n) => n.name === "fins")?.children).toHaveLength(4);
    expect(rw.meshModelGlb(nativeModel, { radial_segments: 32 })).toEqual(glb);
  }, 30_000); // meshes the model twice; 5 s timed out on a loaded machine

  it("profile_svg draws the profile with CG/CP markers", () => {
    const svg = rw.profileSvg(nativeModel, nativeCheck);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(rw.profileSvg(nativeModel, null, { view: "fin", width: 600 })).toMatch(/^<svg/);
  });

  it("motor_library lists the generic motors with curves, filtered like rw motor search", () => {
    const all = rw.motorLibrary();
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const m of all) expect(m.points.length).toBeGreaterThan(2);
    expect(all.map((m) => m.total_impulse)).toEqual([...all.map((m) => m.total_impulse)].sort((a, b) => a - b));
    expect(rw.motorLibrary({ query: "c6" }).map((m) => m.designation)).toEqual(["RW_C6G"]);
    expect(rw.motorLibrary({ diameter: 0.018 }).every((m) => Math.abs(m.diameter - 0.018) < 1e-6)).toBe(true);
  });

  it("throws the core's ApiError", () => {
    expect(() => rw.evalModel({ "rocket.rw.toml": "[c.x\n" })).toThrow(RwWasmError);
    expect(() => rw.applyAndEval({ files, ops: [{ op: "replace", path: "/c/nope/length", value: 1 }] })).toThrow(/op 0/);
    expect(() => rw.meshModelGlb({} as EvaluatedModel)).toThrow();
  });
});
