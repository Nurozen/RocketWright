/**
 * B1b (D4): `pnpm --filter @rw/server test -- ProjectHost`.
 *
 * The sidecar child is a relay front: when the project's owner goes away it
 * reconnects (or promotes itself) without the child restarting, then sends
 * `notifications/resources/updated` for its subscriptions and
 * `notifications/rw/upstream-changed`. `ProjectHost` treats the latter as a
 * resync trigger, like a restart: it re-subscribes and refreshes every
 * mirrored resource.
 *
 * - a fake sidecar (a stdio MCP server script) emits only
 *   `rw/upstream-changed`: the host re-subscribes and re-reads the whole
 *   mirror, with no restart;
 * - the real binary: the headless owner is killed while the host's sidecar
 *   relays to it; the relay promotes, and the host's mirror is refreshed.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectPatch } from "@rw/contracts";
import { MIRROR_KEYS, MIRROR_RESOURCES } from "../src/project/mirror.ts";
import { ProjectHost } from "../src/project/ProjectHost.ts";
import { SidecarClient, UPSTREAM_CHANGED } from "../src/sidecar/SidecarClient.ts";
import { sidecarBin } from "./helpers/harness.ts";

/**
 * A newline-delimited JSON-RPC MCP server. Every resource reads as
 * `{gen, uri}`; `tools/call test_upstream_changed` bumps `gen` and sends
 * only `rw/upstream-changed` (no `resources/updated`). Subscribes are
 * counted in `test_stats`.
 */
const FAKE_SIDECAR = `
const readline = require("node:readline");
let gen = 1;
const subs = [];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {}, resources: { subscribe: true } },
        serverInfo: { name: "rocketwright", version: "0.0.0-fake" },
      });
    case "tools/list":
      return reply(m.id, { tools: [] });
    case "resources/subscribe":
      subs.push(m.params.uri);
      return reply(m.id, {});
    case "resources/unsubscribe":
      return reply(m.id, {});
    case "resources/read":
      return reply(m.id, { contents: [{ uri: m.params.uri, mimeType: "application/json", text: JSON.stringify({ gen, uri: m.params.uri }) }] });
    case "tools/call":
      if (m.params.name === "test_upstream_changed") {
        gen += 1;
        send({ jsonrpc: "2.0", method: "${UPSTREAM_CHANGED}", params: { role: "owner" } });
      }
      return reply(m.id, { content: [{ type: "text", text: JSON.stringify({ gen, subs }) }], structuredContent: { gen, subs } });
    default:
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no " + m.method } });
  }
});
`;

const until = async (cond: () => boolean, what: string, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function host(dir: string, bin: string, patches: ProjectPatch[]): ProjectHost {
  return new ProjectHost(
    {
      info: { projectId: "p", dir, name: "p" },
      bin,
      stderr: "ignore",
      coalesceMs: 5,
      backoff: { initialMs: 5, maxMs: 20, maxAttempts: 2 },
    },
    { patch: (p) => patches.push(p) },
  );
}

const mirrorPatch = (p: ProjectPatch): boolean => MIRROR_KEYS.every((k) => k in p);

describe("ProjectHost upstream changes (B1b)", () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => {
    const d = mkdtempSync(prefix);
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("resyncs its mirror on rw/upstream-changed without a restart", async () => {
    const bin = join(temp(join(tmpdir(), "rw-fake-sidecar-")), "rocketwright");
    writeFileSync(bin, `#!${process.execPath}\n${FAKE_SIDECAR}`);
    chmodSync(bin, 0o755);
    const patches: ProjectPatch[] = [];
    const h = host(temp(join(tmpdir(), "rw-host-")), bin, patches);
    try {
      await h.start();
      expect(h.snapshot().evaluated).toEqual({ gen: 1, uri: MIRROR_RESOURCES.evaluated });
      let changes = 0;
      h.sidecar.onUpstreamChanged(() => changes++);
      patches.length = 0;

      const r = await h.sidecar.callTool("test_upstream_changed", {}, {});
      expect((r.structuredContent as { gen: number }).gen).toBe(2);
      await until(() => changes === 1, "the supervisor saw rw/upstream-changed");
      await until(() => patches.some(mirrorPatch), "a full mirror refresh");
      await h.settled();
      const snap = h.snapshot() as unknown as Record<string, unknown>;
      for (const k of MIRROR_KEYS) expect(snap[k]).toEqual({ gen: 2, uri: MIRROR_RESOURCES[k] });
      // Re-subscribed on the new upstream, as after a restart.
      const stats = await h.sidecar.callTool("test_stats", {}, {});
      const subs = (stats.structuredContent as { subs: string[] }).subs;
      for (const uri of Object.values(MIRROR_RESOURCES)) expect(subs.filter((s) => s === uri)).toHaveLength(2);
      expect(h.sidecar.starts).toBe(1);
      expect(h.sidecar.state).toBe("ready");
    } finally {
      await h.close();
    }
  });

  describe("with the real binary", () => {
    let bin = "";
    beforeAll(() => {
      bin = sidecarBin();
    }, 600_000);

    it("refreshes the mirror after the relay promotes", async () => {
      // Short path: Unix socket paths are limited to ~104 bytes on macOS.
      const project = temp("/tmp/rwph-");
      const owner = new SidecarClient();
      await owner.start({ projectDir: project, bin, app: false, stderr: "ignore" });
      const ownerPid = owner.pid();
      const patches: ProjectPatch[] = [];
      const h = host(project, bin, patches);
      try {
        await h.start();
        let changes = 0;
        h.sidecar.onUpstreamChanged(() => changes++);
        const updates: string[] = [];
        h.sidecar.onResourceUpdated((uri) => updates.push(uri));
        patches.length = 0;

        // The owner dies: the host's relay promotes itself.
        expect(ownerPid).not.toBeNull();
        process.kill(ownerPid ?? 0, "SIGKILL");
        await until(() => changes === 1, "rw/upstream-changed after the promotion", 20_000);
        await until(() => patches.some(mirrorPatch), "a full mirror refresh", 20_000);
        // resources/updated for every replayed subscription.
        for (const uri of Object.values(MIRROR_RESOURCES)) expect(updates).toContain(uri);
        expect(h.sidecar.starts).toBe(1);
        expect(h.sidecar.state).toBe("ready");
        // The promoted relay answers calls.
        const r = await h.sidecar.callTool("job_status", { job_id: "j1" }, {});
        expect(r.isError === true).toBe(false);
      } finally {
        await h.close();
        await owner.stop().catch(() => undefined);
      }
    }, 120_000);
  });
});
