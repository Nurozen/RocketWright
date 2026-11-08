/**
 * What the B1 comparator expects: the evaluated fixture. Read before any
 * launch from a temp copy, so the fixture directory itself stays untouched
 * (a CLI run on it would create `.rw/`). For the comparator only: the drive
 * types the words and values in `case1-script.ts`, never anything from here.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CheckReport, EvaluatedModel, ModelGetOut } from "../packages/contracts/src/generated/index.ts";
import { FIXTURE_DIR } from "./case1-script.ts";
import { SCRATCH } from "./live.ts";

export interface Case1Plan {
  model: EvaluatedModel;
  /** Dry mass, kg (`rw check --json` `mass.dry`). */
  dryMass: number;
}

/** A clean environment for reads: offline, and no test hooks a bar-only caller set. */
export function readEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RW_OFFLINE: "1" };
  delete env["RW_TEST_HOOKS"];
  return env;
}

function runJson<T>(bin: string, project: string, args: readonly string[]): T {
  return JSON.parse(execFileSync(bin, ["-C", project, ...args], { encoding: "utf8", env: readEnv(), maxBuffer: 64 * 1024 * 1024 })) as T;
}

/** Evaluates a temp copy of `source` (the fixture by default) and removes the copy. */
export function loadCase1Plan(bin: string, source: string = FIXTURE_DIR): Case1Plan {
  const parent = mkdtempSync(join(SCRATCH, "rw-case1-plan-"));
  const project = join(parent, "p");
  try {
    cpSync(source, project, { recursive: true });
    const got = runJson<ModelGetOut>(bin, project, ["call", "model_get"]);
    if (got.model == null) throw new Error("model_get returned no model");
    const check = runJson<CheckReport>(bin, project, ["check", "--json"]);
    return { model: got.model, dryMass: check.mass.dry };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
