// @vitest-environment jsdom
/** U63: the 2D drawing a person can open from the Assembly toolbar. */
import type { schema } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore } from "../../state/store.ts";
import { AssemblyToolbarSlot } from "./AssemblyPage.tsx";
import { DrawingDialog, drawingUrl } from "./DrawingDialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function render(ui: ReactNode): Promise<void> {
  await act(async () => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

const result = (view: string): schema.RenderResult => ({ view, path: `renders/default.${view}.png`, svg_path: `renders/default.${view}.svg`, png_sha256: `sha-${view}`, width: 800, height: 300 }) as unknown as schema.RenderResult;

function fakeClient(respond: (view: string) => Promise<schema.RenderResult> = (view) => Promise.resolve(result(view))) {
  const views: string[] = [];
  const client = {
    call: (method: string, params: { view: string }) => {
      if (method !== "render") return Promise.resolve({});
      views.push(params.view);
      return respond(params.view);
    },
    on: () => () => undefined,
  } as unknown as RpcLike;
  return { client, views };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const picture = () => dialog()!.querySelector("img");
const radio = (name: string) => [...dialog()!.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.startsWith(name))!.querySelector("input")!;
const button = (name: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const open = (client: RpcLike, httpBase = "http://127.0.0.1:9") => render(<DrawingDialog client={client} projectId="my rocket" httpBase={httpBase} onClose={() => undefined} />);

describe("drawingUrl", () => {
  it("escapes the project and busts the cache with the picture's hash", () => {
    expect(drawingUrl("http://127.0.0.1:9", "my rocket", { path: "renders/default.fin.png", png_sha256: "abc" })).toBe("http://127.0.0.1:9/api/projects/my%20rocket/renders/default.fin.png?v=abc");
    expect(drawingUrl("", "p", { path: "renders/a.b.png", png_sha256: "1" })).toBe("/api/projects/p/renders/a.b.png?v=1");
  });
});

describe("DrawingDialog", () => {
  it("draws the profile on open and names the file it saved", async () => {
    const { client, views } = fakeClient();
    await open(client);
    expect(views).toEqual(["profile"]);
    expect(dialog()!.querySelector("h2")?.textContent).toBe("2D drawing");
    expect(picture()!.getAttribute("src")).toBe("http://127.0.0.1:9/api/projects/my%20rocket/renders/default.profile.png?v=sha-profile");
    expect(picture()!.getAttribute("alt")).toBe("Profile drawing of the rocket");
    expect(dialog()!.textContent).toContain("Saved in the project as renders/default.profile.png");
  });

  it("offers each 2D view by its visible name in a named group, and draws the one picked", async () => {
    const { client, views } = fakeClient();
    await open(client);
    const group = dialog()!.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("View");
    expect([...group.querySelectorAll(".rw-ui-radio-card__title")].map((t) => t.textContent)).toEqual(["Profile", "Fin", "Stations", "Anchors"]);
    await act(async () => radio("Stations").click());
    expect(views).toEqual(["profile", "stations"]);
    expect(picture()!.getAttribute("alt")).toBe("Stations drawing of the rocket");
  });

  it("ignores a slower answer for the view the person left", async () => {
    let finishProfile: (r: schema.RenderResult) => void = () => undefined;
    const { client } = fakeClient((view) => (view === "profile" ? new Promise((ok) => (finishProfile = ok)) : Promise.resolve(result(view))));
    await open(client);
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toBe("Drawing…");
    await act(async () => radio("Fin").click());
    await act(async () => finishProfile(result("profile")));
    expect(picture()!.getAttribute("src")).toContain("default.fin.png");
  });

  it("says why a drawing failed and can try again", async () => {
    let ok = false;
    const { client, views } = fakeClient((view) => (ok ? Promise.resolve(result(view)) : Promise.reject(new Error("the model has errors"))));
    await open(client);
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("The drawing failed: the model has errors");
    expect(picture()).toBeNull();
    ok = true;
    await act(async () => button("Try again", dialog()!)!.click());
    expect(views).toEqual(["profile", "profile"]);
    expect(picture()).not.toBeNull();
  });

  it("says so when the saved picture cannot be loaded", async () => {
    const { client } = fakeClient();
    await open(client);
    await act(async () => void picture()!.dispatchEvent(new Event("error")));
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    expect(dialog()!.textContent).not.toContain("Saved in the project");
  });
});

describe("the Assembly toolbar", () => {
  function connected() {
    const store = createAppStore();
    store.setState((s) => ({ ...s, project: { ...s.project, projectId: "p", connection: "open", snapshot: new MockRpc().snapshot() as never } }));
    return store;
  }

  it("opens the drawing from a button named 2D drawing, and closes it", async () => {
    const { client, views } = fakeClient();
    await render(<AssemblyToolbarSlot store={connected()} client={client} httpBase="" />);
    expect(dialog()).toBeNull();
    await act(async () => button("2D drawing")!.click());
    expect(views).toEqual(["profile"]);
    expect(picture()!.getAttribute("src")).toBe("/api/projects/p/renders/default.profile.png?v=sha-profile");
    await act(async () => button("Close", dialog()!)!.click());
    expect(dialog()).toBeNull();
  });

  it("disables the button with no connection", async () => {
    await render(<AssemblyToolbarSlot store={createAppStore()} />);
    expect(button("2D drawing")!.disabled).toBe(true);
  });
});
