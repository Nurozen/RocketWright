/** REV-srv: the page's RPC URL carries the server's per-launch token (`#token=` in browser mode, the preload's URL on desktop). */
import { describe, expect, it } from "vitest";
import { pageRpcUrl } from "./rpcUrl.ts";

describe("pageRpcUrl", () => {
  it("adds the fragment token to the query's rpc URL (browser mode)", () => {
    expect(pageRpcUrl({ search: "?page=01&rpc=ws%3A%2F%2F127.0.0.1%3A9%2Frpc", hash: "#token=abc_D-1" })).toBe("ws://127.0.0.1:9/rpc?token=abc_D-1");
  });

  it("keeps a URL that already carries a token (desktop preload, e2e drivers)", () => {
    expect(pageRpcUrl({ search: "", hash: "", desktopUrl: "ws://127.0.0.1:9/rpc?token=t1" })).toBe("ws://127.0.0.1:9/rpc?token=t1");
    expect(pageRpcUrl({ search: "?rpc=ws%3A%2F%2F127.0.0.1%3A9%2Frpc%3Ftoken%3Dt2", hash: "#token=other" })).toBe("ws://127.0.0.1:9/rpc?token=t2");
  });

  it("borrows the desktop's token for the same server when the query lost it", () => {
    expect(pageRpcUrl({ search: "?rpc=ws%3A%2F%2F127.0.0.1%3A9%2Frpc", hash: "", desktopUrl: "ws://127.0.0.1:9/rpc?token=t3" })).toBe("ws://127.0.0.1:9/rpc?token=t3");
    // Never hands the desktop's secret to another server.
    expect(pageRpcUrl({ search: "?rpc=ws%3A%2F%2F127.0.0.1%3A8%2Frpc", hash: "", desktopUrl: "ws://127.0.0.1:9/rpc?token=t3" })).toBe("ws://127.0.0.1:8/rpc");
  });

  it("falls back to the env URL, and is null with no server", () => {
    expect(pageRpcUrl({ search: "", hash: "#token=t4", envUrl: "ws://127.0.0.1:5/rpc" })).toBe("ws://127.0.0.1:5/rpc?token=t4");
    expect(pageRpcUrl({ search: "", hash: "" })).toBeNull();
  });
});
