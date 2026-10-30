/**
 * Store → shell view model (M1.49): header save/check state, the page's
 * threads, the page navigation section (Components tree or Runs), and the
 * design history with named revisions. Pure, so tests and captures can
 * render any state.
 */
import type { PageId, RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import { railThreads, selectedRailId } from "../embed/rail.ts";
import { componentIcon } from "../state/entities.ts";
import { formatDate, relativeAge, savedAgo, stepNumber } from "./format.ts";
import { checkStatus, runRows, saveStatus } from "../state/selectors.ts";
import type { AppState } from "../state/types.ts";
import type { CheckStatus, ShellHistoryStep, ShellModel, ShellNavSection, ShellProject } from "./model.ts";
import { canonicalStep, stepTitle, undoState } from "./undo.ts";

const shapeType = (shape: unknown): string | undefined =>
  typeof shape === "object" && shape !== null && "type" in shape && typeof shape.type === "string" ? shape.type : undefined;

function checkOf(s: AppState, running: boolean): ShellModel["check"] {
  if (running) return { status: "running", issues: 0, label: "Checking model…" };
  const v = checkStatus(s);
  const map: Partial<Record<typeof v.kind, CheckStatus>> = {
    unchecked: "unknown",
    checked: "ok",
    outdated: "outdated",
    errors: "errors",
    warnings: "issues",
    missing_inputs: "issues",
  };
  return { status: map[v.kind] ?? "unknown", issues: v.count ?? 0, label: v.label };
}

function componentsNav(s: AppState): ShellNavSection {
  const comps = s.project.snapshot?.evaluated?.components ?? [];
  // Tree order (depth-first from the root); a flat list as in concept 01, internals included.
  return {
    title: "Components",
    eye: "visibility",
    empty: s.project.snapshot === null ? "Open a project to see its components." : "No components yet.",
    rows: comps.map((c) => ({
      id: c.id,
      label: c.name,
      icon: componentIcon(shapeType(c.shape), c.name),
      hidden: s.ui.hidden.includes(c.id),
      ref: `rw:c/${c.id}`,
    })),
  };
}

function runsNav(s: AppState): ShellNavSection {
  return {
    title: "Runs",
    eye: "plot",
    empty: "No simulations defined.",
    rows: runRows(s).map((r) => ({
      id: r.key,
      label: r.name,
      icon: "run" as const,
      hidden: r.color === null,
      ref: r.entry.superseded_by != null && r.entry.run_id != null ? (`rw:run/${r.entry.run_id}` as const) : (`rw:sim/${r.sim}` as const),
      status: { label: r.status.label, icon: r.status.icon, tone: r.status.tone, ...(r.status.reason !== undefined ? { reason: r.status.reason } : {}) },
      ...(r.color !== null ? { color: r.color } : {}),
    })),
  };
}

function navFor(s: AppState, page: PageId): ShellNavSection | null {
  switch (page) {
    case "assembly":
    case "components":
    case "configurations":
      return componentsNav(s);
    case "results":
      return runsNav(s);
    case "liquid":
      return { title: "Propulsion system", rows: [], empty: "No liquid engine in this project." };
    case "propulsion-sim":
      return { title: "Simulation", rows: [], empty: "Run a propulsion simulation from the Simulate page." };
  }
}

/** The step a selection points at (`rw:step/<seq>`), if any. */
function selectedStep(refs: readonly RwRef[]): number | null {
  for (const r of refs) {
    const p = parseRef(r);
    if ("ok" in p && p.ok.kind === "step") return Number(p.ok.id);
  }
  return null;
}

/**
 * Agent pane provenance footer: the project and the model revision the pane is
 * looking at (`Research vehicle · Rev 07 · Step 12`): the step the page shows
 * (`ui.focusStep`), else the latest. Only what is true of the
 * data: no snapshot, no footer.
 */
export function provenanceOf(s: AppState): string | undefined {
  const snap = s.project.snapshot;
  if (snap === null) return undefined;
  const latest = snap.history.steps.reduce<number | null>((m, st) => (m === null || st.seq > m ? st.seq : m), null);
  if (latest === null) return `${snap.project.name} · no history yet`;
  // The step the page shows (page 02's proposal), so the footer agrees with the strip and the Changed fields card.
  const focus = s.ui.focusStep;
  const head = focus !== null && snap.history.steps.some((st) => st.seq === focus) ? canonicalStep(snap.history.steps, snap.history.revisions, focus) : latest;
  const rev = snap.history.revisions.filter((r) => r.step <= head).sort((a, b) => b.step - a.step || b.number - a.number)[0];
  return [snap.project.name, ...(rev !== undefined ? [`Rev ${stepNumber(rev.number)}`] : []), `Step ${stepNumber(head)}`].join(" · ");
}

/**
 * The history strip's current step (its teal ring): a selected step, else
 * the step the page shows (page 02's proposal), else the shown state (the
 * head, or the state an undo restored). Null without history. The thread
 * history (page 05) marks the same step current.
 */
export function stripCurrentStep(s: AppState): number | null {
  const steps = [...(s.project.snapshot?.history.steps ?? [])].sort((a, b) => a.seq - b.seq);
  if (steps.length === 0) return null;
  const revs = s.project.snapshot?.history.revisions ?? [];
  const picked = selectedStep(s.selection.refs);
  if (picked !== null && steps.some((x) => x.seq === picked)) return picked;
  // A restore step stands for the state it restored (undo moves the pointer back, not forward).
  const focus = s.ui.focusStep !== null ? canonicalStep(steps, revs, s.ui.focusStep) : null;
  if (focus !== null && steps.some((x) => x.seq === focus)) return focus;
  const cursor = undoState(steps, revs);
  return cursor.shown ?? steps.at(-1)!.seq;
}

export interface ShellExtras {
  /** `check.run` in flight. */
  checking?: boolean;
  projects?: ShellProject[];
}

export function shellModelFrom(s: AppState, now: number, extras: ShellExtras = {}): ShellModel & { headStepId: string | null; shownStepId: string | null } {
  const snap = s.project.snapshot;
  const page = s.ui.page;
  const modified = saveStatus(s).kind === "modified";
  const steps = [...(snap?.history.steps ?? [])].sort((a, b) => a.seq - b.seq);
  const revs = snap?.history.revisions ?? [];
  const history: ShellHistoryStep[] = steps.map((st) => {
    const rev = revs.find((r) => r.step === st.seq);
    return {
      id: `step:${st.seq}`,
      number: st.seq,
      name: stepTitle(st),
      date: formatDate(st.ts),
      ref: `rw:step/${st.seq}`,
      origin: st.origin,
      ...(rev !== undefined ? { revision: `Rev ${stepNumber(rev.number)} · ${rev.name}` } : {}),
    };
  });
  const head = steps.at(-1);
  const headStepId = head !== undefined ? `step:${head.seq}` : null;
  // The workspace shows the head's tree; after an undo (a restore) that is an earlier step's state.
  const cursor = undoState(steps, revs);
  const shownStepId = cursor.shown !== null ? `step:${cursor.shown}` : headStepId;
  const current = stripCurrentStep(s);
  const currentStepId = current !== null ? `step:${current}` : shownStepId;
  const byId = (seq: number | null) => (seq === null ? null : (history.find((h) => h.number === seq) ?? null));

  const nav = navFor(s, page);
  const provenance = provenanceOf(s);
  const selectedNavId =
    nav?.rows.find((r) => r.ref !== undefined && s.selection.refs.includes(r.ref))?.id ??
    (page === "results"
      ? (runRows(s).find((r) => s.selection.refs.some((ref) => ref === `rw:run/${r.entry.run_id ?? ""}`))?.key ?? null)
      : null);

  return {
    projectName: snap?.project.name ?? (s.project.connection === "connecting" ? "Opening…" : "No project"),
    projectId: s.project.projectId,
    projects: extras.projects ?? (snap ? [{ id: snap.project.projectId, name: snap.project.name }] : []),
    saveState: modified ? "Modified · not saved" : savedAgo(s.project.updatedAt, now),
    saveTone: modified ? "amber" : "muted",
    check: checkOf(s, extras.checking === true),
    threads: railThreads(s).map((t) => ({
      id: t.id,
      title: t.title,
      age: relativeAge(t.updatedAt, now),
      busy: t.busy,
      ...(t.binding !== null && "artifact" in t.binding ? { artifact: t.binding.artifact } : {}),
    })),
    selectedThreadId: selectedRailId(s),
    nav,
    selectedNavId,
    history,
    currentStepId,
    headStepId,
    shownStepId,
    undo: { undo: byId(cursor.undo), redo: byId(cursor.redo) },
    ...(provenance !== undefined ? { provenance } : {}),
  };
}
