import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverCommand, spawnServer } from "./backend.ts";
import { packagedLayout, packagedServerOptions, userArgv } from "./packaged.ts";

describe("packaged app", () => {
  const layout = packagedLayout("/Applications/RocketWright.app/Contents/Resources", "/Applications/RocketWright.app/Contents/Resources/app.asar", "darwin");

  it("finds the bundled server inside the archive and the sidecar beside it", () => {
    expect(layout).toEqual({
      serverCli: "/Applications/RocketWright.app/Contents/Resources/app.asar/app/apps/server/src/rpc/cli.mjs",
      sidecarBin: "/Applications/RocketWright.app/Contents/Resources/bin/rocketwright",
      samplesRoot: "/Applications/RocketWright.app/Contents/Resources",
    });
    expect(packagedLayout("C:\\RW\\resources", "C:\\RW\\resources\\app.asar", "win32").sidecarBin).toMatch(/rocketwright\.exe$/);
  });

  it("reads user arguments after the script in a checkout run and after the executable when packaged", () => {
    expect(userArgv(["/x/Electron", "src/main.ts", "--project", "/p"], true)).toEqual(["--project", "/p"]);
    expect(userArgv(["/x/RocketWright", "--project", "/p"], undefined)).toEqual(["--project", "/p"]);
  });

  it("runs the bundled server with Electron as Node and the shipped sidecar unless RW_SIDECAR_BIN is set", () => {
    const opts = packagedServerOptions(layout, "/x/RocketWright", { PATH: "/usr/bin" });
    expect(opts).toMatchObject({ cli: layout.serverCli, node: "/x/RocketWright", runAsNode: true });
    expect(opts.env?.RW_SIDECAR_BIN).toBe(layout.sidecarBin);
    expect(packagedServerOptions(layout, "/x/RocketWright", { RW_SIDECAR_BIN: "/opt/rw" }).env?.RW_SIDECAR_BIN).toBe("/opt/rw");
    // No `env -u ELECTRON_RUN_AS_NODE` wrapper: the spawn sets the variable instead.
    expect(serverCommand("/x/RocketWright", layout.serverCli, ["/tmp/p"], undefined, true)).toEqual({ cmd: "/x/RocketWright", args: [layout.serverCli, "--project", "/tmp/p"] });
  });

  it("hands the server ELECTRON_RUN_AS_NODE=1 with runAsNode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-packaged-"));
    const cli = join(dir, "cli.mjs");
    writeFileSync(
      cli,
      `process.stdout.write("RW_SERVER_URL=http://127.0.0.1:1\\nRW_RPC_URL=ws://127.0.0.1:1/rpc\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ eran: process.env.ELECTRON_RUN_AS_NODE ?? null }) + "\\n"), 20);
setInterval(() => {}, 1000);`,
    );
    let seen = "";
    const server = await spawnServer({ cli, node: process.execPath, runAsNode: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, log: (c) => (seen += c) });
    try {
      await expect.poll(() => seen, { timeout: 5000 }).toContain("eran");
      expect(JSON.parse(seen.trim())).toEqual({ eran: "1" });
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
