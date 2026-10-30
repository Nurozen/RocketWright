# Brand assets

Copied unmodified from the RocketWright asset pack (maintainer-held source
files, not published separately): `rocketwright-mark.svg`, `rocketwright-wordmark.svg`, and the
31 line icons in `icons/`. All are original RocketWright artwork, hand-authored
SVG with no third-party icon set, embedded raster, or external reference.
License: AGPL-3.0-or-later, the project license (`LICENSE`, `NOTICE.md`).

The desktop app icon `app/apps/desktop/assets/app-icon-128.png` comes from the
same pack: its `rocketwright-app-icon.png` (1024 px, a rasterization of the
mark on `#1b1e20`) downscaled to 128 px. Same license.

The app inlines the icons through `src/shell/icons.generated.ts`
(`node scripts/gen-icons.ts`; the shell test fails on drift) so their
`currentColor` stroke follows CSS. The header shows the mark as an image and
sets the wordmark text in Inter.
