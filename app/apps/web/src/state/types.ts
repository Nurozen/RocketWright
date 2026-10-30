/** Shared types for the app store slices (M1.48). */
import type {
  CheckDelta,
  CheckReport,
  EmbedThread,
  EvaluatedModel,
  JobInfo,
  MutationOut,
  PageId,
  PatchOp,
  ProjectSnapshot,
  RpcHelloFrame,
  RwRef,
  SimulateOut,
  ViewId,
} from "@rw/contracts";
import type { RpcLike } from "./rpc.ts";
import type { PreviewCore, WasmStatus } from "./wasm.ts";

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

/** Read-only mirror of the server's ProjectHost (I1: the UI never owns project files). */
export interface ProjectSlice {
  projectId: string | null;
  connection: ConnectionState;
  hello: RpcHelloFrame | null;
  /** Deep-frozen; replaced per key by `project.patch` pushes. */
  snapshot: DeepReadonly<ProjectSnapshot> | null;
  subscriptionId: string | null;
  /** Clock ms of the last snapshot or patch (header "Saved N minutes ago"). */
  updatedAt: number | null;
  error: string | null;
  /** Subscribes to `projectId`, loads threads, and loads + handshakes the wasm core. */
  connect(client: RpcLike, projectId: string): Promise<void>;
  disconnect(): void;
}

/** Unsaved UI edits previewed through rw-wasm (and sidecar dry runs). */
export interface DraftSlice {
  ops: PatchOp[];
  label: string | null;
  /** `model_hash` the draft was started on. */
  baseHash: string | null;
  /** The model changed underneath the draft (another writer committed). */
  stale: boolean;
  /** WASM `apply_and_eval` of the draft (null without a ready preview core). */
  preview: EvaluatedModel | null;
  /** Static check of `preview` (live CG/CP while editing), when the core provides it. */
  previewCheck: CheckReport | null;
  previewError: string | null;
  /** Sidecar `model.patch` dry-run delta for the current ops. */
  delta: CheckDelta | null;
  pending: boolean;
  error: string | null;
  engine: WasmStatus;
  edit(ops: PatchOp[], label?: string): Promise<void>;
  discard(): void;
  commit(): Promise<MutationOut>;
}

export type SelectionSource = "tree" | "viewport" | "inspector" | "chat" | "table" | "diagram" | "history" | "agent";

/** One selection model shared by tree, viewport, inspector, tables, and chat chips (C §5.1). */
export interface SelectionSlice {
  refs: RwRef[];
  source: SelectionSource | null;
  /** Bumps on every effective change (sync loops compare it). */
  seq: number;
  select(refs: readonly RwRef[], source: SelectionSource): void;
}

export type Units = "mm" | "cm" | "m" | "in";

export interface UiSlice {
  page: PageId;
  tab: string | null;
  view: ViewId;
  /** 0..1 */
  explode: number;
  /** Whether the last explode change asked for the eased animation (M3.2; the slider jumps). */
  explodeAnimate: boolean;
  section: boolean;
  showInternals: boolean;
  shadows: boolean;
  units: Units;
  /** Component ids hidden with the tree eye toggle. */
  hidden: string[];
  /**
   * The open Compare view (M2.7): Old and New versions (`step:N`, `rev:NN`,
   * `run:<id>`, `live`), or null when closed.
   */
  compare: CompareSelection | null;
  /**
   * The history step the page is showing (page 02: the step whose change the
   * selected part's proposal shows), or null. The history strip marks it as
   * current when no step is selected, so strip, viewport, Changed fields
   * card, and thread agree (BC5).
   */
  focusStep: number | null;
  navigate(page: PageId, tab?: string): void;
  /** `animate` eases the explode change (M3.2) instead of jumping. */
  setView(v: { view?: ViewId; explode?: number; animate?: boolean; section?: boolean; showInternals?: boolean; shadows?: boolean }): void;
  setUnits(units: Units): void;
  toggleHidden(id: string): void;
  /** Opens (or retargets) the Compare view; null closes it. */
  setCompare(sel: CompareSelection | null): void;
  setFocusStep(seq: number | null): void;
}

/** Old and New of the Compare view. */
export interface CompareSelection {
  old: string;
  new: string;
}

/**
 * The agent pane's state on the app side (B12): the embedded Lecturn chat
 * runs in the guest, so the app keeps only the project's Lecturn threads for
 * the rail and the one the embed shows. (B17 removed the old chat's threads,
 * timelines and approvals.)
 */
export interface ChatSlice {
  lecturn: LecturnThreads;
  /** Whether the Lecturn embed is mounted as the pane (the rail then lists `lecturn.threads`). */
  setEmbedded(on: boolean): void;
  /** The thread the embed shows now (the guest's `thread.changed`/`ready`, or a rail click). */
  setLecturnThread(threadId: string | null): void;
}

/**
 * The project's Lecturn threads (B12; `embed.threads` pushes) and the one the
 * embed shows. `activeKey` is that thread's rail key (`embed/threads.ts`
 * `railKey`): it keeps the rail selection through a live switch (D25), while
 * the new server's list has not arrived yet.
 */
export interface LecturnThreads {
  embedded: boolean;
  /** Null until the first push (or without Lecturn). */
  threads: EmbedThread[] | null;
  activeThreadId: string | null;
  activeKey: string | null;
}

/** Series colours for the overlay: A teal, B sand (C §2). */
export const SERIES_COLORS = ["#61b5ad", "#f1ae6e"] as const;

export interface RunsSlice {
  /** Sims overlaid on the plots, at most two (series A, B). */
  overlay: string[];
  /** Last `sim.run` answer per sim. */
  started: Record<string, SimulateOut>;
  error: string | null;
  run(sim: string, opts?: { force?: boolean }): Promise<SimulateOut>;
  cancel(jobId: string): Promise<JobInfo>;
  /** Overlay a run row by its key (`rowKey`: the sim id, or `<sim>@<run id>` for a superseded run). */
  toggleOverlay(key: string): void;
}

export interface AppState {
  project: ProjectSlice;
  draft: DraftSlice;
  selection: SelectionSlice;
  ui: UiSlice;
  chat: ChatSlice;
  runs: RunsSlice;
  thumbs: ThumbsSlice;
}

/** Rendered part thumbnails of the committed model (M3.6). */
export interface ThumbsSlice {
  /** `model_hash` the thumbnails belong to. */
  hash: string | null;
  /** `thumbKey(id, variant)` -> PNG data URL. */
  urls: Record<string, string>;
  /** Keys this window rendered (the rest came from the cache). */
  rendered: string[];
  /** Switches to `hash` and reads its cached thumbnails (`thumb.get`). */
  load(hash: string): Promise<void>;
  /** Adds a rendered thumbnail and stores it in the cache (`thumb.put`). */
  add(hash: string, key: string, pngBase64: string): Promise<void>;
}

export type SliceKey = keyof AppState;

/** Shared by the slice creators: store access plus the live connection. */
export interface SliceCtx {
  get(): AppState;
  /** Shallow-merges `partial` into slice `key`. */
  patch<K extends SliceKey>(key: K, partial: Partial<AppState[K]> | ((s: AppState[K]) => Partial<AppState[K]>)): void;
  /** The connected client and project, or throws. */
  conn(): { client: RpcLike; projectId: string };
  client: RpcLike | null;
  projectId: string | null;
  /** The loaded wasm core (kept across mismatches so a sidecar restart can re-handshake). */
  core: PreviewCore | null;
  loadCore: () => Promise<PreviewCore>;
  now(): number;
  /** Disposers for the current connection's listeners. */
  cleanup: (() => void)[];
}
