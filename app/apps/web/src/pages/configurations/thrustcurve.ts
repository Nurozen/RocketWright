/**
 * Configurations > Motors: what the picker lists beyond the built-in library.
 * Search ThrustCurve's search and download are the sidecar's
 * `thrustcurve_search` / `thrustcurve_fetch` (RocketWright's only network
 * access, and only when the user clicks); the project's own motors come from
 * `motor.search` and `motor.show`, offline.
 */
import type { schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import type { RpcLike } from "../../state/rpc.ts";
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

/**
 * The project's own motors, with curves: `motor.search` lists them, and
 * `motor.show` loads each curve the picker needs (a search result has no
 * points or propellant mass). The built-in library already comes from WASM.
 * `cache` holds curves by id and file hash, so a refetch only asks for a
 * motor that is new or whose file changed.
 */
export async function loadProjectMotors(client: Pick<RpcLike, "call">, projectId: string, cache: Map<string, Curve>): Promise<Curve[]> {
  const { motors } = await client.call("motor.search", { projectId });
  const listed = motors.filter((m) => m.source.kind !== "generic");
  const show = async (id: string, key: string): Promise<Curve> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const { curve } = await client.call("motor.show", { projectId, id });
    cache.set(key, curve);
    return curve;
  };
  const curves = await Promise.all(listed.map((m) => show(m.id, `${m.id}@${m.sha256}`)));
  // `motor.search` sorts by impulse, but a config naming only the file flies the file's first curve, which only `motor.show` can tell.
  const byFile = new Map<string, number[]>();
  listed.forEach((m, i) => {
    if (m.source.kind !== "library") return;
    byFile.set(m.source.path, [...(byFile.get(m.source.path) ?? []), i]);
  });
  await Promise.all(
    [...byFile].map(async ([path, rows]) => {
      if (rows.length < 2) return;
      const first = await show(`lib:${path}`, `first:${path}@${listed[rows[0]!]!.sha256}`);
      const at = rows.find((i) => curves[i]!.designation.toLowerCase() === first.designation.toLowerCase());
      if (at === undefined || at === rows[0]) return;
      const head = rows[0]!;
      [curves[head], curves[at]] = [curves[at]!, curves[head]!];
    }),
  );
  return curves;
}
