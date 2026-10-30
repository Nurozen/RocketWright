/**
 * The packaged desktop app (`make package`, `scripts/desktop/package.ts`).
 *
 * The package keeps the repo's relative layout inside `app.asar` (the
 * bundled main at `PACKAGED_MAIN`, the web bundle at `app/apps/web/dist`,
 * the theme JSON, `preload.ts`, the MCP render card, the app icon), so every
 * `import.meta.dirname`-relative path resolves as it does in a checkout.
 * What differs from a checkout run:
 *
 * - argv carries no script path: user arguments start at `argv[1]`;
 * - the app server is the bundled `PACKAGED_SERVER_CLI`, run by Electron as
 *   Node (`ELECTRON_RUN_AS_NODE=1`): a packaged app has no `node` on PATH;
 * - the `rocketwright` sidecar is `<resources>/bin/rocketwright`, outside
 *   the archive so it can be executed (`RW_SIDECAR_BIN` still wins);
 * - with no `--project`, the window opens a fresh `/tmp` copy of the bundled
 *   sample project (`<resources>/fixtures/research-vehicle`), as `make dev` does.
 */
import { join } from "node:path";
import { REPO_ROOT, type SpawnServerOptions } from "./backend.ts";

/** The bundled Electron main, relative to the app root (the asar). */
export const PACKAGED_MAIN = "app/apps/desktop/src/main.mjs";
/** The bundled app server entry, relative to the app root (the asar). */
export const PACKAGED_SERVER_CLI = "app/apps/server/src/rpc/cli.mjs";

export interface PackagedLayout {
  /** The bundled app server entry. */
  serverCli: string;
  /** The `rocketwright` binary beside the archive. */
  sidecarBin: string;
  /** The directory holding `fixtures/research-vehicle` (`resolveDevProject`'s root). */
  samplesRoot: string;
}

/** Paths of a packaged app whose Electron `process.resourcesPath` is `resourcesPath`. */
export function packagedLayout(resourcesPath: string, appRoot = REPO_ROOT, platform: NodeJS.Platform = process.platform): PackagedLayout {
  return {
    serverCli: join(appRoot, PACKAGED_SERVER_CLI),
    sidecarBin: join(resourcesPath, "bin", platform === "win32" ? "rocketwright.exe" : "rocketwright"),
    samplesRoot: resourcesPath,
  };
}

/** Electron's user arguments: after the script in a checkout run (`electron src/main.ts …`, `process.defaultApp`), after the executable when packaged. */
export function userArgv(argv: readonly string[], defaultApp: boolean | undefined): string[] {
  return argv.slice(defaultApp === true ? 2 : 1);
}

/** `startBackend` options for a packaged app: the bundled server under Electron as Node, with the shipped sidecar. */
export function packagedServerOptions(layout: PackagedLayout, execPath: string, env: NodeJS.ProcessEnv = process.env): Pick<SpawnServerOptions, "cli" | "node" | "runAsNode" | "env"> {
  return {
    cli: layout.serverCli,
    node: execPath,
    runAsNode: true,
    env: { ...env, RW_SIDECAR_BIN: env.RW_SIDECAR_BIN || layout.sidecarBin },
  };
}
