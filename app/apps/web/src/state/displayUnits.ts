/**
 * The units flight results are shown in (R3.5). The engine, run records and
 * Export CSV stay SI; this is the one place that turns an SI number into the
 * number on screen, so the run table, plot axes, legends and run details
 * agree. It only scales numbers the engine produced.
 */
import type { PatchOp } from "@rw/contracts";
import { parse } from "smol-toml";
import type { AppState, DeepReadonly, Units } from "./types.ts";

export type UnitSystem = "metric" | "imperial";

/** The toolbar's length units. */
export const LENGTH_UNITS: readonly Units[] = ["mm", "cm", "m", "in"];

/** What a project with no `[display_units]` table shows. */
export const DEFAULT_LENGTH_UNIT: Units = "mm";

export function isLengthUnit(unit: string | undefined): unit is Units {
  return (LENGTH_UNITS as readonly string[]).includes(unit ?? "");
}

export type FlightDim = "length" | "velocity" | "acceleration" | "mass" | "force" | "wind" | "pressure" | "temperature";

export interface FlightUnit {
  unit: string;
  /** Display per SI. */
  per: number;
  /** Added after scaling (the temperature scales only). */
  offset?: number;
}

// Exact definitions, as in `crates/rw-units/src/table.rs`.
const FOOT = 0.3048;
const POUND = 0.45359237;
const LBF = POUND * 9.80665;
const MPH = 0.44704;
const INHG = 3386.389;

const FLIGHT_UNITS: Readonly<Record<UnitSystem, Readonly<Record<FlightDim, FlightUnit>>>> = {
  metric: {
    length: { unit: "m", per: 1 },
    velocity: { unit: "m/s", per: 1 },
    acceleration: { unit: "m/s²", per: 1 },
    mass: { unit: "kg", per: 1 },
    force: { unit: "N", per: 1 },
    wind: { unit: "m/s", per: 1 },
    pressure: { unit: "hPa", per: 0.01 },
    temperature: { unit: "°C", per: 1, offset: -273.15 },
  },
  imperial: {
    length: { unit: "ft", per: 1 / FOOT },
    velocity: { unit: "ft/s", per: 1 / FOOT },
    acceleration: { unit: "ft/s²", per: 1 / FOOT },
    mass: { unit: "lb", per: 1 / POUND },
    force: { unit: "lbf", per: 1 / LBF },
    wind: { unit: "mph", per: 1 / MPH },
    pressure: { unit: "inHg", per: 1 / INHG },
    temperature: { unit: "°F", per: 9 / 5, offset: -459.67 },
  },
};

export function flightUnit(dim: FlightDim, system: UnitSystem): FlightUnit {
  return FLIGHT_UNITS[system][dim];
}

/** An SI value in the system's unit; a missing value stays missing, for `fmtNum`'s dash. */
export function toFlight<T extends number | null | undefined>(si: T, dim: FlightDim, system: UnitSystem): T | number {
  if (typeof si !== "number") return si;
  const u = FLIGHT_UNITS[system][dim];
  return si * u.per + (u.offset ?? 0);
}

export const MANIFEST = "rocketwright.toml";
const IMPERIAL_LENGTHS = new Set(["in", "ft", "yd", "mi"]);

// A selector reads this on every store update; the manifest text rarely changes.
let lastParsed: { text: string; table: Record<string, unknown> | null } | null = null;

/** The manifest's `display_units` table, in whichever TOML form it was written; null when absent or unreadable. */
function displayUnitsTable(manifest: string): Record<string, unknown> | null {
  if (lastParsed?.text === manifest) return lastParsed.table;
  let table: Record<string, unknown> | null = null;
  try {
    const value = parse(manifest)["display_units"];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) table = value as Record<string, unknown>;
  } catch {
    // Rust reports a manifest it cannot read; the toolbar just keeps what it shows.
  }
  lastParsed = { text: manifest, table };
  return table;
}

/** The `[display_units]` table of a manifest's text (keys are dimension names plus `altitude`). */
export function manifestDisplayUnits(manifest: string | undefined): Record<string, string> {
  if (manifest === undefined) return {};
  const table = displayUnitsTable(manifest);
  if (table === null) return {};
  return Object.fromEntries(Object.entries(table).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/**
 * The system this project's results read in. `altitude` is the manifest's own
 * key for flight distances, so it decides when present. Otherwise a project
 * whose lengths are imperial, or the toolbar Units set to inches, reads
 * imperial; everything else stays metric.
 */
export function unitSystemOf(s: DeepReadonly<Pick<AppState, "project" | "ui">>): UnitSystem {
  const declared = manifestDisplayUnits(s.project.snapshot?.files.files[MANIFEST]);
  const altitude = declared["altitude"];
  if (altitude !== undefined) return IMPERIAL_LENGTHS.has(altitude) ? "imperial" : "metric";
  const length = declared["length"];
  return (length !== undefined && IMPERIAL_LENGTHS.has(length)) || s.ui.units === "in" ? "imperial" : "metric";
}

/**
 * The ops for the toolbar's Units control to set the project's length unit
 * (R3.4). Keeps `unitSystemOf` agreeing with the choice: an existing `altitude`
 * key decides the flight results, so moving between metric and imperial moves
 * it too. Per key when the table exists, so entries the toolbar does not
 * know about are left alone. `add` replaces a key already there.
 */
export function displayLengthOps(manifest: string | undefined, units: Units): PatchOp[] {
  const declared = manifestDisplayUnits(manifest);
  const imperial = IMPERIAL_LENGTHS.has(units);
  const altitude = declared["altitude"];
  const changes: Record<string, string> = { length: units };
  if (altitude !== undefined && IMPERIAL_LENGTHS.has(altitude) !== imperial) changes["altitude"] = imperial ? "ft" : "m";
  if (manifest === undefined || displayUnitsTable(manifest) === null) return [{ op: "add", path: "/project/display_units", value: changes }];
  return Object.entries(changes).map(([key, value]) => ({ op: "add", path: `/project/display_units/${key}`, value }));
}
