import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readJson } from "../bar/paths.ts";
import {
  buildScoreboard,
  conditionsHash,
  gateFailures,
  loadKeymap,
  loadTolerances,
  motorDigest,
  oursFromRun,
  parseCases,
  parseTol,
  PRODUCERS,
  refreshOurs,
  scoreCase,
  selfTest,
  type Golden,
  type OurRun,
} from "../../../scripts/bar/parity.ts";

const keymap = loadKeymap();
const tols = loadTolerances();
const fixture = (name: string): Record<string, unknown> =>
  readJson<{ payload: Record<string, unknown> }>(join(REPO_ROOT, "fixtures/contracts", name)).payload;
const golden = fixture("oracle/golden.json") as unknown as Golden;
const generic = (): Golden => ({ ...golden, case: 1, matrix: "generic" });

function matchingOurs(g: Golden): OurRun {
  return {
    kind: "ours",
    case: g.case,
    matrix: g.matrix,
    sim_name: g.sim_name,
    config_id: g.config_id,
    geometry_sha256: g.geometry_sha256,
    conditions_hash: g.conditions_hash,
    motor_digest: g.motor_digest,
    summary: { apogee_m: 355, max_velocity_ms: 91, time_to_apogee_s: 8.25 },
    check: { "mass.cg": 0.2609, "aero.cp": 0.334, "aero.cna": 10.5, "stability.liftoff": 2.85 },
  };
}

describe("keymap.json and tolerances.json (spec B2)", () => {
  it("is the S:177 key map verbatim", () => {
    expect(keymap.summary).toEqual({
      max_altitude_m: "apogee_m",
      max_velocity_ms: "max_velocity_ms",
      max_accel_ms2: "max_accel_ms2",
      max_mach: "max_mach",
      time_to_apogee_s: "time_to_apogee_s",
      flight_time_s: "flight_time_s",
      ground_hit_velocity_ms: "landing_velocity_ms",
      rod_clear_velocity_ms: "rail_exit_velocity_ms",
      deployment_velocity_ms: "deployment_velocity_ms",
      optimum_delay_s: "optimum_delay_s",
    });
    expect(keymap.static).toEqual({
      cg_m: "mass.cg",
      cp_m: "aero.cp",
      cna: "aero.cna",
      stability_cal: "stability.liftoff",
    });
  });

  it("covers every oracle summary and static key of the golden schema", () => {
    expect(Object.keys(keymap.summary).sort()).toEqual(Object.keys(golden.summary).sort());
    for (const k of Object.keys(keymap.static)) expect(golden.static).toHaveProperty(k);
  });

  it("holds the S:179 tolerances", () => {
    expect(tols.gate_matrix).toBe("generic");
    const byCase = (c: number) => tols.groups.find((g) => g.cases.includes(c))?.tol;
    for (const c of [1, 2, 3, 5]) {
      expect(byCase(c)).toEqual({
        apogee_m: "3%",
        max_velocity_ms: "3%",
        time_to_apogee_s: "0.3 s",
        "mass.cg": "1 mm",
        "aero.cp": "3 mm",
        "stability.liftoff": "0.1 cal",
      });
    }
    expect(byCase(4)).toEqual({ apogee_m: "5%" });
    expect(byCase(6)).toEqual({ apogee_m: "7%" });
    expect(byCase(7)).toEqual({ apogee_m: "7%" });
  });

  it("parses tolerances into SI", () => {
    expect(parseTol("3%")).toEqual({ kind: "rel", frac: 0.03 });
    expect(parseTol("1 mm")).toEqual({ kind: "abs", si: 0.001 });
    expect(parseTol("0.3 s")).toEqual({ kind: "abs", si: 0.3 });
    expect(() => parseTol("3 furlongs")).toThrow();
  });
});

describe("hashes mirror rw_api::oracle", () => {
  it("recomputes the contract golden's conditions_hash and motor_digest", () => {
    expect(conditionsHash(golden.conditions)).toBe(golden.conditions_hash);
    expect(motorDigest(golden.motors.map((m) => m.digest))).toBe(golden.motor_digest);
  });

  it("assembles our run record from a RunManifest, RunSummary, and CheckReport", () => {
    const manifest = fixture("run-manifest.json") as unknown as Parameters<typeof oursFromRun>[0]["manifest"];
    const ours = oursFromRun({
      case: 1,
      matrix: "generic",
      config_id: "cfg",
      geometry_sha256: "0".repeat(64),
      manifest,
      summary: fixture("run-summary.json"),
      check: fixture("check-report.json"),
      metricPaths: Object.values(keymap.static),
    });
    expect(ours.motor_digest).toBe(motorDigest(["e8cf2af56dcc1b4c56e45032b7d9efb67f3d6c92f8716655d242b0b92d995761"]));
    expect(ours.summary["apogee_m"]).toBe(612.4);
    expect(ours.check["aero.cp"]).toBe(0.5774);
    expect(ours.check["stability.liftoff"]).toBe(1.71);
    expect(ours.summary).not.toHaveProperty("schema");
  });
});

