/**
 * The agent pane's drop listener (R3.1), run for real against a fake
 * `electron` and `window`: it takes only trusted drops the page imports,
 * leaves everything else to Lecturn, and exposes nothing to the guest's page.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PANE_DROP_NAME, PANE_GUEST_DROP_CHANNEL } from "@rw/contracts";
import { buildPreload, PANE_DROP_PRELOAD_SRC } from "./backend.ts";

type Listener = (e: FakeDrag) => void;

interface FakeFile {
  name: string;
  path?: string;
}

class FakeDrag {
  defaultPrevented = false;
  stopped = false;
  readonly dataTransfer: { types: string[]; files: FakeFile[]; items: { webkitGetAsEntry(): { isDirectory: boolean } }[]; dropEffect: string };
  readonly isTrusted: boolean;
  readonly target = {
    dispatched: [] as { type: string; dataTransfer: unknown; bubbles: unknown }[],
    dispatchEvent(e: { type: string; dataTransfer: unknown; bubbles: unknown }) {
      this.dispatched.push(e);
      return true;
    },
  };
  constructor(files: FakeFile[], opts: { trusted?: boolean; types?: string[]; folder?: boolean } = {}) {
    this.isTrusted = opts.trusted ?? true;
    this.dataTransfer = { types: opts.types ?? ["Files"], files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: opts.folder === true }) })), dropEffect: "none" };
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

function load() {
  const listeners = new Map<string, Listener>();
  const options: unknown[] = [];
  const sent: [string, unknown][] = [];
  const required: string[] = [];
  const electron = new Proxy(
    {
      ipcRenderer: { send: (channel: string, message: unknown) => void sent.push([channel, message]) },
      webUtils: { getPathForFile: (f: FakeFile) => f.path ?? "" },
    },
    {
      get(target, key: string) {
        required.push(key);
        return (target as Record<string, unknown>)[key];
      },
    },
  );
  class DragEventCtor {
    readonly type: string;
    readonly dataTransfer: unknown;
    readonly bubbles: unknown;
    constructor(type: string, init: { dataTransfer: unknown; bubbles: unknown }) {
      this.type = type;
      this.dataTransfer = init.dataTransfer;
      this.bubbles = init.bubbles;
    }
  }
  runInNewContext(buildPreload(PANE_DROP_PRELOAD_SRC), {
    require: (m: string) => {
      if (m !== "electron") throw new Error(`preload required ${m}`);
      return electron;
    },
    window: {
      addEventListener: (type: string, l: Listener, capture: unknown) => {
        listeners.set(type, l);
        options.push(capture);
      },
    },
    DragEvent: DragEventCtor,
    Array,
  });
  return { listeners, options, sent, required, fire: (type: string, e: FakeDrag) => listeners.get(type)!(e) };
}

const f = (name: string, path = `/out/${name}`): FakeFile => ({ name, path });

describe("paneDropPreload", () => {
  it("listens first, in the capture phase, and takes only what it needs from electron", () => {
    const t = load();
    expect([...t.listeners.keys()]).toEqual(["dragenter", "dragover", "drop"]);
    expect(t.options).toEqual([true, true, true]);
    expect(new Set(t.required)).toEqual(new Set(["ipcRenderer", "webUtils"]));
  });

  it("accepts a file drag so its drop fires anywhere over the guest", () => {
    const t = load();
    const e = new FakeDrag([]);
    t.fire("dragover", e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.dataTransfer.dropEffect).toBe("copy");
  });

  it("leaves a text drag and a scripted event alone", () => {
    const t = load();
    const text = new FakeDrag([], { types: ["text/plain"] });
    t.fire("dragover", text);
    expect(text.defaultPrevented).toBe(false);
    const forged = new FakeDrag([f("motor.eng")], { trusted: false });
    t.fire("dragover", forged);
    t.fire("drop", forged);
    expect(forged.defaultPrevented).toBe(false);
    expect(forged.stopped).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it.each(["motor.eng", "MOTOR.RSE", "rocket.ork"])("takes %s from Lecturn and sends its path to main", (name) => {
    const t = load();
    const e = new FakeDrag([f(name)]);
    t.fire("drop", e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.stopped).toBe(true);
    expect(t.sent).toEqual([[PANE_GUEST_DROP_CHANNEL, { paths: [`/out/${name}`] }]]);
  });

  it("sends several importable files together, for main to refuse as one drop", () => {
    const t = load();
    t.fire("drop", new FakeDrag([f("a.eng"), f("b.rse")]));
    expect(t.sent).toEqual([[PANE_GUEST_DROP_CHANNEL, { paths: ["/out/a.eng", "/out/b.rse"] }]]);
  });

  it("clears Lecturn's drop highlight, whose own drop handler no longer runs", () => {
    const t = load();
    const e = new FakeDrag([f("motor.eng")]);
    t.fire("drop", e);
    expect(e.target.dispatched).toEqual([expect.objectContaining({ type: "dragleave", dataTransfer: e.dataTransfer, bubbles: true })]);
  });

  it.each([
    ["another kind of file", [f("notes.txt")], {}],
    ["a mix, whose other files are Lecturn's", [f("motor.eng"), f("notes.txt")], {}],
    ["a file with no path on disk", [{ name: "motor.eng" }], {}],
    ["a folder named like an import", [f("rocket.ork")], { folder: true }],
    ["an empty drop", [], {}],
  ] as [string, FakeFile[], { folder?: boolean }][])("leaves %s to Lecturn", (_what, files, opts) => {
    const t = load();
    const e = new FakeDrag(files, opts);
    t.fire("drop", e);
    expect(e.defaultPrevented).toBe(false);
    expect(e.stopped).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it("agrees with the contract on what is importable", () => {
    const src = buildPreload(PANE_DROP_PRELOAD_SRC);
    expect(src).toContain(`"${PANE_GUEST_DROP_CHANNEL}"`);
    expect(src).toContain(String(PANE_DROP_NAME));
  });
});
