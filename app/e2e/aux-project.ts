/**
 * A second live project for specs that need a vehicle the seeded research
 * vehicle is not (a two-stage rocket, a vented tube with freeform fins): a
 * fresh copy of a fixture directory under `/tmp` (short socket paths, see
 * live.ts) with its own app server and sidecar, port 0. The web bundle from
 * the global setup connects to it through `?rpc=…&http=…`.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnServer } from "../apps/desktop/src/backend.ts";
import { SCRATCH } from "./live.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface AuxProject {
  dir: string;
  rpc: string;
  http: string;
  stop(): Promise<void>;
}

/**
 * Copies `src` to `<tmp>/<name>` and serves it; `stop()` ends the server and
 * removes the copy. `extraEnv` overrides the server's env (a spec that uses
 * the embedded pane gives the server its own Lecturn dirs: two app servers
 * cannot share one Lecturn sidecar base dir).
 */
export async function auxProject(src: string, name: string, extraEnv: Record<string, string> = {}): Promise<AuxProject> {
  const dir = join(mkdtempSync(join(SCRATCH, "rw-e2e-aux-")), name);
  cpSync(src, dir, { recursive: true });
  const env = { ...process.env, ...extraEnv };
  delete env["RW_TEST_HOOKS"];
  const server = await spawnServer({ projects: [dir], env, log: () => {} });
  return {
    dir,
    rpc: server.rpcUrl,
    http: server.serverUrl,
    stop: async () => {
      await server.stop();
      rmSync(dirname(dir), { recursive: true, force: true });
    },
  };
}
