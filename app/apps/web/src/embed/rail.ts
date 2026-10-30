/**
 * The left rail's agent threads and the shell actions on them (pure TS, no
 * React; B12, R6.9): the project's Lecturn threads bound to pages through
 * their `appData`, opening and creating them through the embedded pane's
 * bridge (`lecturn/thread.open`, `lecturn/thread.new`), Settings (Lecturn's
 * providers panel), and page navigation that keeps the pane on one of the
 * page's threads. Opening refs and result cards lives in
 * `state/navigation.ts`. (B17 removed the old chat these used to drive.)
 */
import type { PageId, RwRef, ThreadBinding } from "@rw/contracts";
import { entityOf, pageOfRef } from "../state/entities.ts";
import type { AppState } from "../state/types.ts";
import type { AppStore } from "../state/store.ts";
import { activeRailKey, appDataOf, embedRailThreads, listedOn, paneOf, type RailThread } from "./threads.ts";

/**
 * Threads the rail lists on `page`, newest first: the project's Lecturn
 * threads bound to the page, or to an artifact that lives on it (by their
 * parsed `appData`), one entry per source thread (a copy and its sidecar
 * original are one, D21, D25), and unbound ones on every page. Empty until
 * the pane is mounted.
 */
export function railThreads(s: AppState, page: PageId = s.ui.page): RailThread[] {
  if (!lecturnRail(s)) return [];
  return embedRailThreads(s.chat.lecturn.threads ?? []).filter((t) => listedOn(t.binding, page, pageOfRef));
}

/** The rail lists Lecturn's threads: the embed is mounted as the pane. */
export function lecturnRail(s: AppState): boolean {
  return s.chat.lecturn.embedded;
}

/** The rail entry that shows as selected: the embed's thread, by its rail key (D25). */
export function selectedRailId(s: AppState): string | null {
  if (!lecturnRail(s)) return null;
  const l = s.chat.lecturn;
  return activeRailKey(l.threads, l.activeThreadId, l.activeKey);
}

/** The Lecturn thread bound to `ref`, if any (its rail entry). */
export function embedArtifactThread(s: AppState, ref: RwRef): RailThread | undefined {
  return embedRailThreads(s.chat.lecturn.threads ?? []).find((t) => t.binding !== null && "artifact" in t.binding && t.binding.artifact === ref);
}

/** The embed's bridge when it is the pane and mounted, else null. */
function embedPane(store: AppStore) {
  return lecturnRail(store.getState()) ? paneOf(store) : null;
}

/**
 * Opens a thread: `id` is a rail key or a Lecturn thread id; the pane is
 * asked to show its current thread (`lecturn/thread.open`).
 */
export async function openThread(store: AppStore, id: string): Promise<void> {
  const s = store.getState();
  if (!lecturnRail(s)) return;
  const entry = embedRailThreads(s.chat.lecturn.threads ?? []).find((t) => t.id === id || t.threadId === id);
  const threadId = entry?.threadId ?? id;
  const pane = paneOf(store);
  if (pane === null) return;
  s.chat.setLecturnThread(threadId);
  pane.openThread(threadId);
}

/** Settings (header, agent pane; W3.6): Lecturn's providers panel opens in the pane. */
export function openProviders(store: AppStore): void {
  embedPane(store)?.openProviders();
}

/** Asks the embed for a new thread whose binding the Lecturn server sets as it creates it (D12). */
function newEmbedThread(store: AppStore, binding: ThreadBinding, title: string): void {
  embedPane(store)?.newThread({ title, appData: appDataOf(binding) });
}

/** `+ New thread`: a thread bound to the current page (the pane reports it once made). */
export function newPageThread(store: AppStore, title?: string): void {
  newEmbedThread(store, { page: store.getState().ui.page }, title ?? "New thread");
}

/**
 * Opening an artifact (component, run, revision, step) opens its bound
 * thread, or asks for a new one bound to it with the artifact's name as the
 * title.
 */
export async function openArtifactThread(store: AppStore, ref: RwRef, title?: string): Promise<void> {
  const s = store.getState();
  if (!lecturnRail(s)) return;
  const bound = embedArtifactThread(s, ref);
  if (bound !== undefined) await openThread(store, bound.id);
  else newEmbedThread(store, { artifact: ref }, title ?? entityOf(s.project.snapshot, ref, s.runs.overlay).label);
}

/**
 * Keeps the pane on one of the page's threads: when the selected thread is
 * not listed on the page, the newest page thread opens. A page without
 * threads keeps what the pane shows.
 */
export async function ensurePageThread(store: AppStore): Promise<void> {
  const s = store.getState();
  if (!lecturnRail(s) || s.chat.lecturn.threads === null || paneOf(store) === null) return;
  const listed = railThreads(s);
  const selected = selectedRailId(s);
  // A thread the list does not name yet (just made) is left alone until it does.
  if (selected === null && s.chat.lecturn.activeThreadId !== null) return;
  if (selected !== null && listed.some((t) => t.id === selected)) return;
  const first = listed[0];
  if (first !== undefined) await openThread(store, first.id);
}

/** Switches page and rebinds the agent pane to that page's threads. */
export async function navigatePage(store: AppStore, page: PageId, tab?: string): Promise<void> {
  store.getState().ui.navigate(page, tab);
  await ensurePageThread(store);
}
