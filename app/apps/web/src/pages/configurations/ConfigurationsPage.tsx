/**
 * Design > Configurations (concept 03, M2.10): the flight configurations
 * table (radio select, Configuration, Motor, Recovery, Simulation status
 * derived from real runs), actions New / Duplicate / Rename / Delete, and
 * sub-tabs Motors (picker over the built-in generic library with its thrust
 * curve, casing, mount silhouette, delay, Assign), Recovery (deployment per
 * device), and Stage separation. The selected configuration is the store
 * selection (`rw:cfg/<id>`), so it persists across sub-tabs and pages.
 * Every change is a `model.patch` (I1, I2); `▶ Run configurations` runs the
 * sims that fly them.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PatchOp, RwRef, schema } from "@rw/contracts";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Icon } from "../../shell/Icon.tsx";
import { StatusBadge } from "../../shell/StatusIcon.tsx";
import { ViewportToolbar, type ViewChip } from "../../shell/ViewportToolbar.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore, type DeepReadonly, type Units } from "../../state/index.ts";
import { UNITS, formatLength } from "../assembly/inspector-model.ts";
import { ComponentTreeSlot } from "../assembly/AssemblyPage.tsx";
import { CasingThumb, MountSilhouette, ThrustPlot } from "./MotorGraphics.tsx";
import { CasingView } from "./CasingView.tsx";
import { thumbKey } from "../../render/thumbnails.ts";
import {
  ALL,
  DEPLOY_EVENTS,
  DEPLOY_LABEL,
  IGNITION_EVENTS,
  IGNITION_LABEL,
  SEPARATION_EVENTS,
  SEPARATION_LABEL,
  altitudeDisplay,
  altitudeSource,
  altitudeUnit,
  assignOps,
  configFieldOps,
  configFieldRemoveOps,
  configRows,
  delaySource,
  ejectionDelayState,
  fmtSeconds,
  detailMotorRef,
  deleteOps,
  deployEventOps,
  diameterLabel,
  duplicateOps,
  filterMotors,
  filterOptions,
  fitsMount,
  manufacturerLabel,
  motorMounts,
  motorRef,
  mountLabel,
  newConfigOps,
  renameOps,
  type ConfigFiles,
  type MotorPick,
  type ConfigRow,
  type MotorFilters,
} from "./model.ts";
import "./configurations.css";

type Curve = DeepReadonly<schema.ThrustCurve>;

export const SUBTABS = ["Motors", "Recovery", "Stage separation"] as const;
export type SubTab = (typeof SUBTABS)[number];

export interface ConfigurationsUi {
  subtab: SubTab;
  /**
   * Candidate highlighted in the picker for comparison (`detailMotorRef`):
   * otherwise the detail shows the selected configuration's mounted motor.
   */
  pick: MotorPick | null;
  /** Mount edited on Motors, per configuration (multi-stage and cluster vehicles). */
  mountByConfig: Record<string, string>;
  filters: MotorFilters;
  rendering: "realistic" | "flat";
  showRocket: boolean;
  showGrid: boolean;
  library: { state: "loading" | "ready" | "error"; motors: Curve[]; error?: string };
  error: string | null;
  /** `run` while `▶ Run configurations` starts jobs. */
  batch: "idle" | "starting";
}

export type ConfigurationsStore = StoreApi<ConfigurationsUi>;

export function createConfigurationsUi(): ConfigurationsStore {
  return createStore<ConfigurationsUi>()(() => ({
    subtab: "Motors",
    pick: null,
    mountByConfig: {},
    filters: { query: "", diameter: ALL, manufacturer: ALL, impulseClass: ALL },
    rendering: "realistic",
    showRocket: true,
    showGrid: false,
    library: { state: "loading", motors: [] },
    error: null,
    batch: "idle",
  }));
}

export interface ConfigurationsSlots {
  content: ReactNode;
  toolbar: ReactNode;
  nav: ReactNode;
  agentExtra: ReactNode;
}

export function configurationsSlots(store: AppStore, client: RpcLike | null, ui: ConfigurationsStore = createConfigurationsUi()): ConfigurationsSlots {
  return {
    content: <ConfigurationsWorkspace store={store} client={client} ui={ui} />,
    toolbar: <ConfigurationsToolbar store={store} ui={ui} />,
    nav: <ComponentTreeSlot store={store} />,
    agentExtra: <RunConfigurations store={store} ui={ui} />,
  };
}

const EMPTY_FILES: ConfigFiles = {};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cfgRef = (id: string): RwRef => `rw:cfg/${id}`;

