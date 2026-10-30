/**
 * Freeform fin outline editor (R6.4, M2.9): the planform polygon of a
 * `freeform_fin_set` with draggable corner handles, a `+` on every edge to
 * add a point there, Remove point (or Delete) for the selected corner, and
 * the points as unit-aware X / Y fields. The root (y = 0, the body) runs
 * along the bottom; the first and last points stay on it.
 *
 * Every change is a draft edit of `/c/<id>/points` (previewed by rw-wasm,
 * whose RW-E061 outline diagnostics the editor lists); a release, Enter, or
 * leaving a field commits it through `model.patch` unless the outline breaks
 * an RW-E061 rule (outline.ts), in which case the draft stays open, drawn in
 * the error colour, until it is fixed or discarded (Escape).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PatchOp, schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { displayUnit, fromDisplay, toDisplay } from "./fields.ts";
import { canRemove, fromPx, insertPoint, movePoint, outlineFrame, outlineProblem, outlineSource, removePoint, snapPoint, toPx, type OutlineFrame, type Pt } from "./outline.ts";

type Comp = DeepReadonly<schema.EvalComponent>;
type Diagnostic = DeepReadonly<schema.Diagnostic>;

const W = 360;
const H = 170;

export interface FinOutlineEditorProps {
  comp: Comp;
  units: Units;
  /** Diagnostics on the part (the draft preview's while editing). */
  diagnostics: readonly Diagnostic[];
  onEdit: (ops: PatchOp[], label: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}

/** The evaluated outline of a freeform fin set (`[x, y]` m), or null for other parts. */
export function freeformPoints(c: Comp | null | undefined): Pt[] | null {
  if (c == null || c.shape.type !== "freeform_fin_set") return null;
  const pts = (c.shape as { points?: readonly (readonly number[])[] }).points;
  return Array.isArray(pts) ? pts.map((p) => [p[0] ?? 0, p[1] ?? 0] as Pt) : null;
}

