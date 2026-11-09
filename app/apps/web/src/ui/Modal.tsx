/**
 * A centred dialog over a dimmed window. The scrim is marked as an overlay as
 * well as the dialog, so the desktop app's agent pane cannot paint over the
 * dimmed area. Focus stays inside until it closes.
 */
import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { OVERLAY_EVENTS } from "./Popover.tsx";
import { useDismiss, useFocusScope } from "./useDismiss.tsx";
import "./ui.css";

let openModals = 0;
const closedListeners = new Set<() => void>();

/**
 * True while any modal is on screen, wherever in the tree it lives. A native
 * accelerator or a request from main arrives past the scrim, so what those run
 * must ask rather than trust that nothing else is open.
 */
export const anyModalOpen = (): boolean => openModals > 0;

/** Called when the last open modal goes away. */
export function onModalsClosed(listener: () => void): () => void {
  closedListeners.add(listener);
  return () => void closedListeners.delete(listener);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading, which also names the dialog. */
  title: string;
  /** Buttons along the bottom, right aligned. */
  footer?: ReactNode;
  /** Close on Escape (default true); turn off while work is in flight. */
  dismissOnEscape?: boolean | undefined;
  /** Close on a press on the scrim (default true); turn off while work is in flight. */
  dismissOnOutside?: boolean | undefined;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}

function ModalSurface({ onClose, title, footer, dismissOnEscape, dismissOnOutside, initialFocus, className, testId, children }: Omit<ModalProps, "open">) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    openModals++;
    return () => {
      openModals--;
      if (openModals === 0) for (const listener of [...closedListeners]) listener();
    };
  }, []);
  useDismiss({ open: true, surfaceRef, onDismiss: onClose, escape: dismissOnEscape, outside: dismissOnOutside, trap: true });
  useFocusScope(true, surfaceRef, initialFocus);
  return createPortal(
    <div className="rw-ui-scrim" data-rw-overlay="" {...OVERLAY_EVENTS}>
      <div ref={surfaceRef} className={className ? `rw-ui-modal ${className}` : "rw-ui-modal"} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={testId}>
        <h2 id={titleId} className="rw-ui-modal__title">
          {title}
        </h2>
        <div className="rw-ui-modal__body">{children}</div>
        {footer !== undefined && <footer className="rw-ui-modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Modal({ open, ...rest }: ModalProps) {
  return open ? <ModalSurface {...rest} /> : null;
}
