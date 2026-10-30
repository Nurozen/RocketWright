/** Display formatting shared by the shell and pages (pure; times in Unix ms). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Compact age for the thread rail: `now`, `3m`, `1h`, `2d`, `5w`. */
export function relativeAge(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** Header save state: `Saved just now`, `Saved 2 minutes ago`, `Saved 3 hours ago`. */
export function savedAgo(ms: number | null, now: number): string {
  if (ms === null) return "Not saved yet";
  const m = Math.floor(Math.max(0, now - ms) / 60_000);
  if (m < 1) return "Saved just now";
  if (m < 60) return `Saved ${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Saved ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `Saved ${d} ${d === 1 ? "day" : "days"} ago`;
}

/** `Apr 12, 2026` (UTC, so captures are deterministic). */
export function formatDate(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Two-digit step number (`Step 04`). */
export function stepNumber(n: number): string {
  return String(n).padStart(2, "0");
}
