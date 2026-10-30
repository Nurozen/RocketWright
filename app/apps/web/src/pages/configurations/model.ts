/**
 * Page 03 view model (M2.10, concepts.md §4.3): configuration rows with a
 * derived simulation status (computed from the runs of the sims that fly the
 * configuration, never stored, I7), motor mounts, the motor picker's
 * filters, and the patch ops behind New / Duplicate / Rename / Delete /
 * Assign. Pure.
 */
import type { EvaluatedModel, HistoryStep, JobInfo, PatchOp, RunListOut, schema } from "@rw/contracts";
import { formatDate } from "../../shell/format.ts";
import { statusOf, type StatusView } from "../../state/status.ts";
import type { DeepReadonly } from "../../state/index.ts";

type Model = DeepReadonly<EvaluatedModel>;
type Run = DeepReadonly<RunListOut["runs"][number]>;
type Curve = DeepReadonly<schema.ThrustCurve>;

export type ConfigStatusKind = "simulated" | "not_simulated" | "outdated" | "running" | "failed";

export interface ConfigStatus {
  kind: ConfigStatusKind;
  /** `Simulated · Oct 15, 2026`. */
  label: string;
  /** Status vocabulary glyph and tone (teal check, amber warning, muted dash). */
  view: Pick<StatusView, "icon" | "tone" | "label"> & { reason?: string };
  date: string | null;
}

export interface ConfigRow {
  id: string;
  name: string;
  /** `RW_B4G` per mount, joined. */
  motor: string;
  /** Deployed recovery devices (`Parachute (stowed)`), joined; `None` when nothing deploys. */
  recovery: string;
  sims: string[];
  status: ConfigStatus;
}

