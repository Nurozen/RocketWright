// @vitest-environment jsdom
/** R2.6 / U52: the Check model panel, from a report to Go to part. */
import type { schema } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_SELECTOR } from "../embed/bridge.ts";
import type { RpcLike } from "../state/rpc.ts";
import { createAppStore, type AppStore } from "../state/store.ts";
import { checkIssuesOf, type CheckPanelModel } from "./CheckIssuesPanel.tsx";
import { ConnectedShell } from "./ConnectedShell.tsx";
import { Header } from "./Header.tsx";

vi.mock("../embed/EmbedPane.tsx", () => ({ EmbedPane: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Diag = schema.Diagnostic;
const diag = (code: string, severity: Diag["severity"], message: string, extra: Partial<Diag> = {}): Diag => ({ code, severity, message, ...extra });
const REPORT: Diag[] = [
  diag("RW-W002", "warning", "joint has no count", { path: "/c/nose/joint/count" }),
  diag("RW-E150", "error", "shoulder does not fit", { path: "/c/fins/shoulder/od" }),
  diag("RW-W001", "warning", "unknown key", { file: "parts/fin_can.rw.toml", line: 12 }),
  diag("RW-E059", "error", "config names a missing part", { path: "/c/gone" }),
  diag("RW-I900", "info", "a note"),
];
const PARTS = [
  { id: "nose", name: "Nosecone" },
  { id: "fins", name: "Fins (4)" },
];

const button = (name: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const panel = (): HTMLElement | null => document.querySelector('[data-testid="header.check-issues"]');
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="header.check-issue"]')];
const groups = (): string[] => [...(panel()?.querySelectorAll("h3") ?? [])].map((h) => h.textContent ?? "");
const checkButton = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="header.check-model"]')!;
const press = (target: Element): void => {
  act(() => void target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
};
const click = (target: HTMLElement): void => {
  act(() => target.click());
};

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

function render(ui: ReactNode): void {
  act(() => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

describe("checkIssuesOf", () => {
  it("groups by severity, leaves info out, and keeps the report's order within a group", () => {
    const { errors, warnings } = checkIssuesOf(REPORT, PARTS);
    expect(errors.map((i) => i.code)).toEqual(["RW-E150", "RW-E059"]);
    expect(warnings.map((i) => i.code)).toEqual(["RW-W002", "RW-W001"]);
  });

  it("names the part from the model and links only a part the model has", () => {
    const { errors, warnings } = checkIssuesOf(REPORT, PARTS);
    expect(errors[0]).toMatchObject({ where: "Fins (4)", part: "rw:c/fins" });
    expect(warnings[0]).toMatchObject({ where: "Nosecone", part: "rw:c/nose" });
    expect(errors[1]).toMatchObject({ where: "gone", part: null });
    expect(warnings[1]).toMatchObject({ where: "parts/fin_can.rw.toml:12", part: null });
  });

  it("gives equal diagnostics distinct keys", () => {
    const same = diag("RW-W002", "warning", "x", { path: "/c/nose" });
    const { warnings } = checkIssuesOf([same, same], PARTS);
    expect(new Set(warnings.map((i) => i.key)).size).toBe(2);
  });
});

describe("in the header", () => {
  const onCheckModel = vi.fn<() => void>();
  const onRunAgain = vi.fn<() => void>();
  const onGoToPart = vi.fn<CheckPanelModel["onGoToPart"]>();
  const model = (over: Partial<CheckPanelModel> = {}): CheckPanelModel => ({ issues: checkIssuesOf(REPORT, PARTS), checked: true, running: false, error: null, onRunAgain, onGoToPart, ...over });
  const header = (check: Parameters<typeof Header>[0]["check"] = { status: "errors", issues: 4 }, panelModel: CheckPanelModel | undefined = model()) =>
    render(<Header projectName="Demo" saveState="Saved" activeTab="design" check={check} onCheckModel={onCheckModel} checkPanel={panelModel} />);

  beforeEach(() => {
    onCheckModel.mockClear();
    onRunAgain.mockClear();
    onGoToPart.mockClear();
  });

  it("opens on Check model and runs the check once; a second press closes it without another run", () => {
    header();
    expect(panel()).toBeNull();
    click(checkButton());
    expect(panel()).not.toBeNull();
    expect(onCheckModel).toHaveBeenCalledTimes(1);
    click(checkButton());
    expect(panel()).toBeNull();
    expect(onCheckModel).toHaveBeenCalledTimes(1);
  });

  it("is a named dialog the desktop app treats as an overlay, so the agent pane becomes a snapshot under it", () => {
    header();
    click(checkButton());
    expect(panel()!.matches(OVERLAY_SELECTOR)).toBe(true);
    expect(panel()!.getAttribute("role")).toBe("dialog");
    expect(panel()!.getAttribute("aria-label")).toBe("Check model");
  });

  it("closes on an outside press, but not on its own or on the button's", () => {
    header();
    click(checkButton());
    press(panel()!.querySelector("h2")!);
    expect(panel()).not.toBeNull();
    press(checkButton());
    expect(panel()).not.toBeNull();
    press(document.body);
    expect(panel()).toBeNull();
  });

  it("shows Errors and Warnings with code, message, part and Go to part", () => {
    header();
    click(checkButton());
    expect(groups()).toEqual(["Errors", "Warnings"]);
    const first = rows()[0]!;
    expect(first.dataset["severity"]).toBe("error");
    expect(first.textContent).toContain("RW-E150");
    expect(first.textContent).toContain("shoulder does not fit");
    expect(first.textContent).toContain("Fins (4)");
    expect(panel()!.querySelector(".rw-badge")?.textContent).toBe("4");
  });

  it("names each row by its code and part, so the repeated Go to part buttons can be told apart", () => {
    header();
    click(checkButton());
    const first = rows()[0]!;
    const named = (first.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(first.getAttribute("role")).toBe("group");
    expect(named).toEqual(["RW-E150", "Fins (4)"]);
  });

  it("offers Go to part only on a row whose part exists", () => {
    header();
    click(checkButton());
    expect(rows().map((r) => button("Go to part", r) !== undefined)).toEqual([true, false, true, false]);
    click(button("Go to part", rows()[0]!)!);
    expect(onGoToPart).toHaveBeenCalledWith("rw:c/fins");
    expect(panel()).not.toBeNull();
  });

  it("Run check again runs the check and waits for it", () => {
    header();
    click(checkButton());
    click(button("Run check again")!);
    expect(onRunAgain).toHaveBeenCalledTimes(1);
    header({ status: "running", issues: 0 }, model({ running: true }));
    expect(button("Run check again")!.disabled).toBe(true);
    expect(button("Run check again")!.getAttribute("aria-busy")).toBe("true");
    expect(panel()).not.toBeNull();
  });

  it.each([
    ["a clean report", { checked: true }, "No errors or warnings."],
    ["no report yet", { checked: false }, "Model not checked yet."],
    ["a check in flight with nothing to show", { checked: false, running: true }, "Checking model…"],
  ])("says what an empty list means: %s", (_name, over, text) => {
    header({ status: "ok", issues: 0 }, model({ issues: checkIssuesOf([], PARTS), ...over }));
    click(checkButton());
    expect(panel()!.textContent).toContain(text);
    expect(groups()).toEqual([]);
  });

  it("says why a check could not run, instead of claiming the model is clean", () => {
    header({ status: "ok", issues: 0 }, model({ issues: checkIssuesOf([], PARTS), error: "sidecar stopped" }));
    click(checkButton());
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe("Could not run the check: sidecar stopped");
    expect(panel()!.textContent).not.toContain("No errors or warnings.");
  });

  it("closes when the model empties and the button goes away", () => {
    header();
    click(checkButton());
    header({ status: "empty", issues: 0 });
    expect(panel()).toBeNull();
  });

  it("without a panel model the button only runs the check", () => {
    render(<Header projectName="Demo" saveState="Saved" activeTab="design" check={{ status: "ok", issues: 0 }} onCheckModel={onCheckModel} />);
    click(checkButton());
    expect(onCheckModel).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    expect(checkButton().hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("in the connected shell", () => {
  function setup(diagnostics: Diag[], checkRun: () => Promise<unknown> = () => Promise.resolve({})) {
    const store: AppStore = createAppStore();
    const snapshot = new MockRpc().snapshot();
    const check = snapshot.check!;
    const part = snapshot.evaluated!.components[0]!;
    const report = diagnostics.map((d) => ({ ...d, ...(d.path === undefined ? {} : { path: `/c/${part.id}` }) }));
    store.setState((s) => ({ ...s, project: { ...s.project, projectId: "p", snapshot: { ...snapshot, check: { ...check, model_hash: snapshot.evaluated!.model_hash, diagnostics: report } } as never } }));
    const calls: unknown[] = [];
    const client = {
      call: (method: string, params: unknown) => {
        if (method !== "check.run") return Promise.resolve({ projects: [] });
        calls.push(params);
        return checkRun();
      },
      on: () => () => undefined,
    } as unknown as RpcLike;
    render(<ConnectedShell store={store} client={client} />);
    return { store, calls, part };
  }
  const open = async (): Promise<void> => {
    await act(async () => checkButton().click());
  };
  const REPORT_ON_PART: Diag[] = [diag("RW-E150", "error", "does not fit", { path: "/c/x" }), diag("RW-W002", "warning", "no count", { path: "/c/x" }), diag("RW-W150", "warning", "tab short", { path: "/c/x" })];

  it("runs the check for this project and lists the report", async () => {
    const { calls } = setup(REPORT_ON_PART);
    await open();
    expect(calls).toEqual([{ projectId: "p" }]);
    expect(rows()).toHaveLength(3);
    expect(groups()).toEqual(["Errors", "Warnings"]);
  });

  it("counts every listed issue on the button and says how many of each", () => {
    setup(REPORT_ON_PART);
    expect(document.querySelector('[data-testid="header.check-count"]')?.textContent).toBe("3");
    expect(document.querySelector('[data-testid="header.check-status"]')?.textContent).toBe("1 error, 2 warnings");
  });

  it("Go to part selects the part on Assembly, shows it again if hidden, and keeps the panel open", async () => {
    const { store, part } = setup(REPORT_ON_PART);
    act(() => {
      store.getState().ui.navigate("results");
      store.getState().ui.toggleHidden(part.id);
    });
    await open();
    await act(async () => button("Go to part", rows()[0]!)!.click());
    const s = store.getState();
    expect(s.selection).toMatchObject({ refs: [`rw:c/${part.id}`], source: "check" });
    expect(s.ui.page).toBe("assembly");
    expect(s.ui.hidden).not.toContain(part.id);
    expect(panel()).not.toBeNull();
  });

  it("Go to part leaves the Compare view, which would hide the part", async () => {
    const { store } = setup(REPORT_ON_PART);
    act(() => store.getState().ui.setCompare({ old: "step:1", new: "step:2" }));
    await open();
    await act(async () => button("Go to part", rows()[0]!)!.click());
    expect(store.getState().ui.compare).toBeNull();
  });

  it("shows a failed check in the panel and clears it on the next run", async () => {
    let fail = true;
    setup([], () => (fail ? Promise.reject(new Error("sidecar stopped")) : Promise.resolve({})));
    await open();
    expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe("Could not run the check: sidecar stopped");
    fail = false;
    await act(async () => button("Run check again")!.click());
    expect(panel()!.querySelector('[role="alert"]')).toBeNull();
  });
});
