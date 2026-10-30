/**
 * DPR-1 page capture over CDP (ts-agent G11): `capturePage` returns the
 * Retina backing scale, so B1 shots use Emulation.setDeviceMetricsOverride
 * plus Page.captureScreenshot on a `useContentSize:true` window.
 *
 * Electron allows one debugger client per webContents and this module never
 * detaches, so every CDP command goes through one cached session per
 * webContents (`debuggerSessions`, B5, D15). A webContents something else
 * already attached to is refused instead of shared. From B10 the Lecturn
 * guest's session is the bridge's `debuggerSession` (same `send` shape); the
 * main window keeps its session here.
 */
import type { WebContents } from "electron";

/** The CDP protocol version every session attaches with. */
const CDP_VERSION = "1.3";

/** The slice of Electron's `Debugger` a session needs (Electron-free fakes implement it). */
export interface DebuggerLike {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, commandParams?: object): Promise<unknown>;
  on(event: "detach", listener: () => void): unknown;
  removeListener(event: "detach", listener: () => void): unknown;
}

/** Anything that owns a debugger: an Electron `WebContents` or a fake. */
export interface DebuggerOwner {
  readonly debugger: DebuggerLike;
  isDestroyed(): boolean;
}

/** One CDP session (the shape of `@lecturn/embed`'s `EmbedBridge.debuggerSession`). */
export interface DebuggerSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Thrown when a webContents' single debugger slot belongs to another client, or the contents are gone. */
export class DebuggerUnavailableError extends Error {
  override readonly name = "DebuggerUnavailableError";
}

interface Entry {
  readonly session: DebuggerSession;
  attached: boolean;
  readonly onDetach: () => void;
}

/**
 * Per-webContents CDP session cache. `session(wc)` always returns the same
 * session for the same contents; the first command attaches. If the debugger
 * is already attached by anyone else (another cache, DevTools, a raw
 * `debugger.attach`), commands reject with `DebuggerUnavailableError`.
 */
export class DebuggerSessions {
  readonly #entries = new WeakMap<DebuggerOwner, Entry>();

  session(owner: DebuggerOwner): DebuggerSession {
    const known = this.#entries.get(owner);
    if (known !== undefined) return known.session;
    const entry: Entry = {
      attached: false,
      onDetach: () => {
        entry.attached = false;
      },
      session: {
        send: async (method, params) => {
          this.#ensureAttached(owner, entry);
          return owner.debugger.sendCommand(method, params);
        },
      },
    };
    if (!owner.isDestroyed()) owner.debugger.on("detach", entry.onDetach);
    this.#entries.set(owner, entry);
    return entry.session;
  }

  /** True while this cache holds the contents' debugger. */
  holds(owner: DebuggerOwner): boolean {
    return this.#entries.get(owner)?.attached === true;
  }

  /** Detaches (if this cache holds it) and drops the entry; used when a view is disposed. */
  release(owner: DebuggerOwner): void {
    const entry = this.#entries.get(owner);
    if (entry === undefined) return;
    this.#entries.delete(owner);
    owner.debugger.removeListener("detach", entry.onDetach);
    if (entry.attached && !owner.isDestroyed() && owner.debugger.isAttached()) owner.debugger.detach();
    entry.attached = false;
  }

  #ensureAttached(owner: DebuggerOwner, entry: Entry): void {
    if (owner.isDestroyed()) throw new DebuggerUnavailableError("the webContents is destroyed");
    if (entry.attached && owner.debugger.isAttached()) return;
    if (owner.debugger.isAttached()) {
      throw new DebuggerUnavailableError("another CDP client is attached to this webContents; Electron allows one, use its cached session");
    }
    owner.debugger.attach(CDP_VERSION);
    entry.attached = true;
  }
}

/** The process-wide cache: one session per webContents for the main window and (until B10) the guest. */
export const debuggerSessions = new DebuggerSessions();

/** Forces CSS-pixel = device-pixel at `width`x`height`. Call before loading to render at DPR 1. */
export async function emulateDpr1(wc: WebContents | DebuggerOwner, width: number, height: number, sessions = debuggerSessions): Promise<void> {
  await sessions.session(wc).send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

/** Page.captureScreenshot of the viewport on a session; throws on an empty frame. */
export async function screenshot(session: DebuggerSession): Promise<Buffer> {
  const shot = (await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })) as { data?: unknown } | undefined;
  const data = typeof shot?.data === "string" ? shot.data : "";
  if (data === "") throw new Error("Page.captureScreenshot returned an empty frame");
  return Buffer.from(data, "base64");
}

/** Captures the viewport as a PNG of exactly `width`x`height` pixels. */
export async function capturePageDpr1(wc: WebContents | DebuggerOwner, width: number, height: number, sessions = debuggerSessions): Promise<Buffer> {
  await emulateDpr1(wc, width, height, sessions);
  return screenshot(sessions.session(wc));
}

/**
 * The capture clock (D15): a script that pins `Date` (constructor, `Date()`,
 * `Date.now`) to `fixedMs`. Timers and `performance` keep running, so
 * loaders and reconnect backoff still progress.
 */
export function freezeClockScript(fixedMs: number): string {
  if (!Number.isFinite(fixedMs)) throw new RangeError(`freeze clock: not a finite epoch ms: ${fixedMs}`);
  return `(() => {
  const fixed = ${JSON.stringify(fixedMs)};
  const Real = globalThis.Date;
  if (Real.__rwFrozen === fixed) return;
  function Date(...args) {
    if (!new.target) return new Real(fixed).toString();
    return Reflect.construct(Real, args.length === 0 ? [fixed] : args, new.target);
  }
  Object.setPrototypeOf(Date, Real);
  Date.prototype = Real.prototype;
  Object.defineProperty(Real.prototype, "constructor", { value: Date, writable: true, configurable: true });
  Date.now = () => fixed;
  Date.parse = Real.parse;
  Date.UTC = Real.UTC;
  Object.defineProperty(Date, "__rwFrozen", { value: fixed });
  globalThis.Date = Date;
})();`;
}

/**
 * Installs the Date shim on every new document of a webContents (D15). Call
 * it after the contents' first navigation (CDP before it crashes Electron 44's
 * main process, so load `about:blank` first) and before `loadURL` of the real
 * page. The current document gets it too.
 */
export async function installFreezeClock(session: DebuggerSession, fixedMs: number): Promise<void> {
  const source = freezeClockScript(fixedMs);
  await session.send("Page.enable");
  await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await session.send("Runtime.evaluate", { expression: source });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reads width and height from a PNG's IHDR chunk; throws on a non-PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.byteLength < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (String.fromCharCode(...png.subarray(12, 16)) !== "IHDR") throw new Error("PNG without IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Counts BGRA/RGBA pixels whose colour differs from the top-left pixel by more than `tolerance`. */
export function countForeground(bitmap: Uint8Array, tolerance = 8): number {
  if (bitmap.byteLength < 4) return 0;
  let n = 0;
  for (let i = 0; i + 3 < bitmap.byteLength; i += 4) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs((bitmap[i + k] ?? 0) - (bitmap[k] ?? 0)) > tolerance) {
        n++;
        break;
      }
    }
  }
  return n;
}
