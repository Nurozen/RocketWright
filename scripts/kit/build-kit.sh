#!/usr/bin/env bash
# B3 kit (M2.11, D8, D20): `make kit` -> dist/kit/
#
#   bin/rocketwright           release CLI with native CEA (`--features cea`; generic motor
#                              library and templates built in)
#   bin/rw -> rocketwright
#   bin/rocketwright-render    launcher for the unsigned renderer app below
#   lib/RocketWright Render.app  electron-builder --dir build of apps/desktop/src/render-main.ts
#                              with the web bundle at Contents/Resources/app/web
#   share/rocketwright/cea/    thermo.lib + trans.lib, the relocatable NASA CEA databases the
#                              binary finds beside itself (`<bin>/../share/rocketwright/cea/`),
#                              so non-tabulated propellants (CEA species such as "N2O(L)") work
#   docs/                      docs/agents/{rocketwright-model,SKILL,diagnostics}.md
#   data/                      `A simple model rocket.ork` (copied from ../openrocket at build
#                              time), case1-generic.ork (the cached variant,
#                              tests/oracle/cache/), case1-generic.json (the golden)
#   LICENSE, NOTICE.md         the project licence (AGPL-3.0-or-later) and third-party notices
#   LICENSES/                  the repo's LICENSES/ texts plus NASA CEA's LICENSE and NOTICE
#                              (for the CEA databases)
#
# The .ork files are data only and never committed (D8; dist/ and the cache are
# gitignored). Any missing input fails the build, naming the file. Last, scripts/kit/test-kit.sh
# designs a custom N2O(L)/IPA(L) engine with the kit binary through native CEA.
# Needs gfortran and cmake (the CEA build; docs/dev/environment.md).
#
# Env overrides:
#   RW_OPENROCKET   OpenRocket checkout (default: ../openrocket, then ../../openrocket)
#   RW_KIT_EXAMPLE  the example .ork      RW_KIT_VARIANT  the cached variant .ork
#   RW_KIT_OUT      output dir (default dist/kit)
#   RW_KIT_NO_REGEN=1  do not run the oracle's openrocket/oracle/regen-cache.sh first
#   RW_KIT_SKIP_APP=1  keep an existing renderer app (faster rebuilds of bin/docs/data)
#   RW_KIT_NO_DATA=1   no data/ dir and none of its inputs (the release kit built in CI,
#                      which has no OpenRocket checkout and no oracle cache)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd -P)
out=${RW_KIT_OUT:-$root/dist/kit}
cargo=${CARGO:-$HOME/.cargo/bin/cargo}
target=${CARGO_TARGET_DIR:-$root/target}
app_name="RocketWright Render"

die() { echo "make kit: $*" >&2; exit 1; }

# ---- inputs (fail loudly before building anything) ---------------------------------------
openrocket=${RW_OPENROCKET:-}
if [ -z "$openrocket" ]; then
  for c in "$root/../openrocket" "$root/../../openrocket"; do
    if [ -d "$c/core" ]; then openrocket=$(cd "$c" && pwd -P); break; fi
  done
fi
example=${RW_KIT_EXAMPLE:-${openrocket:+$openrocket/core/src/main/resources/datafiles/examples/A simple model rocket.ork}}
variant=${RW_KIT_VARIANT:-$root/tests/oracle/cache/case1-generic.ork}
golden=$root/tests/oracle/case1-generic.json

no_data=${RW_KIT_NO_DATA:-}
# The oracle's regenerator refreshes the cached variant when the checkout has it (D8).
regen=${openrocket:+$openrocket/oracle/regen-cache.sh}
if [ "$no_data" != 1 ] && [ -z "${RW_KIT_VARIANT:-}" ] && [ "${RW_KIT_NO_REGEN:-}" != 1 ] && [ -n "$regen" ] && [ -x "$regen" ]; then
  echo "make kit: regenerating the cached variant ($regen)"
  mkdir -p "$root/tests/oracle/cache"
  "$regen" "$root" || echo "make kit: warning: $regen failed (exit $?)" >&2
fi

missing=()
if [ "$no_data" != 1 ]; then
  [ -n "$example" ] && [ -f "$example" ] || missing+=("${example:-A simple model rocket.ork (no OpenRocket checkout at ../openrocket; set RW_OPENROCKET or RW_KIT_EXAMPLE, or RW_KIT_NO_DATA=1)}")
  [ -f "$variant" ] || missing+=("$variant (the cached generic-curve variant; \`make parity\` or the oracle regenerates it; or RW_KIT_NO_DATA=1)")
  [ -f "$golden" ] || missing+=("$golden")
fi
for f in rocketwright-model.md SKILL.md diagnostics.md; do
  [ -f "$root/docs/agents/$f" ] || missing+=("$root/docs/agents/$f")
done
for f in LICENSE NOTICE.md LICENSES third_party/cea/LICENSE.txt third_party/cea/NOTICE.txt; do
  [ -e "$root/$f" ] || missing+=("$root/$f")
done
for tool in gfortran cmake; do
  command -v "$tool" >/dev/null || missing+=("$tool on PATH (native CEA build: brew install gcc cmake)")
done
if [ ${#missing[@]} -gt 0 ]; then
  printf 'make kit: missing input:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

# ---- CLI ----------------------------------------------------------------------------------
echo "make kit: building the release CLI (--features cea)"
"$cargo" build -q --release -p rw-cli --features cea --bin rocketwright
bin=$target/release/rocketwright
[ -x "$bin" ] || die "no CLI at $bin"
case "$("$bin" --version)" in *cea*) ;; *) die "$bin was not built with native CEA ($("$bin" --version))" ;; esac