const motorName = (ref: string | null | undefined): string => (ref == null || ref === "" ? "No motor" : ref.replace(/^generic:/, "").replace(/^lib:.*\//, ""));

/** Date of the history step whose model a run flew (runs carry the model hash, not a time). */
function runDate(run: Run, steps: readonly DeepReadonly<HistoryStep>[]): string | null {
  if (run.model_hash == null) return null;
  const st = [...steps].reverse().find((s) => s.model_hash === run.model_hash);
  return st !== undefined ? formatDate(st.ts) : null;
}

/** Aggregates the runs of a configuration's sims: running, then simulated, outdated, failed, not simulated. */
export function configStatus(sims: readonly string[], runs: readonly Run[], modelHash: string | null, steps: readonly DeepReadonly<HistoryStep>[], jobs: readonly DeepReadonly<JobInfo>[] = []): ConfigStatus {
  const latest = runs.filter((r) => sims.includes(r.sim) && r.superseded_by == null);
  const views = latest.map((r) => ({
    run: r,
    v: statusOf({ kind: "run", run: r as RunListOut["runs"][number], modelHash, job: (jobs.find((j) => j.sim === r.sim && (j.state === "running" || j.state === "queued")) ?? null) as JobInfo | null }),
  }));
  const pick = (k: string) => views.filter((x) => x.v.kind === k);
  const running = [...pick("running"), ...pick("queued")];
  if (running.length > 0) return { kind: "running", label: "Running…", view: { icon: "spinner", tone: "teal", label: "Running" }, date: null };
  const done = pick("complete");
  if (done.length > 0) {
    const date = runDate(done[0]!.run, steps);
    return { kind: "simulated", label: date ? `Simulated · ${date}` : "Simulated", view: { icon: "check", tone: "teal", label: "Simulated" }, date };
  }
  const old = pick("outdated");
  if (old.length > 0) {
    const date = runDate(old[0]!.run, steps);
    return {
      kind: "outdated",
      label: date ? `Outdated · ${date}` : "Outdated",
      view: { icon: "warning", tone: "amber", label: "Outdated", reason: "The model changed after this configuration last flew." },
      date,
    };
  }
  if (pick("failed").length > 0) return { kind: "failed", label: "Failed", view: { icon: "error", tone: "danger", label: "Failed" }, date: null };
  return { kind: "not_simulated", label: "Not simulated", view: { icon: "dot", tone: "muted", label: "Not simulated" }, date: null };
}

export function configRows(model: Model | null, runs: readonly Run[], steps: readonly DeepReadonly<HistoryStep>[], jobs: readonly DeepReadonly<JobInfo>[] = []): ConfigRow[] {
  if (model === null) return [];
  const names = new Map(model.components.map((c) => [c.id, c.name] as const));
  return Object.values(model.configs)
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map((c) => {
      const sims = Object.values(model.sims)
        .filter((s): s is NonNullable<typeof s> => s != null && s.config === c.id)
        .map((s) => s.id);
      const deployed = c.deployments.filter((d) => d.event !== "never").map((d) => names.get(d.component) ?? d.component);
      return {
        id: c.id,
        name: c.name,
        motor: c.motors.length === 0 ? "No motor" : c.motors.map((m) => motorName(m.motor ?? m.engine)).join(", "),
        recovery: deployed.length === 0 ? "None" : deployed.join(", "),
        sims,
        status: configStatus(sims, runs, model.model_hash, steps, jobs),
      };
    });
}

export interface Mount {
  id: string;
  name: string;
  /** Inner diameter (the motor fits it), m. */
  diameter: number;
  /** Standard motor diameter the bore takes (`18 mm` for a 19 mm bore), m. */
  nominal: number;
  length: number;
  x_fore: number;
  x_aft: number;
  /** Stage the mount belongs to (multi-stage vehicles). */
  stage?: string;
}

/** Motor mounts: inner tubes flagged `motor_mount` (or any mount a config names). */
export function motorMounts(model: Model | null): Mount[] {
  if (model === null) return [];
  const named = new Set(Object.values(model.configs).flatMap((c) => c?.motors.map((m) => m.mount) ?? []));
  return model.components
    .filter((c) => c.shape.type === "inner_tube" && ((c.shape as { motor_mount?: boolean }).motor_mount === true || named.has(c.id)))
    .map((c) => {
      const s = c.shape as { id?: number; od?: number; length?: number };
      const d = s.id ?? s.od ?? 0;
      const out: Mount = { id: c.id, name: c.name, diameter: d, nominal: nominalMount(d), length: s.length ?? c.x_aft - c.x_fore, x_fore: c.x_fore, x_aft: c.x_aft };
      if (c.stage != null) out.stage = c.stage;
      return out;
    });
}

/** Standard model/HPR motor diameters (m). */
export const MOTOR_DIAMETERS = [0.013, 0.018, 0.024, 0.029, 0.038, 0.054, 0.075, 0.098] as const;

/** The largest standard motor diameter a bore takes (within 0.5 mm), else the bore. */
export function nominalMount(bore: number): number {
  const fit = MOTOR_DIAMETERS.filter((d) => d <= bore + 0.0005);
  return fit.length > 0 ? fit[fit.length - 1]! : bore;
}

/** Whether a motor fits a mount: diameter within 0.6 mm under the bore, length within the tube. */
export function fitsMount(m: Curve, mount: Mount | undefined): boolean {
  if (mount === undefined) return true;
  return m.diameter <= mount.diameter + 1e-4 && m.diameter >= mount.diameter - 0.0012 && m.length <= mount.length + 1e-6;
}

export interface MotorFilters {
  query: string;
  diameter: string;
  manufacturer: string;
  impulseClass: string;
}

export const ALL = "All";

export const diameterLabel = (d: number) => `${Math.round(d * 1000)} mm`;

export function filterOptions(motors: readonly Curve[]): { diameter: string[]; manufacturer: string[]; impulseClass: string[] } {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    diameter: [ALL, ...uniq([...motors].sort((a, b) => a.diameter - b.diameter).map((m) => diameterLabel(m.diameter)))],
    manufacturer: [ALL, ...uniq(motors.map((m) => manufacturerLabel(m)).sort())],
    impulseClass: [ALL, ...uniq(motors.map((m) => m.class).sort())],
  };
}

/** `Generic` for the built-in library (RocketWright-authored curves), else the file's manufacturer. */
export function manufacturerLabel(m: Curve): string {
  return m.source.kind === "generic" ? "Generic" : (m.manufacturer ?? "Unknown");
}

export function filterMotors(motors: readonly Curve[], f: MotorFilters): Curve[] {
  const q = f.query.trim().toLowerCase();
  return motors.filter(
    (m) =>
      (q === "" || m.designation.toLowerCase().includes(q) || (m.manufacturer ?? "").toLowerCase().includes(q) || m.class.toLowerCase() === q) &&
      (f.diameter === ALL || diameterLabel(m.diameter) === f.diameter) &&
      (f.manufacturer === ALL || manufacturerLabel(m) === f.manufacturer) &&
      (f.impulseClass === ALL || m.class === f.impulseClass),
  );
}

/** Motor ref of a curve as a config writes it: `generic:<id>`, `lib:motors/<file>#<designation>` for a project library file, else the designation. */
export function motorRef(m: Curve): string {
  const src = m.source as DeepReadonly<schema.MotorSource>;
  if (src.kind === "generic") return `generic:${src.id}`;
  if (src.kind === "library") return `lib:${src.path.replace(/^lib\//, "")}#${m.designation}`;
  return m.designation;
}

/**
 * A candidate motor picked in the Motors list for comparison: valid only for
 * the configuration/mount it was picked on (`key` = `<config>/<mount>`) and
 * while that mount still flies the motor it flew then (`base`).
 */
export interface MotorPick {
  key: string;
  base: string | null;
  motor: string;
}

/**
 * The motor the detail (title, curve, casing) shows: the selected
 * configuration's mounted motor (`configs.<id>.motors.<mount>.motor`),
 * unless a candidate was picked on this same configuration and mount since
 * its motor last changed. Changing the configuration, the mount, or the
 * mounted motor (assign, agent patch, undo) drops back to the mounted motor.
 */
export function detailMotorRef(pick: MotorPick | null | undefined, key: string, assigned: string | null): string | null {
  return pick != null && pick.key === key && pick.base === assigned ? pick.motor : assigned;
}

/** `RW_B4G` → `B4` style short designation is not needed: show the file designation. */
export const motorTitle = (m: Curve) => m.designation;

// ---- patch ops ------------------------------------------------------------------

/** A config/sim id from a name, unique among `taken` (`Higher altitude` → `higher_altitude_2`). */
export function uniqueId(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "config";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

const takenIds = (m: Model) => [...Object.keys(m.configs), ...Object.keys(m.sims)];

const seconds = (s: number) => `${Number(s.toFixed(3))} s`;

/** Duplicate: the config and its first sim, copied (New and Duplicate also create a linked simulation, C §4.3). */
export function duplicateOps(m: Model, sourceId: string, name: string): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, takenIds(m));
  const ops: PatchOp[] = [
    { op: "copy", from: `/configs/${sourceId}`, path: `/configs/${id}` },
    { op: "replace", path: `/configs/${id}/name`, value: name },
  ];
  const sim = Object.values(m.sims).find((s) => s?.config === sourceId);
  if (sim != null) {
    ops.push(
      { op: "copy", from: `/sims/${sim.id}`, path: `/sims/${id}` },
      { op: "replace", path: `/sims/${id}/name`, value: name },
      { op: "replace", path: `/sims/${id}/config`, value: id },
    );
  } else {
    ops.push({ op: "add", path: `/sims/${id}`, value: { name, config: id } });
  }
  return { id, ops };
}

