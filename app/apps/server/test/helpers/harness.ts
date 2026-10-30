/**
 * Shared helpers for the server tests: the real `rocketwright mcp` sidecar
 * (built with `doubles`; a seeded project runs the real Session), temp
 * projects, contract fixtures, and the app-only tool list. (B17 removed
 * the old chat's HTTP MCP harness and its mock Anthropic API.)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function cargo(): string {
  const local = join(homedir(), ".cargo/bin/cargo");
  return existsSync(local) ? local : "cargo";
}

let built: string | undefined;

/** Builds `rocketwright` with doubles (once per process) and returns its path; `RW_SIDECAR_BIN` overrides. */
export function sidecarBin(): string {
  const prebuilt = process.env.RW_SIDECAR_BIN;
  if (prebuilt !== undefined && prebuilt !== "") return prebuilt;
  if (built !== undefined) return built;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(cargo(), ["build", "-q", "-p", "rw-cli", "--features", "doubles", "--bin", "rocketwright"], {
    cwd: REPO,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const meta = JSON.parse(
    execFileSync(cargo(), ["metadata", "--no-deps", "--format-version", "1"], { cwd: REPO, env, encoding: "utf8" }),
  ) as { target_directory: string };
  built = join(meta.target_directory, "debug", "rocketwright");
  return built;
}

export type JsonObj = Record<string, unknown>;

/** A `fixtures/contracts/<rel>` payload. */
export function fixture(rel: string): JsonObj {
  const doc = JSON.parse(readFileSync(join(REPO, "fixtures/contracts", rel), "utf8")) as { payload: JsonObj };
  return doc.payload;
}

/**
 * The sidecar's app-only tools (`_meta.ui.visibility: ["app"]`, B3), listed
 * after the registry's: MCP Apps cards call them, hosts hide them from the
 * model, and they have no published schema file.
 */
export const APP_ONLY_TOOLS = ["run_series", "render_picture"] as const;

/** True when a tool's `_meta.ui.visibility` hides it from the model. */
export function appOnly(t: { _meta?: Record<string, unknown> | undefined }): boolean {
  const ui = t._meta?.ui as { visibility?: unknown } | undefined;
  return Array.isArray(ui?.visibility) && !ui.visibility.includes("model");
}

/**
 * A fresh temp project (short path: Unix socket limit). With `seed` (a
 * repo-relative project such as `fixtures/simple`), the copy has
 * `rocketwright.toml`, so the sidecar opens a real `rw_project::Session`;
 * without it the directory is empty and the sidecar answers from doubles.
 */
export function tempProject(prefix: string, seed?: string): string {
  const dir = mkdtempSync(`/tmp/${prefix}-`);
  if (seed !== undefined) cpSync(join(REPO, seed), dir, { recursive: true });
  return dir;
}
