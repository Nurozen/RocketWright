/**
 * B1a (D4): `pnpm --filter @rw/server test -- sidecar-relay`.
 *
 * A held project lock is no longer a spawn failure for `SidecarSupervisor`:
 * when another `rocketwright mcp` (Lecturn's headless instance, say) owns
 * the project, the app's sidecar starts as a relay to it instead of exiting
 * 2 with RW-E007, so the supervisor reaches `ready` on its first start, with
 * no restarts, and its calls are answered by the owner. The supervisor's
 * generic failure cap is unchanged.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SidecarClient } from "../src/sidecar/SidecarClient.ts";
import { SidecarSupervisor } from "../src/sidecar/SidecarSupervisor.ts";
import { sidecarBin } from "./helpers/harness.ts";

const lockPid = (project: string): number => (JSON.parse(readFileSync(join(project, ".rw/lock"), "utf8")) as { pid: number }).pid;

describe("sidecar relay (B1a)", () => {
  let bin = "";
  let project = "";

  beforeAll(() => {
    bin = sidecarBin();
    // Short path: Unix socket paths are limited to ~104 bytes on macOS.
    project = mkdtempSync("/tmp/rwts-");
  }, 600_000);

  afterAll(() => {
    if (project !== "") rmSync(project, { recursive: true, force: true });
  });

  it("starts as a relay when another instance holds the lock", async () => {
    // Another instance owns the project (not --app: a headless host).
    const owner = new SidecarClient();
    await owner.start({ projectDir: project, bin, app: false, stderr: "ignore" });
    const sup = new SidecarSupervisor({
      projectDir: project,
      bin,
      stderr: "ignore",
      // One failed start would be fatal: a held lock must not be one.
      backoff: { initialMs: 5, maxMs: 20, maxAttempts: 1 },
      callWaitMs: 5000,
    });
    try {
      expect(lockPid(project)).toBe(owner.pid());
      await sup.start();
      expect(sup.state).toBe("ready");
      expect(sup.version()).not.toBeNull();
      const r = (await sup.callTool("job_status", { job_id: "j1" }, { "rw/thread": "t-relay" })) as { _meta?: Record<string, { origin?: string; thread?: string }> };
      expect(r._meta?.["rw/ctx"]?.origin).toBe("mcp");
      expect(r._meta?.["rw/ctx"]?.thread).toBe("t-relay");
      await new Promise((ok) => setTimeout(ok, 300));
      expect(sup.state).toBe("ready");
      expect(sup.starts).toBe(1);
      expect(lockPid(project)).toBe(owner.pid());
    } finally {
      await sup.stop();
      await owner.stop();
    }
  }, 60_000);
});
