/**
 * The static shell's agent pane picture (concept 01 "Assembly review"),
 * shown when the web UI runs without a server so the offline capture has a
 * chat in the pane. It is a still image (an SVG data URL), not a chat: B17
 * removed the old chat engine and its timeline, and with a server the pane is
 * Lecturn's embed (D19 keeps this placeholder for `StaticShell`).
 *
 * Drawn in the app's tokens (`packages/ui/tokens.css`): the user bubble with
 * its `@Recovery bay` chip, the folded `3 actions` row, the reply, the step
 * card of the canned exchange, and an idle composer.
 */
import { PLACEHOLDER_HEAD } from "../shell/model.ts";

/** Picture size (CSS px); the pane shows it at its width. */
export const PLACEHOLDER_WIDTH = 400;
export const PLACEHOLDER_HEIGHT = 420;

/** What the picture shows, for its `alt` text. */
export const PLACEHOLDER_ALT = "Canned exchange: Show how the recovery bay fits. 3 actions. Exploded view ready. The recovery bay is selected in the model.";

const C = {
  text: "#e6e9ea",
  secondary: "#8e989c",
  accent: "#61b5ad",
  bubble: "#253c3f",
  line: "#2a3034",
  card: "#22282c",
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function text(x: number, y: number, s: string, fill: string, opts: { size?: number; weight?: number } = {}): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${opts.size ?? 13}" font-weight="${opts.weight ?? 400}">${esc(s)}</text>`;
}

/** The picture's SVG markup. */
export function placeholderSvg(): string {
  const W = PLACEHOLDER_WIDTH;
  const step = `Step ${String(PLACEHOLDER_HEAD.number).padStart(2, "0")} · ${PLACEHOLDER_HEAD.name}`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PLACEHOLDER_HEIGHT}" viewBox="0 0 ${W} ${PLACEHOLDER_HEIGHT}" font-family="Inter, 'SF Pro Text', system-ui, sans-serif">`,
    `<text x="${W / 2}" y="20" fill="${C.secondary}" font-size="12" text-anchor="middle">Today 10:24 AM</text>`,
    // User bubble, right-aligned, with its chip.
    `<rect x="${W - 292}" y="36" width="292" height="72" rx="12" fill="${C.bubble}"/>`,
    text(W - 278, 62, "Show how the recovery bay fits.", C.text),
    `<rect x="${W - 278}" y="74" width="112" height="22" rx="11" fill="none" stroke="${C.accent}"/>`,
    text(W - 266, 89, "@Recovery bay", C.accent, { size: 12 }),
    // Folded tool calls.
    `<circle cx="8" cy="136" r="6" fill="none" stroke="${C.accent}" stroke-width="1.5"/>`,
    `<path d="M5 136 l2 2 l4 -4" fill="none" stroke="${C.accent}" stroke-width="1.5"/>`,
    text(22, 140, "3 actions · View steps", C.secondary, { size: 12 }),
    // The reply.
    text(0, 176, "Exploded view ready. The recovery bay is", C.text),
    text(0, 196, "selected in the model.", C.text),
    // The step card.
    `<rect x="0.5" y="216.5" width="${W - 1}" height="56" rx="8" fill="${C.card}" stroke="${C.line}"/>`,
    text(16, 240, step, C.text, { weight: 600 }),
    text(16, 260, `${PLACEHOLDER_HEAD.date} · Open`, C.secondary, { size: 12 }),
    // Idle composer.
    `<rect x="0.5" y="${PLACEHOLDER_HEIGHT - 52.5}" width="${W - 1}" height="52" rx="10" fill="none" stroke="${C.line}"/>`,
    text(16, PLACEHOLDER_HEIGHT - 21, "Ask about this design…", C.secondary),
    "</svg>",
  ];
  return parts.join("");
}

/** The picture as an `<img src>`. */
export const PLACEHOLDER_SRC = `data:image/svg+xml,${encodeURIComponent(placeholderSvg())}`;
