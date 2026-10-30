/**
 * Configurations > Motors > Search ThrustCurve: the pure parts. The search
 * and download are the sidecar's `thrustcurve_search` / `thrustcurve_fetch`
 * (RocketWright's only network access, and only when the user clicks); the
 * rest of the picker stays on the offline built-in library.
 */
import type { schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { ALL, motorRef, type MotorFilters } from "./model.ts";

type Curve = DeepReadonly<schema.ThrustCurve>;
type TcMotor = DeepReadonly<schema.ThrustcurveMotor>;

/** `motor.thrustcurveSearch` criteria (minus `projectId`). */
export interface ThrustcurveCriteria {
  query?: string;
  manufacturer?: string;
  diameter?: string;
  impulse_class?: string;
  limit?: number;
}

/** The search the panel starts from: the picker's search text and filters ("All" and the generic library's maker are not sent). */
export function criteriaFromFilters(f: MotorFilters): ThrustcurveCriteria {
  const out: ThrustcurveCriteria = {};
  const q = f.query.trim();
  if (q !== "") out.query = q;
  if (f.diameter !== ALL && /^\d+(\.\d+)? mm$/.test(f.diameter)) out.diameter = f.diameter;
  if (f.impulseClass !== ALL) out.impulse_class = f.impulseClass;
  if (f.manufacturer !== ALL && f.manufacturer !== "Generic" && f.manufacturer !== "Unknown") out.manufacturer = f.manufacturer;
  return out;
}

/** True when the criteria name something to search for (the sidecar refuses an empty search). */
export const hasCriteria = (c: ThrustcurveCriteria) => [c.query, c.manufacturer, c.diameter, c.impulse_class].some((v) => v !== undefined && v.trim() !== "");

/** A result row: `Estes C6` and `18 mm · C · 8.82 N·s · 1.86 s burn` (dashes for what ThrustCurve leaves out). */
export function thrustcurveRow(m: TcMotor): { title: string; detail: string } {
  const n = (v: number | null | undefined, digits: number, unit: string) => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)} ${unit}` : "—");
  const diameter = typeof m.diameter === "number" ? `${Math.round(m.diameter * 1000)} mm` : "—";
  return {
    title: `${m.manufacturer} ${m.designation}`,
    detail: [diameter, m.impulse_class ?? "—", n(m.total_impulse, 2, "N·s"), `${n(m.burn_time, 2, "s")} burn`].join(" · "),
  };
}

/** The library list with downloaded curves added (a re-download replaces the same ref). */
export function mergeCurves(motors: readonly Curve[], curves: readonly Curve[]): Curve[] {
  const refs = new Set(curves.map(motorRef));
  return [...motors.filter((m) => !refs.has(motorRef(m))), ...curves];
}
