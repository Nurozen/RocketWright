/** M1.48 WASM loader + version handshake (D19c, I4). */
import { readFileSync } from "node:fs";
import { loadRwWasm } from "@rw/rw-wasm";
import { describe, expect, it } from "vitest";
import { fromRwWasm, handshake, loadWasm, versionsMatch } from "./wasm.ts";

const fake = (version: string, withApply = false) => ({
  coreVersion: () => version,
  ...(withApply ? { applyAndEval: () => ({}) as never } : {}),
});

describe("wasm handshake", () => {
  it("requires exact version equality", () => {
    expect(versionsMatch("0.1.0", "0.1.0")).toBe(true);
    expect(versionsMatch("0.1.0", "0.1.1")).toBe(false);
    expect(versionsMatch("", "")).toBe(false);
  });

  it("ready with preview only when apply_and_eval exists", async () => {
    expect((await loadWasm("1.2.3", async () => fake("1.2.3"))).status).toEqual({ state: "ready", coreVersion: "1.2.3", preview: false });
    const h = await loadWasm("1.2.3", async () => fake("1.2.3", true));
    expect(h.status).toEqual({ state: "ready", coreVersion: "1.2.3", preview: true });
    expect(h.core).not.toBeNull();
  });

  it("refuses a core whose version differs from the server's", async () => {
    const h = await loadWasm("0.0.0-mock", async () => fake("0.1.0", true));
    expect(h).toEqual({ status: { state: "mismatch", wasmVersion: "0.1.0", serverVersion: "0.0.0-mock" }, core: null });
  });

  it("turns load failures into a status instead of throwing", async () => {
    const h = await loadWasm("0.1.0", async () => {
      throw new Error("404 rw_wasm_bg.wasm");
    });
    expect(h).toEqual({ status: { state: "failed", error: "404 rw_wasm_bg.wasm" }, core: null });
    expect(handshake(fake("x"), "y").status.state).toBe("mismatch");
  });

  it("handshakes the real rw-wasm build (make wasm) by its core_version", async () => {
    const rw = await loadRwWasm(readFileSync(new URL("../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
    const core = fromRwWasm(rw);
    const v = core.coreVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    // M1.32: apply_and_eval is exported, so drafts preview in wasm.
    expect((await loadWasm(v, async () => core)).status).toEqual({ state: "ready", coreVersion: v, preview: true });
    expect((await loadWasm(`${v}-other`, async () => core)).status.state).toBe("mismatch");
  });
});
