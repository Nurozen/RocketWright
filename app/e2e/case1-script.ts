/**
 * The B1 drive's script: one row for every field `fixtures/case1` writes, in
 * the words a person sees (D14, D27). The fixture is parsed at test time; the
 * words are written by hand here so a mislabelled control cannot pass by
 * reading its label from product code. Rows change only when the plan's
 * words were wrong, with the reason in the PR.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { REPO_ROOT } from "./bar/paths.ts";
import type { StageId } from "./case1-stages.ts";

export const FIXTURE_DIR = join(REPO_ROOT, "fixtures/case1");

export type TomlScalar = string | number | boolean;

/** One leaf of the fixture's TOML. `key` is dotted, prefixed by what the file is. */
export interface SourceField {
  key: string;
  file: string;
  value: TomlScalar;
}

export type Control = "number" | "text" | "select" | "check" | "add-part" | "material" | "motor";

/** The visible words that reach one source field. */
export interface RowWords {
  control: Control;
  /** The field's visible label: its accessible name. For `add-part`, the palette tile. */
  label: string;
  /** Header tab. Absent when a dialog or sheet is already open. */
  page?: "Design" | "Results";
  /** Design's local tab. */
  local?: "Components" | "Configurations";
  /** Part as named in the tree (or in a table row) when this row runs. */
  part?: string;
  /** Which of the tree rows sharing `part`, in tree order. */
  nth?: number;
  /** Tab that holds the field. */
  tab?: string;
  /** Named group (`role="group"`, from its visible heading) around the field. */
  group?: string;
  /** Add affordance that reveals an absent optional group or field. */
  add?: string;
  /** Unit shown beside the value; the input's accessible description. */
  unit?: string;
  /** Visible option text, for `select` and the motor picker. */
  option?: string;
  /** `add-part`: the Attach to choice. */
  attachTo?: string;
  /** `material`: the name typed for the new material. */
  material?: string;
  /** The field sits in the table row named by `part`. */
  inRow?: boolean;
  /** The dialog or sheet (by accessible name) that holds the field. */
  dialog?: string;
}

export interface ScriptRow extends RowWords {
  key: string;
  stage: StageId;
}

/** A row joined to the value the fixture writes. */
export interface BoundRow extends ScriptRow {
  value: TomlScalar;
}

function leaves(prefix: string, table: Record<string, unknown>, file: string, out: SourceField[]): void {
  for (const [k, v] of Object.entries(table)) {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === "object") leaves(key, v as Record<string, unknown>, file, out);
    else out.push({ key, file, value: v as TomlScalar });
  }
}

function readToml(dir: string, file: string): Record<string, unknown> {
  return parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
}

/**
 * Every field the fixture's rebuilt files write. Only the default
 * configuration is rebuilt: the other four differ by delay, and spec B1 asks
 * for the one assignment.
 */
export function sourceFields(dir: string = FIXTURE_DIR): SourceField[] {
  const out: SourceField[] = [];
  const manifest = readToml(dir, "rocketwright.toml");
  leaves("", readToml(dir, "rocket.rw.toml"), "rocket.rw.toml", out);
  leaves("manifest", manifest, "rocketwright.toml", out);
  const config = `configs/${String(manifest["default_config"])}.rw.toml`;
  leaves("config", readToml(dir, config), config, out);
  const sims = readdirSync(join(dir, "sims"));
  if (sims.length !== 1) throw new Error(`case1 must have exactly one sim, found ${sims.length}`);
  const sim = `sims/${sims[0]!}`;
  leaves("sim", readToml(dir, sim), sim, out);
  return out;
}

/** Source fields no person enters, or that spec B1 leaves at their defaults, each with why. */
export const NOT_DRIVEN: Readonly<Record<string, string>> = {
  "manifest.format": "written by the tool",
  "manifest.name": "same value as `name`, written by project creation",
  "manifest.default_config": "generated id",
  "config.name": "configuration names are not compared (spec B1)",
  "sim.name": "sim names are not compared (spec B1)",
  "sim.config": "generated id",
  "sim.launch.rod_angle": "spec B1 sets only rail, wind and atmosphere",
  "sim.launch.rod_direction": "not gated (spec B1)",
  "sim.launch.altitude": "spec B1 sets only rail, wind and atmosphere",
  "sim.launch.latitude": "not gated (spec B1)",
  "sim.launch.longitude": "spec B1 sets only rail, wind and atmosphere",
  "sim.launch.geodetic": "spec B1 sets only rail, wind and atmosphere",
  "sim.atmosphere.base_temperature": "implied by USSA 1976",
  "sim.atmosphere.base_pressure": "implied by USSA 1976",
  "sim.wind.direction": "no effect at zero wind",
  "sim.wind.turbulence": "spec B1 sets only rail, wind and atmosphere",
  "sim.integrator.method": "not gated (spec B1)",
  "sim.integrator.dt": "not gated (spec B1)",
};

