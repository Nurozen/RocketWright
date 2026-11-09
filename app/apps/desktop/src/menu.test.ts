import type { DesktopCommand, RecentProject } from "@rw/contracts";
import { APP_COMMANDS, DESKTOP_COMMAND_CHANNEL } from "@rw/contracts";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildMenuTemplate, createMenuController, DOCS_URL, ISSUES_URL, linkAction, routeEdit, type EditTarget, type MenuActions, type MenuState } from "./menu.ts";

type Item = MenuItemConstructorOptions;

const state = (over: Partial<MenuState> = {}): MenuState => ({ platform: "darwin", dev: false, projectOpen: true, recents: [], recentsError: null, ...over });

function fakeActions(): MenuActions & { sent: DesktopCommand[] } {
  const sent: DesktopCommand[] = [];
  return { sent, send: (c) => void sent.push(c), edit: vi.fn<MenuActions["edit"]>(), closeWindow: vi.fn<MenuActions["closeWindow"]>(), quit: vi.fn<MenuActions["quit"]>(), openExternal: vi.fn<MenuActions["openExternal"]>() };
}

const children = (item: Item): Item[] => (Array.isArray(item.submenu) ? item.submenu : []);
const flatten = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flatten(children(i))]);
const menu = (template: Item[], label: string): Item[] => children(template.find((m) => m.label === label)!);
const byId = (template: Item[], id: string): Item => flatten(template).find((i) => i.id === id)!;
const click = (item: Item): void => (item.click as () => void)();
const labels = (items: Item[]): (string | undefined)[] => items.map((i) => i.label ?? i.role ?? "---").filter((l) => l !== "---");

const recent = (name: string, status: RecentProject["status"] = "ok"): RecentProject => ({ dir: `/p/${name}`, name, lastOpened: "2026-11-08T00:00:00Z", status });

