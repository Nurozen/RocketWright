/**
 * The Add part popover's Parts library tab: every built-in preset, searched and
 * filtered by the sidecar and paged in as the list scrolls. Only the rows in
 * view exist in the page, so 3,449 parts cost what a screenful costs.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { type DeepReadonly } from "../../state/index.ts";
import { partLabel, type PartKind } from "../../state/ops/parts.ts";
import { needLabel, presetInfo, presetKind } from "./presets.ts";

type Part = DeepReadonly<schema.EvalComponent>;
type LibItem = DeepReadonly<schema.LibItem>;

export type PresetQuery = { kind: "preset"; limit: number; offset: number; query?: string; manufacturer?: string; component_type?: string };
export type PresetSearch = (query: PresetQuery) => Promise<schema.LibrarySearchOut>;

export const ROW_HEIGHT = 52;
export const VIEW_HEIGHT = 312;
const OVERSCAN = 3;
export const PAGE_SIZE = 100;
export const SEARCH_DEBOUNCE_MS = 200;

interface Filters {
  query: string;
  manufacturer: string;
  componentType: string;
}

interface Loaded {
  pages: ReadonlyMap<number, readonly LibItem[]>;
  total: number | null;
  facets: schema.LibraryFacets | null;
  error: string | null;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function toQuery(f: Filters, page: number): PresetQuery {
  return {
    kind: "preset",
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(f.query.trim() !== "" ? { query: f.query.trim() } : {}),
    ...(f.manufacturer !== "" ? { manufacturer: f.manufacturer } : {}),
    ...(f.componentType !== "" ? { component_type: f.componentType } : {}),
  };
}

/** Pages of the current search. `first` to `last` are the rows wanted now. */
function usePresetPages(search: PresetSearch, filters: Filters, first: number, last: number) {
  const [state, setState] = useState<Loaded>({ pages: new Map(), total: null, facets: null, error: null });
  const generation = useRef(0);
  const fetching = useRef(new Set<number>());

  useEffect(() => {
    generation.current++;
    fetching.current.clear();
    setState((s) => ({ pages: new Map(), total: null, facets: s.facets, error: null }));
  }, [filters]);

  const firstPage = Math.floor(first / PAGE_SIZE);
  const lastPage = Math.floor(Math.max(first, last - 1) / PAGE_SIZE);
  useEffect(() => {
    if (state.error !== null) return;
    for (let page = firstPage; page <= lastPage; page++) {
      if (state.pages.has(page) || fetching.current.has(page)) continue;
      fetching.current.add(page);
      const gen = generation.current;
      search(toQuery(filters, page)).then(
        (out) => {
          if (gen !== generation.current) return;
          fetching.current.delete(page);
          setState((s) => ({ ...s, pages: new Map(s.pages).set(page, out.items), total: out.total, facets: out.facets }));
        },
        (e: unknown) => {
          if (gen !== generation.current) return;
          fetching.current.delete(page);
          setState((s) => ({ ...s, error: message(e) }));
        },
      );
    }
  }, [search, filters, firstPage, lastPage, state.pages, state.error]);

  return { ...state, retry: () => setState((s) => ({ ...s, error: null })) };
}

