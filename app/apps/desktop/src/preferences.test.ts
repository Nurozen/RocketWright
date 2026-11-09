import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDisplayUnits, createPreferences, defaultPrefs, prefsPatch, restorableBounds } from "./preferences.ts";

const DISPLAY = { workArea: { x: 0, y: 25, width: 1920, height: 1055 } };

describe("restorableBounds (R3.4)", () => {
  const saved = { x: 100, y: 100, width: 1400, height: 900 };

  it("keeps bounds on a display", () => {
    expect(restorableBounds(saved, [DISPLAY], 1024)).toEqual(saved);
  });

  it("is null when nothing was saved", () => {
    expect(restorableBounds(null, [DISPLAY], 1024)).toBeNull();
  });

  it("is null when the monitor that held the window has gone", () => {
    expect(restorableBounds({ ...saved, x: 4000 }, [DISPLAY], 1024)).toBeNull();
    expect(restorableBounds({ ...saved, y: 3000 }, [DISPLAY], 1024)).toBeNull();
  });

  it("is null when the title bar would be above every display", () => {
    expect(restorableBounds({ ...saved, y: -800 }, [DISPLAY], 1024)).toBeNull();
  });

  it("brings a saved width up to the window's minimum", () => {
    expect(restorableBounds({ ...saved, width: 600 }, [DISPLAY], 1024)?.width).toBe(1024);
  });

  it("shrinks a window saved on a bigger monitor, but never below the minimum", () => {
    expect(restorableBounds({ x: 0, y: 25, width: 3000, height: 2000 }, [DISPLAY], 1024)).toEqual({ x: 0, y: 25, width: 1920, height: 1055 });
    const small = { workArea: { x: 0, y: 0, width: 900, height: 700 } };
    expect(restorableBounds({ x: 0, y: 0, width: 2000, height: 600 }, [small], 1024)?.width).toBe(1024);
  });

  it("finds the display the window is on", () => {
    const right = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
    expect(restorableBounds({ ...saved, x: 2000 }, [DISPLAY, right], 1024)).toEqual({ ...saved, x: 2000 });
  });
});

describe("cleanDisplayUnits", () => {
  it("keeps what rw init can carry", () => {
    expect(cleanDisplayUnits({ length: "in", mass: "kg" })).toEqual({ length: "in", mass: "kg" });
  });

  it("drops entries that would become other flag entries or are not strings", () => {
    expect(cleanDisplayUnits({ length: "in,mass=kg" })).toBeNull();
    expect(cleanDisplayUnits({ "le=ngth": "in" })).toBeNull();
    expect(cleanDisplayUnits({ length: 3, mass: "kg" })).toEqual({ mass: "kg" });
  });

  it("is null for anything else", () => {
    expect(cleanDisplayUnits(null)).toBeNull();
    expect(cleanDisplayUnits("in")).toBeNull();
    expect(cleanDisplayUnits({})).toBeNull();
  });
});

describe("prefsPatch", () => {
  it("drops the window bounds: only main records those", () => {
    expect(prefsPatch({ window: { x: 0, y: 0, width: 1, height: 1 }, lastTab: "results" })).toEqual({ lastTab: "results" });
  });

  it("refuses anything but an object", () => {
    expect(() => prefsPatch("nope")).toThrow(TypeError);
  });

  it("keeps a null default so the preference can be cleared", () => {
    expect(prefsPatch({ defaultDisplayUnits: null })).toEqual({ defaultDisplayUnits: null });
  });

  it("keeps only plain view values", () => {
    expect(prefsPatch({ view: { explode: 0.5, section: true, view: "iso", bad: { a: 1 }, nan: Number.NaN } })).toEqual({ view: { explode: 0.5, section: true, view: "iso" } });
  });
});

describe("createPreferences", () => {
  let dir: string;
  let file: string;
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rw-prefs-"));
    file = join(dir, "sub", "preferences.json");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts from defaults with no file", () => {
    expect(createPreferences({ file }).get()).toEqual(defaultPrefs());
  });

  it("reads a corrupt file as defaults", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(createPreferences({ file: join(dir, "bad.json") }).get()).toEqual(defaultPrefs());
  });

  it("keeps the good fields of a partly corrupt file", () => {
    const good = join(dir, "partial.json");
    writeFileSync(good, JSON.stringify({ window: { x: "no" }, view: { section: true }, lastTab: 7, defaultDisplayUnits: { length: "in" } }));
    expect(createPreferences({ file: good }).get()).toEqual({ window: null, view: { section: true }, lastTab: null, defaultDisplayUnits: { length: "in" } });
  });

  it("waits to write window and view changes, then writes the latest", async () => {
    const prefs = createPreferences({ file, debounceMs: 100 });
    await prefs.update({ window: { x: 1, y: 2, width: 1100, height: 800 } });
    await prefs.update({ view: { section: true } });
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await prefs.flush();
    expect(onDisk()).toMatchObject({ window: { x: 1, y: 2, width: 1100, height: 800 }, view: { section: true } });
  });

  it("flush writes what is waiting, and the shutdown path can rely on it", async () => {
    const prefs = createPreferences({ file, debounceMs: 60_000 });
    await prefs.update({ lastTab: "results" });
    await prefs.flush();
    expect(onDisk()).toMatchObject({ lastTab: "results" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes a changed default unit at once (D5)", async () => {
    const prefs = createPreferences({ file, debounceMs: 60_000 });
    await prefs.update({ defaultDisplayUnits: { length: "in" } });
    expect(onDisk()).toMatchObject({ defaultDisplayUnits: { length: "in" } });
  });

  it("does not rewrite when the default unit is unchanged", async () => {
    const prefs = createPreferences({ file, debounceMs: 60_000 });
    await prefs.update({ defaultDisplayUnits: { length: "in" } });
    await prefs.update({ defaultDisplayUnits: { length: "in" } });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("rejects when a write the person is waiting on fails", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const prefs = createPreferences({ file: join(blocked, "preferences.json") });
    await expect(prefs.update({ defaultDisplayUnits: { length: "in" } })).rejects.toThrow();
  });

  it("only logs when a background write fails", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const log = vi.fn<(line: string) => void>();
    const prefs = createPreferences({ file: join(blocked, "preferences.json"), debounceMs: 10, log });
    await prefs.update({ lastTab: "results" });
    await expect(prefs.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });

  it("records nothing on a hidden run", async () => {
    const prefs = createPreferences({ file, readOnly: true });
    await prefs.update({ lastTab: "results", defaultDisplayUnits: { length: "in" } });
    await prefs.flush();
    expect(existsSync(file)).toBe(false);
    expect(prefs.get()).toEqual(defaultPrefs());
  });

  it("round-trips through a new launch", async () => {
    const first = createPreferences({ file });
    await first.update({ lastTab: "configurations", view: { section: true }, window: { x: 5, y: 6, width: 1200, height: 700 } });
    await first.flush();
    expect(createPreferences({ file }).get()).toEqual({ window: { x: 5, y: 6, width: 1200, height: 700 }, view: { section: true }, lastTab: "configurations", defaultDisplayUnits: null });
  });
});
