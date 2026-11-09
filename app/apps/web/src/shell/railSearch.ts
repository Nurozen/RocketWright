/**
 * The left rail's Search (R3.6): the rail owns the text box, the page-owned
 * lists under it read the text here to narrow themselves.
 */
import { createContext, useContext } from "react";

const RailSearchContext = createContext("");

export const RailSearchProvider = RailSearchContext.Provider;

/** The rail's search text, trimmed and lowercased; `""` shows everything. */
export function useRailSearch(): string {
  return useContext(RailSearchContext);
}

export function matchesRailSearch(label: string, query: string): boolean {
  return query === "" || label.toLowerCase().includes(query);
}

/** Shown in place of a list when the search text matches none of its rows. */
export const NO_RAIL_MATCHES = "Nothing matches that search.";
