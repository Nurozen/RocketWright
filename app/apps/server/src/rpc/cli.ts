/**
 * `node src/rpc/cli.ts [--port N] [--project <dir>]... [--lecturn-base-dir <dir>]`: starts the app
 * server on 127.0.0.1 (port 0 by default), opens the given projects, and
 * prints `RW_SERVER_URL=…` and `RW_RPC_URL=…` for the parent (Electron main,
 * `make dev`) in one write, `RW_RPC_URL` last: the parent stops reading at
 * it, so an optional `RW_LIVE_MCP_URL=…` line (B9) and `RW_MAIN_TOKEN=…` go
 * before it. The token (D11) goes to this stdout pipe only: this process hands
 * its env to the Lecturn link below, so a variable would reach Lecturn's server
 * and agent shells. Stops every sidecar on SIGINT/SIGTERM.
 *
 * Electron main sets `RW_EXIT_WITH_PARENT=1` and holds this process's stdin
 * open. A crash or force quit closes that pipe, which is the one parent-death
 * signal no shutdown path can skip; without it the server and its sidecars
 * would keep every project's lock.
 *
 * Lecturn (B8): with `RW_LECTURN_BASE_DIR`, else `--lecturn-base-dir` (main
 * passes `<userData>/lecturn`), the server connects to Lecturn in the
 * background (`lecturn/connection.ts`); without either it runs without.
 */
import { pathToFileURL } from "node:url";
import { createLecturnLink } from "../lecturn/connection.ts";
import { AppServer } from "./AppServer.ts";

export async function main(argv: string[]): Promise<AppServer> {
  let port = 0;
  const projects: string[] = [];
  let lecturnBaseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--port" && v !== undefined) {
      port = Number(v);
      i++;
    } else if (a === "--project" && v !== undefined) {
      projects.push(v);
      i++;
    } else if (a === "--lecturn-base-dir" && v !== undefined) {
      lecturnBaseDir = v;
      i++;
    } else throw new Error(`unknown argument ${String(a)}`);
  }
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  const server = await AppServer.start({
    port,
    log,
    lecturn: (events) =>
      createLecturnLink(
        { env: process.env, baseDir: lecturnBaseDir },
        {
          ...events,
          status: (status) => {
            log(`lecturn: ${status.state}${status.mode === null ? "" : ` (${status.mode})`}${status.message === undefined ? "" : `: ${status.message}`}`);
            events.status(status);
          },
        },
      ),
  });
  for (const p of projects) await server.openProject(p);
  const live = server.lecturn === null ? "" : `RW_LIVE_MCP_URL=${server.liveMcpUrl}\n`;
  process.stdout.write(`RW_SERVER_URL=${server.url}\n${live}RW_MAIN_TOKEN=${server.mainToken}\nRW_RPC_URL=${server.rpcUrl}\n`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.env.RW_EXIT_WITH_PARENT === "1") {
    // The env reaches Lecturn's server through `createLecturnLink`; this is only ours.
    delete process.env.RW_EXIT_WITH_PARENT;
    watchParent(process.stdin, () => {
      log("app server: the parent is gone; stopping");
      // A close that hangs must not leave an orphan holding the locks.
      setTimeout(() => process.exit(1), PARENT_GONE_GRACE_MS).unref();
      stop();
    });
  }
  return server;
}

/** How long a server whose parent died may spend closing before it exits anyway. */
const PARENT_GONE_GRACE_MS = 8_000;

/** Runs `onGone` once when `stdin`, held open by the parent, reaches EOF. */
export function watchParent(stdin: NodeJS.ReadableStream, onGone: () => void): void {
  let gone = false;
  const once = (): void => {
    if (gone) return;
    gone = true;
    onGone();
  };
  stdin.on("end", once);
  stdin.on("close", once);
  stdin.resume();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The packaged desktop app runs this file with Electron as Node. Keep the
  // variable off our children: the Lecturn helper sets it on its server alone (D3).
  delete process.env.ELECTRON_RUN_AS_NODE;
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
