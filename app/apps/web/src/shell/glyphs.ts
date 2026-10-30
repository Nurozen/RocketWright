/**
 * Interface glyphs the brand icon set does not cover (settings, help, menus,
 * composer). Hand-authored for RocketWright in the same style as
 * public/brand/icons: 20x20 viewBox, 1.5 px currentColor stroke, round caps.
 */
export const GLYPH_BODIES = {
  "chevron-down": '<path d="M6 8l4 4 4-4"/>',
  "chevron-right": '<path d="M8 6l4 4-4 4"/>',
  "chevron-up": '<path d="M6 12l4-4 4 4"/>',
  /** Revert (a curved arrow back). */
  undo: '<path d="M7 5L3.5 8.5 7 12"/><path d="M3.5 8.5H12a4.5 4.5 0 0 1 0 9H8"/>',
  /** Redo (the undo arrow mirrored). */
  redo: '<path d="M13 5l3.5 3.5L13 12"/><path d="M16.5 8.5H8a4.5 4.5 0 0 0 0 9h4"/>',
  /** Duplicate. */
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.2"/><path d="M13 7V4.5A1 1 0 0 0 12 3.5H4.5a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1H7"/>',
  /** Rename. */
  pencil: '<path d="M4 16l1-4 8.5-8.5a2 2 0 0 1 3 3L8 15z"/><path d="M12 5l3 3"/>',
  trash: '<path d="M4 5.5h12M8 5.5V3.5h4v2M5.5 5.5l1 11h7l1-11"/>',
  info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2h.01"/>',
  /** Play in a ring (Run configurations). */
  "play-circle": '<circle cx="10" cy="10" r="7.5"/><path d="M8.3 6.8l4.7 3.2-4.7 3.2z"/>',
  check: '<path d="M5 10.5l3.2 3L15 7"/>',
  "check-circle": '<circle cx="10" cy="10" r="7.5"/><path d="M6.8 10.3l2.2 2.1 4.2-4.6"/>',
  /** Filled disc with a knocked-out check: done states (teal) and the Check model button (white on teal fill). */
  "check-disc": '<circle cx="10" cy="10" r="8" fill="currentColor" stroke="none"/><path class="rw-icon__knock" d="M6.6 10.3l2.3 2.2 4.5-4.9" stroke-width="1.8"/>',
  alert: '<path d="M10 3l7.5 13h-15z"/><path d="M10 8v3.5M10 14h.01"/>',
  "error-circle": '<circle cx="10" cy="10" r="7.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/>',
  spinner: '<path d="M10 2.5a7.5 7.5 0 1 1-7.5 7.5"/>',
  "status-dot": '<circle cx="10" cy="10" r="3" fill="currentColor"/>',
  "status-circle": '<circle cx="10" cy="10" r="5.5"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  user: '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="8.2" r="2.6"/><path d="M5.3 15.6a5.5 5.5 0 0 1 9.4 0"/>',
  stop: '<rect x="6" y="6" width="8" height="8" rx="1.2"/>',
  "folder-open": '<path d="M2.5 6V4.5h5l1.5 2h8.5V9M2.5 6v9.5h12.5l2.5-6.5H5z"/>',
  cloud: '<path d="M6.5 15.5h8a3 3 0 0 0 .4-6A4.5 4.5 0 0 0 6.3 8.6 3.5 3.5 0 0 0 6.5 15.5z"/>',
  help: '<circle cx="10" cy="10" r="7.5"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.4"/><path d="M10 14h.01"/>',
  more: '<path d="M5 10h.01M10 10h.01M15 10h.01"/>',
  paperclip: '<path d="M14.5 9.5l-5 5a3 3 0 0 1-4.2-4.2l5.6-5.6a2 2 0 0 1 2.8 2.8L8.2 13a1 1 0 0 1-1.4-1.4L11.5 7"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  /** Stacked runs (the agent's run comparison row). */
  layers: '<path d="M10 3l7 3.5-7 3.5-7-3.5z"/><path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5"/>',
  /** Run details (a page with lines). */
  document: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5"/>',
  /** Differences between runs (bars). */
  "bar-chart": '<path d="M5 16.5V10M10 16.5V4M15 16.5v-8"/>',
  /** Trajectory analysis (a rising line over axes). */
  trend: '<path d="M3 3.5v13h14"/><path d="M5.5 13.5l3.5-4 3 2 4.5-6"/>',
  /** Stability analysis (a margin dial). */
  stability: '<circle cx="10" cy="10" r="7"/><path d="M10 3v2M10 10l3.5-3.5"/><circle cx="10" cy="10" r="1"/>',
  /** Thermal analysis (a thermometer). */
  thermometer: '<path d="M8 12.2V4.5a2 2 0 0 1 4 0v7.7a3.5 3.5 0 1 1-4 0z"/><path d="M10 8v6.5"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="M13 13l3.5 3.5"/>',
  send: '<path d="M3.5 10L16.5 4l-4 12.5-2.5-5.5z"/><path d="M10 11l6.5-7"/>',
  settings:
    '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/><circle cx="10" cy="10" r="5.5"/>',
} as const;

export type GlyphName = keyof typeof GLYPH_BODIES;
