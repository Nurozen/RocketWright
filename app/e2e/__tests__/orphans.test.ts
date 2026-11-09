import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killStarted, parsePs, parsePsTree, processesNaming, stillRunning, withDescendants } from "../orphans.ts";

describe("teardown orphans (orphans.ts)", () => {
  const rows = parsePs(
    [
      "  101 /usr/bin/node apps/server/src/rpc/cli.ts --project /tmp/rw-b4a-x1/research-vehicle",
      "  102 /opt/rw/rocketwright mcp -C /tmp/rw-b4a-x1/research-vehicle",
      "  103 node lecturn/dist/bin.mjs --base-dir /tmp/rw-b4a-lecturn-y2/base",
      "  104 /usr/bin/node other --project /tmp/rw-b4a-z9/x",
      "  200 node playwright test /tmp/rw-b4a-x1",
      "",
    ].join("\n"),
  );

  it("parses ps rows", () => {
    expect(rows.map((r) => r.pid)).toEqual([101, 102, 103, 104, 200]);
    expect(rows[2]!.command).toMatch(/^node lecturn/);
  });

  it("finds the run's own processes by its temp paths, never this process", () => {
    expect(processesNaming(["/tmp/rw-b4a-x1", "/tmp/rw-b4a-lecturn-y2"], rows, [200]).map((p) => p.pid)).toEqual([101, 102, 103]);
    // Too-short markers (an empty path) match nothing.
    expect(processesNaming(["", "/"], rows, [200])).toEqual([]);
  });

  describe("what a run may kill", () => {
    const tree = parsePsTree(
      [
        "  10   1 /electron main.ts",
        "  11  10 /node server/cli.ts",
        "  12  11 /opt/rocketwright mcp -C /tmp/rw-b1-x/p",
        "  13  12 /opt/helper",
        "  20   1 /opt/rocketwright mcp -C /tmp/rw-b1-other/p",
        "",
      ].join("\n"),
    );

    it("follows parent links from the root, and nothing else", () => {
      expect(withDescendants(10, tree).map((p) => p.pid)).toEqual([10, 11, 12, 13]);
      expect(withDescendants(11, tree).map((p) => p.pid)).toEqual([11, 12, 13]);
      expect(withDescendants(99, tree)).toEqual([]);
    });

    it("keeps only pids that still hold the command they started with", () => {
      const started = new Map(withDescendants(10, tree).map((p) => [p.pid, p.command]));
      const later = parsePs(["  12 /opt/rocketwright mcp -C /tmp/rw-b1-x/p", "  13 /usr/bin/reused-pid", "  20 /opt/rocketwright mcp -C /tmp/rw-b1-other/p", ""].join("\n"));
      expect(stillRunning(started, later).map((p) => p.pid)).toEqual([12]);
    });

    it("kills a process it started, and leaves a matching pid with another command alone", async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
      const pid = child.pid!;
      const row = { pid, command: "the command at launch" };
      expect(killStarted(new Map([[pid, "some other command"]]), [row])).toEqual([]);
      expect(killStarted(new Map([[pid, row.command]]), [row])).toEqual([`${pid} ${row.command}`]);
      await expect(exited).resolves.toBe("SIGKILL");
    });
  });
});
