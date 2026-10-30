/** B10: the embedded pane's window channel (`embedPane.ts`): message validation, theme input, thread mapping. */
import { describe, expect, it } from "vitest";
import { DESCRIBE_REFS_MAX, EMBED_PANE_RECT_CHANNEL, embedThemeInput, mappedThread, PANE_SEND_CHANNELS, parsePaneHostMessage, parsePaneMainMessage } from "./embedPane.ts";

const R = { x: 1, y: 2, width: 3, height: 4 };

describe("embed pane channel", () => {
  it("keeps every channel under the helper's lecturn-embed: prefix", () => {
    for (const ch of PANE_SEND_CHANNELS) expect(ch.startsWith("lecturn-embed:")).toBe(true);
    expect(EMBED_PANE_RECT_CHANNEL).toBe("lecturn-embed:pane-rect");
  });

  it("accepts well-formed page messages only", () => {
    expect(parsePaneHostMessage({ type: "mount", projectId: "p" })).toEqual({ type: "mount", projectId: "p" });
    expect(parsePaneHostMessage({ type: "overlay.open", token: "t", rect: { ...R, extra: 1 } })).toEqual({ type: "overlay.open", token: "t", rect: R });
    for (const bad of [null, "x", { type: "mount", projectId: 3 }, { type: "overlay.open", token: "", rect: R }, { type: "overlay.open", token: "t", rect: { ...R, x: Number.NaN } }, { type: "overlay.close" }, { type: "other" }]) {
      expect(parsePaneHostMessage(bad)).toBeNull();
    }
  });

  it("accepts well-formed main messages only (snapshots must be data:image URLs)", () => {
    expect(parsePaneMainMessage({ type: "event", event: "lecturn/ready", payload: { threadId: null } })).toEqual({ type: "event", event: "lecturn/ready", payload: { threadId: null } });
    expect(parsePaneMainMessage({ type: "open-project", projectId: "p", threadId: "t" })).toEqual({ type: "open-project", projectId: "p", threadId: "t" });
    expect(parsePaneMainMessage({ type: "snapshot", token: "t", dataUrl: "http://x/y.png", rect: R })).toBeNull();
    expect(parsePaneMainMessage({ type: "event", event: "lecturn/evil", payload: {} })).toBeNull();
    expect(parsePaneMainMessage({ type: "state", projectId: "p", state: "weird" })).toBeNull();
  });

  it("accepts the composer placeholder (1-200 chars, or null) and the page's ref labels", () => {
    expect(parsePaneHostMessage({ type: "composer.placeholder", text: "Ask about this design…" })).toEqual({ type: "composer.placeholder", text: "Ask about this design…" });
    expect(parsePaneHostMessage({ type: "composer.placeholder", text: null })).toEqual({ type: "composer.placeholder", text: null });
    for (const text of ["", "x".repeat(201), 3, undefined]) expect(parsePaneHostMessage({ type: "composer.placeholder", text })).toBeNull();
    expect(parsePaneHostMessage({ type: "refs.labels", id: "1", labels: { "rw:c/fins": " Fins ", "rw:c/x": "", "rw:c/y": 3, "rw:c/z": "z".repeat(300) } })).toEqual({
      type: "refs.labels",
      id: "1",
      labels: { "rw:c/fins": "Fins", "rw:c/z": "z".repeat(256) },
    });
    for (const bad of [{ type: "refs.labels", id: "", labels: {} }, { type: "refs.labels", id: "1" }, { type: "refs.labels", id: "1", labels: "x" }]) expect(parsePaneHostMessage(bad)).toBeNull();
  });

  it("accepts main's ref-label asks of 1 to 64 string refs", () => {
    expect(parsePaneMainMessage({ type: "refs.describe", id: "7", refs: ["rw:c/fins", "rw:cfg/baseline"] })).toEqual({ type: "refs.describe", id: "7", refs: ["rw:c/fins", "rw:cfg/baseline"] });
    const many = Array.from({ length: DESCRIBE_REFS_MAX + 1 }, (_, i) => `rw:c/p${i}`);
    for (const bad of [{ type: "refs.describe", id: "7", refs: [] }, { type: "refs.describe", id: "7", refs: many }, { type: "refs.describe", id: "7", refs: ["rw:c/a", 3] }, { type: "refs.describe", id: "", refs: ["rw:c/a"] }]) {
      expect(parsePaneMainMessage(bad)).toBeNull();
    }
  });

  it("builds the embed theme from B11's file and maps threads across a live switch", () => {
    expect(embedThemeInput({ variables: { "--background": "#1b1e20" }, fontsCss: "f" })).toEqual({ theme: "dark", styles: { variables: { "--background": "#1b1e20" }, css: { fonts: "f" } } });
    // The host-only file's variables go on top (Lecturn pin4's `--destructive`).
    expect(embedThemeInput({ variables: { "--background": "#1b1e20" }, fontsCss: "f" }, { variables: { "--destructive": "#e5735c" } }).styles.variables).toEqual({ "--background": "#1b1e20", "--destructive": "#e5735c" });
    expect(mappedThread("a", { a: "b" })).toBe("b");
    expect(mappedThread("a", {})).toBeUndefined();
    expect(mappedThread(null, { a: "b" })).toBeUndefined();
  });
});
