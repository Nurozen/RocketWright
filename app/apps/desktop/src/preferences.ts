/**
 * Preferences (R3.4), Electron-free: `preferences.json` in userData, read and
 * written by main alone.
 *
 * - Window, view and last-tab changes arrive in bursts, so they debounce. The
 *   default units write at once (D5: only window and view preferences wait);
 *   a crash can lose the last moments of a drag, never a setting someone chose.
 * - `flush` runs inside `shutdown`, because the exit hook cannot await a write.
 * - An unreadable or partly corrupt file reads as defaults, field by field. A
 *   failed background write is only logged: losing a window position must
 *   never get in the way of the app.
 *
 * The page sends patches and cannot set the window bounds; only main records those.
 */
import type { DesktopPrefs, DisplayUnits, WindowBounds } from "@rw/contracts";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEBOUNCE_MS = 400;
/** Enough of a window on a display to find its title bar and drag it back. */
const MIN_VISIBLE_WIDTH = 120;
const TITLE_BAR_HEIGHT = 32;

export const defaultPrefs = (): DesktopPrefs => ({ window: null, view: {}, lastTab: null, defaultDisplayUnits: null });

export interface PreferencesOptions {
  /** `<userData>/preferences.json`. */
  file: string;
  /** Hidden runs record nothing, so captures stay reproducible. */
  readOnly?: boolean;
  debounceMs?: number;
  log?: (line: string) => void;
}

export interface Preferences {
  get(): DesktopPrefs;
  /** Resolves when the change is on disk if it had to be written at once; rejects if that write failed. */
  update(patch: Partial<DesktopPrefs>): Promise<void>;
  /** Writes anything still waiting on the debounce. Never rejects. */
  flush(): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanBounds(v: unknown): WindowBounds | null {
  if (!isRecord(v)) return null;
  const { x, y, width, height } = v;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function cleanView(v: unknown): DesktopPrefs["view"] {
  if (!isRecord(v)) return {};
  const out: DesktopPrefs["view"] = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

const UNIT_KEY = /^[a-z_]+$/;
/** `,` and `=` are `rw init --display-units`'s own separators. */
const UNIT_SYMBOL = /^[^,=\p{Cc}]+$/u;

/** Entries `rw init --display-units` could carry; null when none are left. */
export function cleanDisplayUnits(v: unknown): DisplayUnits | null {
  if (!isRecord(v)) return null;
  const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && UNIT_KEY.test(e[0]) && UNIT_SYMBOL.test(e[1]));
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function parsePrefs(text: string): DesktopPrefs {
  try {
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) return defaultPrefs();
    return {
      window: cleanBounds(v.window),
      view: cleanView(v.view),
      lastTab: typeof v.lastTab === "string" && v.lastTab !== "" ? v.lastTab : null,
      defaultDisplayUnits: cleanDisplayUnits(v.defaultDisplayUnits),
    };
  } catch {
    return defaultPrefs();
  }
}

/** A patch from the page, keeping only what it may set. */
export function prefsPatch(raw: unknown): Partial<DesktopPrefs> {
  if (!isRecord(raw)) throw new TypeError("setPrefs: expected an object");
  const out: Partial<DesktopPrefs> = {};
  if (raw.view !== undefined) out.view = cleanView(raw.view);
  if (raw.lastTab !== undefined) out.lastTab = typeof raw.lastTab === "string" && raw.lastTab !== "" ? raw.lastTab : null;
  if (raw.defaultDisplayUnits !== undefined) out.defaultDisplayUnits = cleanDisplayUnits(raw.defaultDisplayUnits);
  return out;
}

const sameUnits = (a: DisplayUnits | null, b: DisplayUnits | null): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createPreferences(options: PreferencesOptions): Preferences {
  const { file, readOnly = false, debounceMs = DEBOUNCE_MS, log = () => undefined } = options;
  let current = read(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  // One write at a time, each writing the latest state; the last one always holds it.
  let queue: Promise<unknown> = Promise.resolve();

  const write = (): Promise<void> => {
    dirty = false;
    const text = `${JSON.stringify(current, null, 2)}\n`;
    const run = queue.then(async () => {
      const temp = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temp, text);
        await rename(temp, file);
      } catch (e) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw e;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const background = (): Promise<void> => write().catch((e: unknown) => log(`preferences: cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`));

  return {
    get: () => current,
    update: (patch) => {
      if (readOnly) return Promise.resolve();
      const unitsChanged = patch.defaultDisplayUnits !== undefined && !sameUnits(patch.defaultDisplayUnits, current.defaultDisplayUnits);
      current = { ...current, ...patch };
      dirty = true;
      if (unitsChanged) {
        cancelTimer();
        return write();
      }
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void background();
        }, debounceMs);
        timer.unref?.();
      }
      return Promise.resolve();
    },
    flush: () => {
      cancelTimer();
      if (!dirty) return queue.then(() => undefined);
      return background();
    },
  };
}

function read(file: string): DesktopPrefs {
  try {
    return parsePrefs(readFileSync(file, "utf8"));
  } catch {
    return defaultPrefs();
  }
}

/**
 * The saved bounds if a window opened there would be reachable, else null (the
 * default size, placed by the OS). A monitor that has gone leaves the window
 * off every display, and macOS would not bring it back. A saved width below
 * `minWidth` comes up to it: the header clips narrower than that.
 */
export function restorableBounds(saved: WindowBounds | null, displays: readonly { workArea: WindowBounds }[], minWidth: number): WindowBounds | null {
  if (saved === null) return null;
  for (const { workArea: area } of displays) {
    const width = Math.max(minWidth, Math.min(saved.width, area.width));
    const height = Math.min(saved.height, area.height);
    const overlap = Math.min(saved.x + width, area.x + area.width) - Math.max(saved.x, area.x);
    const titleBarOn = saved.y + TITLE_BAR_HEIGHT > area.y && saved.y < area.y + area.height;
    if (overlap >= MIN_VISIBLE_WIDTH && titleBarOn) return { x: saved.x, y: saved.y, width, height };
  }
  return null;
}
