#!/usr/bin/env bash
# make vendor-lecturn (plan B7): vendors the Lecturn server (`lecturn`) and
# `@lecturn/embed` at the commit in vendor/lecturn/PIN.
#
#   scripts/vendor-lecturn.sh [<lecturn-commit>]   (no argument: the PIN)
#
# A commit that differs from the PIN re-pins: PIN is rewritten after success.
# So does a PIN edited to a new commit (FORCE=1 make vendor-lecturn): the
# same-pin reproducibility check compares against the committed PIN.
# Steps:
#   1. Theme drift (decision 14): the pinned commit's
#      examples/embed-host/src/rocketwright-theme.json must equal
#      app/packages/ui/generated/lecturn-theme.json; the error names the side
#      to update. Runs every time, also when the kit is current.
#   2. A temporary `git worktree add --detach` of the commit in the Lecturn
#      repo (the editable Lecturn worktree is never moved or touched).
#   3. Filtered `vp i --frozen-lockfile`, `vp run --filter lecturn build`
#      (bundles the web client into dist/client), `vp run --filter
#      @lecturn/embed build`, then `node apps/server/scripts/cli.ts pack`,
#      which writes both tarballs, patches/ and lecturn-pack.json (Lecturn A31).
#   4. Asserts the server tarball holds dist/client/index.html.
#   5-6. Lecturn's scripts/smoke-pack-install.ts against the kit: clean installs
#      of both tarballs into empty dirs (hoisted, and isolated with the kit's
#      publicHoistPattern), probing node:sqlite, a node-pty spawn, fff search,
#      the Cursor helper lookup and `serve`, under Node and under RocketWright's
#      Electron as node, plus Electron from an app.asar with unpacked natives
#      and the kit's patches (plan D3, Lecturn spike A8).
#   7. Installs the kit into vendor/lecturn/ (tarballs renamed to lecturn.tgz
#      and lecturn-embed.tgz, which app/package.json depends on) and checks that
#      app/pnpm-workspace.yaml carries the kit's pnpm settings. The temp
#      worktree is removed on every exit path.
#
# Env:
#   LECTURN_REPO       Lecturn checkout to add the worktree from (default: the
#                      nearest ../lecturn above this repo; get one with
#                      `git clone https://github.com/Nurozen/lecturn ../lecturn`)
#   RW_ELECTRON        Electron binary for the smoke, at the desktop pin
#                      (default: app/apps/desktop's Electron when app/ is
#                      installed, else the pin's zip in Electron's download
#                      cache, `$electron_config_cache` or the platform default;
#                      when neither exists, the pinned `electron` package is
#                      installed into the temp dir with npm and its installer
#                      downloads the release into that cache)
#   FORCE=1            rebuild even when vendor/lecturn/.stamp names the commit
#   KEEP_WORKTREE=1    keep the temp worktree (prints its path; remove it with
#                      `git -C <LECTURN_REPO> worktree remove --force <path>`)
#   LECTURN_WORKTREE   reuse an existing worktree of the commit (never removed)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VENDOR=vendor/lecturn
THEME_RW=app/packages/ui/generated/lecturn-theme.json
THEME_LECTURN=examples/embed-host/src/rocketwright-theme.json
# A patched copy of Lecturn's smoke, written into the worktree (step 5-6).
SMOKE_COPY=scripts/.rw-smoke-pack-install.ts
STAMP=$VENDOR/.stamp

die() {
  echo "vendor-lecturn: $*" >&2
  exit 1
}

read_pin() {
  [ -f "$VENDOR/PIN" ] || die "$VENDOR/PIN is missing"
  grep -v '^[[:space:]]*#' "$VENDOR/PIN" | tr -d '[:space:]'
}

find_lecturn_repo() {
  if [ -n "${LECTURN_REPO:-}" ]; then
    echo "$LECTURN_REPO"
    return
  fi
  local d=$ROOT
  while [ "$d" != / ]; do
    d=$(dirname "$d")
    if [ -e "$d/lecturn/.git" ] && [ -f "$d/lecturn/apps/server/scripts/cli.ts" ]; then
      echo "$d/lecturn"
      return
    fi
  done
  die "no Lecturn checkout found above $ROOT: clone it beside this repo (git clone https://github.com/Nurozen/lecturn ../lecturn) or set LECTURN_REPO=<path to a Lecturn checkout>"
}

want=${1:-$(read_pin)}
[ -n "$want" ] || die "no commit given and $VENDOR/PIN is empty"
# Assign first: a `die` inside `$(cd "$(find_lecturn_repo)" ...)` would only
# leave the inner subshell, and `cd ""` would then resolve to this repo.
lecturn_dir=$(find_lecturn_repo) || exit 1
[ -d "$lecturn_dir/.git" ] || [ -f "$lecturn_dir/.git" ] ||
  die "$lecturn_dir is not a Lecturn git checkout (LECTURN_REPO)"
