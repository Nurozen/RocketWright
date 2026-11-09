// @vitest-environment jsdom
/**
 * The overlay contract of the shared primitives: every surface matches the
 * selector the desktop app watches, and Escape, outside presses and the focus
 * trap act on the top layer only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCustomProperties } from "../../../../packages/ui/src/tokens.ts";
import { OVERLAY_SELECTOR } from "../embed/bridge.ts";
import { Banner } from "./Banner.tsx";
import { Menu, MenuButton, type MenuEntry } from "./Menu.tsx";
import { Modal } from "./Modal.tsx";
import { caretAt, placeFloating, Popover } from "./Popover.tsx";
import { RadioCardGroup } from "./RadioCard.tsx";
import { SideSheet } from "./SideSheet.tsx";
import { StatStrip } from "./StatStrip.tsx";
import { TextField } from "./TextField.tsx";

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
  vi.restoreAllMocks();
});

function render(ui: ReactNode): void {
  act(() => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

const q = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`no element for ${selector}`);
  return el;
};

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => void (document.activeElement ?? document.body).dispatchEvent(e));
  return e;
}

const pointerDown = (el: Element): void => act(() => void el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
const click = (el: HTMLElement): void => act(() => el.click());

/** Pins an element's painted rect, which jsdom always reports as zero. */
function stubRect(el: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

function stubSurfaceSize(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
}

function ModalHarness({ onClose = () => {}, ...props }: { onClose?: () => void; dismissOnEscape?: boolean; dismissOnOutside?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <button id="behind">Behind</button>
      <Modal
        open={open}
        title="New project"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        footer={<button id="last">Create project</button>}
        {...props}
      >
        <input id="first" aria-label="Name" />
        <button id="middle">Choose</button>
        {props.children}
      </Modal>
    </>
  );
}

function openModal(props: Parameters<typeof ModalHarness>[0] = {}): void {
  render(<ModalHarness {...props} />);
  q("#opener").focus();
  click(q("#opener"));
}

describe("Modal", () => {
  it("is a named modal dialog, and its scrim is an overlay too", () => {
    openModal();
    const dialog = q('[role="dialog"]');
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("New project");
    expect(dialog.matches(OVERLAY_SELECTOR)).toBe(true);
    expect(q(".rw-ui-scrim").matches(OVERLAY_SELECTOR)).toBe(true);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("renders nothing while closed", () => {
    render(<ModalHarness />);
    expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn<() => void>();
    openModal({ onClose });
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps Escape for a control that already handled it, or when told to", () => {
    const onClose = vi.fn<() => void>();
    openModal({ onClose, children: <input id="own-escape" onKeyDown={(e) => e.key === "Escape" && e.preventDefault()} /> });
    q("#own-escape").focus();
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    openModal({ onClose, dismissOnEscape: false });
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a press on the scrim, not on one inside the dialog", () => {
    const onClose = vi.fn<() => void>();
    openModal({ onClose });
    pointerDown(q("#middle"));
    expect(onClose).not.toHaveBeenCalled();
    pointerDown(q(".rw-ui-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a scrim press when told to", () => {
    const onClose = vi.fn<() => void>();
    openModal({ onClose, dismissOnOutside: false });
    pointerDown(q(".rw-ui-scrim"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus to the first control and returns it on close", () => {
    openModal();
    expect(document.activeElement).toBe(q("#first"));
    press("Escape");
    expect(document.activeElement).toBe(q("#opener"));
  });

  it("wraps Tab at both ends of the trap", () => {
    openModal();
    q("#last").focus();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("#first"));
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("#last"));
  });

  it("leaves Tab alone between the ends", () => {
    openModal();
    q("#middle").focus();
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("pulls focus back when something outside takes it", () => {
    openModal();
    act(() => q("#behind").focus());
    expect(document.activeElement).toBe(q("#first"));
  });

  it("brings Tab back from outside the dialog", () => {
    openModal();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("#first"));
  });
});

describe("overlay stack", () => {
  function Stacked({ onModal, onMenu }: { onModal: () => void; onMenu: () => void }) {
    const [menu, setMenu] = useState(true);
    return (
      <Modal open title="Below" onClose={onModal}>
        <button id="inside">Inside</button>
        <Menu
          open={menu}
          anchor={{ x: 10, y: 10 }}
          label="Above"
          items={[{ id: "a", label: "A" }]}
          onClose={() => {
            onMenu();
            setMenu(false);
          }}
        />
      </Modal>
    );
  }

  it("gives Escape to the top layer only", () => {
    const onModal = vi.fn<() => void>();
    const onMenu = vi.fn<() => void>();
    render(<Stacked onModal={onModal} onMenu={onMenu} />);
    press("Escape");
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(onModal).not.toHaveBeenCalled();
    press("Escape");
    expect(onModal).toHaveBeenCalledTimes(1);
  });

  it("gives an outside press to the top layer only", () => {
    const onModal = vi.fn<() => void>();
    const onMenu = vi.fn<() => void>();
    render(<Stacked onModal={onModal} onMenu={onMenu} />);
    pointerDown(q(".rw-ui-scrim"));
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(onModal).not.toHaveBeenCalled();
  });

  it("does not trap focus under a menu opened on top", () => {
    render(<Stacked onModal={() => {}} onMenu={() => {}} />);
    expect(document.activeElement).toBe(q('[role="menu"] button'));
  });

  it("does not leak clicks to React ancestors of a portalled surface", () => {
    const onRow = vi.fn<() => void>();
    render(
      <div onClick={onRow}>
        <Menu open anchor={{ x: 0, y: 0 }} label="Row" items={[{ id: "a", label: "A" }]} onClose={() => {}} />
      </div>,
    );
    click(q('[role="menuitem"]'));
    expect(onRow).not.toHaveBeenCalled();
  });
});

describe("Popover", () => {
  function Harness({ onClose, side }: { onClose: () => void; side?: "bottom" | "right" }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button id="trigger" ref={trigger} onClick={() => setOpen(true)}>
          Add
        </button>
        <button id="behind">Behind</button>
        <Popover open={open} anchor={trigger.current} title="Add part" side={side} onClose={onClose}>
          <button id="in-popover">Part types</button>
        </Popover>
      </>
    );
  }

  it("is a named dialog that is not modal", () => {
    render(<Harness onClose={() => {}} />);
    click(q("#trigger"));
    const dialog = q('[role="dialog"]');
    expect(dialog.matches(OVERLAY_SELECTOR)).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Add part");
  });

  it("focuses past the close button", () => {
    render(<Harness onClose={() => {}} />);
    click(q("#trigger"));
    expect(document.activeElement).toBe(q("#in-popover"));
  });

  it("closes on Escape and an outside press, but not a press on its trigger", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    click(q("#trigger"));
    pointerDown(q("#trigger"));
    pointerDown(q("#in-popover"));
    expect(onClose).not.toHaveBeenCalled();
    pointerDown(q("#behind"));
    expect(onClose).toHaveBeenCalledTimes(1);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("sits at its anchor", () => {
    render(<Harness onClose={() => {}} side="right" />);
    stubRect(q("#trigger"), 100, 50, 30, 30);
    click(q("#trigger"));
    const dialog = q('[role="dialog"]');
    expect([dialog.style.left, dialog.style.top]).toEqual(["134px", "50px"]);
  });
});

describe("SideSheet", () => {
  it("is a named dialog that survives a stray press and closes on Escape", () => {
    const onClose = vi.fn<() => void>();
    render(
      <>
        <button id="behind">Behind</button>
        <SideSheet open title="Simulation conditions: Baseline" onClose={onClose}>
          <input id="rail" aria-label="Rail length" />
        </SideSheet>
      </>,
    );
    const dialog = q('[role="dialog"]');
    expect(dialog.matches(OVERLAY_SELECTOR)).toBe(true);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Simulation conditions: Baseline");
    expect(document.activeElement).toBe(q("#rail"));
    pointerDown(q("#behind"));
    expect(onClose).not.toHaveBeenCalled();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from its close button and on an outside press when asked", () => {
    const onClose = vi.fn<() => void>();
    render(
      <>
        <button id="behind">Behind</button>
        <SideSheet open title="Sheet" dismissOnOutside onClose={onClose}>
          Body
        </SideSheet>
      </>,
    );
    click(q('[aria-label="Close"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    pointerDown(q("#behind"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Menu", () => {
  const entries = (onPick: (id: string) => void): MenuEntry[] => [
    { kind: "heading", id: "h", label: "Recent" },
    { id: "skip", label: "Skipped", disabled: true },
    { id: "rename", label: "Rename", onSelect: () => onPick("rename") },
    { id: "move", label: "Move to...", submenu: [
      { id: "tube", label: "Body tube", onSelect: () => onPick("tube") },
      { id: "nose", label: "Nose cone", onSelect: () => onPick("nose") },
    ] },
    { kind: "divider", id: "d" },
    { id: "delete", label: "Delete", danger: true, onSelect: () => onPick("delete") },
  ];

  function Harness({ onPick = () => {}, onClose = () => {} }: { onPick?: (id: string) => void; onClose?: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button id="behind">Behind</button>
        <Menu
          open={open}
          anchor={{ x: 40, y: 60 }}
          label="Part actions"
          items={entries(onPick)}
          testId="menu"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      </>
    );
  }

  const item = (id: string): HTMLElement => q(`[data-item="${id}"]`);

  it("carries menu roles, a danger item, a divider and a heading", () => {
    render(<Harness />);
    const menu = q('[role="menu"]');
    expect(menu.matches(OVERLAY_SELECTOR)).toBe(true);
    expect(menu.getAttribute("aria-label")).toBe("Part actions");
    expect(item("rename").getAttribute("role")).toBe("menuitem");
    expect(item("delete").dataset["danger"]).toBe("true");
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(q(".rw-ui-menu__heading").textContent).toBe("Recent");
  });

  it("opens at a pointer position", () => {
    render(<Harness />);
    const menu = q('[role="menu"]');
    expect([menu.style.left, menu.style.top]).toEqual(["40px", "64px"]);
  });

  it("selects an item and closes", () => {
    const onPick = vi.fn<(id: string) => void>();
    const onClose = vi.fn<() => void>();
    render(<Harness onPick={onPick} onClose={onClose} />);
    click(item("rename"));
    expect(onPick).toHaveBeenCalledWith("rename");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Escape and on an outside press", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    pointerDown(q("#behind"));
    expect(onClose).toHaveBeenCalledTimes(1);
    render(null);
    render(<Harness onClose={onClose} />);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("walks enabled items with the arrow keys and wraps", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(item("rename"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("move"));
    press("End");
    expect(document.activeElement).toBe(item("delete"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("rename"));
    press("ArrowUp");
    expect(document.activeElement).toBe(item("delete"));
    press("Home");
    expect(document.activeElement).toBe(item("rename"));
  });

  it("opens a submenu with ArrowRight and closes only it with Escape", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    item("move").focus();
    press("ArrowRight");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
    expect(item("move").getAttribute("aria-expanded")).toBe("true");
    expect(item("move").getAttribute("aria-haspopup")).toBe("menu");
    expect(document.activeElement).toBe(item("tube"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("nose"));
    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.activeElement).toBe(item("move"));
  });

  it("closes a submenu with ArrowLeft", () => {
    render(<Harness />);
    item("move").focus();
    press("ArrowRight");
    press("ArrowLeft");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.activeElement).toBe(item("move"));
  });

  it("opens a submenu on hover, and each list is an overlay", () => {
    render(<Harness />);
    act(() => item("move").parentElement?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const lists = document.querySelectorAll('[role="menu"]');
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list.matches(OVERLAY_SELECTOR)).toBe(true);
  });

  it("picks from a submenu and closes the whole menu", () => {
    const onPick = vi.fn<(id: string) => void>();
    const onClose = vi.fn<() => void>();
    render(<Harness onPick={onPick} onClose={onClose} />);
    click(item("move"));
    expect(onClose).not.toHaveBeenCalled();
    click(item("nose"));
    expect(onPick).toHaveBeenCalledWith("nose");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab and returns focus", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MenuButton", () => {
  const items: MenuEntry[] = [
    { id: "on", label: "On", checked: true },
    { id: "off", label: "Off", checked: false, disabled: true },
    { id: "plain", label: "Plain" },
  ];

  it("keeps its test ids and roles", () => {
    render(
      <MenuButton testId="results.plot-menu" label="Plot" items={items}>
        Plot
      </MenuButton>,
    );
    const button = q('[data-testid="results.plot-menu"]');
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(q('[data-testid="results.plot-menu.list"]').matches(OVERLAY_SELECTOR)).toBe(true);
    expect(document.querySelectorAll('[data-testid="results.plot-menu.item"]')).toHaveLength(3);
    expect(q('[data-item="on"]').getAttribute("role")).toBe("menuitemcheckbox");
    expect(q('[data-item="on"]').getAttribute("aria-checked")).toBe("true");
    expect(q('[data-item="off"]').getAttribute("aria-checked")).toBe("false");
    expect(q<HTMLButtonElement>('[data-item="off"]').disabled).toBe(true);
    expect(q('[data-item="plain"]').getAttribute("role")).toBe("menuitem");
  });

  it("toggles from its button without the outside press reopening it", () => {
    render(
      <MenuButton testId="m" label="Menu" items={items}>
        Menu
      </MenuButton>,
    );
    const button = q('[data-testid="m"]');
    click(button);
    pointerDown(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    click(button);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("aligns to the button's right edge when asked", () => {
    render(
      <MenuButton testId="m" label="Menu" align="right" items={items}>
        Menu
      </MenuButton>,
    );
    const button = q('[data-testid="m"]');
    stubRect(button, 300, 20, 40, 30);
    const proto = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 90, right: 200, bottom: 90, x: 0, y: 0, toJSON: () => ({}) });
    click(button);
    expect(q('[role="menu"]').style.left).toBe("140px");
    proto.mockRestore();
  });
});

describe("a pointer anchor with a band", () => {
  it("opens below the row under the pointer, not at the pointer", () => {
    render(<Menu open anchor={{ x: 40, y: 60, band: { top: 50, bottom: 76 } }} label="Row" items={[{ id: "a", label: "A" }]} onClose={() => {}} />);
    const list = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(list.style.left).toBe("40px");
    expect(list.style.top).toBe("80px");
  });
});

describe("placeFloating", () => {
  const view = { width: 1000, height: 800 };
  const anchor = { left: 100, top: 100, right: 140, bottom: 130 };
  const size = { width: 200, height: 300 };

  it("goes below the anchor, start aligned, by default", () => {
    expect(placeFloating(anchor, size, view)).toEqual({ x: 100, y: 134 });
  });

  it("aligns to the anchor's end", () => {
    expect(placeFloating({ ...anchor, left: 400, right: 440 }, size, view, { align: "end" })).toEqual({ x: 240, y: 134 });
  });

  it("flips above when only that side has room", () => {
    expect(placeFloating({ left: 100, top: 600, right: 140, bottom: 630 }, size, view)).toEqual({ x: 100, y: 296 });
  });

  it("stays below when neither side has room, kept inside the window", () => {
    expect(placeFloating({ left: 100, top: 200, right: 140, bottom: 230 }, { width: 200, height: 700 }, view).y).toBe(92);
  });

  it("flips a right-side surface to the left", () => {
    expect(placeFloating({ left: 900, top: 100, right: 940, bottom: 130 }, size, view, { side: "right", gap: 2 })).toEqual({ x: 698, y: 100 });
  });

  it("keeps a pointer menu near the window corner on screen", () => {
    expect(placeFloating({ left: 990, top: 790, right: 990, bottom: 790 }, size, view)).toEqual({ x: 792, y: 486 });
  });
});

describe("caretAt", () => {
  const anchor = { left: 100, top: 200, right: 140, bottom: 232 };

  it("sits on the panel's left edge, level with the anchor", () => {
    expect(caretAt(anchor, { left: 266, top: 200, right: 826, bottom: 760 })).toEqual({ x: 266, y: 216 });
  });

  it("stays clear of the corners when the panel moved up to fit", () => {
    expect(caretAt({ ...anchor, top: 700, bottom: 732 }, { left: 266, top: 100, right: 826, bottom: 660 })).toEqual({ x: 266, y: 646 });
  });

  it("has nothing to point at when the panel covers the anchor", () => {
    expect(caretAt(anchor, { left: 120, top: 200, right: 680, bottom: 760 })).toBeNull();
  });
});

describe("Popover beside a rail", () => {
  /** Like a real DOMRect, its edges are getters on the prototype: a spread of one copies nothing. */
  class Rect {
    constructor(
      readonly x: number,
      readonly y: number,
      readonly width: number,
      readonly height: number,
    ) {}
    get left() {
      return this.x;
    }
    get top() {
      return this.y;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
    toJSON() {
      return {};
    }
  }
  const rect = (left: number, top: number, width: number, height: number) => new Rect(left, top, width, height) as DOMRect;

  function open(windowWidth: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: windowWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    const button = document.createElement("button");
    const rail = document.createElement("aside");
    button.getBoundingClientRect = () => rect(217, 252, 32, 32);
    rail.getBoundingClientRect = () => rect(0, 56, 261, 712);
    const proto = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "dialog" ? rect(0, 0, 560, 400) : rect(0, 0, 0, 0);
    });
    render(
      <Popover open anchor={button} clearOf={rail} side="right" gap={6} caret title="Add part" onClose={() => {}}>
        <p>Body</p>
      </Popover>,
    );
    proto.mockRestore();
    return { surface: document.querySelector<HTMLElement>('[role="dialog"]')!, caret: document.querySelector<HTMLElement>(".rw-ui-popover__caret")! };
  }

  it("opens past the rail, level with its button, with a caret toward it", () => {
    const { surface, caret } = open(1536);
    expect(surface.style.left).toBe("267px");
    expect(surface.style.top).toBe("252px");
    expect(caret.hidden).toBe(false);
    expect(caret.style.left).toBe("267px");
    expect(caret.style.top).toBe("268px");
  });

  it("stays on screen beside the rail at the minimum window width", () => {
    const { surface } = open(1024);
    const left = Number.parseFloat(surface.style.left);
    expect(left).toBe(267);
    expect(left + 560).toBeLessThanOrEqual(1024);
  });
});

describe("placement under View zoom", () => {
  it("divides client coordinates by the surface's CSS zoom", () => {
    // jsdom has no CSS zoom; Electron's Chromium does.
    Object.defineProperty(Element.prototype, "currentCSSZoom", { configurable: true, get: () => 1.25 });
    try {
      stubSurfaceSize(100, 50);
      render(<Menu open anchor={{ x: 500, y: 250 }} label="Zoomed" items={[{ id: "a", label: "A" }]} onClose={() => {}} />);
      const menu = q('[role="menu"]');
      expect([menu.style.left, menu.style.top]).toEqual(["400px", "203.2px"]);
    } finally {
      delete (Element.prototype as { currentCSSZoom?: number }).currentCSSZoom;
    }
  });
});

describe("TextField", () => {
  it("names the input by its label and describes it with unit, hint and error", () => {
    render(<TextField label="Rail length" value="1.5" unit="m" hint="Guide rail" error="Too short" onChange={() => {}} />);
    const input = q<HTMLInputElement>("input");
    expect(q<HTMLLabelElement>("label").htmlFor).toBe(input.id);
    expect(q("label").textContent).toBe("Rail length");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["m", "Guide rail", "Too short"]);
  });

  it("reports typed text as a string and passes input props through", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<TextField label="Name" value="" placeholder="solstice" onChange={onChange} />);
    const input = q<HTMLInputElement>("input");
    expect(input.placeholder).toBe("solstice");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      set?.call(input, "abc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("renders a trailing control", () => {
    render(<TextField label="Location" value="" trailing={<button>Choose...</button>} onChange={() => {}} />);
    expect(q("button").textContent).toBe("Choose...");
  });
});

describe("RadioCardGroup", () => {
  const options = [
    { value: "empty", title: "Empty", description: "No parts yet" },
    { value: "minimal", title: "Minimal", description: "Nose and tube" },
    { value: "locked", title: "Locked", disabled: true },
  ] as const;

  it("is a named group of native radios named by their titles", () => {
    render(<RadioCardGroup label="Template" value="empty" options={options} onChange={() => {}} />);
    const group = q('[role="radiogroup"]');
    expect(document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Template");
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent)).toEqual(["Empty", "Minimal", "Locked"]);
    expect(document.getElementById(radios[0]?.getAttribute("aria-describedby") ?? "")?.textContent).toBe("No parts yet");
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[2]?.disabled).toBe(true);
  });

  it("reports the picked value", () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<RadioCardGroup label="Template" value="empty" options={options} onChange={onChange} />);
    click(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1] as HTMLInputElement);
    expect(onChange).toHaveBeenCalledWith("minimal");
  });
});

describe("StatStrip", () => {
  it("shows values with units, a dash when missing, and its action", () => {
    render(
      <StatStrip
        label="Estimates"
        stats={[
          { id: "isp", label: "Isp", value: "212", unit: "s" },
          { id: "chamber", label: "Chamber diameter", value: null, unit: "mm" },
        ]}
        action={<button>Compute</button>}
      />,
    );
    expect(q("section").getAttribute("aria-label")).toBe("Estimates");
    expect(q('[data-stat="isp"] dd').textContent).toBe("212 s");
    expect(q('[data-stat="chamber"] dd').textContent).toBe("— mm");
    expect(q("button").textContent).toBe("Compute");
  });
});

describe("Banner", () => {
  it("announces by tone and shows its action", () => {
    render(<Banner tone="warning" action={<button>Open design</button>}>Outdated</Banner>);
    expect(q(".rw-ui-banner").getAttribute("role")).toBe("status");
    expect(q(".rw-ui-banner__text").textContent).toBe("Outdated");
    expect(q("button").textContent).toBe("Open design");
    render(<Banner tone="danger">Failed</Banner>);
    expect(q(".rw-ui-banner").getAttribute("role")).toBe("alert");
  });

  it("is an overlay only when floating", () => {
    render(<Banner>Inline</Banner>);
    expect(q(".rw-ui-banner").matches(OVERLAY_SELECTOR)).toBe(false);
    render(<Banner floating>Over the pane</Banner>);
    expect(q(".rw-ui-banner").matches(OVERLAY_SELECTOR)).toBe(true);
  });

  it("dismisses", () => {
    const onDismiss = vi.fn<() => void>();
    render(<Banner onDismiss={onDismiss}>Note</Banner>);
    click(q('[aria-label="Dismiss"]'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ui.css", () => {
  const here = import.meta.dirname;
  const css = readFileSync(resolve(here, "ui.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = parseCustomProperties(readFileSync(resolve(here, "../../../../packages/ui/tokens.css"), "utf8"));

  it("uses tokens only (no literal colours)", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("uses only tokens that exist", () => {
    const local = new Set([...css.matchAll(/(--rw-[\w-]+):/g)].map((m) => m[1]));
    for (const m of css.matchAll(/var\((--rw-[\w-]+)\)/g)) {
      expect(local.has(m[1]) || tokens[m[1] as string] !== undefined, m[1]).toBe(true);
    }
  });

  it("never gives a menu a transform or filter, which would capture its fixed submenu", () => {
    for (const rule of css.matchAll(/([^{}]*\.rw-ui-menu[^{}]*)\{([^}]*)\}/g)) {
      expect(rule[2], rule[1]).not.toMatch(/\b(transform|filter|translate|perspective|contain)\s*:/);
    }
  });
});
