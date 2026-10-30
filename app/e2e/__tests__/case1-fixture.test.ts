import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../scripts/bar/parity.ts";
import { componentIdsByName, diffAgainst, generate, num, simToml, slug } from "../../../scripts/fixtures/case1-from-golden.ts";

describe("fixtures/case1 generator (M1.54b)", () => {
  it("the committed configs, sim, and manifest equal a fresh generation", () => {
    expect(diffAgainst(generate())).toEqual([]);
  });

  it("writes one config per oracle configuration id and the golden sim", () => {
    const files = [...generate().keys()].sort();
    expect(files).toContain("configs/5d9a2765-395d-4d9c-9678-38eed0988c72.rw.toml");
    expect(files).toContain("sims/simulation_5.rw.toml");
    expect(files.filter((f) => f.startsWith("configs/"))).toHaveLength(5);
  });

  it("writes every conditions field and refuses fields it cannot express", () => {
    const c = {
      rail_length_m: 1,
      rod_angle_deg: 0,
      rod_direction_deg: 90,
      site_altitude_m: 0,
      latitude_deg: 45,
      longitude_deg: 0,
      base_temperature_k: 288.15,
      base_pressure_pa: 101325,
      atmosphere: "ussa1976",
      geodetic: "flat",
      wind_speed_ms: 0,
      wind_direction_deg: 90,
      wind_turbulence: 0,
      time_step_s: 0.05,
      integrator: "rk4",
    };
    const t = simToml("Simulation 5", "cfg", c);
    for (const line of ['rail_length = "1 m"', 'base_temperature = "288.15 K"', 'dt = "0.05 s"', 'method = "rk4"', "turbulence = 0"]) {
      expect(t).toContain(line);
    }
    expect(() => simToml("s", "cfg", { ...c, gravity: { model: "wgs84" } })).toThrow();
    expect(canonicalJson(c)).toContain('"time_step_s":0.05');
  });

  it("helpers", () => {
    expect(slug("Simulation 5")).toBe("simulation_5");
    expect(slug("5 a")).toBe("sim_5_a");
    expect(num(101325)).toBe("101325");
    expect(() => num(1e-9)).toThrow();
    const ids = componentIdsByName('[c.mmt]\nname = "Inner Tube"\n[c.a]\nname = "Ring"\n[c.b]\nname = "Ring"\n');
    expect(ids.get("Inner Tube")).toEqual(["mmt"]);
    expect(ids.get("Ring")).toEqual(["a", "b"]);
  });
});