describe("scoring", () => {
  it("report mode with no runs: every key of both matrices is not-run", () => {
    const empty = mkdtempSync(join(tmpdir(), "rw-parity-none-"));
    const sb = buildScoreboard({ oursDir: empty });
    expect(sb.rows.length).toBe(7 * 14 + 7 * 10);
    expect(sb.rows.every((r) => r.status === "not-run" && r.pass === null)).toBe(true);
    expect(sb.rows.filter((r) => r.matrix === "original").every((r) => !r.key.includes("."))).toBe(true);
    expect(gateFailures(sb).length).toBeGreaterThan(0);
  });

  it("scores a matching pair against the tolerances", () => {
    const g = generic();
    const rows = scoreCase(1, "generic", g, matchingOurs(g), keymap, tols);
    const by = (k: string) => rows.find((r) => r.key === k);
    expect(by("apogee_m")).toMatchObject({ status: "pass", ours: 355, golden: 350, delta: 5, tol: "3%", pass: true });
    expect(by("max_velocity_ms")?.status).toBe("pass");
    expect(by("time_to_apogee_s")).toMatchObject({ status: "pass", delta: 0.25 });
    expect(by("mass.cg")).toMatchObject({ status: "pass", delta: 0.0009 });
    expect(by("aero.cp")).toMatchObject({ status: "fail", pass: false });
    expect(by("aero.cna")).toMatchObject({ status: "report", pass: null, tol: null });
    expect(by("max_accel_ms2")).toMatchObject({ status: "missing", golden: 150, ours: null });
  });

  it.each(["geometry_sha256", "conditions_hash", "config_id", "sim_name", "motor_digest"] as const)(
    "rejects a %s mismatch before scoring",
    (field) => {
      const g = generic();
      const ours = { ...matchingOurs(g), [field]: field.endsWith("hash") ? "sha256:" + "f".repeat(64) : "f".repeat(64) };
      const rows = scoreCase(1, "generic", g, ours, keymap, tols);
      expect(rows.length).toBe(14);
      for (const r of rows) {
        expect(r.status).toBe("mismatch");
        expect(r.pass).toBeNull();
        expect(r.delta).toBeNull();
        expect(r.reason).toContain(field);
      }
    },
  );

  it("rejects a golden whose own hashes do not recompute", () => {
    const g = { ...generic(), conditions: { ...generic().conditions, rail_length_m: 2 } };
    const rows = scoreCase(1, "generic", g, matchingOurs(generic()), keymap, tols);
    expect(rows.every((r) => r.status === "mismatch")).toBe(true);
    expect(rows[0]?.reason).toContain("golden conditions_hash");
  });

  it("filters keys by either side's name", () => {
    const g = generic();
    const rows = scoreCase(1, "generic", g, matchingOurs(g), keymap, tols, ["max_altitude_m", "mass.cg"]);
    expect(rows.map((r) => r.key)).toEqual(["apogee_m", "mass.cg"]);
  });

  it("the CLI self-test catches a planted digest mismatch", () => {
    expect(selfTest()).toEqual([]);
  });

  it("refreshes only cases with a producer and reports a failed producer", () => {
    expect(Object.keys(PRODUCERS)).toEqual(["1"]);
    const dir = mkdtempSync(join(tmpdir(), "rw-parity-refresh-"));
    expect(refreshOurs([2, 3], dir, "/nonexistent/cargo")).toEqual([]);
    const errors = refreshOurs([1], dir, "/nonexistent/cargo");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("case 1");
  });

  it("parses CASE selections", () => {
    expect(parseCases(undefined)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseCases("2..7")).toEqual([2, 3, 4, 5, 6, 7]);
    expect(parseCases("1,3,5")).toEqual([1, 3, 5]);
    expect(() => parseCases("x")).toThrow();
  });
});
