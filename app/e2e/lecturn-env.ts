/**
 * Lecturn state for one desktop run under test (plan conventions, B13):
 * `LECTURN_HOME` and `RW_LECTURN_BASE_DIR` in temp dirs, so nothing touches
 * `~/.lecturn`, and the Lecturn sidecar's state outlives the run's fresh
 * temp `userData` (`apps/desktop/src/main.ts`) only as long as the caller
 * wants it.
 *
 * - `fresh: false` (default) keeps a pair the caller's environment already
 *   names (`make e2e` sets one per run), else makes one.
 * - `fresh: true` always makes one (the bar: each page is its own sidecar).
 * - `scripted: true` also enables Lecturn's scripted test provider in that
 *   sidecar: `LECTURN_TEST_PROVIDERS=1`, the scripts file
 *   (`LECTURN_SCRIPTED_PROVIDER_SCRIPTS`, written per turn by
 *   `capture/scripted.ts`) and the provider instance in
 *   `<base>/userdata/settings.json`. It implies `fresh`.
 * - `scripts` (B14) also writes that scripts file (keyed by run ordinal)
 *   and makes the scripted model the default (`defaultModelSelection`), so
 *   a thread made in the pane runs it with no admin call: B4(a) and the
 *   B4(b) rehearsal send their prompt through the composer. It implies
 *   `scripted`.
 * - `defaultModel` (B16) makes that model the default for new threads (a
 *   live provider for W-B2 steps 1 and 2, or the scripted model for the
 *   W-B2.4 attach run). It implies `fresh`.
 *
 * Every result also names a temp Electron profile, `RW_USER_DATA_DIR`
 * (CPW2B): the desktop app's `userData` (`apps/desktop/src/main.ts`), so a
 * visible harness window (the B4(a)/B4(b) runs, `--rehearse`) never writes
 * under the real `~/Library/Application Support/Electron`. It lives in the
 * temp dir, or (a kept pair) is the caller's or a fresh one of its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTED_MODEL, SCRIPTED_SETTINGS, type ScriptStep } from "./capture/scripted.ts";

export interface LecturnEnv {
  /** Variables to add to the run's environment. */
  env: Record<string, string>;
  /** The temp dir this call made (null when the caller's pair was kept). */
  dir: string | null;
  /** Removes the temp dir (a no-op for a kept pair). */
  cleanup(): void;
}

export const SCRIPTS_FILE = "rw-scripted.json";

/** Scripts by 1-based run ordinal, as Lecturn reads `LECTURN_SCRIPTED_PROVIDER_SCRIPTS`. */
export type ScriptsFile = Record<string, ScriptStep[]>;

export function lecturnEnv(base: NodeJS.ProcessEnv, prefix: string, opts: { fresh?: boolean; scripted?: boolean; scripts?: ScriptsFile; defaultModel?: { instanceId: string; model: string } } = {}): LecturnEnv {
  const scripted = opts.scripted === true || opts.scripts !== undefined;
  const fresh = opts.fresh === true || scripted || opts.defaultModel !== undefined;
  if (!fresh && base["LECTURN_HOME"] && base["RW_LECTURN_BASE_DIR"]) {
    const kept = base["RW_USER_DATA_DIR"];
    const profile = kept ? null : mkdtempSync(join(tmpdir(), `${prefix}electron-`));
    const env = { LECTURN_HOME: base["LECTURN_HOME"], RW_LECTURN_BASE_DIR: base["RW_LECTURN_BASE_DIR"], RW_USER_DATA_DIR: kept || profile! };
    return { env, dir: null, cleanup: () => (profile === null ? undefined : rmSync(profile, { recursive: true, force: true })) };
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, "home");
  const baseDir = join(dir, "base");
  mkdirSync(home);
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  const env: Record<string, string> = { LECTURN_HOME: home, RW_LECTURN_BASE_DIR: baseDir, RW_USER_DATA_DIR: join(dir, "electron") };
  const defaultModel = opts.defaultModel ?? (opts.scripts === undefined ? undefined : SCRIPTED_MODEL);
  if (scripted || defaultModel !== undefined) {
    const settings = { ...(scripted ? SCRIPTED_SETTINGS : {}), ...(defaultModel === undefined ? {} : { defaultModelSelection: defaultModel }) };
    writeFileSync(join(baseDir, "userdata", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  }
  if (scripted) {
    env["LECTURN_TEST_PROVIDERS"] = "1";
    env["LECTURN_SCRIPTED_PROVIDER_SCRIPTS"] = join(baseDir, SCRIPTS_FILE);
    if (opts.scripts !== undefined) writeFileSync(env["LECTURN_SCRIPTED_PROVIDER_SCRIPTS"], `${JSON.stringify(opts.scripts)}\n`);
  }
  return { env, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