const key = (pts: readonly Pt[]) => pts.map((p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`).join(";");

export function FinOutlineEditor({ comp, units, diagnostics, onEdit, onCommit, onDiscard }: FinOutlineEditorProps) {
  const committed = useMemo(() => freeformPoints(comp) ?? [], [comp]);
  const [pts, setPts] = useState<Pt[]>(committed);
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  /** The frame is frozen while dragging so the outline does not rescale under the pointer. */
  const [frame, setFrame] = useState<OutlineFrame>(() => outlineFrame(committed, W, H));
  const dirty = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);

  // Follow the model (commits, other writers, undo) unless a gesture is in progress.
  useEffect(() => {
    if (drag !== null) return;
    if (!dirty.current || key(committed) === key(pts)) {
      dirty.current = false;
      setPts(committed);
      setFrame(outlineFrame(committed, W, H));
    }
  }, [key(committed)]);
  useEffect(() => {
    setSel(null);
    dirty.current = false;
    setPts(committed);
    setFrame(outlineFrame(committed, W, H));
  }, [comp.id]);

  const problem = outlineProblem(pts);
  // The draft's preview, check, and dry run can each report the same rule: list it once.
  const e061 = diagnostics
    .filter((d) => d.code === "RW-E061" && (d.path === `/c/${comp.id}/points` || (d.path ?? "").startsWith(`/c/${comp.id}/points/`)))
    .filter((d, i, all) => all.findIndex((x) => x.path === d.path && x.message === d.message) === i);
  const label = `Set ${comp.name} outline`;

  /** Draft edit of the outline; `commit` writes it when the outline is valid. */
  const write = (next: Pt[], commit: boolean) => {
    setPts(next);
    dirty.current = true;
    onEdit([{ op: "replace", path: `/c/${comp.id}/points`, value: outlineSource(next, units) as never }], label);
    if (commit && outlineProblem(next) === null) {
      dirty.current = false;
      onCommit();
    }
  };

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current?.getBoundingClientRect();
    const sx = r ? ((e.clientX - r.left) / Math.max(1, r.width)) * W : 0;
    const sy = r ? ((e.clientY - r.top) / Math.max(1, r.height)) * H : 0;
    return snapPoint(fromPx(frame, sx, sy), units);
  };

  const u = displayUnit("length", units);
  const shown = pts.map((p) => toPx(frame, p));
  const poly = shown.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const bad = problem !== null || e061.length > 0;
  /** Escape: back to the committed outline, draft discarded. */
  const reset = () => {
    dirty.current = false;
    setPts(committed);
    setFrame(outlineFrame(committed, W, H));
    onDiscard();
  };
  const remove = (i: number) => {
    if (!canRemove(pts, i)) return;
    write(removePoint(pts, i), true);
    setSel(null);
  };

  return (
    <div className="rw-outline" data-testid="outline" data-part={comp.id} data-points={pts.length} data-invalid={bad ? "true" : undefined}>
      <div className="rw-outline__head">
        <span className="rw-outline__title">Fin outline</span>
        <span className="rw-outline__hint">Drag a corner · + adds a point · Delete removes the selected one</span>
      </div>
      <div className="rw-outline__body">
        <svg
          ref={svg}
          className="rw-outline__svg"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="application"
          aria-label="Fin outline editor"
          tabIndex={0}
          data-testid="outline.canvas"
          onKeyDown={(e) => {
            if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
              e.preventDefault();
              remove(sel);
            } else if (e.key === "Escape") {
              reset();
            }
          }}
          onPointerMove={(e) => {
            if (drag === null) return;
            const next = movePoint(pts, drag, local(e));
            setPts(next);
          }}
          onPointerUp={() => {
            if (drag === null) return;
            const i = drag;
            setDrag(null);
            if (key(pts) !== key(committed)) write(pts, true);
            setSel(i);
          }}
        >
          <line className="rw-outline__root" x1={4} x2={W - 4} y1={frame.oy} y2={frame.oy} />
          <text className="rw-outline__root-label" x={6} y={frame.oy + 16}>
            Root (body)
          </text>
          <polygon className="rw-outline__shape" data-testid="outline.shape" points={poly} />
          {problem?.edges.map((k) => {
            const a = shown[k];
            const b = shown[(k + 1) % shown.length];
            return a && b ? <line key={`bad-${k}`} className="rw-outline__bad-edge" data-testid="outline.bad-edge" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} /> : null;
          })}
          {shown.map((a, k) => {
            const b = shown[(k + 1) % shown.length]!;
            if (k === shown.length - 1) return null; // the closing edge runs along the root
            const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            return (
              <g
                key={`add-${k}`}
                className="rw-outline__add"
                data-testid="outline.add"
                data-edge={k}
                role="button"
                aria-label={`Add a point between ${k + 1} and ${k + 2}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const next = insertPoint(pts, k, snapPoint([(pts[k]![0] + pts[k + 1]![0]) / 2, (pts[k]![1] + pts[k + 1]![1]) / 2], units));
                  write(next, true);
                  setSel(k + 1);
                }}
              >
                <circle cx={mx} cy={my} r={6} />
                <path d={`M${mx - 3},${my} H${mx + 3} M${mx},${my - 3} V${my + 3}`} />
              </g>
            );
          })}
          {shown.map(([x, y], k) => (
            <circle
              key={`pt-${k}`}
              className="rw-outline__point"
              data-testid="outline.point"
              data-index={k}
              data-selected={sel === k ? "true" : undefined}
              data-root={k === 0 || k === pts.length - 1 ? "true" : undefined}
              data-bad={problem?.points.includes(k) ? "true" : undefined}
              cx={x}
              cy={y}
              r={sel === k ? 6.5 : 5}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture?.(e.pointerId);
                setSel(k);
                setDrag(k);
                setFrame(outlineFrame(pts, W, H));
              }}
            />
          ))}
        </svg>
        <div className="rw-outline__table" role="table" aria-label="Outline points">
          <div className="rw-outline__row rw-outline__row--head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">X ({u.unit})</span>
            <span role="columnheader">Y ({u.unit})</span>
            <span />
          </div>
          {pts.map((p, k) => (
            <div key={k} className="rw-outline__row" role="row" data-testid="outline.row" data-index={k} data-selected={sel === k ? "true" : undefined} onClick={() => setSel(k)}>
              <span>{k + 1}</span>
              <CoordInput label={`Point ${k + 1} X`} testid="outline.x" value={toDisplay(p[0], "length", units)} onDone={(v) => write(movePoint(pts, k, [fromDisplay(v, "length", units), p[1]]), true)} onCancel={reset} />
              <CoordInput label={`Point ${k + 1} Y`} testid="outline.y" value={toDisplay(p[1], "length", units)} disabled={k === 0 || k === pts.length - 1} onDone={(v) => write(movePoint(pts, k, [p[0], fromDisplay(v, "length", units)]), true)} onCancel={reset} />
              <button type="button" className="rw-icon-button" data-testid="outline.remove" data-index={k} aria-label={`Remove point ${k + 1}`} disabled={!canRemove(pts, k)} onClick={() => remove(k)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
      {(problem !== null || e061.length > 0) && (
        <ul className="rw-editor__diags rw-outline__diags" data-testid="outline.validation">
          {problem !== null && (
            <li data-severity="error" data-local="true">
              <Icon name="alert" size={14} /> {problem.message} Not saved: fix the outline, or press Escape to discard.
            </li>
          )}
          {e061.map((d, i) => (
            <li key={`e061-${i}`} data-severity={d.severity} data-code={d.code} title={d.hint ?? d.code}>
              <Icon name="alert" size={14} /> {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CoordInput({ label, testid, value, disabled, onDone, onCancel }: { label: string; testid: string; value: string; disabled?: boolean; onDone: (v: number) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  return (
    <input
      className="rw-outline__input"
      aria-label={label}
      data-testid={testid}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        setEditing(false);
        const n = Number(text.trim());
        if (text.trim() !== "" && Number.isFinite(n) && text.trim() !== value) onDone(n);
        else setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(value);
          setEditing(false);
          onCancel();
        }
      }}
    />
  );
}
