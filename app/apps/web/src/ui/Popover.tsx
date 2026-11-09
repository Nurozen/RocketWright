/**
 * A floating panel anchored to an element or a pointer position, and the
 * placement code the menus share. The panel is `role="dialog"`, so the desktop
 * app takes the agent pane out of the way when it overlaps (`OVERLAY_SELECTOR`
 * in `embed/bridge.ts`).
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../shell/Icon.tsx";
import { useDismiss, useFocusScope } from "./useDismiss.tsx";
import "./ui.css";

/** An element to sit next to, or a pointer position in client coordinates. */
export type Anchor = HTMLElement | { x: number; y: number };

export type PlacementSide = "bottom" | "right";
export type PlacementAlign = "start" | "end";

export interface Placement {
  side?: PlacementSide | undefined;
  align?: PlacementAlign | undefined;
  /** Space between anchor and surface, in px. */
  gap?: number | undefined;
  /** Smallest distance from the window edge, in px. */
  margin?: number | undefined;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clamp(value: number, size: number, limit: number, margin: number): number {
  return Math.max(margin, Math.min(value, limit - size - margin));
}

/** Top-left of a surface next to `anchor`: flipped when only the other side has room, then kept inside the window. */
export function placeFloating(anchor: Box, surface: { width: number; height: number }, view: { width: number; height: number }, placement: Placement = {}): { x: number; y: number } {
  const { side = "bottom", align = "start", gap = 4, margin = 8 } = placement;
  if (side === "right") {
    const after = anchor.right + gap;
    const before = anchor.left - gap - surface.width;
    const flip = after + surface.width > view.width - margin && before >= margin;
    return { x: clamp(flip ? before : after, surface.width, view.width, margin), y: clamp(anchor.top, surface.height, view.height, margin) };
  }
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - surface.height;
  const flip = below + surface.height > view.height - margin && above >= margin;
  const x = align === "end" ? anchor.right - surface.width : anchor.left;
  return { x: clamp(x, surface.width, view.width, margin), y: clamp(flip ? above : below, surface.height, view.height, margin) };
}

/**
 * Where a surface's caret goes: on its left edge, level with the anchor and
 * clear of the rounded corners. Null when the surface is not to the anchor's
 * right (flipped, or pushed back over it on a narrow window), where a caret on
 * that edge would point at nothing.
 */
export function caretAt(anchor: Box, surface: Box, inset = 14): { x: number; y: number } | null {
  if (surface.left < anchor.right) return null;
  const level = (anchor.top + anchor.bottom) / 2;
  return { x: surface.left, y: Math.max(surface.top + inset, Math.min(level, surface.bottom - inset)) };
}

export interface AnchoredOptions extends Placement {
  /** With `side: "right"`, the surface starts past this element's right edge too (a rail it must not cover). */
  clearOf?: HTMLElement | null | undefined;
  /** Moved to `caretAt`, and hidden when it returns null. */
  caret?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Keeps a `position: fixed` surface next to its anchor as it, the page or the
 * window changes. Rects are painted pixels, but `left` and `top` are multiplied
 * by CSS `zoom` (View zoom), so the result is divided by the surface's zoom.
 */
export function useAnchoredPosition(surfaceRef: RefObject<HTMLElement | null>, anchor: () => Anchor | null, placement?: AnchoredOptions): void {
  const place = (): void => {
    const surface = surfaceRef.current;
    const at = anchor();
    if (surface === null || at === null) return;
    const margin = placement?.margin ?? 8;
    const zoom = surface.currentCSSZoom || 1;
    surface.style.maxHeight = `${(window.innerHeight - 2 * margin) / zoom}px`;
    const box: Box = at instanceof HTMLElement ? at.getBoundingClientRect() : { left: at.x, top: at.y, right: at.x, bottom: at.y };
    const clear = placement?.clearOf?.getBoundingClientRect().right;
    const { width, height } = surface.getBoundingClientRect();
    const { x, y } = placeFloating(clear === undefined ? box : { left: box.left, top: box.top, bottom: box.bottom, right: Math.max(box.right, clear) }, { width, height }, { width: window.innerWidth, height: window.innerHeight }, placement);
    surface.style.left = `${x / zoom}px`;
    surface.style.top = `${y / zoom}px`;
    const caret = placement?.caret?.current;
    if (caret !== null && caret !== undefined) {
      const point = caretAt(box, { left: x, top: y, right: x + width, bottom: y + height });
      caret.hidden = point === null;
      if (point !== null) {
        caret.style.left = `${point.x / zoom}px`;
        caret.style.top = `${point.y / zoom}px`;
      }
    }
  };
  const latest = useRef(place);
  latest.current = place;
  // Every render, before paint and before the overlay scanner reads the rect.
  useLayoutEffect(place);
  useEffect(() => {
    const update = (): void => latest.current();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const surface = surfaceRef.current;
    const observer = typeof ResizeObserver === "undefined" || surface === null ? null : new ResizeObserver(update);
    if (surface !== null) observer?.observe(surface);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, []);
}

const stop = (e: { stopPropagation: () => void }): void => e.stopPropagation();

/**
 * Keeps pointer events on a portalled surface from reaching React ancestors,
 * such as the table row or tree row that opened it. Keyboard events stay out of
 * this: the dismissal stack listens for them on the document.
 */
export const OVERLAY_EVENTS = { onClick: stop, onDoubleClick: stop, onContextMenu: stop, onPointerDown: stop };

/** The close button in an overlay header; focus skips it on open. */
export function CloseButton({ onClick, label = "Close" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="rw-icon-button" aria-label={label} data-rw-close="" onClick={onClick}>
      <Icon name="close" size={18} />
    </button>
  );
}

export interface PopoverProps {
  open: boolean;
  anchor: Anchor | null;
  onClose: () => void;
  /** Visible heading, which also names the dialog. Adds a close button. */
  title?: string | undefined;
  /** Accessible name when there is no visible `title`. */
  label?: string | undefined;
  side?: PlacementSide | undefined;
  align?: PlacementAlign | undefined;
  /** Space between anchor and panel, in px. */
  gap?: number | undefined;
  /** With `side="right"`, also start past this element's right edge. */
  clearOf?: HTMLElement | null | undefined;
  /** Draw a small pointer from the panel toward the anchor (`side="right"`). */
  caret?: boolean | undefined;
  /** Close on a press outside the panel (default true). */
  dismissOnOutside?: boolean | undefined;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}

function PopoverSurface({ anchor, onClose, title, label, side, align, gap, clearOf, caret, dismissOnOutside, initialFocus, className, testId, children }: Omit<PopoverProps, "open">) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDismiss({ open: true, surfaceRef, onDismiss: onClose, outside: dismissOnOutside, ignore: () => (anchor instanceof HTMLElement ? [anchor] : []) });
  useFocusScope(true, surfaceRef, initialFocus);
  useAnchoredPosition(surfaceRef, () => anchor, { side, align, gap, clearOf, caret: caretRef });
  return createPortal(
    <>
      <div
        ref={surfaceRef}
        className={className ? `rw-ui-popover ${className}` : "rw-ui-popover"}
        role="dialog"
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-label={title === undefined ? label : undefined}
        tabIndex={-1}
        data-testid={testId}
        {...OVERLAY_EVENTS}
      >
        {title !== undefined && (
          <header className="rw-ui-popover__head">
            <h2 id={titleId} className="rw-ui-popover__title">
              {title}
            </h2>
            <CloseButton onClick={onClose} />
          </header>
        )}
        {children}
      </div>
      {/* A sibling, not a child: the panel scrolls, so anything past its edge would be clipped. */}
      {caret === true && <div ref={caretRef} className="rw-ui-popover__caret" aria-hidden="true" />}
    </>,
    document.body,
  );
}

export function Popover({ open, ...rest }: PopoverProps) {
  return open ? <PopoverSurface {...rest} /> : null;
}
