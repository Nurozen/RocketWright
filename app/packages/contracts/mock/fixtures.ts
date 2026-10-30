/**
 * Loads `fixtures/contracts/**.json` (M1.5): each file wraps one payload of a
 * `rw_api::schema_registry()` type. The Rust test `contract_fixtures` proves
 * every payload valid; the mock only serves them (or copies with fields it
 * owns changed: hashes, ids, states).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "../src/types.ts";

export const CONTRACT_FIXTURE = "contract-fixture" as const;

/** The repository root (this file is `app/packages/contracts/mock/fixtures.ts`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const DEFAULT_FIXTURES_DIR = join(REPO_ROOT, "fixtures/contracts");

export interface Fixture {
  /** Path relative to the fixtures directory. */
  file: string;
  /** Registry name (`check-report`, `tools/model_patch.output`). */
  type: string;
  payload: JsonValue;
}

export class FixtureSet {
  readonly all: readonly Fixture[];
  private readonly byType = new Map<string, Fixture[]>();
  private readonly byFile = new Map<string, Fixture>();

  constructor(fixtures: Fixture[]) {
    this.all = fixtures;
    for (const f of fixtures) {
      const list = this.byType.get(f.type) ?? [];
      list.push(f);
      this.byType.set(f.type, list);
      this.byFile.set(f.file, f);
    }
  }

  /** Every registry type with at least one fixture. */
  types(): string[] {
    return [...this.byType.keys()].sort();
  }

  /** All payloads of a type (deep copies). */
  ofType(type: string): JsonValue[] {
    return (this.byType.get(type) ?? []).map((f) => clone(f.payload));
  }

  /** A deep copy of the first payload of `type` (by file name), or of the fixture at `file` when given. */
  payload<T = JsonValue>(type: string, file?: string): T {
    const f = file === undefined ? this.byType.get(type)?.[0] : this.byFile.get(file);
    if (f === undefined || f.type !== type) throw new Error(`no contract fixture of type ${type}${file ? ` at ${file}` : ""}`);
    return clone(f.payload) as T;
  }
}

/** Reads every fixture under `dir`, sorted by path. */
export function loadFixtures(dir: string = DEFAULT_FIXTURES_DIR): FixtureSet {
  const out: Fixture[] = [];
  for (const path of walk(dir)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { provenance?: unknown; type?: unknown; payload?: JsonValue };
    if (raw.provenance !== CONTRACT_FIXTURE || typeof raw.type !== "string" || raw.payload === undefined) {
      throw new Error(`${path}: not a ${CONTRACT_FIXTURE} wrapper`);
    }
    out.push({ file: relative(dir, path).split("\\").join("/"), type: raw.type, payload: raw.payload });
  }
  if (out.length === 0) throw new Error(`no contract fixtures under ${dir}`);
  return new FixtureSet(out);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}