/**
 * New: a configuration with the smallest fitting motor on each mount, the
 * main parachute at ejection, and a sim that flies it in the environment of
 * the project's first sim.
 */
export function newConfigOps(m: Model, motors: readonly Curve[], name = "New configuration"): { id: string; ops: PatchOp[] } {
  const id = uniqueId(name, takenIds(m));
  const mountsVal: Record<string, { motor: string; delay: string }> = {};
  for (const mt of motorMounts(m)) {
    const fit = motors.find((c) => fitsMount(c, mt)) ?? motors[0];
    if (fit !== undefined) mountsVal[mt.id] = { motor: motorRef(fit), delay: seconds(fit.delays[0] ?? 3) };
  }
  const deploy: Record<string, { event: string }> = {};
  let main = false;
  for (const c of m.components) {
    if (c.shape.type !== "parachute" && c.shape.type !== "streamer") continue;
    deploy[c.id] = { event: !main && c.shape.type === "parachute" ? "ejection" : "never" };
    if (c.shape.type === "parachute") main = true;
  }
  const value: Record<string, unknown> = { name, motors: mountsVal, deploy };
  const ops: PatchOp[] = [{ op: "add", path: `/configs/${id}`, value: value as never }];
  const first = Object.values(m.sims).find((s) => s != null);
  if (first != null) {
    ops.push(
      { op: "copy", from: `/sims/${first.id}`, path: `/sims/${id}` },
      { op: "replace", path: `/sims/${id}/name`, value: name },
      { op: "replace", path: `/sims/${id}/config`, value: id },
    );
  } else {
    ops.push({ op: "add", path: `/sims/${id}`, value: { name, config: id } });
  }
  return { id, ops };
}

export function renameOps(id: string, name: string, sims: readonly string[], m: Model): PatchOp[] {
  const ops: PatchOp[] = [{ op: "replace", path: `/configs/${id}/name`, value: name }];
  // A sim named like its configuration follows the rename.
  const old = m.configs[id]?.name;
  for (const s of sims) if (m.sims[s]?.name === old) ops.push({ op: "replace", path: `/sims/${s}/name`, value: name });
  return ops;
}

