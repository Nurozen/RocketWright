import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveUnder, serveStatic } from "./serve.ts";

describe("static server", () => {
  it("keeps paths under the root", () => {
    expect(resolveUnder("/srv/web", "/")).toBe("/srv/web/index.html");
    expect(resolveUnder("/srv/web", "/assets/a.wasm?x=1")).toBe("/srv/web/assets/a.wasm");
    expect(resolveUnder("/srv/web", "/../etc/passwd")).toBe("/srv/web/etc/passwd");
    expect(resolveUnder("/srv/web", "/%2e%2e/%2e%2e/etc/passwd")).toBe("/srv/web/etc/passwd");
    expect(resolveUnder("/srv/web", "/%E0%A4%A")).toBeNull();
  });

  it("serves wasm as application/wasm on 127.0.0.1", async () => {
    const root = mkdtempSync(join(tmpdir(), "rw-serve-"));
    writeFileSync(join(root, "m.wasm"), new Uint8Array([0, 0x61, 0x73, 0x6d]));
    const server = await serveStatic(root);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${server.origin}/m.wasm`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/wasm");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
      expect((await fetch(`${server.origin}/missing.js`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
