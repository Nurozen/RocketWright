/**
 * The app server stops when the process that started it dies, however it dies
 * (R4): a crash or force quit runs no cleanup, so a server left behind keeps
 * its sidecars and every project lock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchParent } from "../src/rpc/cli.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/rpc/cli.ts");

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function readLine(child: ChildProcess, prefix: string): Promise<string> {
  return new Promise((ok, fail) => {
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      out += c;
      const line = out.split("\n").find((l) => l.startsWith(prefix));
      if (line !== undefined) ok(line.slice(prefix.length));
    });
    child.once("exit", () => fail(new Error(`exited before ${prefix}`)));
  });
}

describe("watchParent", () => {
  it("runs once when stdin ends, and not before", () => {
    const stream = new PassThrough();
    const onGone = vi.fn<() => void>();
    watchParent(stream, onGone);
    expect(onGone).not.toHaveBeenCalled();
    stream.end();
    stream.emit("end");
    stream.emit("close");
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});

describe("the real server", () => {
  const started: ChildProcess[] = [];
  afterEach(() => {
    for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  });

  it("exits when its parent dies without any cleanup", async () => {
    // A throwaway parent that starts the server the way spawnServer does and is then killed outright.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const server = spawn(process.execPath, [${JSON.stringify(CLI)}], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, RW_EXIT_WITH_PARENT: "1" } });
         server.stdout.on("data", (c) => process.stdout.write(c));
         process.stdout.write("SERVER_PID=" + server.pid + "\\n");`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    started.push(parent);
    const serverPid = Number(await readLine(parent, "SERVER_PID="));
    try {
      await readLine(parent, "RW_RPC_URL=");
      expect(isGone(serverPid)).toBe(false);
      parent.kill("SIGKILL");
      await vi.waitFor(() => expect(isGone(serverPid)).toBe(true), { timeout: 15_000, interval: 100 });
    } finally {
      // Only on a failure is this still running; a leftover server would hold the run's stderr open.
      if (!isGone(serverPid)) process.kill(serverPid, "SIGKILL");
    }
  }, 60_000);
});
