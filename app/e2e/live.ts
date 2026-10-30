/**
 * The seeded live project for the e2e specs and bar captures (plan M1.53b,
 * M1.55): the `rocketwright` sidecar binary, and copies of the research
 * vehicle seeded by `fixtures/research-vehicle/seed.sh` (real history and
 * runs; no contract JSON).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { seedProject } from "../../scripts/fixtures/seed.ts";
import { REPO_ROOT } from "./bar/paths.ts";

/** The project folder name; the server names the project after it ("Research vehicle" in the header). */
export const PROJECT_NAME = "Research vehicle";

/**
 * Where seeded copies go: `/tmp`, not macOS's long `$TMPDIR`, so
 * `<project>/.rw/sidecar.sock` stays under the 104-byte socket path limit
 * (the CLI forwards to the live owner over it).
 */
export const SCRATCH = process.platform === "win32" ? tmpdir() : "/tmp";

/** Set by the Playwright global setup: a pristine seeded project that specs copy. */
export const SEEDED_ENV = "RW_E2E_SEEDED";

function cargo(): string {
  const local = join(homedir(), ".cargo/bin/cargo");
  return existsSync(local) ? local : "cargo";
}

/**
 * `rocketwright` for the live specs: `$RW_SIDECAR_BIN` when set, else a debug
 * build with the `doubles` feature (the same artifact the server tests build,
 * so the two do not rebuild each other; a real project always gets the real
 * Session).
 */
export function sidecarBinary(): string {
  const pre = process.env["RW_SIDECAR_BIN"];
  if (pre !== undefined && pre !== "") return pre;
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  execFileSync(cargo(), ["build", "-q", "-p", "rw-cli", "--features", "doubles", "--bin", "rocketwright"], { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
  const meta = JSON.parse(execFileSync(cargo(), ["metadata", "--no-deps", "--format-version", "1"], { cwd: REPO_ROOT, env, encoding: "utf8" })) as { target_directory: string };
  return join(meta.target_directory, "debug", "rocketwright");
}

/** Seeds `<new temp dir>/Research vehicle` and returns its path. */
export function seedTemp(rw: string, prefix = "rw-seeded-"): string {
  const dir = join(mkdtempSync(join(SCRATCH, prefix)), PROJECT_NAME);
  seedProject(dir, rw);
  return dir;
}

/**
 * A fresh copy of the seeded project as `<new temp dir>/Research vehicle`:
 * from `$RW_E2E_SEEDED` when the global setup made one, else seeded now.
 * Returns the project dir; remove its parent when done.
 */
export function seededCopy(rw: string, prefix = "rw-live-"): string {
  const pristine = process.env[SEEDED_ENV];
  if (pristine === undefined || pristine === "" || !existsSync(pristine)) return seedTemp(rw, prefix);
  const dir = join(mkdtempSync(join(SCRATCH, prefix)), PROJECT_NAME);
  mkdirSync(dir, { recursive: true });
  cpSync(pristine, dir, { recursive: true });
  return dir;
}
