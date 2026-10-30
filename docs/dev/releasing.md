# CI and releases

## CI (`.github/workflows/ci.yml`)

Runs on every pull request and on pushes to `main`; together the jobs are
`make check-fast`.

| Job | Runner | Runs |
|---|---|---|
| Lecturn kit | macos-15 | the vendored Lecturn tarballs (`lecturn-kit.yml`) |
| Rust | ubuntu-24.04 | `make check-rust`: fmt, clippy, tests, `rw-liquid` acceptance, audit, docs-check |
| Schema, WASM and TypeScript | ubuntu-24.04 | `make schema-check wasm check-ts` |
| E2E (not required) | macos-15 | `make wasm e2e` (Playwright and Electron) |
| Check | ubuntu-24.04 | passes only when every job above except E2E passed |

Branch protection should require `Check` alone. E2E stays out of `Check`
until it has a green track record on hosted macOS runners; then add it to
`Check`'s `needs`.

The Lecturn kit job checks out Nurozen/lecturn at `vendor/lecturn/PIN` beside
RocketWright and runs `make vendor-lecturn LECTURN_INSTALL=none` (the full
`scripts/vendor-lecturn.sh`, smoke included). The kit is cached on the PIN
plus the script, the theme, `lecturn-pack.json`, and
`app/pnpm-workspace.yaml`, so most runs only restore it. Other jobs download
it as the `lecturn-kit` artifact (`.github/actions/setup-app`), write
`vendor/lecturn/.stamp`, and install `app/` with `--frozen-lockfile`. It runs
on macOS arm64 because `app/pnpm-lock.yaml` records the tarballs' sha512 from
macOS builds, and the build is only known to be byte-reproducible there. If
that job fails with "not reproducible", a kit rebuilt in CI differs from the
committed lockfile: rebuild it locally with `FORCE=1 make vendor-lecturn`,
diff the two tarballs, and fix the cause in the script.

Under `CI`, `make vendor-lecturn` installs `app/` with `pnpm install
--frozen-lockfile` instead of `pnpm update` (`LECTURN_INSTALL` in the
Makefile). `schema-check` and `check-ts` depend on `vendor-lecturn`, so a fresh
clone's `make check-fast` vendors Lecturn first.

## Cutting a release (`.github/workflows/release.yml`)

