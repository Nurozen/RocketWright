/**
 * Checks for scripts/vendor-lecturn.sh (plan B7). Node built-ins only: it runs
 * before app/ is installed.
 *
 *   node scripts/vendor/lecturn-kit.ts settings <lecturn-pack.json> <pnpm-workspace.yaml>
 *     Exit 1, listing what is missing, unless the workspace carries every
 *     allowBuilds entry, publicHoistPattern item and patchedDependencies
 *     selector (pointing at ../vendor/lecturn/patches/) the kit asks for.
 *   node scripts/vendor/lecturn-kit.ts lock <pnpm-lock.yaml> <vendor dir>
 *     Prints each vendored tarball whose sha512 differs from its lockfile
 *     integrity (nothing when they match or the lockfile has no entry).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface KitPnpm {
  allowBuilds: Record<string, boolean>;
  publicHoistPattern: string[];
  patchedDependencies: Record<string, string>;
}

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, "");

/** `key: value` pairs and `- item` entries of a YAML file, comments dropped. */
function yamlLines(text: string): { pairs: Array<[string, string]>; items: string[] } {
  const pairs: Array<[string, string]> = [];
  const items: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line.startsWith("- ")) {
      items.push(unquote(line.slice(2)));
      continue;
    }
    // Keys may be quoted and contain `@` and `/`; the value follows the first `: `.
    const m = /^('[^']+'|"[^"]+"|[^\s'":][^:]*?):\s+(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) pairs.push([unquote(m[1]), unquote(m[2])]);
  }
  return { pairs, items };
}

export function missingSettings(kit: KitPnpm, workspaceYaml: string): string[] {
  const { pairs, items } = yamlLines(workspaceYaml);
  const has = (key: string, value: string): boolean =>
    pairs.some(([k, v]) => k === key && v === value);
  const missing: string[] = [];
  for (const [name, allowed] of Object.entries(kit.allowBuilds)) {
    if (!has(name, String(allowed))) missing.push(`allowBuilds: ${name}: ${allowed}`);
  }
  for (const pattern of kit.publicHoistPattern) {
    if (!items.includes(pattern)) missing.push(`publicHoistPattern: - '${pattern}'`);
  }
  for (const [selector, patch] of Object.entries(kit.patchedDependencies)) {
    const target = `../vendor/lecturn/${patch}`;
    if (!has(selector, target)) missing.push(`patchedDependencies: '${selector}': ${target}`);
  }
  return missing;
}

const TARBALLS = [
  ["lecturn", "lecturn.tgz"],
  ["@lecturn/embed", "lecturn-embed.tgz"],
] as const;

/** Tarballs whose bytes no longer match the integrity the lockfile recorded. */
export function lockDrift(lockYaml: string, read: (file: string) => Buffer): string[] {
  const drift: string[] = [];
  for (const [name, file] of TARBALLS) {
    const key = `${name}@file:../vendor/lecturn/${file}`;
    const lines = lockYaml.split("\n");
    const at = lines.findIndex((l) => unquote(l.trim().replace(/:$/, "")) === key);
    const integrity = at < 0 ? undefined : /integrity: ([^,}\s]+)/.exec(lines[at + 1] ?? "")?.[1];
    if (integrity === undefined) continue;
    const actual = `sha512-${createHash("sha512").update(read(file)).digest("base64")}`;
    if (actual !== integrity) drift.push(file);
  }
  return drift;
}

function main(argv: string[]): number {
  const [command, first, second] = argv;
  if (command === "settings" && first !== undefined && second !== undefined) {
    const kit = (JSON.parse(readFileSync(first, "utf8")) as { pnpm: KitPnpm }).pnpm;
    const missing = missingSettings(kit, readFileSync(second, "utf8"));
    if (missing.length === 0) return 0;
    console.error(
      `vendor-lecturn: ${second} lacks the kit's pnpm settings (${first}):\n  ${missing.join("\n  ")}`,
    );
    return 1;
  }
  if (command === "lock" && first !== undefined && second !== undefined) {
    const lock = existsSync(first) ? readFileSync(first, "utf8") : "";
    const drift = lockDrift(lock, (file) => readFileSync(join(second, file)));
    if (drift.length > 0) console.log(drift.join(" "));
    return 0;
  }
  console.error("usage: lecturn-kit.ts settings <lecturn-pack.json> <pnpm-workspace.yaml> | lock <pnpm-lock.yaml> <vendor dir>");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