LECTURN_REPO=$(cd "$lecturn_dir" && pwd)
sha=$(git -C "$LECTURN_REPO" rev-parse --verify --quiet "$want^{commit}") ||
  die "commit '$want' is not in $LECTURN_REPO (git -C $LECTURN_REPO fetch first)"

# ---- 1. theme drift (decision 14) ----------------------------------------------
lecturn_theme=$(mktemp "${TMPDIR:-/tmp}/rw-lecturn-theme.XXXXXX")
trap 'rm -f "$lecturn_theme"' EXIT
git -C "$LECTURN_REPO" show "$sha:$THEME_LECTURN" >"$lecturn_theme" 2>/dev/null ||
  die "Lecturn ${sha:0:10} has no $THEME_LECTURN; pin a commit with the embed-host theme (Lecturn A19)"
if ! cmp -s "$lecturn_theme" "$THEME_RW"; then
  # RocketWright's token map is the source (decision 14): when its generated
  # file is current, the Lecturn copy is the stale side.
  if [ -d app/node_modules ] && ! pnpm --dir app --filter @rw/ui --silent gen:lecturn-theme:check >/dev/null 2>&1; then
    die "theme drift: $THEME_RW is stale against app/packages/ui/tokens.css. Update RocketWright: pnpm -C app --filter @rw/ui gen:lecturn-theme, then copy it to Lecturn's $THEME_LECTURN if that still differs"
  fi
  die "theme drift: Lecturn ${sha:0:10}:$THEME_LECTURN differs from $THEME_RW. Update Lecturn: copy RocketWright's $THEME_RW to $THEME_LECTURN, commit, then re-pin with scripts/vendor-lecturn.sh <new commit>"
fi
echo "vendor-lecturn: theme matches Lecturn ${sha:0:10}:$THEME_LECTURN"

# ---- pnpm settings the kit asks for ----------------------------------------------
# Every allowBuilds entry, the publicHoistPattern, and each patchedDependencies
# selector (pointing at vendor/lecturn/patches/) must be in app/pnpm-workspace.yaml.
check_workspace_settings() {
  node scripts/vendor/lecturn-kit.ts settings "$VENDOR/lecturn-pack.json" app/pnpm-workspace.yaml
}

