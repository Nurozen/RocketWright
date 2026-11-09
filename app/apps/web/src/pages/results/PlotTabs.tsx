/**
 * The Results plot tabs on one row. Tabs that do not fit, beside the Simulation
 * conditions sheet or in a narrow window, move into a More menu; the active
 * tab always stays on the row. Every tab stays mounted so its width can be
 * measured, and a hidden one leaves the accessibility tree.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { PLOT_TABS, type PlotTabId } from "../../plots/quantities.ts";
import { MenuButton } from "../../ui/Menu.tsx";
import { overflowTabs } from "./model.ts";
import { ResultsIcon } from "./ResultsIcon.tsx";

const widthOf = (el: Element): number => el.getBoundingClientRect().width;

export function PlotTabs({ active, onSelect }: { active: PlotTabId; onSelect: (id: PlotTabId) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<readonly number[]>([]);
  const activeIndex = PLOT_TABS.findIndex((t) => t.id === active);

  useLayoutEffect(() => {
    const row = bar.current;
    const strip = list.current;
    if (row === null || strip === null) return;
    const measure = () => {
      const available = row.getBoundingClientRect().right - strip.getBoundingClientRect().left;
      const next = overflowTabs([...strip.children].map(widthOf), available, more.current === null ? 0 : widthOf(more.current), activeIndex);
      setHidden((cur) => (cur.join() === next.join() ? cur : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The tabs too: their widths change with the font loading and the page's container queries.
    const observer = new ResizeObserver(measure);
    for (const el of [row, ...strip.children]) observer.observe(el);
    return () => observer.disconnect();
  }, [activeIndex]);

  const overflowing = hidden.length > 0;
  return (
    <div className="rw-plot-bar" ref={bar}>
      <div className="rw-plot-tabs" role="tablist" aria-label="Plot" ref={list}>
        {PLOT_TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="rw-tab rw-plot-tab"
            data-testid="plot.tab"
            data-tab={t.id}
            aria-selected={t.id === active}
            data-overflow={hidden.includes(i) ? "more" : undefined}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Keyed so a menu left open closes when the row regains room for every tab. */}
      <div key={overflowing ? "more" : "none"} className="rw-plot-more" data-overflow={overflowing ? "more" : "none"} ref={more}>
        <MenuButton
          testId="plot.more"
          label="More plots"
          className="rw-tab rw-plot-tab rw-plot-more__button"
          align="right"
          items={hidden.flatMap((i) => {
            const t = PLOT_TABS[i];
            return t === undefined ? [] : [{ id: t.id, label: t.label, onSelect: () => onSelect(t.id) }];
          })}
        >
          More
          <ResultsIcon name="chevron-down" size={14} />
        </MenuButton>
      </div>
    </div>
  );
}