/** Delete: the configuration and the sims that fly it (a sim cannot name a missing config). */
export function deleteOps(id: string, sims: readonly string[]): PatchOp[] {
  return [{ op: "remove", path: `/configs/${id}` }, ...sims.map((s): PatchOp => ({ op: "remove", path: `/sims/${s}` }))];
}

export function assignOps(cfg: string, mount: string, m: Curve, delay: number | null, existing: boolean): PatchOp[] {
  const value: Record<string, string> = { motor: motorRef(m) };
  if (delay !== null) value["delay"] = seconds(delay);
  return existing
    ? [
        { op: "replace", path: `/configs/${cfg}/motors/${mount}/motor`, value: value["motor"]! },
        ...(delay !== null ? [{ op: "add", path: `/configs/${cfg}/motors/${mount}/delay`, value: value["delay"]! } as PatchOp] : []),
      ]
    : [{ op: "add", path: `/configs/${cfg}/motors/${mount}`, value: value as never }];
}

export const DEPLOY_EVENTS = ["ejection", "apogee", "altitude", "timer", "never"] as const;
export const DEPLOY_LABEL: Record<(typeof DEPLOY_EVENTS)[number], string> = {
  ejection: "At ejection charge",
  apogee: "At apogee",
  altitude: "At altitude (descent)",
  timer: "Timer after launch",
  never: "Not deployed",
};

export function deployOps(cfg: string, component: string, event: string, existing: boolean): PatchOp[] {
  return existing ? [{ op: "replace", path: `/configs/${cfg}/deploy/${component}/event`, value: event }] : [{ op: "add", path: `/configs/${cfg}/deploy/${component}`, value: { event } }];
}

// ---- recovery and stage settings (R6.5) -----------------------------------------

export type ConfigFiles = Readonly<Record<string, string | undefined>>;

/** Source text of a configuration (`configs/<id>.rw.toml`). */
const configText = (files: ConfigFiles, cfg: string) => files[`configs/${cfg}.rw.toml`] ?? "";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A TOML key as a header segment: bare or quoted. */
const seg = (k: string) => `(?:${esc(k)}|"${esc(k)}")`;

/**
 * What a configuration's source already holds for `[<table>.<key>]`:
 * `entry` (the sub-table exists, so a field can be set in place), `table`
 * (only `<table>` exists), or `none`.
 */
export function configSourceLevel(files: ConfigFiles, cfg: string, table: string, key: string): "entry" | "table" | "none" {
  const text = configText(files, cfg);
  const entry = new RegExp(`^\\s*\\[\\s*${seg(table)}\\s*\\.\\s*${seg(key)}\\s*\\]`, "m");
  // `[deploy]` followed (before the next header) by `chute = { … }`.
  const inline = new RegExp(`^\\s*\\[\\s*${seg(table)}\\s*\\]\\s*$(?:\\n(?!\\s*\\[).*)*?\\n\\s*${seg(key)}\\s*=`, "m");
  if (entry.test(text) || inline.test(text)) return "entry";
  const any = new RegExp(`^\\s*(?:\\[\\s*${seg(table)}\\s*[.\\]]|${seg(table)}\\s*=)`, "m");
  return any.test(text) ? "table" : "none";
}

/**
 * Sets `<table>.<key>.<field>` on a configuration: in place when the entry
 * exists, else adds the entry (with `base`, e.g. a deployment's required
 * `event`) or the whole table. JSON Patch `add` on an object member also
 * replaces it, so one op covers set and overwrite.
 */
export function configFieldOps(files: ConfigFiles, cfg: string, table: string, key: string, field: string, value: unknown, base: Record<string, unknown> = {}): PatchOp[] {
  const level = configSourceLevel(files, cfg, table, key);
  if (level === "entry") return [{ op: "add", path: `/configs/${cfg}/${table}/${key}/${field}`, value: value as never }];
  const entry = { ...base, [field]: value };
  if (level === "table") return [{ op: "add", path: `/configs/${cfg}/${table}/${key}`, value: entry as never }];
  return [{ op: "add", path: `/configs/${cfg}/${table}`, value: { [key]: entry } as never }];
}

/** Removes `<table>.<key>.<field>` when the source sets it (else nothing). */
export function configFieldRemoveOps(files: ConfigFiles, cfg: string, table: string, key: string, field: string): PatchOp[] {
  if (configSourceLevel(files, cfg, table, key) !== "entry") return [];
  const text = configText(files, cfg);
  const block = new RegExp(`^\\s*\\[\\s*${seg(table)}\\s*\\.\\s*${seg(key)}\\s*\\]\\s*$((?:\\n(?!\\s*\\[).*)*)`, "m").exec(text);
  const has = block !== null ? new RegExp(`^\\s*${seg(field)}\\s*=`, "m").test(block[1] ?? "") : new RegExp(`${seg(key)}\\s*=\\s*\\{[^}]*\\b${esc(field)}\\s*=`).test(text);
  return has ? [{ op: "remove", path: `/configs/${cfg}/${table}/${key}/${field}` }] : [];
}

