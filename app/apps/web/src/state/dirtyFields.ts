/**
 * Typed values that have not reached the model yet (D22). `project.disconnect`
 * clears the draft, a page change unmounts the fields with no blur, and a
 * native accelerator fires with no blur, so anything that leaves a project or
 * a page asks here first: every field that holds typed text registers, and
 * every write a field starts is tracked, so a flush can wait for the ones
 * already on their way.
 *
 * A module of its own rather than store state: a field is a closure over its
 * component, and only one project surface is mounted at a time.
 */
import { useEffect, useRef } from "react";
import type { AppStore } from "./store.ts";

export interface DirtyField {
  /** Holds typed text the model does not have. */
  dirty(): boolean;
  /** Writes the text. A string says why it cannot be saved as typed; null means it was sent (or there was nothing to send). */
  commit(): string | null;
  /** The person chose not to save this: forget the typed text, so nothing later writes it. */
  discard?(): void;
}

const fields = new Set<DirtyField>();
/** Writes on their way; each resolves to why it failed, or null. */
const writes = new Set<Promise<string | null>>();
/** Told when a field comes or goes and when a write lands. */
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function onDirtyFieldsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function registerDirtyField(field: DirtyField): () => void {
  fields.add(field);
  changed();
  return () => {
    fields.delete(field);
    changed();
  };
}

/** Registers `field` for this component's life, always reading its latest render. */
export function useDirtyField(field: DirtyField): void {
  const latest = useRef(field);
  latest.current = field;
  useEffect(() => registerDirtyField({ dirty: () => latest.current.dirty(), commit: () => latest.current.commit(), discard: () => latest.current.discard?.() }), []);
}

/** Lets a flush wait for `write`. `failure` turns its result into the reason it did not save. */
export function trackWrite<T>(write: Promise<T>, failure?: (result: T) => string | null): Promise<T> {
  const settled: Promise<string | null> = write.then(
    (result) => failure?.(result) ?? null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  writes.add(settled);
  void settled.finally(() => {
    writes.delete(settled);
    changed();
  });
  return write;
}

/** True while any field write started by a blur or a flush is still on its way. */
export function writesPending(): boolean {
  return writes.size > 0;
}

/** Waits for every tracked write; resolves to why any failed. */
export async function settleWrites(): Promise<string[]> {
  const problems: string[] = [];
  // A write that lands can start another (a field's commit settling an open draft). A write stays
  // listed until it answers (`trackWrite` removes it), so a page change during this wait still sees it.
  const seen = new Set<Promise<string | null>>();
  for (let batch = [...writes]; batch.length > 0; batch = [...writes].filter((p) => !seen.has(p))) {
    for (const p of batch) seen.add(p);
    for (const problem of await Promise.all(batch)) if (problem !== null) problems.push(problem);
  }
  return problems;
}

export function anyDirtyField(): boolean {
  return [...fields].some((f) => f.dirty());
}

/** Commits every dirty field and waits for every write. Returns what could not be saved; empty means all of it was. */
export async function flushDirtyFields(): Promise<string[]> {
  const problems: string[] = [];
  for (const field of [...fields]) {
    if (!field.dirty()) continue;
    const problem = field.commit();
    if (problem !== null) problems.push(problem);
  }
  problems.push(...(await settleWrites()));
  return problems;
}

/** Saves everything this project holds that is not yet in the model, draft included. */
export async function flushProject(store: Pick<AppStore, "getState">): Promise<string[]> {
  const problems = await flushDirtyFields();
  const { draft } = store.getState();
  if (draft.ops.length === 0) return problems;
  if (draft.stale) return [...problems, "The model changed under your unsaved edit."];
  try {
    await draft.commit();
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return problems;
}

/** Each field forgets its typed text: the person chose not to save it. */
export function discardDirtyFields(): void {
  for (const field of [...fields]) field.discard?.();
}

/**
 * Typed text, an open draft, or a write still on its way, which a page change
 * would lose: a field reads clean from the moment its blur sends the save, and
 * a failure that comes back after the page is gone has nobody to tell.
 */
export function hasUnsavedWork(state: { draft: { ops: readonly unknown[] } }): boolean {
  return state.draft.ops.length > 0 || anyDirtyField() || writesPending();
}

/** Test seam: forgets everything registered. */
export function resetDirtyFields(): void {
  fields.clear();
  writes.clear();
  listeners.clear();
}

/** Where typed text comes and goes without the store hearing of it: typing, Escape, a blur that commits. */
const FIELD_EVENTS = ["input", "change", "focusout", "keyup", "click"] as const;

export interface DirtyWatch {
  isDirty: () => boolean;
  send: (dirty: boolean) => void;
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Other sources of change, each returning its unsubscribe. */
  sources: readonly ((listener: () => void) => () => void)[];
}

/**
 * Pushes whether anything is unsaved, only when that changes (R3.7), and false
 * when the watch ends: nothing is left to lose once a surface is gone. Checks
 * run after a timer because a capture of the event comes before React has
 * rendered the keystroke it carries.
 */
export function watchDirty({ isDirty, send, target, sources }: DirtyWatch): () => void {
  let last = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = (): void => {
    timer = null;
    const now = isDirty();
    if (now === last) return;
    last = now;
    send(now);
  };
  const schedule = (): void => {
    timer ??= setTimeout(check, 0);
  };
  for (const event of FIELD_EVENTS) target.addEventListener(event, schedule, true);
  const off = sources.map((source) => source(schedule));
  schedule();
  return () => {
    for (const event of FIELD_EVENTS) target.removeEventListener(event, schedule, true);
    for (const stop of off) stop();
    if (timer !== null) clearTimeout(timer);
    if (last) send(false);
  };
}
