/**
 * U35 (D11): the role-bound host channel over real sockets. A token-only socket
 * (what the renderer has) can neither claim the channel nor answer on it, and
 * consent requests reach only the socket that claimed it.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { AppServer } from "../src/rpc/AppServer.ts";
import { HostChannel, HostChannelError } from "../src/rpc/HostChannel.ts";

const validator = makeValidator();
const ASK = { tool: "project_open", path: "/tmp/rocket" } as const;
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved", (e: unknown) => (e instanceof HostChannelError ? e.code : e));

describe("host channel over the socket (U35)", () => {
  let server: AppServer;
  let page: TestClient;
  let main: TestClient;

  beforeEach(async () => {
    server = await AppServer.start({ coreVersion: "test", stderr: "ignore" });
    page = await TestClient.connect(server.rpcUrl, validator);
    main = await TestClient.connect(server.rpcUrl, validator);
  });

  afterEach(async () => {
    page.close();
    main.close();
    await server.close();
    expect([...page.violations, ...main.violations]).toEqual([]);
  });

  const register = (): Promise<unknown> => main.call("host.register", { token: server.mainToken });

  it("refuses host.register with the RPC token or a wrong one", async () => {
    for (const token of [server.rpcToken, "wrong"]) {
      expect(await page.request("host.register", { token })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(await failure(server.hostChannel.request(ASK))).toBe("no_host");
  });

  it("refuses a second registration, from any socket, with the same message as a wrong token", async () => {
    await register();
    const taken = await page.request("host.register", { token: server.mainToken });
    const wrong = await page.request("host.register", { token: "wrong" });
    expect(taken).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(wrong.ok === false && wrong.error).toEqual(taken.ok === false && taken.error);
    expect(await main.request("host.register", { token: server.mainToken })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses host.respond from a token-only socket, even with a live request id", async () => {
    await register();
    const consent = server.hostChannel.request(ASK);
    const { requestId } = await main.push("host.request");
    expect(await page.request("host.respond", { requestId, accepted: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await page.request("host.respond", {})).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await main.call("host.respond", { requestId, accepted: false });
    await expect(consent).resolves.toEqual({ requestId, accepted: false });
  });

  it("sends host.request only to the main socket", async () => {
    await register();
    const consent = server.hostChannel.request({ ...ASK, request: "open it" });
    const asked = await main.push("host.request");
    expect(asked).toMatchObject({ ...ASK, request: "open it" });
    await main.call("host.respond", { requestId: asked.requestId, accepted: true, displayUnits: { length: "mm" } });
    await expect(consent).resolves.toEqual({ requestId: asked.requestId, accepted: true, displayUnits: { length: "mm" } });
    // A round trip on the page's own socket: any push to it would have landed first.
    await page.call("project.list", {});
    expect(page.pushes("host.request")).toEqual([]);
  });

  it("checks an answer's shape, and refuses a repeat", async () => {
    await register();
    const consent = server.hostChannel.request(ASK);
    const { requestId } = await main.push("host.request");
    expect(await main.request("host.respond", { requestId, accepted: "yes" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await main.request("host.respond", { requestId, accepted: true, displayUnits: { length: 1 } })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    await main.call("host.respond", { requestId, accepted: true });
    await consent;
    expect(await main.request("host.respond", { requestId, accepted: true })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("fails the pending request when the main socket closes, and the channel stays closed", async () => {
    await register();
    const consent = server.hostChannel.request(ASK);
    await main.push("host.request");
    main.close();
    expect(await failure(consent)).toBe("disconnected");
    expect(await failure(server.hostChannel.request(ASK))).toBe("no_host");
    expect(await page.request("host.register", { token: server.mainToken })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("fails the pending request when the server closes", async () => {
    await register();
    const consent = server.hostChannel.request(ASK);
    await main.push("host.request");
    const outcome = failure(consent);
    await server.close();
    expect(await outcome).toBe("disconnected");
  });
});

describe("HostChannel (U35)", () => {
  const owned = (): { channel: HostChannel<string>; sent: { requestId: string }[] } => {
    const channel = new HostChannel<string>();
    const sent: { requestId: string }[] = [];
    expect(channel.claim("main", (r) => sent.push(r))).toBe(true);
    return { channel, sent };
  };

  it("is single-flight: a second request is refused while one waits, and allowed after", async () => {
    const { channel, sent } = owned();
    const first = channel.request(ASK);
    expect(await failure(channel.request(ASK))).toBe("busy");
    expect(sent).toHaveLength(1);
    channel.respond({ requestId: sent[0]!.requestId, accepted: true });
    await first;
    const second = channel.request(ASK);
    expect(sent).toHaveLength(2);
    channel.respond({ requestId: sent[1]!.requestId, accepted: false });
    await expect(second).resolves.toMatchObject({ accepted: false });
  });

  it("drops a request on abort, so a late answer finds nothing and the channel is free", async () => {
    const { channel, sent } = owned();
    const abort = new AbortController();
    const asked = channel.request(ASK, abort.signal);
    abort.abort();
    expect(await failure(asked)).toBe("aborted");
    expect(channel.respond({ requestId: sent[0]!.requestId, accepted: true })).toBe(false);
    const again = channel.request(ASK);
    channel.respond({ requestId: sent[1]!.requestId, accepted: true });
    await again;
    expect(await failure(channel.request(ASK, AbortSignal.abort()))).toBe("aborted");
    expect(sent).toHaveLength(2);
  });

  it("ignores another owner's disconnect", async () => {
    const { channel, sent } = owned();
    const asked = channel.request(ASK);
    channel.dropOwner("page");
    channel.respond({ requestId: sent[0]!.requestId, accepted: true });
    await expect(asked).resolves.toMatchObject({ accepted: true });
    expect(channel.claim("page", () => undefined)).toBe(false);
  });
});

describe("rpc/cli.ts (U35)", () => {
  it("prints RW_MAIN_TOKEN before RW_RPC_URL, a secret distinct from the RPC token that claims the channel", async () => {
    const env = { ...process.env };
    for (const k of ["ELECTRON_RUN_AS_NODE", "LECTURN_HOME", "RW_LECTURN_BASE_DIR"]) delete env[k];
    const cli = resolve(import.meta.dirname, "../src/rpc/cli.ts");
    const child = spawn(process.execPath, [cli], { env, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const out = await new Promise<string>((ok, fail) => {
        let text = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c: string) => {
          text += c;
          if (/^RW_RPC_URL=\S+\n/m.test(text)) ok(text);
        });
        child.once("exit", (code) => fail(new Error(`cli exited (${String(code)}): ${text}`)));
      });
      expect(out).toMatch(/^RW_MAIN_TOKEN=\S+\nRW_RPC_URL=/m);
      const token = /^RW_MAIN_TOKEN=(\S+)$/m.exec(out)![1]!;
      const rpcUrl = /^RW_RPC_URL=(\S+)$/m.exec(out)![1]!;
      expect(new URL(rpcUrl).searchParams.get("token")).not.toBe(token);
      const c = await TestClient.connect(rpcUrl, validator);
      await expect(c.call("host.register", { token })).resolves.toEqual({});
      c.close();
    } finally {
      child.kill("SIGTERM");
    }
  }, 60_000);
});
