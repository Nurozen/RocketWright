/**
 * Shell view model (M1.19, M1.49). The shell components are presentational:
 * `shellModelFrom` (connect.ts) maps the web state (M1.48, `src/state`) and
 * its RPC mirror (IF10 `ProjectSnapshot`, `ThreadInfo`, history) onto this
 * shape. `PLACEHOLDER_SHELL` is the static stand-in used without a server.
 */
import type { PageId, RwRef } from "@rw/contracts";
import type { StatusView } from "../state/status.ts";
import type { IconName } from "./Icon.tsx";

/** Header tabs, in display order (concepts.md §3). */
export const TOP_TABS = [
  { id: "design", label: "Design" },
  { id: "propulsion", label: "Propulsion" },
  { id: "simulate", label: "Simulate" },
  { id: "results", label: "Results" },
] as const;
export type TopTab = (typeof TOP_TABS)[number]["id"];

/** Design local tabs (concepts.md §3 Local tabs). */
export const DESIGN_TABS = [
  { id: "assembly", label: "Assembly" },
  { id: "components", label: "Components" },
  { id: "configurations", label: "Configurations" },
] as const;
export type DesignTab = (typeof DESIGN_TABS)[number]["id"];

/** Bar page id (tests/bar/regions.json) → header tab and Design local tab. */
export const BAR_PAGES = {
  "01": { tab: "design", local: "assembly" },
  "02": { tab: "design", local: "components" },
  "03": { tab: "design", local: "configurations" },
  "04": { tab: "results", local: null },
  "05": { tab: "propulsion", local: null },
  "06": { tab: "simulate", local: null },
} as const satisfies Record<string, { tab: TopTab; local: DesignTab | null }>;
export type BarPage = keyof typeof BAR_PAGES;

export function isBarPage(v: string | null): v is BarPage {
  return v !== null && Object.hasOwn(BAR_PAGES, v);
}

/** State page (`ui.page`, IF11 PageId) → header tab and Design local tab. */
export const PAGE_TABS: Readonly<Record<PageId, { tab: TopTab; local: DesignTab | null }>> = {
  assembly: { tab: "design", local: "assembly" },
  components: { tab: "design", local: "components" },
  configurations: { tab: "design", local: "configurations" },
  results: { tab: "results", local: null },
  liquid: { tab: "propulsion", local: null },
  "propulsion-sim": { tab: "simulate", local: null },
};

/** Header tab (and Design local tab) → state page. */
export function pageOf(tab: TopTab, local: DesignTab | null = null): PageId {
  switch (tab) {
    case "design":
      return local ?? "assembly";
    case "results":
      return "results";
    case "propulsion":
      return "liquid";
    case "simulate":
      return "propulsion-sim";
  }
}

/** Bar page id → state page. */
export function pageOfBar(page: BarPage): PageId {
  const { tab, local } = BAR_PAGES[page];
  return pageOf(tab, local);
}

export interface ShellThread {
  id: string;
  title: string;
  /** Relative age of the last activity, already formatted (`3m`, `1h`). */
  age: string;
  /** A turn is running. */
  busy?: boolean;
  /** `rw:` ref of the bound artifact (artifact threads only). */
  artifact?: RwRef;
}

export interface ShellNavRow {
  id: string;
  label: string;
  icon: IconName;
  hidden?: boolean;
  /** Tree depth (0 = root) for indentation. */
  depth?: number;
  /** The entity the row stands for (selection, thread binding). */
  ref?: RwRef;
  /** Status vocabulary badge (Runs rail). */
  status?: Pick<StatusView, "label" | "icon" | "tone"> & { reason?: string };
  /** Series colour when the run is overlaid. */
  color?: string;
}

export interface ShellNavSection {
  title: string;
  rows: ShellNavRow[];
  /** What the eye toggle means: hide in the viewport (components) or plot (runs). */
  eye?: "visibility" | "plot";
  /** Shown when there are no rows. */
  empty?: string;
}

export interface ShellHistoryStep {
  id: string;
  /** 1-based display number (`01`). */
  number: number;
  name: string;
  /** Formatted date (`Apr 12, 2026`). */
  date: string;
  /** Named revision tagged at this step (`Rev 07 · Flight-ready fins`). */
  revision?: string;
  ref?: RwRef;
  /** `user`, `mcp` (agent), `watcher` (external edit), … */
  origin?: string;
}