# ---- renderer app (D20: unsigned electron-builder --dir) ----------------------------------
app_out=$out/lib/$app_name.app
if [ "${RW_KIT_SKIP_APP:-}" = 1 ] && [ -d "$app_out" ]; then
  echo "make kit: keeping $app_out"
else
  echo "make kit: building the web bundle and the renderer app"
  "$root/scripts/build-wasm.sh" >/dev/null
  pnpm --dir "$root/app" --filter @rw/web build >/dev/null 2>&1 || die "web bundle build failed (pnpm --dir app --filter @rw/web build)"
  desktop=$root/app/apps/desktop
  electron_dist=$desktop/node_modules/electron/dist
  [ -d "$electron_dist" ] || die "no Electron at $electron_dist (run pnpm --dir app install)"
  builder=$desktop/node_modules/.bin/electron-builder
  [ -x "$builder" ] || die "no electron-builder at $builder (run pnpm --dir app install)"
  stage=$(mktemp -d "${TMPDIR:-/tmp}/rw-kit-app.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  mkdir -p "$stage/app/src"
  # render-main.ts and its local imports only (Electron 44 strips the types; asar is off).
  for f in render-main.ts capture.ts render-request.ts serve.ts; do
    cp "$desktop/src/$f" "$stage/app/src/$f"
  done
  cp -R "$root/app/apps/web/dist" "$stage/app/src/web"
  electron_version=$(node -p "require('$desktop/node_modules/electron/package.json').version")
  cat >"$stage/app/package.json" <<JSON
{
  "name": "rocketwright-render",
  "productName": "$app_name",
  "version": "$(node -p "require('$desktop/package.json').version")",
  "private": true,
  "type": "module",
  "main": "src/render-main.ts",
  "description": "RocketWright headless 3D renderer (rw render --view iso|top|side|front|rear)",
  "license": "AGPL-3.0-or-later"
}
JSON
  # The packaged app looks for the bundle at <app>/web; app.getAppPath() is the app dir.
  mv "$stage/app/src/web" "$stage/app/web"
  cat >"$stage/builder.json" <<JSON
{
  "appId": "dev.rocketwright.render",
  "productName": "$app_name",
  "directories": { "app": "$stage/app", "output": "$stage/out" },
  "electronDist": "$electron_dist",
  "electronVersion": "$electron_version",
  "asar": false,
  "npmRebuild": false,
  "nodeGypRebuild": false,
  "files": ["**/*"],
  "mac": { "identity": null, "target": ["dir"], "extendInfo": { "LSUIElement": true, "ApplePersistenceIgnoreState": true } }
}
JSON
  (cd "$stage" && CSC_IDENTITY_AUTO_DISCOVERY=false "$builder" --dir --config "$stage/builder.json" --projectDir "$stage/app" >"$stage/builder.log" 2>&1) \
    || { tail -30 "$stage/builder.log" >&2; die "electron-builder failed"; }
  built=$(find "$stage/out" -maxdepth 2 -name "$app_name.app" -type d | head -1)
  [ -n "$built" ] || { tail -30 "$stage/builder.log" >&2; die "electron-builder produced no $app_name.app"; }
  rm -rf "$app_out"
  mkdir -p "$out/lib"
  mv "$built" "$app_out"
fi

# ---- assemble -----------------------------------------------------------------------------
rm -rf "$out/bin" "$out/docs" "$out/data" "$out/share" "$out/LICENSES"
mkdir -p "$out/bin" "$out/docs"
cp "$root/LICENSE" "$root/NOTICE.md" "$out/"
cp -R "$root/LICENSES" "$out/LICENSES"
cp "$root/third_party/cea/LICENSE.txt" "$out/LICENSES/NASA-CEA-Apache-2.0.txt"
cp "$root/third_party/cea/NOTICE.txt" "$out/LICENSES/NASA-CEA-NOTICE.txt"
cp "$bin" "$out/bin/rocketwright"
# The CEA databases this build compiled, installed relocatably beside bin/.
"$cargo" run -q --release -p rw-cea-sys --features cea --bin rw-cea-probe -- --install-data "$out" >/dev/null \
  || die "installing the CEA databases into $out/share/rocketwright/cea failed"
chmod 644 "$out/share/rocketwright/cea/"*
ln -s rocketwright "$out/bin/rw"
cat >"$out/bin/rocketwright-render" <<'SH'
#!/bin/sh
# rocketwright-render (B3 kit): runs the bundled renderer app. `rw render --view
# iso|top|side|front|rear` finds this file beside the rocketwright binary.
set -eu
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
done
kit=$(cd "$(dirname "$self")/.." && pwd -P)
exec env -u ELECTRON_RUN_AS_NODE "$kit/lib/RocketWright Render.app/Contents/MacOS/RocketWright Render" "$@" -ApplePersistenceIgnoreState YES
SH
chmod 755 "$out/bin/rocketwright-render"
for f in rocketwright-model.md SKILL.md diagnostics.md; do cp "$root/docs/agents/$f" "$out/docs/$f"; done
if [ "$no_data" = 1 ]; then
  echo "make kit: no data/ (RW_KIT_NO_DATA=1)"
else
  mkdir -p "$out/data"
  cp "$example" "$out/data/A simple model rocket.ork"
  cp "$variant" "$out/data/case1-generic.ork"
  cp "$golden" "$out/data/case1-generic.json"
  chmod 644 "$out/data/"*
fi

"$out/bin/rw" --version >/dev/null || die "$out/bin/rw --version failed"
"$root/scripts/kit/test-kit.sh" "$out" || die "kit test failed (scripts/kit/test-kit.sh $out)"
echo "make kit: $out ($("$out/bin/rw" --version))"
