import { describe, expect, it } from "vitest";
import { parsePs, processesNaming } from "../orphans.ts";

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
});
