/**
 * M4.3: the thermo tables ship beside the wasm (`pkg/thermo/*.rwtbl`, copied by `make wasm`, D19d) and load from the
 * local bundle with the network off (`RW_OFFLINE=1`, I10): `fetch` is stubbed to throw for the whole suite, and the
 * table URL must resolve to the package itself (`file:` here, `app://`/`http://127.0.0.1` in the app).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRwWasm, RwWasmError, THERMO_PAIRS, thermoTableUrl } from "./index.ts";
import type { RwWasm } from "./index.ts";

let rw: RwWasm;
const realFetch = globalThis.fetch;
const env = process.env.RW_OFFLINE;

beforeAll(async () => {
  process.env.RW_OFFLINE = "1";
  globalThis.fetch = (() => {
    throw new Error("network access under RW_OFFLINE=1");
  }) as typeof fetch;
  rw = await loadRwWasm(readFileSync(new URL("../pkg/rw_wasm_bg.wasm", import.meta.url)));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (env === undefined) delete process.env.RW_OFFLINE;
  else process.env.RW_OFFLINE = env;
});

function table(pair: (typeof THERMO_PAIRS)[number]): Uint8Array {
  const url = thermoTableUrl(pair);
  expect(url.protocol).toBe("file:");
  return new Uint8Array(readFileSync(fileURLToPath(url)));
}

describe("thermo tables", () => {
  it("bundles every shipped pair under pkg/thermo/", () => {
    for (const pair of THERMO_PAIRS) {
      const bytes = table(pair);
      expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("RWTBL01\n");
    }
  });

  it("interpolates LOX/ethanol at the CEA golden point (O/F 1.4, 20 bar, eps 4)", () => {
    const p = rw.thermoLookup(table("lox-ethanol"), { oxidizer: "lox", fuel: "ethanol", of: 1.4, pc: 20e5, eps: 4 });
    expect(p.mode).toBe("equilibrium");
    expect(Math.abs(p.chamber.t_c - 3107.2) / 3107.2).toBeLessThan(5e-3);
    expect(Math.abs(p.chamber.c_star - 1714.28) / 1714.28).toBeLessThan(5e-3);
    expect(p.nozzle).not.toBeNull();
    expect(Math.abs(p.nozzle!.isp - 2456.38) / 2456.38).toBeLessThan(5e-3);
    const frozen = rw.thermoLookup(table("lox-ethanol"), { of: 1.4, pc: 20e5, eps: 4, frozen: true });
    expect(frozen.mode).toBe("frozen");
    expect(frozen.nozzle!.isp).toBeLessThan(p.nozzle!.isp);
  });

  it("rejects mismatched propellants and out-of-range points", () => {
    expect(() => rw.thermoLookup(table("n2o-ipa"), { oxidizer: "lox", of: 4, pc: 20e5 })).toThrow(RwWasmError);
    expect(() => rw.thermoLookup(table("n2o-ipa"), { of: 40, pc: 20e5 })).toThrow(/outside the table range/);
  });
});
