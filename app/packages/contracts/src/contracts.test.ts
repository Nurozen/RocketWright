import { describe, expect, it } from "vitest";
import { AGENT_OPS, RPC_METHODS, TEST_HOOK_OPS } from "./index.ts";

describe("frozen contracts", () => {
  it("lists every RPC method once", () => {
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
  });

  it("keeps test hooks apart from agent broker ops", () => {
    for (const op of TEST_HOOK_OPS) expect((AGENT_OPS as readonly string[]).includes(op)).toBe(false);
    for (const op of TEST_HOOK_OPS) expect(op.startsWith("app_")).toBe(true);
  });
});
