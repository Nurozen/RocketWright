/**
 * The seeded research vehicle (plan M1.55, D10a): runs
 * `fixtures/research-vehicle/seed.sh` (real `rw` commands under `RW_CLOCK`)
 * and checks the result against `seed.expected.json`: step titles, count,
 * origins and times, the revision, run statuses, and the hash relationships
 * (each Complete run is on the current model, the Outdated one is not, and
 * each run's model is the one its expected step recorded). No physics numbers
 * are compared.
 *
 * Usage: `node scripts/fixtures/seed.ts [--check] <dest>` (`make seed-fixture
 * DEST=<dir>`). Without `--check` it seeds `<dest>` first. The binary is
 * `$RW`, else `$RW_SIDECAR_BIN`, else `rocketwright` on PATH.
 * The e2e specs and bar captures import `seedProject`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_DIR = join(REPO_ROOT, "fixtures/research-vehicle");
export const SEED_SCRIPT = join(FIXTURE_DIR, "seed.sh");
export const SEED_EXPECTED = join(FIXTURE_DIR, "seed.expected.json");

export interface ExpectedStep {
  seq: number;
  title: string;
  origin: string;
  ts: string;
  rev?: string;
}

export interface ExpectedRun {
  status: "complete" | "outdated" | "not_run";
  /** The step whose model the run was flown on. */
  model_step?: number;
  started?: string;
}

export interface SeedExpected {
  description: string;
  steps: ExpectedStep[];
  revisions: { number: number; name: string; step: number }[];
  runs: Record<string, ExpectedRun>;
}

interface Step {
  seq: number;
  title: string;
  origin: string;
  ts: string;
  rev?: string | null;
  model_hash: string;
}

interface RunEntry {
  sim: string;
  status: string;
  run_id?: string | null;
  model_hash?: string | null;
}

export function loadExpected(path = SEED_EXPECTED): SeedExpected {
  return JSON.parse(readFileSync(path, "utf8")) as SeedExpected;
}

/** The `rocketwright` binary to seed with. */
export function rwBinary(): string {
  return process.env["RW"] || process.env["RW_SIDECAR_BIN"] || "rocketwright";
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  return env;
}

/** Runs seed.sh into `dest` (missing or empty). Throws with its output on failure. */
export function seedProject(dest: string, rw = rwBinary()): void {
  const r = spawnSync("bash", [SEED_SCRIPT, dest], { env: { ...childEnv(), RW: rw }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seed.sh ${dest} failed (exit ${String(r.status)})\n${r.stdout}\n${r.stderr}`);
}

function rwJson(rw: string, dir: string, args: string[]): unknown {
  return JSON.parse(execFileSync(rw, ["-C", dir, "--json", ...args], { env: { ...childEnv(), RW_OFFLINE: "1" }, encoding: "utf8" }));
}

/** Differences between the seeded project at `dir` and `expected` (empty: it matches). */
export function checkSeed(dir: string, rw = rwBinary(), expected = loadExpected()): string[] {
  const errors: string[] = [];
  const log = rwJson(rw, dir, ["history", "log"]) as { steps: Step[]; revisions: { number: number; name: string; step: number }[] };
  const runs = rwJson(rw, dir, ["call", "run_list", "{}"]) as { model_hash: string; runs: RunEntry[] };

  if (log.steps.length !== expected.steps.length) errors.push(`steps: ${log.steps.length}, want ${expected.steps.length}`);
  for (const want of expected.steps) {
    const got = log.steps.find((s) => s.seq === want.seq);
    if (got === undefined) {
      errors.push(`step ${want.seq}: missing`);
      continue;
    }
    for (const k of ["title", "origin", "ts"] as const) {
      if (got[k] !== want[k]) errors.push(`step ${want.seq} ${k}: ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
    }
    if ((got.rev ?? null) !== (want.rev ?? null)) errors.push(`step ${want.seq} rev: ${JSON.stringify(got.rev ?? null)}, want ${JSON.stringify(want.rev ?? null)}`);
  }
  const revs = log.revisions.map(({ number, name, step }) => ({ number, name, step }));
  if (JSON.stringify(revs) !== JSON.stringify(expected.revisions)) errors.push(`revisions: ${JSON.stringify(revs)}, want ${JSON.stringify(expected.revisions)}`);

  const head = log.steps[log.steps.length - 1];
  if (head !== undefined && head.model_hash !== runs.model_hash) errors.push("the current model is not the last step's model");
  const sims = runs.runs.map((r) => r.sim).sort();
  const wantSims = Object.keys(expected.runs).sort();
  if (JSON.stringify(sims) !== JSON.stringify(wantSims)) errors.push(`runs: ${sims.join(",")}, want ${wantSims.join(",")}`);
  for (const [sim, want] of Object.entries(expected.runs)) {
    const got = runs.runs.find((r) => r.sim === sim);
    if (got === undefined) continue;
    if (got.status !== want.status) errors.push(`run ${sim}: ${got.status}, want ${want.status}`);
    if (want.status === "not_run") {
      if (got.run_id) errors.push(`run ${sim}: has run ${got.run_id}, want none`);
      continue;
    }
    const hash = got.model_hash ?? "";
    const current = hash === runs.model_hash;
    if (want.status === "complete" && !current) errors.push(`run ${sim}: Complete but its model_hash is not the current one`);
    if (want.status === "outdated" && current) errors.push(`run ${sim}: Outdated but its model_hash equals the current one`);
    const step = log.steps.find((s) => s.seq === want.model_step);
    if (want.model_step !== undefined && step?.model_hash !== hash) errors.push(`run ${sim}: not flown on step ${want.model_step}'s model`);
    if (want.started !== undefined && got.run_id) {
      const manifest = JSON.parse(readFileSync(join(dir, "runs", sim, got.run_id, "manifest.json"), "utf8")) as { started?: string };
      if (manifest.started !== want.started) errors.push(`run ${sim} started: ${String(manifest.started)}, want ${want.started}`);
    }
  }
  return errors;
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const dest = argv.filter((a) => a !== "--check")[0];
  if (dest === undefined) {
    console.error("usage: node scripts/fixtures/seed.ts [--check] <dest>");
    return 2;
  }
  if (!check) seedProject(dest);
  const errors = checkSeed(dest);
  if (errors.length > 0) {
    console.error(`seed check failed for ${dest}:\n  ${errors.join("\n  ")}`);
    return 1;
  }
  const e = loadExpected();
  console.log(`seed ok: ${dest} (${e.steps.length} steps, Rev ${String(e.revisions[0]?.number).padStart(2, "0")}, runs ${Object.entries(e.runs).map(([s, r]) => `${s}=${r.status}`).join(" ")})`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
