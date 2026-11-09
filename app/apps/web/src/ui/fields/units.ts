/**
 * Display and source units for every named dimension of the model. A field
 * shows one unit per dimension (length follows the toolbar Units) and writes
 * the source literal the engine parses, so a dimensioned value is never a bare
 * number, which the schema rejects (`x-unit-dimension`, `crates/rw-units`).
 *
 * A `dim` may pin its unit with `dimension:symbol` (`length:um`, `length:m`):
 * values whose range the toolbar unit would round away, and quantities the
 * product always states in one unit.
 */
import type { Units } from "../../state/index.ts";

export interface DisplayUnit {
  /** What the field shows (`kg/m³`); empty for a plain number. */
  unit: string;
  /** Display per SI. */
  per: number;
  digits: number;
  /** Added before scaling to SI (the absolute temperature scales only). */
  offset?: number;
  /** The source spelling, when it is not `unit` (`kg/m^3`). */
  source?: string;
  /** Spinner step in display units. */
  step?: number;
}

const LENGTH: Record<Units, { per: number; digits: number }> = {
  mm: { per: 1000, digits: 1 },
  cm: { per: 100, digits: 2 },
  m: { per: 1, digits: 4 },
  in: { per: 1 / 0.0254, digits: 3 },
};

const RAD_TO_DEG = 180 / Math.PI;

const BY_DIMENSION: Record<string, DisplayUnit | ((units: Units) => DisplayUnit)> = {
  length: (units) => ({ unit: units, ...LENGTH[units] }),
  mass: { unit: "g", per: 1000, digits: 1 },
  angle: { unit: "deg", per: RAD_TO_DEG, digits: 1 },
  time: { unit: "s", per: 1, digits: 2 },
  area: (units) => (units === "in" ? { unit: "in²", source: "in^2", per: 1 / 0.0254 ** 2, digits: 2 } : { unit: "cm²", source: "cm^2", per: 1e4, digits: 2 }),
  volume: { unit: "L", per: 1e3, digits: 3 },
  density: { unit: "kg/m³", source: "kg/m^3", per: 1, digits: 1, step: 1 },
  area_density: { unit: "g/m²", source: "g/m^2", per: 1e3, digits: 1, step: 1 },
  line_density: { unit: "g/m", per: 1e3, digits: 2, step: 0.1 },
  velocity: { unit: "m/s", per: 1, digits: 2, step: 0.1 },
  acceleration: { unit: "m/s²", source: "m/s^2", per: 1, digits: 2, step: 0.1 },
  force: { unit: "N", per: 1, digits: 2, step: 0.1 },
  pressure: { unit: "kPa", per: 1e-3, digits: 2, step: 1 },
  temperature: { unit: "°C", source: "degC", per: 1, digits: 1, offset: 273.15, step: 1 },
  impulse: { unit: "N·s", source: "N*s", per: 1, digits: 2, step: 0.1 },
  mass_flow: { unit: "g/s", per: 1e3, digits: 2 },
  angular_velocity: { unit: "deg/s", per: RAD_TO_DEG, digits: 1 },
  inertia: { unit: "kg·m²", source: "kg*m^2", per: 1, digits: 6 },
  energy: { unit: "J", per: 1, digits: 1 },
  power: { unit: "W", per: 1, digits: 1 },
  frequency: { unit: "Hz", per: 1, digits: 1 },
  torque: { unit: "N·m", source: "N*m", per: 1, digits: 3 },
  kinematic_viscosity: { unit: "m²/s", source: "m^2/s", per: 1, digits: 9 },
  dynamic_viscosity: { unit: "Pa·s", source: "Pa*s", per: 1, digits: 7 },
  specific_heat: { unit: "J/(kg·K)", source: "J/(kg*K)", per: 1, digits: 1 },
};