const LENGTH = "mm";
const ANGLE = "deg";

interface PartRef {
  id: string;
  name: string;
  nth?: number;
}

const part = (id: string, name: string, nth?: number): PartRef => ({ id, name, ...(nth === undefined ? {} : { nth }) });

function partRow(p: PartRef, leaf: string, stage: StageId, words: Partial<RowWords>): ScriptRow {
  const base: RowWords = { control: "text", label: "", page: "Design", local: "Components", part: p.name, ...(p.nth === undefined ? {} : { nth: p.nth }) };
  return { ...base, ...words, key: `c.${p.id}.${leaf}`, stage };
}

/** The part's `type`: its palette tile, with the Attach to choice. */
const newPart = (p: PartRef, stage: StageId, palette: string, attachTo?: string): ScriptRow =>
  partRow(p, "type", stage, { control: "add-part", label: palette, ...(attachTo === undefined ? {} : { attachTo }) });

/** The part's `name`, found by what the tree shows until this row renames it. */
const rename = (p: PartRef, shownBefore: string): ScriptRow => partRow(p, "name", "fields", { control: "text", tab: "Geometry", label: "Name", part: shownBefore });

const num = (p: PartRef, leaf: string, stage: StageId, tab: string, label: string, unit: string | null, more: Partial<RowWords> = {}): ScriptRow =>
  partRow(p, leaf, stage, { control: "number", tab, label, ...(unit === null ? {} : { unit }), ...more });

const pick = (p: PartRef, leaf: string, tab: string, label: string, option: string, more: Partial<RowWords> = {}): ScriptRow =>
  partRow(p, leaf, "fields", { control: "select", tab, label, option, ...more });

const tick = (p: PartRef, leaf: string, tab: string, label: string, more: Partial<RowWords> = {}): ScriptRow =>
  partRow(p, leaf, "fields", { control: "check", tab, label, ...more });

const nose = part("nose", "Nose cone");
const body = part("body", "Body tube");
const chute = part("chute", "Parachute");
const cord = part("cord", "Shock cord");
const wadding = part("wadding", "Wadding");
const lug = part("lug", "Launch lug");
const fins = part("fins", "Trapezoidal fin set");
const ringFore = part("ring_fore", "Centering ring", 0);
const ringAft = part("ring_aft", "Centering ring", 1);
const mmt = part("mmt", "Inner Tube");
const block = part("block", "Engine block");

const G = "Geometry";
const P = "Position";
const M = "Material";
const SHOULDER = { group: "Shoulder", add: "Add shoulder" };
const PACKED = { group: "Packed" };
const TAB = { group: "Fin tab", add: "Add fin tab" };
const FINISH = { group: "Finish", add: "Custom roughness" };

const material = (id: string, name: string, leaf: string, label: string, unit: string): ScriptRow => ({
  key: `materials.${id}.${leaf}`,
  stage: "materials",
  control: "material",
  page: "Design",
  local: "Components",
  tab: "Materials",
  add: "New material",
  material: name,
  label,
  unit,
});

const SHEET = "Simulation conditions";

