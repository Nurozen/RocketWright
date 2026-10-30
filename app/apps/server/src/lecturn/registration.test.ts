/**
 * B8: `pnpm -C app --filter @rw/server test -- lecturn registration`.
 * RocketWright's Lecturn registration (W2.1): the pinned fields, Lecturn's
 * caps (icon ≤ 64 KB PNG, instructions ≤ 8 KB), provider-neutral
 * instructions that name only real `rw_<tool>` tools, and the absolute binary.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_OPS } from "@rw/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { APP_ICON_PATH, absoluteSidecarBinary, iconDataUrl, rocketwrightRegistration, RW_LECTURN_INSTRUCTIONS } from "./registration.ts";

const BIN = "/opt/rocketwright/bin/rocketwright";
const REPO = resolve(import.meta.dirname, "../../../../..");
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("Lecturn registration (B8, W2.1)", () => {
  it("pins every registration field", () => {
    const reg = rocketwrightRegistration({ bin: BIN });
    const { iconDataUrl: icon, instructions, ...rest } = reg;
    expect(rest).toEqual({
      appId: "dev.rocketwright.app",
      name: "RocketWright",
      toolPrefix: "rw",
      openUrlTemplate: "rocketwright://open?workspace={workspaceRoot}&thread={threadId}",
      refPrefixes: ["rw:"],
      headlessTools: {
        command: BIN,
        args: ["mcp", "--project", "{workspaceRoot}"],
        listArgs: ["mcp", "--list-tools", "--project", "{workspaceRoot}"],
        cwd: "{workspaceRoot}",
      },
      liveTools: true,
      gatedTools: [],
      embedOrigins: ["http://127.0.0.1:*"],
    });
    expect(icon).toBe(iconDataUrl());
    expect(instructions).toBe(RW_LECTURN_INSTRUCTIONS);
  });

  it("meets Lecturn's field rules", () => {
    const reg = rocketwrightRegistration({ bin: BIN });
    expect(reg.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    expect(reg.toolPrefix).toMatch(/^[a-z0-9]{2,12}$/);
    for (const p of reg.refPrefixes) expect(p).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*:$/);
    for (const o of reg.embedOrigins ?? []) expect(o).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5}|\*)$/);
    expect(reg.headlessTools?.command.startsWith("/")).toBe(true);
  });

  it("ships a 128 px PNG icon under 64 KB", () => {
    const png = readFileSync(APP_ICON_PATH);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeLessThanOrEqual(64 * 1024);
    // IHDR width and height.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
    const url = iconDataUrl();
    expect(url.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
  });

  it("refuses an icon that is not a PNG or is over the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-icon-"));
    temps.push(dir);
    writeFileSync(join(dir, "a.png"), "GIF89a");
    expect(() => iconDataUrl(join(dir, "a.png"))).toThrow(/not a PNG/);
    writeFileSync(join(dir, "b.png"), Buffer.concat([readFileSync(APP_ICON_PATH).subarray(0, 8), Buffer.alloc(64 * 1024)]));
    expect(() => iconDataUrl(join(dir, "b.png"))).toThrow(/icon cap/);
  });

  it("keeps the instructions provider-neutral and under 8 KB", () => {
    expect(Buffer.byteLength(RW_LECTURN_INSTRUCTIONS)).toBeLessThanOrEqual(8 * 1024);
    expect(RW_LECTURN_INSTRUCTIONS).not.toMatch(/mcp__/);
    expect(RW_LECTURN_INSTRUCTIONS).not.toMatch(/\bClaude\b/);
  });

  it("names only tools the sidecar or the window serves, with the rw_ prefix", () => {
    const sidecarTools = readdirSync(join(REPO, "fixtures/contracts/tools")).map((f) => f.split(".")[0]!);
    const known = new Set([...sidecarTools, ...AGENT_OPS]);
    // Tool names are plain text (CPW2B): no backticks model code formatting for identifiers.
    const named = [...RW_LECTURN_INSTRUCTIONS.matchAll(/\brw_([a-z_]+)\b/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((t) => !known.has(t))).toEqual([]);
    // Every tool-like name carries the prefix.
    expect([...RW_LECTURN_INSTRUCTIONS.matchAll(/(?<!rw_)\b(model_patch|design_check|simulate|job_status)\b/g)]).toEqual([]);
  });

  it("resolves the rocketwright binary to an absolute path", () => {
    expect(absoluteSidecarBinary("/abs/rocketwright")).toBe("/abs/rocketwright");
    const dir = mkdtempSync(join(tmpdir(), "rw-path-"));
    temps.push(dir);
    const bin = join(dir, "rocketwright");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(absoluteSidecarBinary("rocketwright", { PATH: `/nonexistent:${dir}` })).toBe(bin);
    expect(() => absoluteSidecarBinary("rocketwright", { PATH: "/nonexistent" })).toThrow(/RW_SIDECAR_BIN/);
  });
});
