/** Public brand asset URLs (public/brand; provenance in public/brand/PROVENANCE.md). */
const base = import.meta.env.BASE_URL;

export const BRAND = {
  name: "RocketWright",
  mark: `${base}brand/rocketwright-mark.svg`,
  wordmark: `${base}brand/rocketwright-wordmark.svg`,
} as const;