/** The selected configuration: the store's `rw:cfg/…` ref, else the first row. */
function useSelectedConfig(store: AppStore, rows: readonly ConfigRow[]): ConfigRow | null {
  const refs = useAppState(store, (s) => s.selection.refs);
  const id = refs.map((r) => /^rw:cfg\/([^#@/]+)/.exec(r)?.[1]).find((x) => x !== undefined);
  return rows.find((r) => r.id === id) ?? rows[0] ?? null;
}

/** Loads the built-in motor library (rw-wasm `motor_library`) once per page store. */
function useMotorLibrary(ui: ConfigurationsStore): void {
  const state = useStore(ui, (s) => s.library.state);
  useEffect(() => {
    if (state !== "loading") return;
    let alive = true;
    import("@rw/rw-wasm")
      .then(({ loadRwWasm }) => loadRwWasm())
      .then((rw) => {
        if (alive) ui.setState({ library: { state: "ready", motors: rw.motorLibrary() } });
      })
      .catch((e: unknown) => alive && ui.setState({ library: { state: "error", motors: [], error: message(e) } }));
    return () => {
      alive = false;
    };
  }, [state, ui]);
}

function ConfigurationsWorkspace({ store, client, ui }: { store: AppStore; client: RpcLike | null; ui: ConfigurationsStore }) {
  const snap = useAppState(store, (s) => s.project.snapshot);
  const projectId = useAppState(store, (s) => s.project.projectId);
  const subtab = useStore(ui, (s) => s.subtab);
  const error = useStore(ui, (s) => s.error);
  const model = snap?.evaluated ?? null;
  const rows = useMemo(() => configRows(model, snap?.runs.runs ?? [], snap?.history.steps ?? [], snap?.jobs ?? []), [model, snap?.runs, snap?.history.steps, snap?.jobs]);
  const selected = useSelectedConfig(store, rows);
  // A comparison candidate belongs to the configuration it was picked on: selecting another drops it.
  useEffect(() => {
    const pick = ui.getState().pick;
    if (pick !== null && !pick.key.startsWith(`${selected?.id ?? ""}/`)) ui.setState({ pick: null });
  }, [selected?.id, ui]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  useMotorLibrary(ui);
  const motors = useStore(ui, (s) => s.library.motors);

  const patch = async (ops: PatchOp[], label: string): Promise<boolean> => {
    if (client === null || projectId === null || ops.length === 0) return false;
    setPending(true);
    try {
      await client.call("model.patch", { projectId, ops, label });
      ui.setState({ error: null });
      return true;
    } catch (e) {
      ui.setState({ error: message(e) });
      return false;
    } finally {
      setPending(false);
    }
  };
  const select = (id: string) => store.getState().selection.select([cfgRef(id)], "table");

  return (
    <div className="rw-cfg" data-testid="configurations-page">
      <header className="rw-cfg__head">
        <h1 className="rw-page-title" data-testid="page.title">
          Flight configurations
        </h1>
        <div className="rw-cfg__actions">
          <button
            type="button"
            className="rw-button rw-button--quiet"
            data-testid="configs.action"
            data-action="new"
            disabled={model === null || pending}
            onClick={() => {
              if (model === null) return;
              const { id, ops } = newConfigOps(model, motors);
              void patch(ops, "New configuration").then((ok) => ok && select(id));
            }}
          >
            <Icon name="plus" size={18} /> New
          </button>
          <button
            type="button"
            className="rw-button rw-button--quiet"
            data-testid="configs.action"
            data-action="duplicate"
            disabled={selected === null || pending}
            onClick={() => {
              if (model === null || selected === null) return;
              const { id, ops } = duplicateOps(model, selected.id, `${selected.name} (copy)`);
              void patch(ops, `Duplicate ${selected.name}`).then((ok) => ok && select(id));
            }}
          >
            <Icon name="copy" size={18} /> Duplicate
          </button>
          <button type="button" className="rw-button rw-button--quiet" data-testid="configs.action" data-action="rename" disabled={selected === null || pending} onClick={() => selected && setRenaming(selected.id)}>
            <Icon name="pencil" size={18} /> Rename
          </button>
          <button type="button" className="rw-button rw-button--quiet" data-testid="configs.action" data-action="delete" disabled={selected === null || pending || rows.length <= 1} onClick={() => setConfirmDelete(true)} title={rows.length <= 1 ? "A project keeps at least one configuration" : undefined}>
            <Icon name="trash" size={18} /> Delete
          </button>
        </div>
      </header>
      {confirmDelete && selected !== null && (
        <div className="rw-cfg__confirm" role="alertdialog" data-testid="configs.confirm-delete">
          <span>
            Delete {selected.name}
            {selected.sims.length > 0 ? ` and its ${selected.sims.length === 1 ? "simulation" : `${selected.sims.length} simulations`}` : ""}? Runs stay on disk; history can restore it.
          </span>
          <button
            type="button"
            className="rw-button rw-button--quiet rw-button--danger"
            data-testid="configs.confirm"
            onClick={() => {
              setConfirmDelete(false);
              const others = rows.filter((r) => r.id !== selected.id);
              void patch(deleteOps(selected.id, selected.sims), `Delete ${selected.name}`).then((ok) => ok && others[0] && select(others[0].id));
            }}
          >
            Delete
          </button>
          <button type="button" className="rw-button rw-button--quiet" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}
      <div className="rw-cfg-table" data-rw-region="config-table" data-testid="config-table" role="table" aria-label="Flight configurations">
        <div className="rw-cfg-table__row rw-cfg-table__row--head" role="row" data-testid="configs.header">
          <span role="columnheader" className="rw-cfg-table__radio">
            <span className="rw-cfg-check" aria-hidden />
          </span>
          <span role="columnheader">Configuration</span>
          <span role="columnheader">Motor</span>
          <span role="columnheader">Recovery</span>
          <span role="columnheader">Simulation</span>
        </div>
        <div className="rw-cfg-table__body" role="radiogroup" aria-label="Configuration">
          {rows.length === 0 && <p className="rw-cfg__empty">{model === null ? "Open a project to see its configurations." : "No configurations yet. + New adds one."}</p>}
          {rows.map((r) => (
            <div
              key={r.id}
              className="rw-cfg-table__row"
              role="radio"
              aria-checked={selected?.id === r.id}
              tabIndex={0}
              data-testid="configs.row"
              data-config={r.id}
              data-status={r.status.kind}
              onClick={() => select(r.id)}
              onKeyDown={(e) => (e.key === " " || e.key === "Enter") && select(r.id)}
            >
              <span className="rw-cfg-table__radio">
                <span className="rw-radio" aria-hidden />
              </span>
              <span className="rw-cfg-table__name">
                {renaming === r.id ? (
                  <RenameInput
                    initial={r.name}
                    onDone={(name) => {
                      setRenaming(null);
                      if (model !== null && name !== null && name.trim() !== "" && name.trim() !== r.name) void patch(renameOps(r.id, name.trim(), r.sims, model), `Rename ${r.name}`);
                    }}
                  />
                ) : (
                  r.name
                )}
              </span>
              <span data-testid="configs.motor">{r.motor}</span>
              <span data-testid="configs.recovery">{r.recovery}</span>
              <span className="rw-cfg-table__status" data-testid="configs.status" data-kind={r.status.kind} data-tone={r.status.view.tone}>
                {r.status.kind === "not_simulated" ? <span className="rw-cfg-dash" aria-hidden>—</span> : <StatusBadge status={r.status.view} size={18} />}
                <span>{r.status.label}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <nav className="rw-cfg__subtabs" role="tablist" aria-label="Configuration settings">
        {SUBTABS.map((t) => (
          <button key={t} type="button" role="tab" className="rw-tab rw-tab--editor" data-testid="configs.subtab" aria-selected={t === subtab} onClick={() => ui.setState({ subtab: t })}>
            {t}
          </button>
        ))}
      </nav>
      {selected !== null && model !== null && subtab === "Motors" && <MotorPanel store={store} ui={ui} config={selected} patch={patch} />}
      {selected !== null && model !== null && subtab === "Recovery" && <RecoveryPanel store={store} config={selected} patch={patch} />}
      {selected !== null && model !== null && subtab === "Stage separation" && <StagePanel store={store} config={selected} patch={patch} />}
      {error !== null && (
        <p className="rw-cfg__error" role="alert" data-testid="configs.error">
          {error}
          <button type="button" className="rw-link" onClick={() => ui.setState({ error: null })}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="rw-cfg__rename"
      data-testid="configs.rename-input"
      aria-label="Configuration name"
      autoFocus
      value={v}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.currentTarget.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

function Select({ label, value, options, onChange, testid }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; testid: string }) {
  return (
    <label className="rw-cfg-filter">
      <span>{label}</span>
      <span className="rw-select rw-select--native">
        <select data-testid={testid} aria-label={label} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16} />
      </span>
    </label>
  );
}

function MotorPanel({ store, ui, config, patch }: { store: AppStore; ui: ConfigurationsStore; config: ConfigRow; patch: (ops: PatchOp[], label: string) => Promise<boolean> }) {
  const model = useAppState(store, (s) => s.project.snapshot?.evaluated ?? null)!;
  const units = useAppState(store, (s) => s.ui.units);
  const view = useAppState(store, (s) => s.ui.view);
  const lib = useStore(ui, (s) => s.library);
  const filters = useStore(ui, (s) => s.filters);
  const mountPick = useStore(ui, (s) => s.mountByConfig[config.id]);
  const rendering = useStore(ui, (s) => s.rendering);
  const showRocket = useStore(ui, (s) => s.showRocket);
  const showGrid = useStore(ui, (s) => s.showGrid);
  const [info, setInfo] = useState<string | null>(null);
  const cfg = model.configs[config.id];
  const mounts = motorMounts(model);
  // The mount being edited: the one picked for this configuration, else the first (top-down) with a motor, else the first.
  const mount = mounts.find((m) => m.id === mountPick) ?? mounts.find((m) => cfg?.motors.some((a) => a.mount === m.id)) ?? mounts[0];
  const assignment = mount !== undefined ? cfg?.motors.find((a) => a.mount === mount.id) : undefined;
  const pickKey = `${config.id}/${mount?.id ?? ""}`;
  const pick = useStore(ui, (s) => s.pick);
  const casingThumb = useAppState(store, (s) => (mount === undefined ? undefined : s.thumbs.urls[thumbKey(mount.id)]));
  const assignedRef = assignment?.motor ?? null;
  const list = filterMotors(lib.motors, filters);
  const opts = filterOptions(lib.motors);
  // The detail follows the selected configuration's mounted motor; a candidate picked here shows only until the configuration, mount, or mounted motor changes.
  const shownRef = detailMotorRef(pick, pickKey, assignedRef);
  const picked = shownRef !== assignedRef ? shownRef : null;
  useEffect(() => {
    if (pick !== null && (pick.key !== pickKey || pick.base !== assignedRef)) ui.setState({ pick: null });
  }, [pick, pickKey, assignedRef, ui]);
  const current = lib.motors.find((m) => motorRef(m) === shownRef) ?? list[0] ?? null;
  const isAssigned = current !== null && motorRef(current) === assignedRef;
  const delay = assignment?.delay ?? null;
  const [delayText, setDelayText] = useState(delay !== null ? String(delay) : "");
  useEffect(() => setDelayText(delay !== null ? String(Number(delay.toFixed(2))) : ""), [delay, config.id, mount?.id]);
  // The ejection delay's one source (R20-03): manufacturer when the configured delay is one the motor file lists, custom otherwise
  // (or when the user unticked "Use manufacturer data" to type one). The delay row and the checkbox both read it.
  const [custom, setCustom] = useState(false);
  useEffect(() => setCustom(false), [config.id, picked, mount?.id]);
  const delayState = ejectionDelayState(delay, current?.delays ?? [], custom);
  const fileDelays = delayState.source === "manufacturer";
  const listedText = delayState.listed.map((d) => Number(d.toFixed(2))).join(", ");
  const setFilter = (k: keyof MotorFilters, v: string) => ui.setState((s) => ({ filters: { ...s.filters, [k]: v } }));
  return (
    <div className="rw-motors" data-rw-region="motor-panel" data-testid="motor-panel" data-config={config.id} data-mount={mount?.id ?? ""} data-assigned={assignedRef ?? ""}>
      <div className="rw-motors__list">
        <h3 className="rw-motors__title">Select a motor</h3>
        <label className="rw-motors__search">
          <Icon name="search" size={18} />
          <input data-testid="motors.search" placeholder="Search motors…" aria-label="Search motors" value={filters.query} onChange={(e) => setFilter("query", e.currentTarget.value)} />
        </label>
        <div className="rw-motors__filters">
          <Select label="Diameter" testid="motors.filter" value={filters.diameter} options={opts.diameter} onChange={(v) => setFilter("diameter", v)} />
          <Select label="Manufacturer" testid="motors.filter" value={filters.manufacturer} options={opts.manufacturer} onChange={(v) => setFilter("manufacturer", v)} />
          <Select label="Impulse class" testid="motors.filter" value={filters.impulseClass} options={opts.impulseClass} onChange={(v) => setFilter("impulseClass", v)} />
        </div>
        <ul className="rw-motors__rows" role="listbox" aria-label="Motors" data-testid="motors.list" data-state={lib.state}>
          {lib.state === "loading" && <li className="rw-motors__empty">Loading the motor library…</li>}
          {lib.state === "error" && <li className="rw-motors__empty">{lib.error}</li>}
          {lib.state === "ready" && list.length === 0 && <li className="rw-motors__empty">No motors match these filters.</li>}
          {list.map((m) => {
            const ref = motorRef(m);
            const fits = fitsMount(m, mount);
            return (
              <li
                key={ref}
                className="rw-motors__row"
                role="option"
                aria-selected={current !== null && ref === motorRef(current)}
                data-testid="motors.row"
                data-motor={ref}
                data-fits={fits ? "true" : "false"}
                onClick={() => ui.setState({ pick: ref === assignedRef ? null : { key: pickKey, base: assignedRef, motor: ref } })}
              >
                <CasingThumb url={casingThumb} />
                <span className="rw-motors__name">
                  <span>{m.designation}</span>
                  <span className="rw-motors__sub" title={!fits && mount ? `Does not fit the ${diameterLabel(mount.nominal)} mount` : undefined}>
                    {diameterLabel(m.diameter)} · {manufacturerLabel(m)}
                  </span>
                </span>
                {ref === assignedRef ? (
                  <span className="rw-motors__tag" data-testid="motors.assigned" title={`Assigned to ${config.name}${mounts.length > 1 && mount ? ` (${mountLabel(mount, model)})` : ""}`}>
                    <Icon name="check" size={16} label={`Assigned to ${config.name}`} />
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="rw-icon-button rw-motors__info"
                  data-testid="motors.info"
                  aria-label={`About ${m.designation}`}
                  aria-expanded={info === ref}
                  title={`Class ${m.class} · ${m.total_impulse.toFixed(2)} N·s · ${m.burn_time.toFixed(2)} s burn · ${m.average_thrust.toFixed(1)} N average`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setInfo(info === ref ? null : ref);
                  }}
                >
                  <Icon name="info" size={18} />
                </button>
                {info === ref && (
                  <dl className="rw-motors__details" data-testid="motors.details">
                    <dt>Class</dt>
                    <dd>{m.class}</dd>
                    <dt>Total impulse</dt>
                    <dd>{m.total_impulse.toFixed(2)} N·s</dd>
                    <dt>Burn time</dt>
                    <dd>{m.burn_time.toFixed(2)} s</dd>
                    <dt>Propellant</dt>
                    <dd>{(m.prop_mass * 1000).toFixed(1)} g</dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {current !== null ? (
        <div className="rw-motor" data-testid="motor.detail" data-motor={motorRef(current)}>
          <div className="rw-motor__head">
            <h3 className="rw-motor__title" data-testid="motor.title">
              {current.designation}
            </h3>
            <span className="rw-pill" data-testid="motor.mount-pill">
              {mount ? `${formatLength(mount.nominal, units)} mount` : "No mount"}
            </span>
            {mounts.length > 1 && mount !== undefined && (
              <span className="rw-select rw-select--native rw-motor__mount">
                <select
                  data-testid="motor.mount"
                  aria-label="Motor mount"
                  value={mount.id}
                  onChange={(e) => {
                    const id = e.currentTarget.value;
                    ui.setState((s) => ({ mountByConfig: { ...s.mountByConfig, [config.id]: id } }));
                  }}
                >
                  {mounts.map((m) => {
                    const a = cfg?.motors.find((x) => x.mount === m.id);
                    const motor = a?.motor ?? a?.engine ?? null;
                    return (
                      <option key={m.id} value={m.id}>
                        {mountLabel(m, model)} · {motor === null ? "No motor" : motor.replace(/^generic:/, "")}
                      </option>
                    );
                  })}
                </select>
                <Icon name="chevron-down" size={16} />
              </span>
            )}
            {isAssigned ? (
              // The assigned state: a clear status (check, teal outline), not a dimmed primary button.
              <button type="button" className="rw-button rw-motor__assign rw-motor__assign--done" data-testid="motor.assign" data-state="assigned" disabled title={`${current.designation} is assigned to ${config.name}`}>
                <Icon name="check" size={16} />
                Assigned
              </button>
            ) : (
              <button
                type="button"
                className="rw-button rw-button--primary rw-motor__assign"
                data-testid="motor.assign"
                data-state="assign"
                disabled={mount === undefined || !fitsMount(current, mount)}
                title={mount !== undefined && !fitsMount(current, mount) ? "This motor does not fit the mount" : `Assign ${current.designation} to ${config.name}${mounts.length > 1 && mount ? ` (${mountLabel(mount, model)})` : ""}`}
                onClick={() => {
                  if (mount === undefined) return;
                  const keep = delay !== null && current.delays.some((d) => Math.abs(d - delay) < 1e-6) ? delay : (current.delays[0] ?? delay);
                  void patch(assignOps(config.id, mount.id, current, keep, assignment !== undefined), `Assign ${current.designation} to ${config.name}${mounts.length > 1 ? ` (${mountLabel(mount, model)})` : ""}`);
                }}
              >
                Assign to configuration
              </button>
            )}
          </div>
          <div className="rw-motor__top">
            <ThrustPlot curve={current} width={showRocket ? 420 : 540} height={236} grid={showGrid} />
            {showRocket && <MountSilhouette model={model} mount={mount} units={units} height={262} />}
          </div>
          <div className="rw-motor__bottom">
            <CasingView curve={current} width={296} height={154} style={rendering} view={view} />
            <dl className="rw-motor__fields">
              <div data-testid="motor.field" data-field="mount">
                <dt>Motor mount</dt>
                <dd>{mount ? formatLength(mount.nominal, units) : "—"}</dd>
              </div>
              <div data-testid="motor.field" data-field="delay" data-source={delayState.source}>
                <dt>Ejection delay</dt>
                <dd className="rw-motor__delay-cell">
                  {fileDelays && delayState.listed.length > 0 && isAssigned ? (
                    <span className="rw-select rw-select--native rw-motor__delay">
                      <select
                        aria-label="Ejection delay"
                        data-testid="motor.delay"
                        value={delay !== null ? String(delay) : ""}
                        onChange={(e) => void patch([{ op: "add", path: `/configs/${config.id}/motors/${mount!.id}/delay`, value: `${e.currentTarget.value} s` }], `Set ${config.name} ejection delay`)}
                      >
                        {delayState.listed.map((d) => (
                          <option key={d} value={String(d)}>
                            {d.toFixed(1)} s
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron-down" size={16} />
                    </span>
                  ) : (
                    <span className="rw-motor__delay-input">
                      <input
                        aria-label="Ejection delay"
                        data-testid="motor.delay"
                        inputMode="decimal"
                        value={delayText}
                        disabled={!isAssigned}
                        onChange={(e) => setDelayText(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        onBlur={() => {
                          const n = Number(delayText);
                          if (!Number.isFinite(n) || n < 0 || mount === undefined || (delay !== null && Math.abs(n - delay) < 1e-9)) return;
                          void patch([{ op: "add", path: `/configs/${config.id}/motors/${mount.id}/delay`, value: `${n} s` }], `Set ${config.name} ejection delay`);
                        }}
                      />
                      <span>s</span>
                    </span>
                  )}
                  <span
                    className="rw-motor__delay-source"
                    data-testid="motor.delay-source"
                    data-source={delayState.source}
                    title={fileDelays ? `One of the delays the ${current.designation} file lists (${listedText} s)` : listedText !== "" ? `Not one of the delays the ${current.designation} file lists (${listedText} s)` : `The ${current.designation} file lists no delays`}
                  >
                    {fileDelays ? "Manufacturer" : "Custom"}
                  </span>
                </dd>
              </div>
              {model.stages.length > 1 && (
                <div data-testid="motor.field" data-field="ignition">
                  <dt>Ignition</dt>
                  <dd>
                    <span className="rw-select rw-select--native rw-motor__delay">
                      <select
                        aria-label="Ignition"
                        data-testid="motor.ignition"
                        disabled={assignment === undefined || mount === undefined}
                        value={assignment?.ignition ?? "launch"}
                        onChange={(e) => mount && void patch([{ op: "add", path: `/configs/${config.id}/motors/${mount.id}/ignition`, value: e.currentTarget.value }], `Set ${config.name} ${mount.name} ignition`)}
                      >
                        {IGNITION_EVENTS.map((ev) => (
                          <option key={ev} value={ev}>
                            {IGNITION_LABEL[ev]}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron-down" size={16} />
                    </span>
                  </dd>
                </div>
              )}
              <div data-testid="motor.manufacturer-data" data-source={delayState.source}>
                <dt>Use manufacturer data</dt>
                <dd>
                  <label className="rw-check" title={listedText !== "" ? `${current.designation} lists ${listedText} s` : `${current.designation} lists no delays`}>
                    <input
                      type="checkbox"
                      data-testid="motor.use-file"
                      checked={fileDelays}
                      disabled={!isAssigned || delayState.listed.length === 0}
                      aria-label="Use manufacturer data"
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setCustom(!on);
                        // Back to the file's timing: the listed delay nearest the configured one.
                        if (on && mount !== undefined && delayState.nearest !== null && (delay === null || Math.abs(delayState.nearest - delay) > 1e-6)) {
                          void patch([{ op: "add", path: `/configs/${config.id}/motors/${mount.id}/delay`, value: `${delayState.nearest} s` }], `Set ${config.name} ejection delay`);
                        }
                      }}
                    />
                    <span data-testid="motor.use-file-label">{fileDelays ? "Enabled" : listedText !== "" ? `Off · lists ${listedText} s` : "Off · no listed delays"}</span>
                  </label>
                </dd>
              </div>
              <p className="rw-motor__note">
                {fileDelays ? "Thrust curve and timing" : "Thrust curve"} from the motor file ({current.source.kind === "generic" ? "RocketWright generic library" : (current.manufacturer ?? "imported")})
                {fileDelays ? "." : `; ejection delay ${delay !== null ? fmtSeconds(delay) : "set"} for ${config.name}.`}
              </p>
            </dl>
          </div>
        </div>
      ) : (
        <div className="rw-motor rw-motor--empty">{lib.state === "ready" ? "Choose a motor from the list." : ""}</div>
      )}
    </div>
  );
}

/** Diagnostics the model reports under a configuration path (`/configs/<id>/deploy/<c>`). */
function useConfigDiagnostics(store: AppStore, prefix: string) {
  const diags = useAppState(store, (s) => s.project.snapshot?.evaluated?.diagnostics ?? null);
  return useMemo(() => (diags ?? []).filter((d) => d.path != null && (d.path === prefix || d.path.startsWith(`${prefix}/`))), [diags, prefix]);
}

/**
 * A unit-aware number field of a configuration table: typed text, the unit
 * after it, Enter or blur writes (`onCommit` returns a local validation
 * message, or null once the value is written), Escape restores the value.
 */
function CfgNumber({
  value,
  unit,
  label,
  testid,
  disabled,
  invalid,
  onCommit,
}: {
  value: string;
  unit: string;
  label: string;
  testid: string;
  disabled?: boolean;
  invalid?: boolean;
  onCommit: (text: string) => string | null;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  useEffect(() => setError(null), [value]);
  const commit = () => {
    if (text.trim() === value.trim() && value.trim() !== "") return;
    setError(onCommit(text));
  };
  return (
    <span className="rw-cfg-num" data-invalid={error !== null || invalid ? "true" : undefined}>
      <span className="rw-motor__delay-input">
        <input
          aria-label={label}
          data-testid={testid}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          aria-invalid={error !== null || invalid ? true : undefined}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={() => {
            setEditing(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setText(value);
              setError(null);
              setEditing(false);
            }
          }}
        />
        <span>{unit}</span>
      </span>
      {error !== null && (
        <span className="rw-cfg-num__error" role="alert" data-testid={`${testid}-error`}>
          {error}
        </span>
      )}
    </span>
  );
}

function RecoveryPanel({ store, config, patch }: { store: AppStore; config: ConfigRow; patch: (ops: PatchOp[], label: string) => Promise<boolean> }) {
  const model = useAppState(store, (s) => s.project.snapshot?.evaluated ?? null)!;
  const files = useAppState(store, (s) => (s.project.snapshot?.files.files ?? EMPTY_FILES) as ConfigFiles);
  const units = useAppState(store, (s) => s.ui.units);
  const diags = useConfigDiagnostics(store, `/configs/${config.id}/deploy`);
  const cfg = model.configs[config.id];
  const devices = model.components.filter((c) => c.shape.type === "parachute" || c.shape.type === "streamer");
  const alt = altitudeUnit(units);
  return (
    <div className="rw-motors rw-recovery" data-rw-region="motor-panel" data-testid="recovery-panel" data-config={config.id}>
      <table className="rw-recovery__table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Size</th>
            <th>Deploys</th>
            <th>Altitude</th>
            <th>Delay</th>
          </tr>
        </thead>
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td colSpan={5} className="rw-cfg__empty">
                No parachute or streamer in this rocket.
              </td>
            </tr>
          )}
          {devices.map((c) => {
            const d = cfg?.deployments.find((x) => x.component === c.id);
            const event = d?.event ?? "never";
            const s = c.shape as { diameter?: number; length?: number; width?: number };
            const mine = diags.filter((x) => x.path === `/configs/${config.id}/deploy/${c.id}` || x.path!.startsWith(`/configs/${config.id}/deploy/${c.id}/`));
            const bad = (f: string) => mine.some((x) => x.path!.endsWith(`/${f}`));
            const write = (field: string, value: string, what: string) => void patch(configFieldOps(files, config.id, "deploy", c.id, field, value, { event }), `Set ${c.name} ${what}`);
            return (
              <tr key={c.id} data-testid="recovery.row" data-component={c.id} data-event={event} data-invalid={mine.some((x) => x.severity === "error") ? "true" : undefined}>
                <td>{c.name}</td>
                <td>{s.diameter !== undefined ? `⌀ ${formatLength(s.diameter, units)}` : s.length !== undefined ? `${formatLength(s.length, units)} × ${formatLength(s.width ?? 0, units)}` : "—"}</td>
                <td>
                  <span className="rw-select rw-select--native">
                    <select data-testid="recovery.event" aria-label={`${c.name} deployment`} value={event} onChange={(e) => void patch(deployEventOps(files, config.id, c.id, e.currentTarget.value), `Deploy ${c.name} ${e.currentTarget.value}`)}>
                      {DEPLOY_EVENTS.map((ev) => (
                        <option key={ev} value={ev}>
                          {DEPLOY_LABEL[ev]}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={16} />
                  </span>
                </td>
                <td data-testid="recovery.altitude-cell">
                  {event === "altitude" ? (
                    <CfgNumber
                      label={`${c.name} deployment altitude`}
                      testid="recovery.altitude"
                      unit={alt.unit}
                      value={altitudeDisplay(d?.altitude, units)}
                      invalid={bad("altitude")}
                      onCommit={(t) => {
                        const r = altitudeSource(t, units);
                        if ("error" in r) return r.error;
                        write("altitude", r.value, "deployment altitude");
                        return null;
                      }}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td data-testid="recovery.delay-cell">
                  {event !== "never" ? (
                    <CfgNumber
                      label={event === "timer" ? `${c.name} time after launch` : `${c.name} deployment delay`}
                      testid="recovery.delay"
                      unit="s"
                      value={d !== undefined && (d.delay > 0 || event === "timer") ? String(Number(d.delay.toFixed(2))) : ""}
                      invalid={bad("delay")}
                      onCommit={(t) => {
                        if (t.trim() === "" && event !== "timer") {
                          const ops = configFieldRemoveOps(files, config.id, "deploy", c.id, "delay");
                          if (ops.length > 0) void patch(ops, `Clear ${c.name} deployment delay`);
                          return null;
                        }
                        const r = delaySource(t, event === "timer" ? "The time after launch" : "The delay");
                        if ("error" in r) return r.error;
                        write("delay", r.value, event === "timer" ? "deployment time" : "deployment delay");
                        return null;
                      }}
                    />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {diags.length > 0 && (
        <ul className="rw-cfg__diags" data-testid="recovery.validation">
          {diags.map((d, i) => (
            <li key={`${d.code}-${i}`} data-code={d.code} data-severity={d.severity} title={d.hint ?? d.code}>
              <Icon name="alert" size={14} /> {d.message}
              {d.hint ? ` (${d.hint})` : ""}
            </li>
          ))}
        </ul>
      )}
      <p className="rw-motor__note">Deployment events follow the configuration. At altitude deploys on descent through the altitude; Timer counts from launch; Delay waits after the event.</p>
    </div>
  );
}

function StagePanel({ store, config, patch }: { store: AppStore; config: ConfigRow; patch: (ops: PatchOp[], label: string) => Promise<boolean> }) {
  const model = useAppState(store, (s) => s.project.snapshot?.evaluated ?? null)!;
  const files = useAppState(store, (s) => (s.project.snapshot?.files.files ?? EMPTY_FILES) as ConfigFiles);
  const diags = useConfigDiagnostics(store, `/configs/${config.id}/stages`);
  const cfg = model.configs[config.id];
  const stages = cfg?.stages ?? [];
  return (
    <div className="rw-motors rw-recovery" data-rw-region="motor-panel" data-testid="stage-panel" data-config={config.id}>
      {model.stages.length <= 1 ? (
        <p className="rw-cfg__empty" data-testid="stage.empty">
          Single-stage vehicle: no separation events. Stages appear here once the rocket defines more than one.
        </p>
      ) : (
        <table className="rw-recovery__table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Active</th>
              <th>Separation</th>
              <th>Delay</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s, i) => {
              const name = model.stages.find((x) => x.id === s.stage)?.name ?? s.stage;
              const write = (field: string, value: unknown, what: string) => void patch(configFieldOps(files, config.id, "stages", s.stage, field, value), `Set ${name} ${what}`);
              return (
                <tr key={s.stage} data-testid="stage.row" data-stage={s.stage} data-separation={String(s.separation)}>
                  <td>{name}</td>
                  <td>
                    <label className="rw-check">
                      <input type="checkbox" data-testid="stage.active" aria-label={`${name} active`} checked={s.active} onChange={(e) => write("active", e.currentTarget.checked, e.currentTarget.checked ? "active" : "inactive")} />
                      <span>{s.active ? "Yes" : "No"}</span>
                    </label>
                  </td>
                  <td>
                    {i === 0 ? (
                      <span title="The top stage stays with the payload">Top stage</span>
                    ) : (
                      <span className="rw-select rw-select--native">
                        <select data-testid="stage.separation" aria-label={`${name} separation`} value={String(s.separation)} onChange={(e) => write("separation", e.currentTarget.value, "separation")}>
                          {SEPARATION_EVENTS.map((ev) => (
                            <option key={ev} value={ev}>
                              {SEPARATION_LABEL[ev]}
                            </option>
                          ))}
                        </select>
                        <Icon name="chevron-down" size={16} />
                      </span>
                    )}
                  </td>
                  <td>
                    {i === 0 ? (
                      "—"
                    ) : (
                      <CfgNumber
                        label={`${name} separation delay`}
                        testid="stage.delay"
                        unit="s"
                        value={String(Number(s.separation_delay.toFixed(2)))}
                        disabled={s.separation === "never"}
                        onCommit={(t) => {
                          const r = delaySource(t, "The separation delay");
                          if ("error" in r) return r.error;
                          write("separation_delay", r.value, "separation delay");
                          return null;
                        }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {diags.length > 0 && (
        <ul className="rw-cfg__diags" data-testid="stage.validation">
          {diags.map((d, i) => (
            <li key={`${d.code}-${i}`} data-code={d.code} data-severity={d.severity}>
              <Icon name="alert" size={14} /> {d.message}
            </li>
          ))}
        </ul>
      )}
      {model.stages.length > 1 && <p className="rw-motor__note">Each stage below the top separates on its event plus the delay. Assign each stage&apos;s motor on Motors (pick its mount).</p>}
    </div>
  );
}

const chipOf = (v: string): ViewChip => (v[0]!.toUpperCase() + v.slice(1)) as ViewChip;

function ConfigurationsToolbar({ store, ui }: { store: AppStore; ui: ConfigurationsStore }) {
  const view = useAppState(store, (s) => s.ui.view);
  const units = useAppState(store, (s) => s.ui.units);
  const rendering = useStore(ui, (s) => s.rendering);
  const showRocket = useStore(ui, (s) => s.showRocket);
  const showGrid = useStore(ui, (s) => s.showGrid);
  return (
    <ViewportToolbar
      view={chipOf(view)}
      units={units}
      unitOptions={UNITS}
      onUnitsChange={(u) => store.getState().ui.setUnits(u as Units)}
      onViewChange={(v) => store.getState().ui.setView({ view: v.toLowerCase() as typeof view })}
    >
      <span className="rw-toolbar__sep" aria-hidden />
      <span className="rw-toolbar__label">Rendering</span>
      <span className="rw-select rw-select--native">
        <select data-testid="toolbar.rendering" aria-label="Rendering" value={rendering} onChange={(e) => ui.setState({ rendering: e.currentTarget.value as "realistic" | "flat" })}>
          <option value="realistic">Realistic</option>
          <option value="flat">Flat</option>
        </select>
        <Icon name="chevron-down" size={16} />
      </span>
      <span className="rw-toolbar__sep" aria-hidden />
      <Toggle testid="toolbar.show-rocket" label="Show rocket" on={showRocket} onChange={(v) => ui.setState({ showRocket: v })} />
      <Toggle testid="toolbar.show-grid" label="Show grid" on={showGrid} onChange={(v) => ui.setState({ showGrid: v })} />
      <span className="rw-toolbar__sep" aria-hidden />
    </ViewportToolbar>
  );
}

function Toggle({ testid, label, on, onChange }: { testid: string; label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="rw-switch" data-testid={testid} onClick={() => onChange(!on)}>
      <span className="rw-switch__track" aria-hidden>
        <span className="rw-switch__thumb" />
      </span>
      {label}
    </button>
  );
}

/** `▶ Run configurations` (agent pane): runs every sim that flies a configuration. */
function RunConfigurations({ store, ui }: { store: AppStore; ui: ConfigurationsStore }) {
  const snap = useAppState(store, (s) => s.project.snapshot);
  const connected = useAppState(store, (s) => s.project.connection === "open");
  const batch = useStore(ui, (s) => s.batch);
  const model = snap?.evaluated ?? null;
  const rows = useMemo(() => configRows(model, snap?.runs.runs ?? [], snap?.history.steps ?? [], snap?.jobs ?? []), [model, snap?.runs, snap?.history.steps, snap?.jobs]);
  const sims = rows.flatMap((r) => r.sims.slice(0, 1));
  const running = rows.filter((r) => r.status.kind === "running").length;
  return (
    <div className="rw-runcfg">
      <button
        type="button"
        className="rw-button rw-button--primary rw-runcfg__button"
        data-testid="agent.run-configurations"
        data-sims={sims.join(",")}
        data-running={running}
        disabled={!connected || sims.length === 0 || batch === "starting"}
        onClick={() => {
          ui.setState({ batch: "starting" });
          Promise.allSettled(sims.map((s) => store.getState().runs.run(s)))
            .then((r) => {
              const failed = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
              ui.setState({ error: failed.length > 0 ? message(failed[0]!.reason) : null });
            })
            .finally(() => ui.setState({ batch: "idle" }));
        }}
      >
        <Icon name="play-circle" size={22} />
        {running > 0 ? `Running ${running} of ${rows.length}…` : "Run configurations"}
      </button>
      <p className="rw-runcfg__note">
        Flies {sims.length === 1 ? "1 configuration" : `${sims.length} configurations`} with the current model; results appear on Results.
      </p>
    </div>
  );
}