export type CheckStatus = "unknown" | "running" | "ok" | "issues" | "errors" | "outdated";

export interface ShellProject {
  id: string;
  name: string;
}

export interface ShellModel {
  projectName: string;
  /** Formatted save state (`Saved 2 minutes ago`). */
  saveState: string;
  /** Amber while unsaved UI edits exist. */
  saveTone?: "muted" | "amber";
  check: { status: CheckStatus; issues: number; label?: string };
  threads: ShellThread[];
  selectedThreadId: string | null;
  nav: ShellNavSection | null;
  selectedNavId: string | null;
  history: ShellHistoryStep[];
  currentStepId: string | null;
  /**
   * Header undo/redo (undo.ts): the step each would restore, null when there
   * is nothing to move to. Absent: no history to move through (static shell).
   */
  undo?: { undo: ShellHistoryStep | null; redo: ShellHistoryStep | null };
  /** Open projects for the header switcher. */
  projects?: ShellProject[];
  projectId?: string | null;
  /** Agent pane provenance footer: the source of the data shown (project and model revision, or the offline stand-in). */
  provenance?: string;
}

export const COMPOSER_PLACEHOLDER: Record<TopTab, string> = {
  design: "Ask about this design…",
  propulsion: "Ask about this propulsion system…",
  simulate: "Ask about this simulation…",
  results: "Ask about these results…",
};

/** Pages whose composer names their subject (concept 03 `Ask about this configuration…`). */
export const PAGE_COMPOSER_PLACEHOLDER: Partial<Record<PageId, string>> = {
  configurations: "Ask about this configuration…",
  liquid: "Ask about this design…",
};

/** Composer placeholder for a page: its own, else its header tab's. */
export function composerPlaceholder(page: PageId): string {
  return PAGE_COMPOSER_PLACEHOLDER[page] ?? COMPOSER_PLACEHOLDER[PAGE_TABS[page].tab];
}

/** Two-digit step label (`01`). */
export function stepLabel(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The offline stand-in's design history: the static shell's strip and the
 * canned exchange's step card both read it, so the card always names a step
 * that exists in the strip (never a hardcoded number).
 */
export const PLACEHOLDER_HISTORY: readonly ShellHistoryStep[] = [
  { id: "step:1", number: 1, name: "Initial concept", date: "Oct 12, 2026", ref: "rw:step/1" },
  { id: "step:2", number: 2, name: "Assembly layout", date: "Oct 13, 2026", ref: "rw:step/2" },
  { id: "step:3", number: 3, name: "Fin revision", date: "Oct 14, 2026", ref: "rw:step/3" },
  { id: "step:4", number: 4, name: "Exploded assembly", date: "Oct 15, 2026", ref: "rw:step/4" },
];

/** The head of `PLACEHOLDER_HISTORY` (the step the canned exchange recorded). */
export const PLACEHOLDER_HEAD: ShellHistoryStep = PLACEHOLDER_HISTORY.at(-1)!;

/** Static stand-in shell used without a server (offline capture, render tests). */
export const PLACEHOLDER_SHELL: ShellModel = {
  projectName: "Research vehicle",
  saveState: "Saved just now",
  check: { status: "unknown", issues: 0 },
  threads: [{ id: "t-1", title: "Assembly review", age: "now" }],
  selectedThreadId: "t-1",
  nav: {
    title: "Components",
    eye: "visibility",
    rows: [
      { id: "nose", label: "Nosecone", icon: "nose-cone", ref: "rw:c/nose" },
      { id: "recovery_bay", label: "Recovery bay", icon: "recovery-bay", ref: "rw:c/recovery_bay" },
      { id: "airframe", label: "Airframe tube", icon: "body-tube", ref: "rw:c/airframe" },
      { id: "fins", label: "Fin set", icon: "fin-set", ref: "rw:c/fins" },
      { id: "motor", label: "Motor casing", icon: "motor", ref: "rw:c/motor" },
    ],
  },
  selectedNavId: "recovery_bay",
  history: [...PLACEHOLDER_HISTORY],
  currentStepId: PLACEHOLDER_HEAD.id,
  // True of this view: no server, a canned exchange over a stand-in tree.
  provenance: "Offline preview · canned exchange",
};
