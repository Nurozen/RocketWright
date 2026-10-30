/**
 * Design > Components (concept 02, M2.9). Four shell slots over one store:
 * the workspace (shaded orthographic profile above the component editor),
 * the Components tree (shared with Assembly; Cmd/Ctrl-click multi-selects),
 * the rail footer view chips (Side | Top | Front | Rear), and the agent pane
 * additions (Changed fields, Compare revisions, this thread's history).
 *
 * The proposal of the selected part (proposal.ts) is computed once here and
 * shared by the slots through a small page store: the open draft against the
 * committed model, else the latest step that changed the part (its reverse,
 * evaluated by rw-wasm, is the amber ghost and what Revert change commits).
 */
import { useEffect, useMemo, type ReactNode } from "react";
import type { CheckReport, CompareOut, PatchOp, RwRef, schema } from "@rw/contracts";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RpcLike } from "../../state/rpc.ts";
import { componentRef, useAppState, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { selectedComponentIds } from "../../state/slices/selection.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import { COMPARE_EVENT, type CompareEventDetail } from "../../shell/ConnectedShell.tsx";
import { ComponentTreeSlot } from "../assembly/AssemblyPage.tsx";
import { ChangedFieldsCard, ThreadHistory, useOpenThreadHistory } from "./AgentExtras.tsx";
import { ComponentEditor, type EditorStatus } from "./ComponentEditor.tsx";
import { editorFields, type EditorTab } from "./fields.ts";
import { PROFILE_VIEW_LABEL, PROFILE_VIEWS, type ProfileView as ViewId } from "./profile-geometry.ts";
import { ProfileView } from "./ProfileView.tsx";
import { draftProposal, findStepProposal, type Proposal } from "./proposal.ts";
import { agentSteps } from "./thread-history.ts";
import { stepTitle } from "../../shell/undo.ts";
import "./components.css";

type LibItem = DeepReadonly<schema.LibItem>;

export interface ComponentsUi {
  view: ViewId;
  collapsed: boolean;
  /** Editor tab per part (restored when the part is reselected). */
  tabs: Record<string, EditorTab>;
  proposal: { key: string; state: "idle" | "loading" | "ready"; value: Proposal | null };
  library: { state: "idle" | "loading" | "ready" | "error"; items: LibItem[]; error?: string };
  error: string | null;
}

export type ComponentsStore = StoreApi<ComponentsUi>;

export function createComponentsUi(): ComponentsStore {
  return createStore<ComponentsUi>()(() => ({
    view: "side",
    collapsed: false,
    tabs: {},
    proposal: { key: "", state: "idle", value: null },
    library: { state: "idle", items: [] },
    error: null,
  }));
}

export interface ComponentsSlots {
  content: ReactNode;
  nav: ReactNode;
  railFooter: ReactNode;
  agentExtra: ReactNode;
}

export function componentsSlots(store: AppStore, client: RpcLike | null, glbDeps: GlbDeps, ui: ComponentsStore = createComponentsUi()): ComponentsSlots {
  return {
    content: <ComponentsWorkspace store={store} client={client} glbDeps={glbDeps} ui={ui} />,
    nav: <ComponentTreeSlot store={store} />,
    railFooter: <ViewChips ui={ui} />,
    agentExtra: <ComponentsAgentExtra store={store} ui={ui} />,
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `history.compare` answers per project and step pair (steps never change once written). */
const compareCache = new Map<string, Promise<CompareOut>>();

function ViewChips({ ui }: { ui: ComponentsStore }) {
  const view = useStore(ui, (s) => s.view);
  return (
    <>
      <span className="rw-toolbar__label">View</span>
      <div className="rw-chips rw-chips--rail" role="radiogroup" aria-label="View">
        {PROFILE_VIEWS.map((v) => (
          <button key={v} type="button" role="radio" className="rw-chip rw-chip--small" data-testid="rail.view-chip" data-view={v} aria-checked={v === view} onClick={() => ui.setState({ view: v })}>
            {PROFILE_VIEW_LABEL[v]}
          </button>
        ))}
      </div>
    </>
  );
}

/** The ids the page edits: the component selection, else the first fin set (concept 02 opens on it), else the first part. */
function useEditedIds(store: AppStore): string[] {
  const refs = useAppState(store, (s) => s.selection.refs);
  const components = useAppState(store, (s) => s.project.snapshot?.evaluated?.components ?? null);
  const ids = useMemo(() => selectedComponentIds(refs), [refs]);
  const known = new Set((components ?? []).map((c) => c.id));
  const kept = ids.filter((id) => known.has(id));
  if (kept.length > 0) return kept;
  const fin = components?.find((c) => c.shape.type.endsWith("fin_set"));
  return fin ? [fin.id] : components?.[0] ? [components[0].id] : [];
}

function ComponentsWorkspace({ store, client, glbDeps, ui }: { store: AppStore; client: RpcLike | null; glbDeps: GlbDeps; ui: ComponentsStore }) {
  const snap = useAppState(store, (s) => s.project.snapshot);
  const projectId = useAppState(store, (s) => s.project.projectId);
  const draft = useAppState(store, (s) => s.draft);
  const units = useAppState(store, (s) => s.ui.units);
  const hidden = useAppState(store, (s) => s.ui.hidden);
  const view = useStore(ui, (s) => s.view);
  const collapsed = useStore(ui, (s) => s.collapsed);
  const tabs = useStore(ui, (s) => s.tabs);
  const proposalState = useStore(ui, (s) => s.proposal);
  const library = useStore(ui, (s) => s.library);
  const pageError = useStore(ui, (s) => s.error);
  const ids = useEditedIds(store);
  const committed = snap?.evaluated ?? null;
  const shown = draft.preview ?? committed;
  const check = (draft.preview !== null ? draft.previewCheck : null) ?? snap?.check ?? null;
  const comps = useMemo(() => ids.map((id) => shown?.components.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => c !== undefined), [ids, shown]);
  const primary = comps.length === 1 ? comps[0]!.id : null;
  const files = (snap?.files.files ?? {}) as Readonly<Record<string, string | undefined>>;
  const steps = snap?.history.steps ?? [];
  const engineReady = draft.engine.state === "ready";
  const threadItems = useOpenThreadHistory(store);
  const byAgent = useMemo(() => agentSteps(steps, threadItems), [steps, threadItems]);

  // The proposal of the (single) selected part.
  const key = `${primary ?? ""}|${committed?.model_hash ?? ""}|${draft.preview?.model_hash ?? ""}|${steps.length}|${engineReady}`;
  useEffect(() => {
    if (primary === null || committed === null) {
      ui.setState({ proposal: { key, state: "ready", value: null } });
      return;
    }
    const fromDraft = draftProposal(primary, committed, snap?.check ?? null, draft.preview);
    if (fromDraft !== null || draft.ops.length > 0) {
      ui.setState({ proposal: { key, state: "ready", value: fromDraft } });
      return;
    }
    if (!engineReady || client === null || projectId === null) {
      ui.setState({ proposal: { key, state: "ready", value: null } });
      return;
    }
    let alive = true;
    ui.setState((s) => ({ proposal: { key, state: "loading", value: s.proposal.value } }));
    void (async () => {
      try {
        const { loadRwWasm } = await import("@rw/rw-wasm");
        const rw = await loadRwWasm();
        const value = await findStepProposal(
          { id: primary, current: committed, steps: steps.map((st) => ({ seq: st.seq, title: stepTitle(st) })) },
          {
            compare: (a, b) => {
              const k = `${projectId}|${a}|${b}`;
              let p = compareCache.get(k);
              if (p === undefined) {
                p = client.call("history.compare", { projectId, a, b });
                p.catch(() => compareCache.delete(k));
                compareCache.set(k, p);
              }
              return p;
            },
            apply: (ops) => rw.applyAndEval({ files, ops }),
          },
        );
        if (alive) ui.setState({ proposal: { key, state: "ready", value } });
      } catch (e) {
        if (alive) ui.setState({ proposal: { key, state: "ready", value: null }, error: message(e) });
      }
    })();
    return () => {
      alive = false;
    };
    // `key` captures every input that changes the answer.
  }, [key]);

  // The answer for these inputs, else (while the next one loads, or for the frame before the effect) the last one for the same part.
  const samePart = proposalState.key.split("|")[0] === (primary ?? "");
  const proposal = proposalState.key === key || samePart ? proposalState.value : null;
  // The strip marks the step this proposal shows (strip, viewport, Changed fields, and thread agree).
  const focusStep = proposal?.kind === "step" ? proposal.step : null;
  useEffect(() => {
    store.getState().ui.setFocusStep(focusStep);
  }, [store, focusStep]);
  useEffect(() => () => store.getState().ui.setFocusStep(null), [store]);
  const runs = snap?.runs.runs ?? [];
  const needsRerun = draft.ops.length > 0 || runs.some((r) => r.status === "outdated");
  const status: EditorStatus =
    draft.ops.length > 0 && proposal?.kind === "draft"
      ? { kind: "unsaved", detail: "Simulation needs rerun", title: "Unsaved edit: Enter or leaving the field saves it as a history step; Escape discards it." }
      : proposal !== null
        ? {
            kind: "modified",
            detail: needsRerun ? "Simulation needs rerun" : "Simulations up to date",
            title: proposal.step !== null ? `Changed in step ${String(proposal.step).padStart(2, "0")} · ${proposal.stepTitle ?? ""}` : "Changed",
          }
        : { kind: "clean", detail: needsRerun ? "Simulation needs rerun" : "" };

  const diagnostics = useMemo(() => {
    if (draft.ops.length > 0) return [...(draft.previewCheck?.diagnostics ?? []), ...(draft.delta?.new_diagnostics ?? []), ...(draft.preview?.diagnostics ?? [])];
    return [...(snap?.check?.diagnostics ?? []), ...(committed?.diagnostics ?? [])];
  }, [draft.ops.length, draft.previewCheck, draft.delta, draft.preview, snap?.check, committed]);

  // Fields the agent changed in the revision shown (a marker under each label, never a source path).
  const agentChanged = proposal?.kind === "step" && proposal.step !== null && byAgent.has(proposal.step) ? proposal.fields.map((f) => f.key) : [];

  const tabKey = ids.join(",");
  const tab = tabs[tabKey] ?? "Geometry";
  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => ui.setState({ error: message(e) }));
  const patch = (ops: PatchOp[], label: string) => {
    if (client === null || projectId === null || ops.length === 0) return;
    run(client.call("model.patch", { projectId, ops, label }));
  };
  const materials = Object.keys(shown?.materials ?? {}).sort();

  return (
    <div className="rw-comp" data-testid="components-page" data-collapsed={collapsed ? "true" : "false"}>
      <ProfileView
        evaluated={shown}
        check={check as DeepReadonly<CheckReport> | null}
        base={proposal?.base ?? null}
        selected={primary}
        view={view}
        units={units}
        hidden={hidden}
        glbDeps={glbDeps}
        proposal={proposal !== null}
        onPick={(id) => store.getState().selection.select(id === null ? [] : [componentRef(id)], "viewport")}
      />
      <ComponentEditor
        comps={comps}
        files={files}
        units={units}
        materials={materials}
        diagnostics={diagnostics}
        status={status}
        tab={tab}
        onTab={(t) => ui.setState((s) => ({ tabs: { ...s.tabs, [tabKey]: t } }))}
        collapsed={collapsed}
        onCollapse={(c) => ui.setState({ collapsed: c })}
        canRevert={proposal !== null}
        agentChanged={agentChanged}
        onEdit={(ops, label) => run(store.getState().draft.edit(ops, label))}
        onCommit={() => {
          if (store.getState().draft.ops.length > 0) run(store.getState().draft.commit());
        }}
        onDiscard={() => store.getState().draft.discard()}
        onRevert={() => {
          if (store.getState().draft.ops.length > 0) store.getState().draft.discard();
          else if (proposal?.kind === "step" && proposal.revertOps.length > 0) patch(proposal.revertOps, `Revert ${comps[0]?.name ?? "part"}`);
        }}
        library={library}
        onOpenLibrary={() => {
          if (client === null || projectId === null) return;
          ui.setState({ library: { state: "loading", items: [] } });
          client.call("library.search", { projectId, kind: "preset", limit: 200 }).then(
            (r) => ui.setState({ library: { state: "ready", items: r.items } }),
            (e: unknown) => ui.setState({ library: { state: "error", items: [], error: message(e) } }),
          );
        }}
        onApplyPreset={(item) => {
          const c = comps[0];
          if (c === undefined) return;
          const keys = new Set(editorFields(c.shape.type).filter((f) => f.tab === "Geometry").map((f) => f.key));
          const ops: PatchOp[] = Object.entries(item.data)
            .filter(([k, v]) => keys.has(k) && v !== undefined && v !== null)
            .map(([k, v]) => ({ op: "replace", path: `/c/${c.id}/${k}`, value: v as never }));
          if (ops.length === 0) {
            ui.setState({ error: `${item.name} has no ${c.shape.type.replace(/_/g, " ")} fields to apply.` });
            return;
          }
          patch(ops, `Apply preset ${item.name}`);
        }}
      />
      {(pageError ?? draft.error) !== null && (
        <p className="rw-comp__error" role="alert" data-testid="components.error">
          {pageError ?? draft.error}
          <button type="button" className="rw-link" onClick={() => ui.setState({ error: null })}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}

function ComponentsAgentExtra({ store, ui }: { store: AppStore; ui: ComponentsStore }) {
  const proposal = useStore(ui, (s) => s.proposal.value);
  const units = useAppState(store, (s) => s.ui.units);
  // This thread's steps, the strip's current one current (one owner: the history strip's store).
  const items = useOpenThreadHistory(store);
  const source = proposal === null ? "" : proposal.kind === "draft" ? "Unsaved edit" : `Step ${String((proposal.step ?? 1) - 1).padStart(2, "0")} → ${String(proposal.step ?? 0).padStart(2, "0")}`;
  return (
    <>
      {proposal !== null && proposal.fields.length > 0 && (
        <ChangedFieldsCard
          fields={proposal.fields}
          units={units}
          source={source}
          step={proposal.kind === "step" ? proposal.step : null}
          onCompare={
            proposal.step === null
              ? null
              : () => window.dispatchEvent(new CustomEvent<CompareEventDetail>(COMPARE_EVENT, { detail: { a: `step:${proposal.step! - 1}`, b: `step:${proposal.step!}` } }))
          }
        />
      )}
      <ThreadHistory
        items={items}
        onOpen={(seq) => {
          // Keep the edited parts selected; the step ref moves the history strip's current step.
          const keep = store.getState().selection.refs.filter((r) => r.startsWith("rw:c/"));
          store.getState().selection.select([...keep, `rw:step/${seq}` as RwRef], "agent");
        }}
      />
    </>
  );
}
