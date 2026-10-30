/**
 * The vendored Lecturn install (plan B7, `make vendor-lecturn`): what the app
 * workspace got from vendor/lecturn/*.tgz, checked where B8 will load it.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const appRoot = join(repoRoot, "app");
const vendorDir = join(repoRoot, "vendor/lecturn");
const require = createRequire(import.meta.url);

interface PackDescriptor {
  packages: { lecturn: { name: string; version: string }; embed: { name: string; version: string } };
  pnpm: { publicHoistPattern: string[] };
}
const descriptor = JSON.parse(
  readFileSync(join(vendorDir, "lecturn-pack.json"), "utf8"),
) as PackDescriptor;

/** `<root>/node_modules/lecturn` as the app links it (a symlink in the isolated install). */
const lecturnLink = join(appRoot, "node_modules", "lecturn");

function installedManifest(dir: string): { name: string; version: string } {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
}

/** Walks up from `start` the way @cursor/sdk looks for its platform helper. */
function findCursorHelper(start: string): string | undefined {
  const name = `sdk-${process.platform}-${process.arch}`;
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@cursor", name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

describe("vendored Lecturn (B7)", () => {
  it("pins a full Lecturn commit", () => {
    const pin = readFileSync(join(vendorDir, "PIN"), "utf8").trim();
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
  });

  it("installs the kit's versions of lecturn and @lecturn/embed", () => {
    const { lecturn, embed } = descriptor.packages;
    expect(installedManifest(lecturnLink)).toMatchObject({ name: lecturn.name, version: lecturn.version });
    const embedDir = resolve(dirname(require.resolve("@lecturn/embed/node")), "..");
    expect(installedManifest(embedDir)).toMatchObject({ name: embed.name, version: embed.version });
  });

  it("ships the server entry and the bundled web client", () => {
    expect(existsSync(join(lecturnLink, "dist/bin.mjs"))).toBe(true);
    expect(existsSync(join(lecturnLink, "dist/client/index.html"))).toBe(true);
  });

  it("finds the Cursor helper from both the link and the real server entry", () => {
    expect(descriptor.pnpm.publicHoistPattern).toContain("@cursor/sdk-*");
    const dist = join(lecturnLink, "dist");
    expect(findCursorHelper(dist)).toBeDefined();
    expect(findCursorHelper(realpathSync(dist))).toBeDefined();
  });

  it("loads @lecturn/embed's node and browser entries", async () => {
    const node = (await import("@lecturn/embed/node")) as { connect?: unknown };
    const browser = (await import("@lecturn/embed/browser")) as { mountEmbed?: unknown };
    expect(typeof node.connect).toBe("function");
    expect(typeof browser.mountEmbed).toBe("function");
  });
});