/** In drive order: a part's rename comes before the rows that find it by its new name. */
export const SCRIPT_ROWS: readonly ScriptRow[] = [
  { key: "name", stage: "new", control: "text", dialog: "New project", label: "Name" },

  material("polystyrene", "polystyrene", "density", "Density", "kg/m³"),
  material("cardboard", "cardboard", "density", "Density", "kg/m³"),
  material("ripstop_nylon", "ripstop nylon", "surface_density", "Surface density", "g/m²"),
  material("elastic_cord", "elastic cord", "line_density", "Line density", "g/m"),

  newPart(nose, "nose", "Nose cone"),
  num(nose, "length", "nose", G, "Length", LENGTH),
  num(nose, "od", "nose", G, "Outer diameter", LENGTH),

  newPart(body, "body", "Body tube", "Nose cone"),
  num(body, "length", "body", G, "Length", LENGTH),
  num(body, "od", "body", G, "Outer diameter", LENGTH),

  newPart(chute, "others", "Parachute", "Body tube"),
  newPart(cord, "others", "Shock cord", "Body tube"),
  newPart(wadding, "others", "Mass component", "Body tube"),
  newPart(lug, "others", "Launch lug", "Body tube"),
  newPart(fins, "others", "Trapezoidal fin set", "Body tube"),
  newPart(ringFore, "others", "Centering ring", "Body tube"),
  newPart(ringAft, "others", "Centering ring", "Body tube"),
  newPart(mmt, "others", "Inner tube", "Body tube"),
  newPart(block, "block", "Engine block", "Inner tube"),

  rename(nose, "Nose cone"),
  pick(nose, "shape", G, "Shape", "Ogive"),
  num(nose, "shape_param", "fields", G, "Shape parameter", null),
  num(nose, "thickness", "fields", G, "Thickness", LENGTH),
  num(nose, "shoulder.length", "fields", G, "Length", LENGTH, SHOULDER),
  num(nose, "shoulder.od", "fields", G, "Outer diameter", LENGTH, SHOULDER),
  num(nose, "shoulder.thickness", "fields", G, "Thickness", LENGTH, SHOULDER),
  tick(nose, "shoulder.capped", G, "Capped", SHOULDER),
  pick(nose, "material", M, "Material", "polystyrene"),
  num(nose, "finish.roughness", "fields", M, "Roughness", "µm", FINISH),

  rename(body, "Body tube"),
  num(body, "thickness", "fields", G, "Thickness", LENGTH),
  pick(body, "attach.to", P, "Attach to", "Nose cone: Base"),
  pick(body, "material", M, "Material", "cardboard"),
  num(body, "finish.roughness", "fields", M, "Roughness", "µm", FINISH),

  rename(chute, "Parachute"),
  pick(chute, "attach.to", P, "Attach to", "Body tube: Fore"),
  pick(chute, "attach.at", P, "Anchor", "Attach point"),
  num(chute, "attach.offset", "fields", P, "Offset", LENGTH),
  num(chute, "diameter", "fields", G, "Diameter", LENGTH),
  num(chute, "cd", "fields", G, "Drag coefficient", null),
  num(chute, "line_count", "fields", G, "Shroud lines", null),
  num(chute, "line_length", "fields", G, "Line length", LENGTH),
  num(chute, "packed_length", "fields", G, "Packed length", LENGTH, PACKED),
  num(chute, "packed_diameter", "fields", G, "Packed diameter", LENGTH, PACKED),
  pick(chute, "material", M, "Material", "ripstop nylon"),
  pick(chute, "line_material", M, "Line material", "elastic cord"),

  rename(cord, "Shock cord"),
  pick(cord, "attach.to", P, "Attach to", "Body tube: Fore"),
  pick(cord, "attach.at", P, "Anchor", "Attach point"),
  num(cord, "attach.offset", "fields", P, "Offset", LENGTH),
  num(cord, "cord_length", "fields", G, "Cord length", LENGTH),
  num(cord, "packed_length", "fields", G, "Packed length", LENGTH, PACKED),
  num(cord, "packed_diameter", "fields", G, "Packed diameter", LENGTH, PACKED),
  pick(cord, "material", M, "Material", "elastic cord"),

  rename(wadding, "Mass component"),
  pick(wadding, "attach.to", P, "Attach to", "Body tube: Fore"),
  pick(wadding, "attach.at", P, "Anchor", "Fore"),
  num(wadding, "attach.offset", "fields", P, "Offset", LENGTH),
  num(wadding, "mass", "fields", G, "Mass", "g"),
  num(wadding, "length", "fields", G, "Length", LENGTH, PACKED),
  num(wadding, "od", "fields", G, "Outer diameter", LENGTH, PACKED),

  rename(lug, "Launch lug"),
  pick(lug, "attach.to", P, "Attach to", "Body tube: Middle"),
  pick(lug, "attach.at", P, "Anchor", "Fore"),
  num(lug, "attach.offset", "fields", P, "Offset", LENGTH),
  num(lug, "attach.spin", "fields", P, "Spin", ANGLE),
  num(lug, "length", "fields", G, "Length", LENGTH),
  num(lug, "od", "fields", G, "Outer diameter", LENGTH),
  num(lug, "thickness", "fields", G, "Thickness", LENGTH),
  pick(lug, "material", M, "Material", "cardboard"),
  num(lug, "finish.roughness", "fields", M, "Roughness", "µm", FINISH),

  rename(fins, "Trapezoidal fin set"),
  pick(fins, "attach.to", P, "Attach to", "Body tube: Aft"),
  pick(fins, "attach.at", P, "Anchor", "Root trailing edge"),
  num(fins, "count", "fields", G, "Fin count", null),
  num(fins, "root_chord", "fields", G, "Root chord", LENGTH),
  num(fins, "tip_chord", "fields", G, "Tip chord", LENGTH),
  num(fins, "span", "fields", G, "Span", LENGTH),
  num(fins, "sweep", "fields", G, "Sweep", LENGTH),
  num(fins, "thickness", "fields", G, "Thickness", LENGTH),
  pick(fins, "cross_section", G, "Cross section", "Rounded"),
  num(fins, "tab.height", "fields", G, "Height", LENGTH, TAB),
  num(fins, "tab.length", "fields", G, "Length", LENGTH, TAB),
  pick(fins, "material", M, "Material", "cardboard"),
  num(fins, "finish.roughness", "fields", M, "Roughness", "µm", FINISH),

  rename(ringFore, "Centering ring"),
  pick(ringFore, "attach.to", P, "Attach to", "Body tube: Aft"),
  pick(ringFore, "attach.at", P, "Anchor", "Fore"),
  num(ringFore, "attach.offset", "fields", P, "Offset", LENGTH),
  num(ringFore, "length", "fields", G, "Length", LENGTH),
  num(ringFore, "od", "fields", G, "Outer diameter", LENGTH),
  num(ringFore, "id", "fields", G, "Inner diameter", LENGTH),
  pick(ringFore, "material", M, "Material", "cardboard"),

  rename(ringAft, "Centering ring"),
  pick(ringAft, "attach.to", P, "Attach to", "Body tube: Aft"),
  pick(ringAft, "attach.at", P, "Anchor", "Aft"),
  num(ringAft, "length", "fields", G, "Length", LENGTH),
  num(ringAft, "od", "fields", G, "Outer diameter", LENGTH),
  num(ringAft, "id", "fields", G, "Inner diameter", LENGTH),
  pick(ringAft, "material", M, "Material", "cardboard"),

  rename(mmt, "Inner tube"),
  pick(mmt, "attach.to", P, "Attach to", "Body tube: Aft"),
  pick(mmt, "attach.at", P, "Anchor", "Aft"),
  num(mmt, "attach.offset", "fields", P, "Offset", LENGTH),
  num(mmt, "length", "fields", G, "Length", LENGTH),
  num(mmt, "od", "fields", G, "Outer diameter", LENGTH),
  num(mmt, "thickness", "fields", G, "Thickness", LENGTH),
  tick(mmt, "motor_mount", G, "Motor mount"),
  num(mmt, "overhang", "fields", G, "Overhang", LENGTH),
  pick(mmt, "material", M, "Material", "cardboard"),

  rename(block, "Engine block"),
  pick(block, "attach.to", P, "Attach to", "Inner Tube: Inside"),
  pick(block, "attach.at", P, "Anchor", "Fore"),
  num(block, "attach.offset", "fields", P, "Offset", LENGTH),
  num(block, "length", "fields", G, "Length", LENGTH),
  num(block, "od", "fields", G, "Outer diameter", LENGTH),
  num(block, "id", "fields", G, "Inner diameter", LENGTH),
  pick(block, "material", M, "Material", "cardboard"),

  { key: "config.motors.mmt.motor", stage: "motor", control: "motor", page: "Design", local: "Configurations", part: "Inner Tube", label: "Search motors", option: "RW_C6G" },
  { key: "config.motors.mmt.delay", stage: "motor", control: "number", page: "Design", local: "Configurations", part: "Inner Tube", label: "Ejection delay", unit: "s" },

  { key: "config.deploy.chute.event", stage: "deploy", control: "select", page: "Design", local: "Configurations", part: "Parachute", inRow: true, label: "Deploys", option: "Ejection" },
  { key: "config.deploy.chute.altitude", stage: "deploy", control: "number", page: "Design", local: "Configurations", part: "Parachute", inRow: true, label: "Altitude", unit: "m" },

  { key: "sim.launch.rail_length", stage: "sim", control: "number", dialog: SHEET, group: "Launch", label: "Rail length", unit: "m" },
  { key: "sim.wind.speed", stage: "sim", control: "number", dialog: SHEET, group: "Wind", label: "Speed", unit: "m/s" },
  { key: "sim.atmosphere.model", stage: "sim", control: "select", dialog: SHEET, group: "Atmosphere", label: "Model", option: "USSA 1976" },
];

/** Rows joined to the fixture's values. Throws on a row with no source field. */
export function boundRows(fields: readonly SourceField[] = sourceFields()): BoundRow[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return SCRIPT_ROWS.map((row) => {
    const field = byKey.get(row.key);
    if (field === undefined) throw new Error(`script row ${row.key} has no source field in fixtures/case1`);
    return { ...row, value: field.value };
  });
}

/** How the app spells a source unit beside a value. */
const SHOWN_SPELLING: Readonly<Record<string, string>> = { "kg/m^3": "kg/m³", "g/m^2": "g/m²", um: "µm" };

/**
 * What to type: the fixture's number in the unit the row says is shown. The
 * fixture and the app share units today, so a difference is a wrong row.
 */
export function typedValue(row: BoundRow): string {
  if (typeof row.value !== "string") return String(row.value);
  const m = /^\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s+(\S+)\s*$/.exec(row.value);
  if (m === null) return row.value;
  const shown = SHOWN_SPELLING[m[2]!] ?? m[2]!;
  if (row.unit !== shown) throw new Error(`${row.key}: the fixture writes ${m[2]!}, the row says the app shows ${row.unit ?? "no unit"}`);
  return m[1]!;
}
