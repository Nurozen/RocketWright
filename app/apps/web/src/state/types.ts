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
  schema,
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
  error: string | null;
  /** Subscribes to `projectId`, loads threads, and loads + handshakes the wasm core. */
  connect(client: RpcLike, projectId: string): Promise<void>;
  disconnect(): void;
  /** `library.search` on this project; throws when no project is connected. */
  searchLibrary(query: schema.LibrarySearchIn): Promise<schema.LibrarySearchOut>;
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
  /** The check is left to the sidecar's dry run: this rocket's motor is one the WASM core cannot load. */
  previewDeferred: boolean;
  previewError: string | null;
  /** Sidecar `model.patch` dry-run delta for the current ops. */
  delta: CheckDelta | null;
  pending: boolean;
  error: string | null;
  engine: WasmStatus;
  edit(ops: PatchOp[], label?: string): Promise<void>;
  discard(): void;
  commit(): Promise<MutationOut>;
  /** Resolves when no commit is on its way, to the `model_hash` the mirror still has to show (a landed write whose push has not come), or null. */
  settled(): Promise<string | null>;
  /** A direct write answered with this `model_hash`: `settled` reports it until the push that shows it arrives. */
  noteLanded(hash: string): void;
  /** What `ops` would do, written nowhere; leaves the open draft alone. */
  dryRun(ops: readonly PatchOp[]): Promise<MutationOut>;
  /** Commits one direct edit after settling any open draft; rejects with a user-facing message. */
  mutate(ops: readonly PatchOp[], label?: string): Promise<MutationOut | null>;
  /** Deletes a part (and `also` any more parts), what is attached to them, and their motor and deploy entries, as one step; settles any open draft first. */
  removeComponent(id: string, label: string, also?: readonly string[]): Promise<MutationOut>;
}

export type SelectionSource = "tree" | "viewport" | "inspector" | "chat" | "table" | "diagram" | "history" | "agent" | "check";

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
  /** The open part dialog (rename, delete confirmation, or a failed part operation), or null. */
  partDialog: PartDialog | null;
  /** A page change is waiting on the person: what could not be saved. */
  leaving: { problems: readonly string[] } | null;
  /** The answer to `leaving`: true drops what could not be saved and changes page. */
  answerLeave(leave: boolean): void;
  /** Changes page once what the page holds is saved, or the person chose to drop it. The change is immediate when nothing is unsaved. */
  navigate(page: PageId, tab?: string): void;
  /** `navigate`, for a caller that goes on to act on the new page. */
  goToPage(page: PageId, tab?: string): Promise<void>;
  /** `animate` eases the explode change (M3.2) instead of jumping. */
  setView(v: { view?: ViewId; explode?: number; animate?: boolean; section?: boolean; showInternals?: boolean; shadows?: boolean }): void;
  /** Sets the toolbar's unit locally; what the project's own `[display_units]` drives. */
  setUnits(units: Units): void;
  /** The Units control (R3.4): writes the project's `[display_units]`, which does not change the model hash. Never rejects: a failure reverts and shows the error dialog. */
  setProjectUnits(units: Units): Promise<void>;
  toggleHidden(id: string): void;
  /** Opens (or retargets) the Compare view; null closes it. */
  setCompare(sel: CompareSelection | null): void;
  setFocusStep(seq: number | null): void;
  setPartDialog(dialog: PartDialog | null): void;
}

/** Held in the store because the tree, the inspector and the Delete key all open the same dialogs. */
export type PartDialog = { kind: "rename"; id: string } | { kind: "delete"; id: string; also?: readonly string[] } | { kind: "error"; title: string; message: string };

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
  /**
   * Asks the app server for a new thread (`embed.createThread`) and records
   * how that went in `lecturn.threadStart`. Resolves its id, or null when one
   * is already being made or it failed (the reason is on screen, not thrown).
   */
  createThread(input: { title: string; appData: string }): Promise<string | null>;
}

/** A new thread on its way: what the rail and the empty pane's prompt show meanwhile, and why it did not arrive. */
export type ThreadStart = { state: "idle" } | { state: "starting" } | { state: "error"; message: string };

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
  threadStart: ThreadStart;
}

/**
 * Series colours for the Results overlay, in slot order: A teal, B sand (C §2),
 * then four more for R3.5's six runs. Every pair stays at least 8.5 OKLab dE
 * apart under protan, deutan and tritan simulation, each new colour at 3:1 or
 * better on the page background; the plot's legend names each run, so identity
 * never rests on colour alone.
 * Mirrors `--rw-series-*` in tokens.css.
 */
export const SERIES_COLORS = ["#61b5ad", "#f1ae6e", "#3a6bb8", "#9f75e1", "#b83d6d", "#38a017"] as const;

/** The overlay's slots, one per colour, in order (`data-series` on rows, dots and legend swatches). */
export const SERIES_SLOTS = ["a", "b", "c", "d", "e", "f"] as const;

export type SeriesSlot = (typeof SERIES_SLOTS)[number];

export interface RunsSlice {
  /** Row keys overlaid on the plots, at most six (`SERIES_SLOTS`), oldest pick first. */
  overlay: string[];
  /** Last `sim.run` answer per sim. */
  started: Record<string, SimulateOut>;
  error: string | null;
  run(sim: string, opts?: { force?: boolean }): Promise<SimulateOut>;
  cancel(jobId: string): Promise<JobInfo>;
  /** Clears `error`, once it has been read. */
  dismissError(): void;
  /** Removes one stored run (`run.delete`) and drops it from the plot overlay and the selection. */
  deleteRun(target: { key: string; sim: string; runId: string }): Promise<void>;
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
  /** A draft commit is on its way, so a mirror change may be that commit and not another writer. */
  draftWriting: boolean;
  /** The hash the last write produced, until the mirror reaches it. `from` is the mirror when it landed; `through` the writes before it whose pushes come first. */
  landed: { from: string | null; to: string; through: string[] } | null;
}