if [ -z "${FORCE:-}" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$sha" ] &&
  [ -f "$VENDOR/lecturn.tgz" ] && [ -f "$VENDOR/lecturn-embed.tgz" ] && [ -f "$VENDOR/lecturn-pack.json" ]; then
  check_workspace_settings
  touch "$STAMP"
  echo "vendor-lecturn: $VENDOR is current (Lecturn ${sha:0:10}); FORCE=1 rebuilds"
  exit 0
fi

# ---- tools ------------------------------------------------------------------------
if ! command -v vp >/dev/null 2>&1 && [ -f "$HOME/.config/vite-plus/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/vite-plus/env"
fi
command -v vp >/dev/null 2>&1 ||
  die "Lecturn builds with Vite+ (vp): install it with 'curl -fsSL https://vite.plus | bash', then open a new shell or run '. ~/.config/vite-plus/env'"

resolve_electron() {
  if [ -n "${RW_ELECTRON:-}" ]; then
    echo "$RW_ELECTRON"
    return
  fi
  local pin bin zip dir
  pin=$(node -p 'require("./app/apps/desktop/package.json").devDependencies.electron')
  bin=$(cd app/apps/desktop && env -u ELECTRON_RUN_AS_NODE node -p 'require("electron")' 2>/dev/null) || bin=
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    echo "$bin"
    return
  fi
  # No install yet (a fresh clone installs app/ after vendoring, because app/
  # depends on the tarballs this script writes): unzip the cached release of
  # the desktop pin, downloading it first when the cache lacks it.
  local caches=("$HOME/Library/Caches/electron" "$HOME/.cache/electron")
  [ -n "${electron_config_cache:-}" ] && caches=("$electron_config_cache")
  zip=$(find "${caches[@]}" -name "electron-v$pin-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').zip" 2>/dev/null | head -1)
  if [ -z "$zip" ]; then
    download_electron "$pin"
    return
  fi
  dir=$tmp/electron
  mkdir -p "$dir" && unzip -q "$zip" -d "$dir"
  if [ -d "$dir/Electron.app" ]; then echo "$dir/Electron.app/Contents/MacOS/Electron"; else echo "$dir/electron"; fi
}

# Electron's own installer (the pinned `electron` package's install.js) fetches
# the release into Electron's download cache, verifies it against the package's
# checksums.json, and unpacks it into the package; the package lives in $tmp,
# the cached zip stays for the next run. Prints the binary path.
download_electron() {
  local pin=$1 pkg=$tmp/electron-pkg
  echo "vendor-lecturn: Electron $pin is not installed or cached; downloading it for the smoke" >&2
  command -v npm >/dev/null 2>&1 || die "npm (bundled with Node) is needed to download Electron $pin; or set RW_ELECTRON=<Electron $pin binary>"
  mkdir -p "$pkg"
  npm install --prefix "$pkg" --no-save --no-package-lock --no-audit --no-fund --ignore-scripts \
    --loglevel=error "electron@$pin" >&2 ||
    die "npm install electron@$pin failed; set RW_ELECTRON=<Electron $pin binary> instead"
  (cd "$pkg" && env -u ELECTRON_RUN_AS_NODE node node_modules/electron/install.js) >&2 ||
    die "downloading Electron $pin failed (output above); set RW_ELECTRON=<Electron $pin binary> instead"
  (cd "$pkg" && env -u ELECTRON_RUN_AS_NODE node -p 'require("electron")')
}

# ---- 2. temporary worktree -------------------------------------------------------
tmp=$(mktemp -d "${TMPDIR:-/tmp}/rw-vendor-lecturn.XXXXXX")
wt=${LECTURN_WORKTREE:-$tmp/lecturn}
cleanup() {
  rm -f "$lecturn_theme" "$wt/$SMOKE_COPY"
  if [ -z "${LECTURN_WORKTREE:-}" ] && [ -d "$wt" ]; then
    if [ -n "${KEEP_WORKTREE:-}" ]; then
      echo "vendor-lecturn: kept $wt (git -C $LECTURN_REPO worktree remove --force $wt)" >&2
    else
      git -C "$LECTURN_REPO" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$LECTURN_REPO" worktree prune 2>/dev/null || true
    fi
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
if [ -n "${LECTURN_WORKTREE:-}" ]; then
  [ "$(git -C "$wt" rev-parse HEAD)" = "$sha" ] || die "LECTURN_WORKTREE $wt is not at ${sha:0:10}"
else
  # Keep the worktree outside $tmp when kept, so the rm -rf above spares it.
  [ -n "${KEEP_WORKTREE:-}" ] && wt=$(mktemp -d "${TMPDIR:-/tmp}/rw-lecturn-wt.XXXXXX")/lecturn
  git -C "$LECTURN_REPO" worktree add --detach "$wt" "$sha" >/dev/null
fi
echo "vendor-lecturn: Lecturn ${sha:0:10} in $wt"

electron=$(resolve_electron)
[ -x "$electron" ] || die "Electron binary $electron is not executable"

# ---- 3. install, build, pack ---------------------------------------------------------
kit=$tmp/kit
(
  cd "$wt"
  # Lecturn's worktree setup reads LECTURN_PROJECT_ROOT; no repo .env is linked,
  # so the build has Lecturn Connect and telemetry off (lecturn-pack.json `build`).
  export LECTURN_PROJECT_ROOT=$LECTURN_REPO CI=1
  unset ELECTRON_RUN_AS_NODE
  vp i --frozen-lockfile --filter @lecturn/monorepo --filter 'lecturn...' \
    --filter '@lecturn/embed...' --filter '@lecturn/scripts...' -- --yes </dev/null
  vp run --filter lecturn build
  vp run --filter @lecturn/embed build
  # Rolldown names asset-URL placeholders with a random per-build id, which
  # survives only in sourcemap sourcesContent. Normalized, two builds of one
  # commit pack byte-identical tarballs (pnpm pack is deterministic), so the
  # tarball integrity in app/pnpm-lock.yaml stays valid across rebuilds.
  { grep -rlE 'ROLLDOWN_FILE_URL_' apps/server/dist packages/embed/dist || true; } | while IFS= read -r f; do
    perl -pi -e 's/ROLLDOWN_FILE_URL_[A-Za-z0-9_\$-]+/ROLLDOWN_FILE_URL_0/g' "$f"
  done
  node apps/server/scripts/cli.ts pack --out-dir "$kit"
)

server_tgz=$kit/$(node -p 'require(process.argv[1]).packages.lecturn.tarball' "$kit/lecturn-pack.json")
embed_tgz=$kit/$(node -p 'require(process.argv[1]).packages.embed.tarball' "$kit/lecturn-pack.json")
[ -f "$server_tgz" ] && [ -f "$embed_tgz" ] || die "pack did not write both tarballs into $kit"

# ---- 4. web client present ---------------------------------------------------------
tar -tzf "$server_tgz" | grep -qx 'package/dist/client/index.html' ||
  die "$(basename "$server_tgz") lacks dist/client/index.html (the lecturn build did not bundle @lecturn/web)"

# ---- 5-6. clean install + Electron/asar smoke ----------------------------------------
echo "vendor-lecturn: smoke (hoisted + isolated, Node + Electron $(env -u ELECTRON_RUN_AS_NODE "$electron" --version 2>/dev/null) as node + app.asar)"
# Since Lecturn 847fc19f3f (T3's #12291) the server answers 503 with
# Retry-After until its request handler attaches, but Lecturn's smoke still
# fails on the first non-2xx answer from /.well-known/lecturn/environment.
# Run a copy that treats that 503 as "not ready yet" (the smoke's own ready
# timeout still bounds the wait). Drop this once Lecturn's smoke retries.
smoke=scripts/smoke-pack-install.ts
if grep -q 'if (response !== undefined) {' "$wt/$smoke"; then
  perl -pe 's/if \(response !== undefined\) \{/if (response !== undefined && response.status !== 503) {/' \
    "$wt/$smoke" >"$wt/$SMOKE_COPY"
  smoke=$SMOKE_COPY
fi
(
  cd "$wt"
  unset ELECTRON_RUN_AS_NODE
  node "$smoke" --pack-dir "$kit" --electron "$electron" --asar --patches \
    --layout both --json "$kit/smoke.json"
) || die "Lecturn's smoke-pack-install failed (table above; $kit/smoke.json is removed with the temp dir)"

# ---- 7. install the kit -------------------------------------------------------------
mkdir -p "$VENDOR"
rm -rf "$VENDOR/patches" "$VENDOR"/*.tgz
cp "$server_tgz" "$VENDOR/lecturn.tgz"
cp "$embed_tgz" "$VENDOR/lecturn-embed.tgz"
cp -R "$kit/patches" "$VENDOR/patches"
cp "$kit/smoke.json" "$VENDOR/smoke.json"
# The tarballs take stable names so a re-pin does not touch app/package.json.
node --input-type=module - "$kit/lecturn-pack.json" "$VENDOR/lecturn-pack.json" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const [from, to] = process.argv.slice(2);
const d = JSON.parse(readFileSync(from, "utf8"));
d.packages.lecturn.tarball = "lecturn.tgz";
d.packages.embed.tarball = "lecturn-embed.tgz";
writeFileSync(to, `${JSON.stringify(d, null, 2)}\n`);
EOF
check_workspace_settings

# The lockfile pins each tarball's integrity. Same pin as the committed PIN
# (the lockfile was made at it): a mismatch means the build was not
# reproducible (pnpm would rewrite the lockfile), so fail. New pin (an
# argument, or a PIN edited but not yet committed): the lockfile is expected
# to change.
committed_pin=$(git show "HEAD:$VENDOR/PIN" 2>/dev/null | grep -v '^[[:space:]]*#' | tr -d '[:space:]' || true)
drift=$(node scripts/vendor/lecturn-kit.ts lock app/pnpm-lock.yaml "$VENDOR")
if [ -n "$drift" ]; then
  if [ "$(read_pin)" = "$sha" ] && [ "$committed_pin" = "$sha" ]; then
    # CI rebuilds with another Node/zlib, so the same files can gzip to other
    # bytes; it re-records the integrity of these two tarballs only
    # (.github/actions/setup-app). Locally a mismatch is a real bug.
    if [ "${RW_VENDOR_REHASH:-}" = 1 ]; then
      echo "vendor-lecturn: rebuilt $drift differs from app/pnpm-lock.yaml's integrity; RW_VENDOR_REHASH=1, so installs re-record it"
    else
      die "rebuilt $drift at the same pin differs from its integrity in app/pnpm-lock.yaml: the Lecturn build is not reproducible (diff two builds' dist/ and normalize the cause above)"
    fi
  fi
  echo "vendor-lecturn: re-pinned: run pnpm -C app update lecturn @lecturn/embed, then commit PIN, lecturn-pack.json and app/pnpm-lock.yaml together"
fi
[ "$(read_pin)" = "$sha" ] || printf '%s\n' "$sha" >"$VENDOR/PIN"
printf '%s' "$sha" >"$STAMP"
echo "vendor-lecturn: vendored lecturn $(node -p 'require(process.argv[1]).packages.lecturn.version' "$ROOT/$VENDOR/lecturn-pack.json") at ${sha:0:10} into $VENDOR"