/** SI value of one source unit. */
const SOURCE_UNITS: Record<string, number> = {
  "%": 0.01,
  m: 1,
  km: 1e3,
  cm: 1e-2,
  mm: 1e-3,
  um: 1e-6,
  "µm": 1e-6,
  "μm": 1e-6,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  kg: 1,
  g: 1e-3,
  mg: 1e-6,
  lb: 0.45359237,
  oz: 0.45359237 / 16,
  s: 1,
  ms: 1e-3,
  min: 60,
  h: 3600,
  K: 1,
  degC: 1,
  "°C": 1,
  degF: 5 / 9,
  "°F": 5 / 9,
  rad: 1,
  deg: Math.PI / 180,
  "°": Math.PI / 180,
  L: 1e-3,
  l: 1e-3,
  mL: 1e-6,
  ml: 1e-6,
  cc: 1e-6,
  kph: 1 / 3.6,
  mph: 0.44704,
  kn: 1852 / 3600,
  gn: 9.80665,
  N: 1,
  mN: 1e-3,
  kN: 1e3,
  lbf: 0.45359237 * 9.80665,
  Pa: 1,
  hPa: 1e2,
  kPa: 1e3,
  MPa: 1e6,
  bar: 1e5,
  mbar: 1e2,
  atm: 101325,
  inHg: 3386.389,
  psi: (0.45359237 * 9.80665) / 0.0254 ** 2,
  J: 1,
  kJ: 1e3,
  W: 1,
  kW: 1e3,
  Hz: 1,
};

/** Only a bare absolute temperature carries an offset; inside a compound unit it is an interval. */
const SOURCE_OFFSETS: Record<string, number> = { degC: 273.15, "°C": 273.15, degF: 459.67, "°F": 459.67 };

const SHOWN: Record<string, string> = { um: "µm", degC: "°C", degF: "°F" };

function pinned(symbol: string): DisplayUnit {
  const scale = SOURCE_UNITS[symbol];
  if (scale === undefined) return { unit: "", per: 1, digits: 3 };
  const offset = SOURCE_OFFSETS[symbol];
  return {
    unit: SHOWN[symbol] ?? symbol,
    per: 1 / scale,
    digits: symbol === "um" ? 1 : (LENGTH[symbol as Units]?.digits ?? 3),
    source: symbol,
    ...(symbol === "um" ? { step: 1 } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

/** Display unit, SI → display factor, and decimals for a dimension. */
export function displayUnit(dim: string | undefined, units: Units): DisplayUnit {
  if (dim === undefined) return { unit: "", per: 1, digits: 3 };
  const colon = dim.indexOf(":");
  if (colon !== -1) return pinned(dim.slice(colon + 1));
  const row = BY_DIMENSION[dim];
  if (row === undefined) return { unit: "", per: 1, digits: 3 };
  return typeof row === "function" ? row(units) : row;
}

export function trimNum(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** SI → the number shown in the field (`0.09` m → `90` in mm). */
export function toDisplay(si: number | null | undefined, dim: string | undefined, units: Units): string {
  if (si == null || !Number.isFinite(si)) return "";
  const u = displayUnit(dim, units);
  return trimNum((si * u.per - (u.offset ?? 0)).toFixed(u.digits));
}

/** A typed display number → the source literal (`"90 mm"`), or a number for unitless fields. */
export function toSource(display: number, dim: string | undefined, units: Units): string | number {
  const u = displayUnit(dim, units);
  if (u.unit === "") {
    // The schema rejects a bare number on a dimensioned field, so this is a bug, not a value to write.
    if (dim !== undefined && dim !== "dimensionless") throw new Error(`No source unit for the dimension ${dim}.`);
    return display;
  }
  return `${trimNum(display.toFixed(Math.max(u.digits, 3)))} ${u.source ?? u.unit}`;
}

/** Display number → SI. */
export function fromDisplay(display: number, dim: string | undefined, units: Units): number {
  const u = displayUnit(dim, units);
  return (display + (u.offset ?? 0)) / u.per;
}

/** SI scale of a compound like `kg/m^3` or `N*s`; null for anything unknown. */
function compoundScale(unit: string): number | null {
  const parts = unit.split("/");
  if (parts.length > 2) return null;
  let scale = 1;
  for (const [i, raw] of parts.entries()) {
    const part = raw.replace(/^\((.*)\)$/, "$1");
    for (const term of part.split(/[*·]/)) {
      const m = /^([^\s^²³]+)(?:\^(-?\d+)|(²)|(³))?$/.exec(term.trim());
      if (m === null) return null;
      const k = SOURCE_UNITS[m[1]!];
      if (k === undefined) return null;
      const power = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? 2 : m[4] !== undefined ? 3 : 1;
      scale *= k ** (i === 0 ? power : -power);
    }
  }
  return scale;
}

/** `"120 mm"` → 0.12, in SI (simple literals only; expressions → null). */
export function parseLiteral(v: string | number | boolean | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(.*?)\s*$/.exec(v);
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2]!;
  if (unit === "") return n;
  const k = compoundScale(unit);
  return k === null ? null : (n + (SOURCE_OFFSETS[unit] ?? 0)) * k;
}
