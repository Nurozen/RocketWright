import { describe, expect, it } from "vitest";
import { openHiddenWindow, type HiddenPaneLike, type HiddenWindowLike } from "./hiddenWindow.ts";

const APP_URL = "http://127.0.0.1:1/index.html";

interface FakePane extends HiddenPaneLike {
  received: string[];
  destroyed: boolean;
}

class FakeWindow implements HiddenWindowLike {
  destroyed = false;
  /** What IPC would reach: a message with no listener is gone, as in Electron. */
  listener: FakePane | null = null;
  constructor(private readonly fail: boolean) {}
  async loadURL(url: string): Promise<void> {
    if (this.fail) throw new Error(`ERR_FAILED (-2) loading '${url}'`);
    // The page's effect asks for its mount while the load is still in progress.
    this.listener?.received.push("mount");
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Opens windows that fail for each `true` in `failures`, recording every window and pane. */
function harness(failures: boolean[], withPane = true) {
  const windows: FakeWindow[] = [];
  const panes: FakePane[] = [];
  const logs: string[] = [];
  const open = () =>
    openHiddenWindow<FakeWindow, FakePane>({
      url: APP_URL,
      deadline: Date.now() + 60_000,
      waitForServer: async () => {},
      createWindow: () => {
        const win = new FakeWindow(failures[windows.length] ?? false);
        windows.push(win);
        return win;
      },
      prepare: async () => {},
      startPane: (win) => {
        if (!withPane) return null;
        const pane: FakePane = {
          received: [],
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        };
        win.listener = pane;
        panes.push(pane);
        return pane;
      },
      log: (line) => logs.push(line),
      sleep: async () => {},
    });
  return { open, windows, panes, logs };
}

describe("opening the hidden window (hiddenWindow.ts)", () => {
  it("has the pane listening before the page loads, so a mount sent during the load arrives", async () => {
    const { open } = harness([]);
    const { pane } = await open();
    expect(pane?.received).toEqual(["mount"]);
  });

  it("starts the pane after the window is prepared, because preparing it loads about:blank", async () => {
    const order: string[] = [];
    await openHiddenWindow({
      url: APP_URL,
      deadline: Date.now() + 60_000,
      waitForServer: async () => {},
      createWindow: () => ({ loadURL: async () => order.push("load"), destroy: () => {} }),
      prepare: async () => {
        order.push("prepare");
      },
      startPane: () => {
        order.push("pane");
        return null;
      },
      log: () => {},
    });
    expect(order).toEqual(["prepare", "pane", "load"]);
  });

  it("replaces both the window and the pane when a load fails, then returns the working pair", async () => {
    const { open, windows, panes, logs } = harness([true]);
    const { win, pane } = await open();
    expect(windows).toHaveLength(2);
    expect(win).toBe(windows[1]);
    expect(pane).toBe(panes[1]);
    expect(windows[0]?.destroyed).toBe(true);
    expect(panes[0]?.destroyed).toBe(true);
    expect(panes[1]?.destroyed).toBe(false);
    expect(logs).toEqual([`hidden window load failed (attempt 1/4): ERR_FAILED (-2) loading '${APP_URL}'`]);
  });

  it("gives up with the last error after four attempts, leaving no pane running", async () => {
    const { open, windows, panes } = harness([true, true, true, true]);
    await expect(open()).rejects.toThrow("ERR_FAILED");
    expect(windows).toHaveLength(4);
    expect(panes.every((p) => p.destroyed)).toBe(true);
  });

  it("opens with no pane when there is no server to drive one", async () => {
    const { open } = harness([], false);
    expect((await open()).pane).toBeNull();
  });
});