/** A deployment's event, written so the entry exists (a new entry is just `{ event }`). */
export function deployEventOps(files: ConfigFiles, cfg: string, component: string, event: string): PatchOp[] {
  return configFieldOps(files, cfg, "deploy", component, "event", event);
}

/** Altitude display unit: feet with inch lengths, else metres. */
export function altitudeUnit(units: string): { unit: "m" | "ft"; per: number } {
  return units === "in" ? { unit: "ft", per: 1 / 0.3048 } : { unit: "m", per: 1 };
}

/** Altitude (m) as the field shows it (`150`, `492.1`). */
export function altitudeDisplay(m: number | null | undefined, units: string): string {
  if (m == null || !Number.isFinite(m)) return "";
  const u = altitudeUnit(units);
  return String(Number((m * u.per).toFixed(1)));
}

/** Typed altitude → source literal (`"150 m"`, `"500 ft"`), or an error message. */
export function altitudeSource(text: string, units: string): { value: string } | { error: string } {
  const t = text.trim();
  if (t === "") return { error: "Enter the deployment altitude." };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: "The altitude needs a number." };
  if (n <= 0) return { error: "The altitude must be above the launch site (greater than 0)." };
  return { value: `${Number(n.toFixed(3))} ${altitudeUnit(units).unit}` };
}

/** Where a mounted motor's ejection delay comes from (R20-03). */
export interface EjectionDelayState {
  /** `manufacturer`: one of the delays the motor file lists; `custom`: any other value (or the user chose to type one). */
  source: "manufacturer" | "custom";
  /** The delays the motor file lists (s), ascending. */
  listed: number[];
  /** The listed delay nearest the configured one (what "use manufacturer data" switches back to), else the first listed. */
  nearest: number | null;
}

/**
 * The ejection delay's source for a configured `delay` (s; null when unset)
 * against the motor file's `listed` delays: manufacturer when it is one of
 * them (or unset and the file lists any), custom otherwise or when
 * `preferCustom` (the user unticked "Use manufacturer data").
 */
export function ejectionDelayState(delay: number | null, listed: readonly number[], preferCustom = false): EjectionDelayState {
  const sorted = [...listed].sort((a, b) => a - b);
  const onList = delay === null ? sorted.length > 0 : sorted.some((d) => Math.abs(d - delay) < 1e-6);
  const nearest = sorted.length === 0 ? null : delay === null ? sorted[0]! : sorted.reduce((a, b) => (Math.abs(b - delay) < Math.abs(a - delay) ? b : a));
  return { source: onList && !preferCustom ? "manufacturer" : "custom", listed: sorted, nearest };
}

/** Seconds for display: `3 s`, `1.5 s`. */
export const fmtSeconds = (s: number) => `${Number(s.toFixed(2))} s`;

/** Typed delay (s) → source literal (`"1.5 s"`), or an error message. */
export function delaySource(text: string, label = "The delay"): { value: string } | { error: string } {
  const t = text.trim();
  if (t === "") return { error: `${label} needs a value.` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: `${label} needs a number.` };
  if (n < 0) return { error: `${label} must be 0 s or more.` };
  return { value: seconds(n) };
}

export const SEPARATION_EVENTS = ["upper_ignition", "burnout", "ejection", "launch", "never"] as const;
export const SEPARATION_LABEL: Record<(typeof SEPARATION_EVENTS)[number], string> = {
  upper_ignition: "Upper stage ignition",
  burnout: "Burnout of this stage",
  ejection: "Ejection charge",
  launch: "At launch",
  never: "Never",
};

export const IGNITION_EVENTS = ["launch", "previous_burnout", "stage_separation", "never"] as const;
export const IGNITION_LABEL: Record<(typeof IGNITION_EVENTS)[number], string> = {
  launch: "At launch",
  previous_burnout: "Burnout of the stage below",
  stage_separation: "Separation of the stage below",
  never: "Never",
};

/** Mount label in a multi-stage picker: `Booster · Booster motor mount`. */
export function mountLabel(m: Mount, model: Model | null): string {
  const stage = m.stage !== undefined ? model?.stages.find((s) => s.id === m.stage)?.name : undefined;
  return stage !== undefined && (model?.stages.length ?? 0) > 1 ? `${stage} · ${m.name}` : m.name;
}
