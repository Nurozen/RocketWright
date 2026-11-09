/**
 * Which project the window is showing (seam 2): a pure reducer, so every
 * transition is testable without React, a socket or a preload.
 *
 * The app server owns which projects are open and Electron main owns Recents;
 * this owns only which one is on screen. `ProjectSurface` is keyed on the
 * project id, so entering the `project` phase with a new id remounts it.
 */

export type LifecycleState =
  | { phase: "connecting" }
  /** Connected; the boot state and the project list are in flight. */
  | { phase: "listing" }
  | { phase: "welcome"; notice: string | null }
  | { phase: "project"; projectId: string }
  | { phase: "fatal"; error: string };

export type LifecycleEvent =
  | { type: "connected" }
  | {
      type: "listed";
      /** `?project=`. */
      requested: string | null;
      /** The project main reopened (`DesktopBoot.activeProjectId`). */
      active: string | null;
      /** Open project ids, in the server's order. */
      projects: readonly string[];
      /** Why the last project did not reopen. */
      notice: string | null;
    }
  | { type: "select"; projectId: string }
  | { type: "closed"; projectId: string; next: string | null }
  /** The project could not be shown (a failed `project.subscribe`). */
  | { type: "openFailed"; projectId: string; error: string }
  | { type: "startFailed"; error: string };

export const INITIAL_LIFECYCLE: LifecycleState = { phase: "connecting" };

export function lifecycle(state: LifecycleState, event: LifecycleEvent): LifecycleState {
  // Nothing recovers a fatal state short of a relaunch (D19).
  if (state.phase === "fatal") return state;
  switch (event.type) {
    case "connected":
      return state.phase === "connecting" ? { phase: "listing" } : state;
    case "listed": {
      // A link that arrived while listing has already picked the project.
      if (state.phase !== "listing") return state;
      const projectId = event.requested ?? event.active ?? event.projects[0] ?? null;
      return projectId === null ? { phase: "welcome", notice: event.notice } : { phase: "project", projectId };
    }
    case "select":
      if (state.phase === "connecting") return state;
      return state.phase === "project" && state.projectId === event.projectId ? state : { phase: "project", projectId: event.projectId };
    case "closed":
      if (state.phase !== "project" || state.projectId !== event.projectId) return state;
      return event.next === null ? { phase: "welcome", notice: null } : { phase: "project", projectId: event.next };
    case "openFailed":
      return state.phase === "project" && state.projectId === event.projectId ? { phase: "welcome", notice: event.error } : state;
    case "startFailed":
      return state.phase === "connecting" || state.phase === "listing" ? { phase: "fatal", error: event.error } : state;
  }
}

/** What `window.__rwShell` should report for this state; null while it is still starting. */
export function shellOutcome(state: LifecycleState): { status: "ready" } | { status: "error"; error: string } | null {
  switch (state.phase) {
    case "welcome":
    case "project":
      return { status: "ready" };
    case "fatal":
      return { status: "error", error: state.error };
    default:
      return null;
  }
}

export type LaunchMode = "live" | "fatal" | "static";

/**
 * What a page with no project chosen yet renders. The preload's presence
 * means a real app window, where the static shell's canned "Research vehicle"
 * would pass for the user's project. Only a preload-free page (spikes, bar
 * captures, a bare `vite`) may show it.
 */
export function launchMode(input: { rpc: string | null; desktop: boolean }): LaunchMode {
  if (input.rpc !== null) return "live";
  return input.desktop ? "fatal" : "static";
}
