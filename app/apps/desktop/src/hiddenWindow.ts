/**
 * Opens the hidden window (`--render-out`, `--probe-out`) with its agent pane
 * listening before the app page loads. The page asks main to mount the pane
 * from an effect, which can run before `loadURL` resolves. Electron drops an
 * IPC message that has no listener and the page never repeats it, so a pane
 * started after the load can wait forever for a mount that was already sent.
 */

export interface HiddenWindowLike {
  loadURL(url: string): Promise<unknown>;
  destroy(): void;
}

export interface HiddenPaneLike {
  destroy(): void;
}

export interface OpenHiddenWindowOptions<W extends HiddenWindowLike, P extends HiddenPaneLike> {
  /** The app page. */
  url: string;
  /** Epoch ms after which a failed attempt is not retried. */
  deadline: number;
  /** Resolves once the app origin answers. */
  waitForServer: () => Promise<void>;
  createWindow: () => W;
  /** Everything that must happen before the app page loads (DPR 1 emulation, the frozen clock). */
  prepare: (win: W) => Promise<void>;
  /** Null without a pane. */
  startPane: (win: W) => P | null;
  log: (line: string) => void;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts at opening the hidden window before giving up. */
const OPEN_ATTEMPTS = 4;

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Creates the window and loads the app, retrying with a fresh window and pane
 * when a load fails. Under load, Electron 44 intermittently rejects the very
 * first navigation (`ERR_FAILED (-2) loading 'about:blank'`) before the
 * renderer is up; a new window then loads fine. The app origin is polled until
 * it answers before each attempt.
 */
export async function openHiddenWindow<W extends HiddenWindowLike, P extends HiddenPaneLike>(opts: OpenHiddenWindowOptions<W, P>): Promise<{ win: W; pane: P | null }> {
  const sleep = opts.sleep ?? pause;
  let lastError: unknown;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    await opts.waitForServer();
    const win = opts.createWindow();
    let pane: P | null = null;
    try {
      await opts.prepare(win);
      pane = opts.startPane(win);
      await win.loadURL(opts.url);
      return { win, pane };
    } catch (e) {
      lastError = e;
      opts.log(`hidden window load failed (attempt ${attempt}/${OPEN_ATTEMPTS}): ${e instanceof Error ? e.message : String(e)}`);
      pane?.destroy();
      win.destroy();
      if (Date.now() > opts.deadline) break;
      await sleep(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
