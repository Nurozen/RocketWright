/**
 * The sandboxed preload cannot import `@rw/contracts` (no imports or exports,
 * see `preload.ts`), so its channel names are copies. This runs the stripped
 * preload and holds what it really sends to the contract.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_COMMAND_CHANNEL,
  DESKTOP_DIRTY_CHECK_CHANNEL, DESKTOP_FLUSH_CHANNEL,
  DESKTOP_INVOKE_CHANNELS,
  EMBED_HOST_BRIDGE_CHANNEL,
  EMBED_PANE_RECT_CHANNEL,
  PANE_HOST_CHANNEL,
  PANE_MAIN_CHANNEL,
} from "@rw/contracts";
import { buildPreload } from "./backend.ts";

type Listener = (event: unknown, message: unknown) => void;

function load() {
  const invoked: { channel: string; payload: unknown }[] = [];
  const sent: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const paths: unknown[] = [];
  const exposed: Record<string, Record<string, unknown>> = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, value: Record<string, unknown>) => (exposed[key] = value) },
    ipcRenderer: {
      invoke: (channel: string, payload: unknown) => {
        invoked.push({ channel, payload });
        return Promise.resolve(null);
      },
      send: (channel: string) => void sent.push(channel),
      on: (channel: string, listener: Listener) => void listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
      removeListener: (channel: string, listener: Listener) => void listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener)),
    },
    webUtils: {
      getPathForFile: (file: unknown) => {
        paths.push(file);
        return "/dropped/rocket.ork";
      },
    },
  };
  runInNewContext(buildPreload(), {
    require: (m: string) => {
      if (m !== "electron") throw new Error(`preload required ${m}`);
      return electron;
    },
    process: { argv: [], platform: "darwin", versions: { electron: "44.8.0", chrome: "146" } },
  });
  return { invoked, sent, listeners, paths, desktop: exposed.rwDesktop!, embedIpc: exposed.lecturnEmbedIpc! };
}

describe("preload channels match @rw/contracts", () => {
  it("each desktop method invokes its contract channel and forwards its argument", async () => {
    for (const [method, channel] of Object.entries(DESKTOP_INVOKE_CHANNELS)) {
      const { desktop, invoked } = load();
      await (desktop[method] as (arg: unknown) => Promise<unknown>)("arg");
      expect(invoked.map((i) => i.channel), method).toEqual([channel]);
      if (invoked[0]!.payload !== undefined) expect(invoked[0]!.payload).toBe("arg");
    }
  });

  it("exposes no desktop method that is not in the contract", () => {
    const { desktop } = load();
    const services = Object.keys(desktop).filter((k) => typeof desktop[k] === "function");
    expect(services.sort()).toEqual([...Object.keys(DESKTOP_INVOKE_CHANNELS), "onCommand", "onDirtyCheck", "onFlush", "pathForFile"].sort());
  });

  it("receives native menu commands on the contract channel and stops on unsubscribe", () => {
    const { desktop, listeners } = load();
    const seen: unknown[] = [];
    const off = (desktop.onCommand as (cb: (c: unknown) => void) => () => void)((c) => seen.push(c));
    expect([...listeners.keys()]).toEqual([DESKTOP_COMMAND_CHANNEL]);
    listeners.get(DESKTOP_COMMAND_CHANNEL)![0]!(null, { id: "project.new" });
    expect(seen).toEqual([{ id: "project.new" }]);
    off();
    expect(listeners.get(DESKTOP_COMMAND_CHANNEL)).toEqual([]);
  });

  it("receives save requests on the contract channel and stops on unsubscribe", () => {
    const { desktop, listeners } = load();
    const seen: unknown[] = [];
    const off = (desktop.onFlush as (cb: (id: unknown) => void) => () => void)((id) => seen.push(id));
    expect([...listeners.keys()]).toEqual([DESKTOP_FLUSH_CHANNEL]);
    listeners.get(DESKTOP_FLUSH_CHANNEL)![0]!(null, 7);
    expect(seen).toEqual([7]);
    off();
    expect(listeners.get(DESKTOP_FLUSH_CHANNEL)).toEqual([]);
  });

  it("receives dirty checks on the contract channel and stops on unsubscribe", () => {
    const { desktop, listeners } = load();
    const seen: unknown[] = [];
    const off = (desktop.onDirtyCheck as (cb: (id: unknown) => void) => () => void)((id) => seen.push(id));
    expect([...listeners.keys()]).toEqual([DESKTOP_DIRTY_CHECK_CHANNEL]);
    listeners.get(DESKTOP_DIRTY_CHECK_CHANNEL)![0]!(null, 9);
    expect(seen).toEqual([9]);
    off();
    expect(listeners.get(DESKTOP_DIRTY_CHECK_CHANNEL)).toEqual([]);
  });

  it("resolves a dropped file's path through webUtils", () => {
    const { desktop, paths } = load();
    const file = { name: "rocket.ork" };
    expect((desktop.pathForFile as (f: unknown) => string)(file)).toBe("/dropped/rocket.ork");
    expect(paths).toEqual([file]);
  });

  it("the embed bridge still sends only its contract channels", () => {
    const { embedIpc, sent } = load();
    const send = embedIpc.send as (channel: unknown, payload: unknown) => void;
    for (const channel of [EMBED_PANE_RECT_CHANNEL, EMBED_HOST_BRIDGE_CHANNEL, PANE_HOST_CHANNEL]) send(channel, {});
    send(PANE_MAIN_CHANNEL, {});
    send("rw-desktop:boot", {});
    expect(sent).toEqual([EMBED_PANE_RECT_CHANNEL, EMBED_HOST_BRIDGE_CHANNEL, PANE_HOST_CHANNEL]);
  });

  it("reads the lecturn messages on the contract channel", () => {
    const { desktop, listeners } = load();
    (desktop.lecturn as { onMessage: (cb: () => void) => unknown }).onMessage(() => undefined);
    expect([...listeners.keys()]).toEqual([PANE_MAIN_CHANNEL]);
  });
});
