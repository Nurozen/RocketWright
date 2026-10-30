/** M1.45: `SidecarSupervisor` restart with backoff, and the sidecar child env. */
import { describe, expect, it } from "vitest";
import { sidecarEnv } from "../src/sidecar/SidecarClient.ts";
import { SidecarSupervisor, SidecarUnavailable, backoffDelay, type SidecarConnection } from "../src/sidecar/SidecarSupervisor.ts";
import type { SidecarState } from "@rw/contracts";

/** A scripted connection: `fail` starts throw; `crash()` simulates the child dying. */
class FakeConn implements SidecarConnection {
  static made: FakeConn[] = [];
  closeCbs: (() => void)[] = [];
  started = false;
  constructor(readonly fail: boolean) {
    FakeConn.made.push(this);
  }
  start(): Promise<void> {
    if (this.fail) return Promise.reject(new Error("spawn failed"));
    this.started = true;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }
  crash(): void {
    this.started = false;
    for (const cb of this.closeCbs) cb();
  }
  onClose(cb: () => void): () => void {
    this.closeCbs.push(cb);
    return () => undefined;
  }
  onResourceUpdated(): () => void {
    return () => undefined;
  }
  subscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  unsubscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  readJson(): Promise<unknown> {
    return Promise.resolve({});
  }
  serverVersion(): { name: string; version: string } {
    return { name: "rocketwright", version: "9.9.9" };
  }
  pid(): number {
    return FakeConn.made.indexOf(this) + 1000;
  }
  listTools(): Promise<never[]> {
    return Promise.resolve([]);
  }
  callTool(name: string): Promise<{ content: []; structuredContent: { name: string } }> {
    return Promise.resolve({ content: [], structuredContent: { name } });
  }
}

/** Connections fail per `plan` (true = fail), then succeed. */
function supervisor(plan: boolean[], maxAttempts = 6): { sup: SidecarSupervisor; states: SidecarState[] } {
  FakeConn.made = [];
  let i = 0;
  const sup = new SidecarSupervisor({
    projectDir: "/nowhere",
    backoff: { initialMs: 5, maxMs: 20, maxAttempts },
    callWaitMs: 2000,
    connect: () => new FakeConn(plan[i++] ?? false),
  });
  const states: SidecarState[] = [];
  sup.onState((s) => states.push(s));
  return { sup, states };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("SidecarSupervisor", () => {
  it("computes capped exponential backoff", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n))).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000]);
    expect(backoffDelay(3, { initialMs: 10, factor: 3, maxMs: 100 })).toBe(100);
  });

  it("restarts after a crash, retrying failed starts, and calls wait for it", async () => {
    const { sup, states } = supervisor([false, true, true, false]);
    await sup.start();
    expect(sup.state).toBe("ready");
    expect(sup.version()).toBe("9.9.9");
    FakeConn.made[0]!.crash();
    expect(sup.state).toBe("restarting");
    // A call made during the restart resolves on the new connection.
    const call = sup.callTool("model_get", {}, {});
    await until(() => sup.state === "ready");
    expect(await call).toMatchObject({ structuredContent: { name: "model_get" } });
    expect(FakeConn.made).toHaveLength(4);
    expect(sup.starts).toBe(4);
    expect(states).toEqual(["ready", "restarting", "ready"]);
    expect(sup.pid()).toBe(1003);
    await sup.stop();
  });

  it("gives up after maxAttempts consecutive failures and fails waiting calls; restart() retries", async () => {
    const { sup, states } = supervisor([false, true, true, true], 3);
    await sup.start();
    FakeConn.made[0]!.crash();
    const call = sup.callTool("model_get", {}, {}).catch((e: unknown) => e);
    await until(() => sup.state === "failed");
    expect(await call).toBeInstanceOf(SidecarUnavailable);
    await expect(sup.listTools()).rejects.toBeInstanceOf(SidecarUnavailable);
    expect(states).toEqual(["ready", "restarting", "failed"]);
    sup.restart();
    await until(() => sup.state === "ready");
    expect(FakeConn.made).toHaveLength(5);
    await sup.stop();
    await expect(sup.callTool("x", {}, {})).rejects.toBeInstanceOf(SidecarUnavailable);
  });

  it("does not restart after stop()", async () => {
    const { sup } = supervisor([false]);
    await sup.start();
    const conn = FakeConn.made[0]!;
    await sup.stop();
    conn.crash();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeConn.made).toHaveLength(1);
  });

  it("a first start that fails reports failed and rejects", async () => {
    const { sup } = supervisor([true]);
    await expect(sup.start()).rejects.toThrow(/spawn failed/);
    expect(sup.state).toBe("failed");
  });
});

describe("sidecar env", () => {
  it("drops ELECTRON_RUN_AS_NODE (env -u) and keeps the rest", () => {
    const env = sidecarEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", RW_OFFLINE: "1", EMPTY: undefined });
    expect(env).toEqual({ PATH: "/bin", RW_OFFLINE: "1" });
  });
});
