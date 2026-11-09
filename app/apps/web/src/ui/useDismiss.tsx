/**
 * Layered dismissal and focus for the overlay primitives.
 *
 * Open overlays form one stack. Escape, outside pointer presses and the focus
 * trap act only on the top layer, so a menu opened inside a modal closes
 * without closing the modal. One set of document listeners serves the stack,
 * which means one event can never dismiss two layers.
 */
import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "escape" | "outside";

export interface DismissOptions {
  open: boolean;
  /** The surface; a press inside it is not outside. */
  surfaceRef: RefObject<HTMLElement | null>;
  onDismiss: (reason: DismissReason) => void;
  /** More elements that do not count as outside, such as the trigger that toggles the overlay. */
  ignore?: (() => readonly (Element | null | undefined)[]) | undefined;
  /** Close on Escape (default true). */
  escape?: boolean | undefined;
  /** Close on a press outside the surface (default true). */
  outside?: boolean | undefined;
  /** Keep Tab and programmatic focus inside the surface (default false). */
  trap?: boolean | undefined;
}

type Layer = RefObject<DismissOptions & { order: number }>;

const layers: Layer[] = [];

/** Open order, taken during render: parents render before children, but their effects run after. */
let nextOrder = 0;

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keyboard-reachable elements inside `surface`, in document order. */
export function tabbables(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.closest("[hidden], [inert]") === null);
}

/** Where focus lands on open: the first control that is not the close button, else the surface. */
function firstFocus(surface: HTMLElement): HTMLElement {
  return tabbables(surface).find((el) => !el.hasAttribute("data-rw-close")) ?? surface;
}

function trapTab(e: KeyboardEvent, surface: HTMLElement): void {
  const list = tabbables(surface);
  const first = list[0];
  const last = list.at(-1);
  if (first === undefined || last === undefined) {
    e.preventDefault();
    surface.focus();
    return;
  }
  const active = document.activeElement;
  if (active === null || !surface.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === surface)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const top = layers.at(-1)?.current;
  if (top === undefined || e.defaultPrevented) return;
  if (e.key === "Escape") {
    if (e.isComposing || top.escape === false) return;
    e.preventDefault();
    top.onDismiss("escape");
  } else if (e.key === "Tab" && top.trap === true && top.surfaceRef.current !== null) {
    trapTab(e, top.surfaceRef.current);
  }
}

function onPointerDown(e: PointerEvent): void {
  const top = layers.at(-1)?.current;
  const target = e.target;
  if (top === undefined || top.outside === false || !(target instanceof Node)) return;
  const surface = top.surfaceRef.current;
  if (surface === null || surface.contains(target)) return;
  if (top.ignore?.().some((el) => el?.contains(target) === true) === true) return;
  top.onDismiss("outside");
}

function onFocusIn(e: FocusEvent): void {
  const top = layers.at(-1)?.current;
  const surface = top?.surfaceRef.current ?? null;
  if (top?.trap !== true || surface === null || !(e.target instanceof Node) || surface.contains(e.target)) return;
  firstFocus(surface).focus();
}

function pushLayer(layer: Layer): void {
  if (layers.length === 0) {
    document.addEventListener("keydown", onKeyDown);
    // Capture, so a page handler that stops propagation cannot keep the overlay open.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
  }
  layers.push(layer);
  layers.sort((a, b) => a.current.order - b.current.order);
}

function removeLayer(layer: Layer): void {
  const at = layers.indexOf(layer);
  if (at >= 0) layers.splice(at, 1);
  if (layers.length === 0) {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn);
  }
}

/** Puts the surface on the overlay stack while `open`. A handler that calls `preventDefault` on Escape keeps it open. */
export function useDismiss(options: DismissOptions): void {
  const wasOpen = useRef(false);
  const order = useRef(0);
  if (options.open && !wasOpen.current) order.current = ++nextOrder;
  wasOpen.current = options.open;
  const layer = useRef({ ...options, order: order.current });
  layer.current = { ...options, order: order.current };
  useEffect(() => {
    if (!options.open) return;
    pushLayer(layer);
    return () => removeLayer(layer);
  }, [options.open]);
}

/** Moves focus into the surface on open and returns it to where it was on close. */
export function useFocusScope(open: boolean, surfaceRef: RefObject<HTMLElement | null>, initialFocus?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const surface = surfaceRef.current;
    // A child overlay opened in the same commit has already taken focus; leave it there.
    const at = layers.findIndex((l) => l.current.surfaceRef === surfaceRef);
    const covered = at >= 0 && at < layers.length - 1;
    if (surface !== null && !covered) (initialFocus?.current ?? firstFocus(surface)).focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
}