describe("the native menu", () => {
  const platforms = ["darwin", "linux", "win32"] as const;

  it("has File, Edit, View and Help, and an app menu only on macOS", () => {
    const top = (platform: NodeJS.Platform) => buildMenuTemplate(state({ platform }), fakeActions()).map((m) => m.label);
    expect(top("darwin")).toEqual(["RocketWright", "File", "Edit", "View", "Help"]);
    expect(top("linux")).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("sends the project commands to the page, labelled from the one table", () => {
    const actions = fakeActions();
    const t = buildMenuTemplate(state(), actions);
    for (const id of ["project.new", "project.open", "project.openSample", "file.import", "file.export", "project.rename", "project.close", "help.quickStart", "app.settings"] as const) {
      const item = byId(t, id);
      expect(item.label).toBe(APP_COMMANDS.find((c) => c.id === id)!.label);
      click(item);
      expect(actions.sent.at(-1)).toEqual({ id });
    }
  });

  it.each(platforms)("carries the accelerators R0.10 needs on %s", (platform) => {
    const t = flatten(buildMenuTemplate(state({ platform }), fakeActions()));
    const accelerated = (accelerator: string) => t.filter((i) => i.accelerator === accelerator).map((i) => i.id);
    expect(accelerated("CmdOrCtrl+W")).toEqual(["project.close"]);
    expect(accelerated("CmdOrCtrl+Shift+W")).toEqual(["window.close"]);
    expect(accelerated("CmdOrCtrl+Z")).toEqual(["edit.undo"]);
    expect(accelerated("CmdOrCtrl+N")).toEqual(["project.new"]);
    expect(accelerated("CmdOrCtrl+O")).toEqual(["project.open"]);
    expect(accelerated("CmdOrCtrl+,")).toEqual(["app.settings"]);
    expect([1, 2, 3, 4].map((n) => accelerated(`CmdOrCtrl+${n}`))).toEqual([["view.tab:design"], ["view.tab:propulsion"], ["view.tab:simulate"], ["view.tab:results"]]);
  });

  it.each(platforms)("has no close, zoom or Delete shortcut that would bypass the app on %s", (platform) => {
    const t = flatten(buildMenuTemplate(state({ platform, dev: true }), fakeActions()));
    expect(t.filter((i) => ["close", "zoomIn", "zoomOut", "resetZoom", "undo", "redo", "togglefullscreen"].includes(i.role ?? "")).map((i) => i.role)).toEqual([]);
    expect(t.filter((i) => /^(Delete|Backspace)$/i.test(String(i.accelerator ?? "")))).toEqual([]);
    const del = t.find((i) => i.role === "delete");
    expect(del).toBeDefined();
    expect(del!.accelerator).toBeUndefined();
  });

  it("keeps every Edit role", () => {
    const edit = menu(buildMenuTemplate(state(), fakeActions()), "Edit");
    expect(edit.map((i) => i.role).filter(Boolean)).toEqual(["cut", "copy", "paste", "selectAll", "delete"]);
  });

  it.each(["darwin", "linux"] as const)("has exactly one Quit accelerator on %s", (platform) => {
    const t = flatten(buildMenuTemplate(state({ platform }), fakeActions()));
    expect(t.filter((i) => i.accelerator === "CmdOrCtrl+Q")).toHaveLength(1);
  });

  it("offers Quit in the File menu on every platform", () => {
    for (const platform of platforms) {
      const file = menu(buildMenuTemplate(state({ platform }), fakeActions()), "File");
      expect(file.at(-1)!.id).toBe("file.quit");
    }
  });

  it("quits through the File item on macOS, where it is a plain item", () => {
    const actions = fakeActions();
    click(byId(buildMenuTemplate(state(), actions), "file.quit"));
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it("closes the window from Close window, not from Close project", () => {
    const actions = fakeActions();
    const t = buildMenuTemplate(state(), actions);
    click(byId(t, "window.close"));
    expect(actions.closeWindow).toHaveBeenCalledOnce();
    expect(actions.sent).toEqual([]);
  });

  it("routes Undo and Redo through the custom edit action", () => {
    const actions = fakeActions();
    const t = buildMenuTemplate(state(), actions);
    click(byId(t, "edit.undo"));
    click(byId(t, "edit.redo"));
    expect(vi.mocked(actions.edit).mock.calls).toEqual([["undo"], ["redo"]]);
  });

  it("only offers project-bound items with a project open", () => {
    const t = buildMenuTemplate(state({ projectOpen: false }), fakeActions());
    for (const id of ["project.close", "project.rename", "file.export", "view.tab:design"]) expect(byId(t, id).enabled, id).toBe(false);
    expect(byId(t, "app.settings").enabled, "default units are settable from Welcome").not.toBe(false);
    expect(byId(t, "project.new").enabled).toBeUndefined();
    expect(byId(t, "file.import").enabled, "an .ork starts a new project (D17)").toBeUndefined();
    expect(byId(t, "project.openSample").enabled).toBeUndefined();
  });

  it("lists the header's tabs under View and sends the one picked", () => {
    const actions = fakeActions();
    const t = buildMenuTemplate(state(), actions);
    expect(labels(menu(t, "View")).slice(0, 4)).toEqual(["Design", "Propulsion", "Simulate", "Results"]);
    click(byId(t, "view.tab:results"));
    expect(actions.sent).toEqual([{ id: "view.tab", tab: "results" }]);
  });

  it("zooms through the page, with a hidden Shift-held Zoom in", () => {
    const actions = fakeActions();
    const view = menu(buildMenuTemplate(state(), actions), "View");
    const zoom = view.filter((i) => /Zoom|Actual/.test(i.label ?? ""));
    expect(zoom.map((i) => [i.label, i.accelerator, i.visible])).toEqual([
      ["Actual size", "CmdOrCtrl+0", true],
      ["Zoom in", "CmdOrCtrl+=", true],
      ["Zoom in", "CmdOrCtrl+Plus", false],
      ["Zoom out", "CmdOrCtrl+-", true],
    ]);
    zoom.forEach(click);
    expect(actions.sent).toEqual([
      { id: "view.zoom", direction: "reset" },
      { id: "view.zoom", direction: "in" },
      { id: "view.zoom", direction: "in" },
      { id: "view.zoom", direction: "out" },
    ]);
  });

  it("reloads in development only", () => {
    const has = (dev: boolean) => flatten(buildMenuTemplate(state({ dev }), fakeActions())).some((i) => i.role === "reload");
    expect(has(true)).toBe(true);
    expect(has(false)).toBe(false);
  });

  it("opens the browser from Help and shows the bundled quick start in the app", () => {
    const actions = fakeActions();
    const t = buildMenuTemplate(state(), actions);
    click(byId(t, "help.docs"));
    click(byId(t, "help.issue"));
    expect(vi.mocked(actions.openExternal).mock.calls).toEqual([[DOCS_URL], [ISSUES_URL]]);
    expect(menu(t, "Help").map((i) => i.label ?? i.role).filter(Boolean)).toEqual(["Quick start", "Online documentation", "Report an issue", "About RocketWright"]);
  });

  describe("Recent", () => {
    const recentMenu = (over: Partial<MenuState>, actions = fakeActions()) => children(byId(buildMenuTemplate(state(over), actions), "project.openRecent"));

    it("sends the picked folder to the page, which shows any failure", () => {
      const actions = fakeActions();
      const [row] = recentMenu({ recents: [recent("weekend")] }, actions);
      expect(row!.label).toBe("weekend");
      click(row!);
      expect(actions.sent).toEqual([{ id: "project.openRecent", dir: "/p/weekend" }]);
    });

    it("says why a row is unusable, and disables only a missing one (D5)", () => {
      const rows = recentMenu({ recents: [recent("gone", "missing"), recent("locked", "locked"), recent("tcc", "denied")] });
      expect(rows.map((r) => [r.label, r.enabled])).toEqual([
        ["gone (Missing)", false],
        ["locked (In use)", true],
        ["tcc (No access)", true],
      ]);
    });

    it("says so when empty, or when it cannot be read", () => {
      expect(recentMenu({}).map((r) => [r.label, r.enabled])).toEqual([["No recent projects", false]]);
      expect(recentMenu({ recentsError: "Could not read recent projects" }).map((r) => [r.label, r.enabled])).toEqual([["Could not read recent projects", false]]);
    });

    it("keeps the native submenu short", () => {
      expect(recentMenu({ recents: Array.from({ length: 30 }, (_, i) => recent(`p${i}`)) })).toHaveLength(10);
    });
  });
});

describe("routeEdit", () => {
  const target = () => ({ undo: vi.fn<() => void>(), redo: vi.fn<() => void>(), isDestroyed: () => false }) satisfies EditTarget;

  it("hands a focused guest the edit itself and leaves the design history alone", () => {
    const host = target();
    const guest = target();
    const send = vi.fn<(c: DesktopCommand) => void>();
    routeEdit("undo", guest, host, send);
    routeEdit("redo", guest, host, send);
    expect(guest.undo).toHaveBeenCalledOnce();
    expect(guest.redo).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(host.undo).not.toHaveBeenCalled();
  });

  it("asks the page when the page is focused, because only it knows about its fields", () => {
    const host = target();
    const send = vi.fn<(c: DesktopCommand) => void>();
    routeEdit("undo", host, host, send);
    routeEdit("redo", host, host, send);
    expect(send.mock.calls.map(([c]) => c)).toEqual([{ id: "edit.undo" }, { id: "edit.redo" }]);
    expect(host.undo).not.toHaveBeenCalled();
  });

  it("treats no focused contents as the page (U05)", () => {
    const send = vi.fn<(c: DesktopCommand) => void>();
    routeEdit("undo", null, target(), send);
    expect(send).toHaveBeenCalledWith({ id: "edit.undo" });
  });

  it("treats a guest that is already gone as the page", () => {
    const gone = { ...target(), isDestroyed: () => true };
    const send = vi.fn<(c: DesktopCommand) => void>();
    routeEdit("undo", gone, target(), send);
    expect(gone.undo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("linkAction", () => {
  const ORIGIN = "http://127.0.0.1:5173";

  it("keeps the app's own origin in the window", () => {
    expect(linkAction(`${ORIGIN}/?page=04`, ORIGIN)).toBe("navigate");
  });

  it("sends web links to the browser, another port on loopback included", () => {
    expect(linkAction("https://example.com/", ORIGIN)).toBe("external");
    expect(linkAction("http://127.0.0.1:9/", ORIGIN)).toBe("external");
  });

  it("refuses other schemes and anything unparseable", () => {
    expect(linkAction("file:///etc/passwd", ORIGIN)).toBe("deny");
    expect(linkAction("javascript:alert(1)", ORIGIN)).toBe("deny");
    expect(linkAction("not a url", ORIGIN)).toBe("deny");
  });
});

describe("createMenuController", () => {
  function harness(recents: () => Promise<RecentProject[]> = () => Promise.resolve([])) {
    const applied: MenuItemConstructorOptions[][] = [];
    const sent: unknown[][] = [];
    const host: EditTarget = { undo: vi.fn<() => void>(), redo: vi.fn<() => void>(), isDestroyed: () => false };
    let destroyed = false;
    const win = {
      webContents: { ...host, send: (...args: unknown[]) => void sent.push(args) },
      isDestroyed: () => destroyed,
      close: vi.fn<() => void>(),
    };
    const log = vi.fn<(line: string) => void>();
    const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
    const controller = createMenuController({ win, channel: DESKTOP_COMMAND_CHANNEL, platform: "darwin", dev: false, recents, apply: (t) => void applied.push(t), focused: () => null, openExternal, quit: vi.fn<() => void>(), log });
    return { controller, applied, sent, win, log, openExternal, destroy: () => (destroyed = true) };
  }

  it("rebuilds with the new Recents on refresh", async () => {
    const h = harness(() => Promise.resolve([recent("a")]));
    await h.controller.refresh();
    expect(children(byId(h.applied.at(-1)!, "project.openRecent")).map((r) => r.label)).toEqual(["a"]);
  });

  it("follows whether a project is showing", async () => {
    const h = harness();
    await h.controller.setProjectOpen(true);
    expect(byId(h.applied.at(-1)!, "project.close").enabled).toBe(true);
    await h.controller.setProjectOpen(false);
    expect(byId(h.applied.at(-1)!, "project.close").enabled).toBe(false);
  });

  it("installs a working menu at once, with Recent still loading", () => {
    const h = harness(() => new Promise(() => undefined));
    h.controller.install();
    expect(h.applied).toHaveLength(1);
    expect(children(byId(h.applied[0]!, "project.openRecent")).map((r) => r.label)).toEqual(["Loading recent projects…"]);
  });

  it("applies whether a project is showing before Recents have been read", () => {
    const h = harness(() => new Promise(() => undefined));
    void h.controller.setProjectOpen(true);
    expect(byId(h.applied.at(-1)!, "project.close").enabled).toBe(true);
  });

  it("hides a project already in the header's list, but not on Welcome", async () => {
    const open = { ...recent("open"), open: true } as RecentProject;
    const h = harness(() => Promise.resolve([recent("a"), open]));
    await h.controller.setProjectOpen(true);
    expect(children(byId(h.applied.at(-1)!, "project.openRecent")).map((r) => r.label)).toEqual(["a"]);
    await h.controller.setProjectOpen(false);
    expect(children(byId(h.applied.at(-1)!, "project.openRecent")).map((r) => r.label)).toEqual(["a", "open"]);
  });

  it("drops a slow rebuild once a newer one has been asked for", async () => {
    let first!: (r: RecentProject[]) => void;
    const reads = [new Promise<RecentProject[]>((ok) => (first = ok)), Promise.resolve([recent("new")])];
    const h = harness(() => reads.shift()!);
    const slow = h.controller.refresh();
    await h.controller.refresh();
    first([recent("old")]);
    await slow;
    expect(h.applied).toHaveLength(1);
    expect(children(byId(h.applied[0]!, "project.openRecent")).map((r) => r.label)).toEqual(["new"]);
  });

  it("says so in the submenu when Recents cannot be read", async () => {
    const h = harness(() => Promise.reject(new Error("unreadable")));
    await h.controller.refresh();
    expect(children(byId(h.applied.at(-1)!, "project.openRecent")).map((r) => r.label)).toEqual(["Could not read recent projects"]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
  });

  it("sends a Recent pick over the command channel", async () => {
    const h = harness(() => Promise.resolve([recent("a")]));
    await h.controller.refresh();
    click(children(byId(h.applied.at(-1)!, "project.openRecent"))[0]!);
    expect(h.sent).toEqual([[DESKTOP_COMMAND_CHANNEL, { id: "project.openRecent", dir: "/p/a" }]]);
  });

  it("does nothing to a window that has gone", async () => {
    const h = harness();
    await h.controller.refresh();
    h.destroy();
    click(byId(h.applied.at(-1)!, "project.new"));
    click(byId(h.applied.at(-1)!, "edit.undo"));
    click(byId(h.applied.at(-1)!, "window.close"));
    expect(h.sent).toEqual([]);
    expect(h.win.close).not.toHaveBeenCalled();
  });

  it("logs a link the system could not open", async () => {
    const h = harness();
    h.openExternal.mockRejectedValueOnce(new Error("no browser"));
    await h.controller.refresh();
    click(byId(h.applied.at(-1)!, "help.docs"));
    await vi.waitFor(() => expect(h.log).toHaveBeenCalledWith(expect.stringContaining("no browser")));
  });
});
