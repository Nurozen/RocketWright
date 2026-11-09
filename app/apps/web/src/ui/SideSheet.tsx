/**
 * A panel along the right edge, below the header. The page behind stays in
 * use, so a press outside does not close it unless asked, and an edit in
 * progress survives a stray click.
 */
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CloseButton, OVERLAY_EVENTS } from "./Popover.tsx";
import { useDismiss, useFocusScope } from "./useDismiss.tsx";
import "./ui.css";

export interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading, which also names the dialog. */
  title: string;
  /** Buttons pinned to the bottom. */
  footer?: ReactNode;
  /** Close on a press outside the sheet (default false). */
  dismissOnOutside?: boolean | undefined;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}

function SideSheetSurface({ onClose, title, footer, dismissOnOutside = false, initialFocus, className, testId, children }: Omit<SideSheetProps, "open">) {
  const surfaceRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDismiss({ open: true, surfaceRef, onDismiss: onClose, outside: dismissOnOutside });
  useFocusScope(true, surfaceRef, initialFocus);
  return createPortal(
    <aside ref={surfaceRef} className={className ? `rw-ui-sheet ${className}` : "rw-ui-sheet"} role="dialog" aria-labelledby={titleId} tabIndex={-1} data-testid={testId} {...OVERLAY_EVENTS}>
      <header className="rw-ui-sheet__head">
        <h2 id={titleId} className="rw-ui-sheet__title">
          {title}
        </h2>
        <CloseButton onClick={onClose} />
      </header>
      <div className="rw-ui-sheet__body">{children}</div>
      {footer !== undefined && <footer className="rw-ui-sheet__footer">{footer}</footer>}
    </aside>,
    document.body,
  );
}

export function SideSheet({ open, ...rest }: SideSheetProps) {
  return open ? <SideSheetSurface {...rest} /> : null;
}