function FilterSelect({ label, value, all, facets, optionLabel, onChange }: {
  label: string;
  value: string;
  all: string;
  facets: readonly schema.FacetCount[];
  optionLabel: (value: string) => string;
  onChange: (value: string) => void;
}) {
  // A narrowed search can drop the chosen value from the facets; the control must still show it.
  const options = value === "" || facets.some((f) => f.value === value) ? facets : [{ value, count: 0 }, ...facets];
  const id = useId();
  // `htmlFor`, not a wrapping label: a wrapped select's options would join its accessible name.
  return (
    <div className="rw-parts__filter">
      <label htmlFor={id}>{label}</label>
      <span className="rw-select rw-select--native">
        <select id={id} value={value} onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.currentTarget.value)}>
          <option value="">{all}</option>
          {options.map((f) => (
            <option key={f.value} value={f.value}>
              {`${optionLabel(f.value)} (${f.count.toLocaleString("en-US")})`}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={14} />
      </span>
    </div>
  );
}

export interface PartsLibraryProps {
  search: PresetSearch;
  /** Why this kind cannot be added right now, or null when it can. */
  reasonFor: (kind: PartKind) => string | null;
  /** The part whose geometry a preset can replace: the one selected part. */
  selected: Part | null;
  busy: boolean;
  onAdd: (item: LibItem) => void;
  onReplace: (item: LibItem, part: Part) => void;
}

export function PartsLibrary({ search, reasonFor, selected, busy, onAdd, onReplace }: PartsLibraryProps) {
  const searchId = useId();
  const [typed, setTyped] = useState("");
  const [filters, setFilters] = useState<Filters>({ query: "", manufacturer: "", componentType: "" });
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Typing settles before it searches; the two lists apply at once.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === typed ? f : { ...f, query: typed })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    setScrollTop(0);
    if (listRef.current !== null) listRef.current.scrollTop = 0;
  }, [filters]);

  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastVisible = Math.ceil((scrollTop + VIEW_HEIGHT) / ROW_HEIGHT) + OVERSCAN;
  const { pages, total, facets, error, retry } = usePresetPages(search, filters, firstVisible, lastVisible);
  const count = total ?? 0;
  const end = Math.min(count, lastVisible);

  const rows = [];
  for (let i = firstVisible; i < end; i++) {
    const item = pages.get(Math.floor(i / PAGE_SIZE))?.[i % PAGE_SIZE];
    rows.push(item === undefined ? <PendingRow key={`pending-${i}`} index={i} count={count} /> : <PresetRow key={item.id} index={i} count={count} item={item} reasonFor={reasonFor} selected={selected} busy={busy} onAdd={onAdd} onReplace={onReplace} />);
  }

  return (
    <div className="rw-parts" data-testid="add-part.library">
      <div className="rw-parts__search">
        <label htmlFor={searchId}>Search parts</label>
        <input id={searchId} type="search" className="rw-ui-field__input" placeholder="Name or part number" value={typed} onChange={(e) => setTyped(e.currentTarget.value)} />
      </div>
      <div className="rw-parts__filters">
        <FilterSelect label="Manufacturer" value={filters.manufacturer} all="All manufacturers" facets={facets?.manufacturers ?? []} optionLabel={(v) => v} onChange={(manufacturer) => setFilters((f) => ({ ...f, manufacturer }))} />
        <FilterSelect label="Type" value={filters.componentType} all="All types" facets={facets?.component_types ?? []} optionLabel={partLabel} onChange={(componentType) => setFilters((f) => ({ ...f, componentType }))} />
      </div>
      {error !== null ? (
        <div className="rw-parts__status" role="alert">
          <span>{error}</span>
          <button type="button" className="rw-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : (
        <p className="rw-parts__status" role="status" data-testid="add-part.library-count">
          {total === null ? "Searching…" : total === 1 ? "1 part" : `${total.toLocaleString("en-US")} parts`}
        </p>
      )}
      <div ref={listRef} className="rw-parts__list" style={{ height: VIEW_HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="add-part.library-list">
        {total === 0 && error === null ? (
          <p className="rw-parts__empty">No parts match. Clear a filter or change the search.</p>
        ) : (
          <div role="list" aria-label="Parts" style={{ position: "relative", height: count * ROW_HEIGHT }}>
            {rows}
          </div>
        )}
      </div>
    </div>
  );
}

function rowStyle(index: number) {
  return { position: "absolute", top: index * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT } as const;
}

function PendingRow({ index, count }: { index: number; count: number }) {
  return (
    <div role="listitem" aria-setsize={count} aria-posinset={index + 1} className="rw-parts__row rw-parts__row--pending" style={rowStyle(index)}>
      Loading…
    </div>
  );
}

function PresetRow({ index, count, item, reasonFor, selected, busy, onAdd, onReplace }: Omit<PartsLibraryProps, "search"> & { index: number; count: number; item: LibItem }) {
  const kind = presetKind(item);
  const info = presetInfo(item);
  const reason = kind === null ? "This item is not a part." : reasonFor(kind);
  const canReplace = selected !== null && kind !== null && selected.shape.type === kind;
  const meta = [info.manufacturer, info.description || partLabel(kind ?? ""), info.needs.length > 0 ? `Adds default ${info.needs.map(needLabel).join(", ")}` : ""].filter((t) => t !== "").join(" · ");
  return (
    <div role="listitem" aria-setsize={count} aria-posinset={index + 1} className="rw-parts__row" style={rowStyle(index)}>
      <div className="rw-parts__text">
        <span className="rw-parts__name" title={item.name}>
          {item.name}
        </span>
        <span className="rw-parts__meta" title={meta}>
          {meta}
        </span>
      </div>
      <div className="rw-parts__actions" role="group" aria-label={item.name}>
        {canReplace && (
          <button type="button" className="rw-button" disabled={busy} title={`Give ${selected.name} this part's size`} onClick={() => onReplace(item, selected)}>
            Replace geometry
          </button>
        )}
        <button type="button" className="rw-button" disabled={busy || reason !== null} title={reason ?? undefined} onClick={() => onAdd(item)}>
          Add
        </button>
      </div>
    </div>
  );
}
