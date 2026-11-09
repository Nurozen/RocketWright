/**
 * Typed values that have not reached the model yet (D22). `project.disconnect`
 * clears the draft and a native accelerator fires with no blur, so anything
 * that leaves a project asks here first: every field that holds typed text
 * registers, and every write a field starts is tracked, so a flush can wait
 * for the ones already on their way.
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
}

const fields = new Set<DirtyField>();
/** Writes on their way; each resolves to why it failed, or null. */
const writes = new Set<Promise<string | null>>();

export function registerDirtyField(field: DirtyField): () => void {
  fields.add(field);
  return () => void fields.delete(field);
}

/** Registers `field` for this component's life, always reading its latest render. */
export function useDirtyField(field: DirtyField): void {
  const latest = useRef(field);
  latest.current = field;
  useEffect(() => registerDirtyField({ dirty: () => latest.current.dirty(), commit: () => latest.current.commit() }), []);
}

/** Lets a flush wait for `write`. `failure` turns its result into the reason it did not save. */
export function trackWrite<T>(write: Promise<T>, failure?: (result: T) => string | null): Promise<T> {
  const settled: Promise<string | null> = write.then(
    (result) => failure?.(result) ?? null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  writes.add(settled);
  void settled.finally(() => writes.delete(settled));
  return write;
}

async function settleWrites(): Promise<string[]> {
  const problems: string[] = [];
  // A write that lands can start another (a field's commit settling an open draft).
  while (writes.size > 0) {
    const batch = [...writes];
    for (const p of batch) writes.delete(p);
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
export async function flushProject(store: AppStore): Promise<string[]> {
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

/** Test seam: forgets everything registered. */
export function resetDirtyFields(): void {
  fields.clear();
  writes.clear();
}