1. Check that `main` is green, and that the packaged agent pane can start
   (see [`@cursor/sdk`](#cursorsdk) below).
2. Push a tag: `git tag v0.2.0 && git push origin v0.2.0`. The workflow
   builds that commit and publishes the release. A version with a suffix
   (`v0.2.0-rc.1`) is published as a prerelease.
3. Or rehearse first: Actions > Release > Run workflow. It builds the selected
   branch as a draft release tagged `v<version>` (default: the version in
   `app/apps/desktop/package.json` plus `-dev.<run number>`). Check the assets
   and notes, then publish the draft on GitHub, which creates the tag at the
   built commit, or delete it.

The tag sets the app version; `app/apps/desktop/package.json` only supplies
the default for manual runs. Re-running a failed publish job uploads the
assets again (`--clobber`) to the release it created.

Assets:

| File | Built by | Notes |
|---|---|---|
| `RocketWright-<v>-mac-arm64.dmg`, `.zip` | macos-15, `make package` | required: no release without it |
| `RocketWright-<v>-linux-x86_64.AppImage` | ubuntu-24.04, `make package` | published when it builds; never run by CI |
| `rocketwright-kit-<v>-macos-arm64.tar.gz` | macos-15, `RW_KIT_NO_DATA=1 make kit` | published when it builds; no `data/` (CI has no OpenRocket checkout or oracle cache) |
| `SHA256SUMS` | the publish job | over every asset above |

The release notes list the downloads, name any asset that failed to build,
and say whether the macOS app is signed, followed by GitHub's generated
change list.

## The packaged app (`make package`)

`make package` builds the release `rocketwright` (no `doubles`, no native
CEA), the WASM core, and the web bundle, then `scripts/desktop/package.ts`
stages the app and runs electron-builder for the host into `dist/desktop/`
(macOS: dmg and zip; Linux: AppImage). `TARGETS=dir` builds only the unpacked
app, `VERSION=x.y.z` sets the version, and `SIGNED=1` signs and notarizes.

- `app.asar` keeps the repo's relative layout: the Electron main and the app
  server as rolldown bundles (`main.mjs`, `cli.mjs`) beside their sources'
  paths, the web bundle, the embed theme, and `node_modules/` with a clean
  hoisted install of the vendored `lecturn` and `@lecturn/embed` (the kit's
  pnpm settings and patches). Natives are unpacked into `app.asar.unpacked`.
- Beside the archive: `bin/rocketwright`, the sample
  `fixtures/research-vehicle`, and `NOTICE.md`.
- At runtime (`app/apps/desktop/src/packaged.ts`) the server runs under
  Electron as Node with the shipped `rocketwright`, and the Lecturn sidecar
  keeps its state in `<userData>/lecturn` (`~/Library/Application
  Support/RocketWright/lecturn`). Without `--project`, the window opens a
  fresh `/tmp` copy of the sample, as `make dev` does. Open your own project
  with `open -a RocketWright --args --project ~/my-rocket` or a
  `rocketwright://open?workspace=<dir>` link.
- The script fails unless the archive has both bundles, the web bundle and
  the Lecturn packages, the resources have the binary and the sample, and
  (with the switch on) no `@cursor/sdk` is anywhere in the package.

Smoke-test a local build without touching `~/.lecturn` or your Electron
profile:

```sh
make package TARGETS=dir
t=$(mktemp -d /tmp/rw-pkg.XXXXXX)
LECTURN_HOME=$t/home RW_LECTURN_BASE_DIR=$t/base RW_USER_DATA_DIR=$t/electron \
  dist/desktop/mac-arm64/RocketWright.app/Contents/MacOS/RocketWright --dev-project --smoke
```

It prints the probe JSON (`page.status` `ready`, `project` set) and exits 0.

## `@cursor/sdk`

`@cursor/sdk` is proprietary and grants no redistribution right, so the
package leaves `@cursor/sdk` and `@cursor/sdk-*` out of the Lecturn server's
`node_modules`. The switch is `EXCLUDE_CURSOR_SDK` near the top of
`scripts/desktop/package.ts` (on by default). `RW_PACKAGE_CURSOR_SDK=1`
keeps the SDK for a local test build; never publish one.

Lecturn's server runs without the SDK from 847fc19f3f on (the pinned
commit): the packaged sidecar starts and reports Cursor as not installed,
and the agent pane works with the other providers. A PIN older than that
brings back the startup failure (`Cannot find module '@cursor/sdk'`, the
agent pane reports Lecturn unavailable). The smoke above shows the pane
connecting when run with `--render-out <png>`: stderr says `lecturn:
connected (sidecar)` and the capture includes the pane.

## Signing

The macOS app is signed with a Developer ID, built with the hardened runtime,
and notarized (electron-builder staples the ticket) when every one of these
repository secrets (Settings > Secrets and variables > Actions) is set:

| Name | Kind | Value |
|---|---|---|
| `CSC_LINK` | secret | the Developer ID Application certificate and key as a `.p12`, base64 (`base64 -i cert.p12`) |
| `CSC_KEY_PASSWORD` | secret | the `.p12` password |
| `APPLE_API_KEY` | secret | the App Store Connect API key: the `.p8` file's contents |
| `APPLE_API_KEY_ID` | secret | that key's ID |
| `APPLE_API_ISSUER` | secret | the issuer ID |
| `APPLE_TEAM_ID` | variable | the team ID (optional; passed to electron-builder) |

The workflow imports the certificate into a throwaway keychain, writes the
key to a `.p8` file, and runs `make package SIGNED=1`, then checks
`codesign --verify`, `stapler validate`, and `spctl --assess`. With only some
of the secrets it warns and builds unsigned; with none it builds unsigned
quietly. Linux AppImages and the kit are never signed.

Locally: `make package SIGNED=1` with the certificate in your login keychain
(or `CSC_LINK`/`CSC_KEY_PASSWORD`) and `APPLE_API_KEY` set to the `.p8` path.

## Unsigned builds

An unsigned macOS build is ad-hoc signed (its seal is intact, so macOS does
not call it damaged) but carries no Developer ID and is not notarized, so
Gatekeeper blocks the first open of a downloaded copy. Users open it once
by Control-clicking (right-clicking) the app in Applications and choosing
Open, then Open again. On macOS 15 and later there may be no Open button:
choose Done, then System Settings > Privacy & Security > Open Anyway. Or
clear the quarantine flag: `xattr -dr com.apple.quarantine
/Applications/RocketWright.app` (for the kit, the unpacked folder). After
that it opens normally. The release notes carry these steps whenever the
build is unsigned.
