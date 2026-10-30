/**
 * B6: `pnpm --filter @rw/desktop test -- mainRpc`. Electron main's IF10
 * client against the contracts mock server: the seed list, `project.opened`
 * pushes (once per project), calls and their errors, version mismatch, close.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RPC_VERSION, type LecturnStatus, type ProjectInfo } from "@rw/contracts";
import { acceptUpgrade, type WsConnection } from "@rw/contracts/ws";
import { SEED_PROJECT_ID, startMockServer, type MockServer } from "@rw/contracts/mock";
import { connectMainRpc, MainRpcError, type MainRpc } from "./mainRpc.ts";

const servers: MockServer[] = [];
const clients: MainRpc[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(): Promise<{ srv: MockServer; rpc: MainRpc; opened: ProjectInfo[] }> {
  const srv = await startMockServer({ tickMs: 5 });
  servers.push(srv);
  const opened: ProjectInfo[] = [];
  const rpc = await connectMainRpc(srv.url, { onProjectOpened: (p) => opened.push(p) });
  clients.push(rpc);
  return { srv, rpc, opened };
}

/** A bare IF10 server: `hello` with `rpc`, then answers the first `project.list` with no projects. */
async function fakeServer(rpc: string): Promise<{ url: string; closeAll(): void; stop(): Promise<void> }> {
  const conns: WsConnection[] = [];
  const http = createServer();
  http.on("upgrade", (req, socket) => {
    let answered = false;
    acceptUpgrade(req, socket, (conn) => {
      conns.push(conn);
      setImmediate(() => conn.send(JSON.stringify({ kind: "hello", rpc, schema: "rw/1", coreVersion: "0", testHooks: false })));
      return {
        message: (text) => {
          const f = JSON.parse(text) as { id: number; method: string };
          if (f.method !== "project.list" || answered) return;
          answered = true;
          conn.send(JSON.stringify({ kind: "response", id: f.id, ok: true, result: { projects: [] } }));
        },
        close: () => undefined,
      };
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const closeAll = (): void => {
    for (const c of conns.splice(0)) c.close();
  };
  return {
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/rpc`,
    closeAll,
    stop: async () => {
      closeAll();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    },
  };
}

const until = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("main RPC client (B6)", () => {
  it("seeds the open projects from project.list", async () => {
    const { rpc, opened } = await setup();
    expect(opened.map((p) => p.projectId)).toEqual([SEED_PROJECT_ID]);
    expect(rpc.projects().map((p) => p.projectId)).toEqual([SEED_PROJECT_ID]);
  });

  it("hears project.opened from any socket, once per project", async () => {
    const { srv, rpc, opened } = await setup();
    const other = await connectMainRpc(srv.url);
    clients.push(other);
    const p = (await other.call("project.open", { dir: "/tmp/Second Rocket" })).project;
    await until(() => opened.length === 2);
    expect(opened[1]).toEqual(p);
    await other.call("project.open", { dir: "/tmp/Second Rocket" });
    await rpc.call("project.list", {}); // a round trip after the reopen: any push would have landed
    expect(opened.map((x) => x.projectId)).toEqual([SEED_PROJECT_ID, "second-rocket"]);
    expect(rpc.projects()).toEqual(opened);
  });

  it("keeps the last lecturn.status and reports each push, live switches included (B10, D25)", async () => {
    const srv = await startMockServer({ tickMs: 5 });
    servers.push(srv);
    const seen: LecturnStatus[] = [];
    const rpc = await connectMainRpc(srv.url, { onLecturnStatus: (s) => seen.push(s) });
    clients.push(rpc);
    await until(() => seen.length === 1);
    expect(rpc.lecturnStatus()).toMatchObject({ state: expect.any(String) });
    srv.mock.lecturnSwitch("user-server");
    await until(() => seen.length === 2);
    expect(rpc.lecturnStatus()).toMatchObject({ mode: "user-server", switched: { environmentId: expect.any(String), projects: { [SEED_PROJECT_ID]: expect.any(String) } } });
  });

  it("calls methods and rejects error responses with the RPC code", async () => {
    const { rpc } = await setup();
    const target = await rpc.call("embed.target", { projectId: SEED_PROJECT_ID });
    expect(target).toMatchObject({ token: expect.any(String), expiresAt: expect.any(String) });
    const err = await rpc.call("embed.target", { projectId: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MainRpcError);
    expect((err as MainRpcError).code).toBe("not_found");
  });

  it("fails pending and later calls once the socket closes", async () => {
    const fake = await fakeServer(RPC_VERSION);
    try {
      let closed = 0;
      const rpc = await connectMainRpc(fake.url, { onClose: () => closed++ });
      clients.push(rpc);
      const hanging = rpc.call("project.list", {}); // the fake answers only the first project.list
      fake.closeAll();
      await expect(hanging).rejects.toThrow(/closed/);
      await until(() => closed === 1);
      await expect(rpc.call("project.list", {})).rejects.toThrow(/closed/);
    } finally {
      await fake.stop();
    }
  });

  it("refuses a server that speaks another RPC version", async () => {
    const fake = await fakeServer("rw-rpc/0");
    try {
      await expect(connectMainRpc(fake.url, { timeoutMs: 5_000 })).rejects.toThrow(/version mismatch/);
    } finally {
      await fake.stop();
    }
  });
});
