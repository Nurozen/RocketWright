import { describe, expect, it } from "vitest";
import { INITIAL_LIFECYCLE, launchMode, lifecycle, shellOutcome, type LifecycleEvent, type LifecycleState } from "./lifecycle.ts";

const run = (events: LifecycleEvent[], from: LifecycleState = INITIAL_LIFECYCLE) => events.reduce(lifecycle, from);
const listed = (over: Partial<Extract<LifecycleEvent, { type: "listed" }>> = {}): LifecycleEvent => ({ type: "listed", requested: null, active: null, projects: [], notice: null, ...over });
const LISTING: LifecycleState = { phase: "listing" };
const WELCOME: LifecycleState = { phase: "welcome", notice: null };
const showing = (projectId: string): LifecycleState => ({ phase: "project", projectId });

describe("lifecycle", () => {
  it("starts connecting and lists once connected", () => {
    expect(INITIAL_LIFECYCLE).toEqual({ phase: "connecting" });
    expect(run([{ type: "connected" }])).toEqual(LISTING);
  });

  it("picks ?project=, then the reopened project, then the first open one", () => {
    expect(run([listed({ requested: "r", active: "a", projects: ["p"] })], LISTING)).toEqual(showing("r"));
    expect(run([listed({ active: "a", projects: ["p"] })], LISTING)).toEqual(showing("a"));
    expect(run([listed({ projects: ["p", "q"] })], LISTING)).toEqual(showing("p"));
  });

  it("shows Welcome with no project, carrying why the last one did not reopen", () => {
    expect(run([listed()], LISTING)).toEqual(WELCOME);
    expect(run([listed({ notice: "gone" })], LISTING)).toEqual({ phase: "welcome", notice: "gone" });
  });

  it("lets a link that arrived while listing win over the listed default", () => {
    expect(run([{ type: "select", projectId: "link" }, listed({ projects: ["p"] })], LISTING)).toEqual(showing("link"));
  });

  it("switches projects, and keeps the same state for the project already showing", () => {
    const here = showing("a");
    expect(lifecycle(here, { type: "select", projectId: "b" })).toEqual(showing("b"));
    expect(lifecycle(here, { type: "select", projectId: "a" })).toBe(here);
    expect(lifecycle(WELCOME, { type: "select", projectId: "a" })).toEqual(showing("a"));
    expect(lifecycle(INITIAL_LIFECYCLE, { type: "select", projectId: "a" })).toEqual(INITIAL_LIFECYCLE);
  });

  it("closing the shown project goes to the next open one or Welcome; another project's close changes nothing", () => {
    expect(lifecycle(showing("a"), { type: "closed", projectId: "a", next: "b" })).toEqual(showing("b"));
    expect(lifecycle(showing("a"), { type: "closed", projectId: "a", next: null })).toEqual(WELCOME);
    expect(lifecycle(showing("a"), { type: "closed", projectId: "z", next: null })).toEqual(showing("a"));
    expect(lifecycle(WELCOME, { type: "closed", projectId: "z", next: "a" })).toEqual(WELCOME);
  });

  it("falls back to Welcome with the reason when the shown project will not open", () => {
    expect(lifecycle(showing("a"), { type: "openFailed", projectId: "a", error: "no such project" })).toEqual({ phase: "welcome", notice: "no such project" });
  });

  it("ignores a failure from a project the window already left", () => {
    expect(lifecycle(showing("b"), { type: "openFailed", projectId: "a", error: "late" })).toEqual(showing("b"));
  });

  it("is fatal when startup fails, and only then", () => {
    expect(lifecycle(INITIAL_LIFECYCLE, { type: "startFailed", error: "no server" })).toEqual({ phase: "fatal", error: "no server" });
    expect(lifecycle(LISTING, { type: "startFailed", error: "boot" })).toEqual({ phase: "fatal", error: "boot" });
    expect(lifecycle(showing("a"), { type: "startFailed", error: "late" })).toEqual(showing("a"));
    expect(lifecycle(WELCOME, { type: "startFailed", error: "late" })).toEqual(WELCOME);
  });

  it("nothing leaves fatal", () => {
    const fatal: LifecycleState = { phase: "fatal", error: "x" };
    for (const e of [{ type: "connected" }, listed({ projects: ["p"] }), { type: "select", projectId: "a" }] as LifecycleEvent[]) expect(lifecycle(fatal, e)).toBe(fatal);
  });
});

describe("shellOutcome", () => {
  it("is ready on Welcome and on a project, an error when fatal, nothing while starting", () => {
    expect(shellOutcome(WELCOME)).toEqual({ status: "ready" });
    expect(shellOutcome(showing("a"))).toEqual({ status: "ready" });
    expect(shellOutcome({ phase: "fatal", error: "x" })).toEqual({ status: "error", error: "x" });
    expect(shellOutcome(INITIAL_LIFECYCLE)).toBeNull();
    expect(shellOutcome(LISTING)).toBeNull();
  });
});

describe("launchMode", () => {
  it("never gives an app window the static shell's fake project", () => {
    expect(launchMode({ rpc: "ws://x", desktop: true })).toBe("live");
    expect(launchMode({ rpc: "ws://x", desktop: false })).toBe("live");
    expect(launchMode({ rpc: null, desktop: true })).toBe("fatal");
    expect(launchMode({ rpc: null, desktop: false })).toBe("static");
  });
});
