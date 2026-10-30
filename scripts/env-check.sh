#!/usr/bin/env bash
# Asserts the RocketWright toolchain. Each failure prints the fix line;
# optional tools print a warning naming what needs them and never fail.
# Run via `make env-check` (which puts ~/.cargo/bin first on PATH).
set -u
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n        fix: %s\n' "$1" "$2"; fail=1; }
warn() { printf '  warn  %s\n        fix: %s\n' "$1" "$2"; }

WANT_RUST=1.92.0
WANT_WASM_BINDGEN=0.2.129
WANT_NODE_MAJOR=24
WANT_PNPM_MAJOR=12
WANT_CMAKE=3.20
WANT_JAVA_MAJOR=21
LECTURN_URL=https://github.com/Nurozen/lecturn

# version_ge A B: true when A >= B (dotted numeric)
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]; }

echo "rust"
cargo_path=$(command -v cargo || true)
if [ "$cargo_path" = "$HOME/.cargo/bin/cargo" ]; then ok "cargo resolves to rustup ($cargo_path)"
else bad "cargo resolves to '${cargo_path:-nothing}', not ~/.cargo/bin/cargo" 'install rustup (https://rustup.rs), then export PATH="$HOME/.cargo/bin:$PATH"'; fi
rustc_v=$(rustc --version 2>/dev/null | awk '{print $2}')
if [ "$rustc_v" = "$WANT_RUST" ]; then ok "rustc $rustc_v (rust-toolchain.toml)"
else bad "rustc '${rustc_v:-missing}', want $WANT_RUST" "rustup toolchain install $WANT_RUST --component rustfmt clippy --target wasm32-unknown-unknown"; fi
if rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then ok "target wasm32-unknown-unknown"
else bad "target wasm32-unknown-unknown missing" "rustup target add wasm32-unknown-unknown --toolchain $WANT_RUST"; fi
for c in rustfmt clippy; do
  if rustup component list --installed 2>/dev/null | grep -q "^$c"; then ok "component $c"
  else bad "component $c missing" "rustup component add $c --toolchain $WANT_RUST"; fi
done
wb_v=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [ "$wb_v" = "$WANT_WASM_BINDGEN" ]; then ok "wasm-bindgen $wb_v (= crate pin)"
else bad "wasm-bindgen '${wb_v:-missing}', want $WANT_WASM_BINDGEN" "cargo install wasm-bindgen-cli --version $WANT_WASM_BINDGEN --locked"; fi

echo "node"
node_v=$(node -v 2>/dev/null | sed 's/^v//')
if [ "${node_v%%.*}" = "$WANT_NODE_MAJOR" ]; then ok "node v$node_v"
else bad "node '${node_v:-missing}', want v$WANT_NODE_MAJOR.x" "nvm install $WANT_NODE_MAJOR && nvm use $WANT_NODE_MAJOR"; fi
pnpm_v=$(pnpm -v 2>/dev/null)
if [ "${pnpm_v%%.*}" = "$WANT_PNPM_MAJOR" ]; then ok "pnpm $pnpm_v"
else bad "pnpm '${pnpm_v:-missing}', want $WANT_PNPM_MAJOR.x" "corepack enable && corepack prepare pnpm@$WANT_PNPM_MAJOR --activate"; fi
if [ "${ELECTRON_RUN_AS_NODE:-}" = "" ]; then ok "ELECTRON_RUN_AS_NODE unset"
else bad "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE (Electron would run as plain Node)" "env -u ELECTRON_RUN_AS_NODE <cmd>  (make targets unexport it)"; fi

# `make vendor-lecturn` builds the pinned Lecturn kit into vendor/lecturn/,
# which app/ depends on. Once the kit is current, vp and the checkout are only
# needed for a re-pin, so they downgrade to warnings.
echo "lecturn (make vendor-lecturn)"
pin=$(grep -v '^[[:space:]]*#' vendor/lecturn/PIN 2>/dev/null | tr -d '[:space:]')
kit_current=
if [ -n "$pin" ] && [ "$(cat vendor/lecturn/.stamp 2>/dev/null)" = "$pin" ] &&
  [ -f vendor/lecturn/lecturn.tgz ] && [ -f vendor/lecturn/lecturn-embed.tgz ]; then
  kit_current=1
  ok "vendor/lecturn is current at ${pin:0:10}"
fi
need() { if [ -n "$kit_current" ]; then warn "$1 (needed only to re-pin)" "$2"; else bad "$1" "$2"; fi; }
if ! command -v vp >/dev/null 2>&1 && [ -f "$HOME/.config/vite-plus/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/vite-plus/env"
fi
vp_v=$(vp --version 2>/dev/null | awk 'NR==1{print $2}')
if [ -n "$vp_v" ]; then ok "Vite+ vp $vp_v"
else need "Vite+ (vp) missing; it builds the pinned Lecturn" "curl -fsSL https://vite.plus | bash, then open a new shell"; fi
# Same lookup as scripts/vendor-lecturn.sh: $LECTURN_REPO, else the nearest
# lecturn/ checkout in a directory above this repo.
lecturn_repo=${LECTURN_REPO:-}
if [ -z "$lecturn_repo" ]; then
  d=$PWD
  while [ "$d" != / ]; do
    d=$(dirname "$d")
    if [ -e "$d/lecturn/.git" ] && [ -f "$d/lecturn/apps/server/scripts/cli.ts" ]; then lecturn_repo=$d/lecturn; break; fi
  done
fi
if [ -z "$lecturn_repo" ]; then
  need "no Lecturn checkout above this repo (LECTURN_REPO unset)" "git clone $LECTURN_URL ../lecturn  (or set LECTURN_REPO=<checkout>)"
elif [ -z "$pin" ]; then
  bad "vendor/lecturn/PIN is missing or empty" "git checkout -- vendor/lecturn/PIN"
elif git -C "$lecturn_repo" rev-parse --verify --quiet "$pin^{commit}" >/dev/null 2>&1; then
  ok "Lecturn checkout $lecturn_repo has the pin ${pin:0:10}"
else
  need "Lecturn checkout $lecturn_repo lacks the pin ${pin:0:10}" "git -C $lecturn_repo fetch origin"
fi

echo "optional (warnings only)"
gf_v=$(gfortran -dumpfullversion 2>/dev/null)
cm_v=$(cmake --version 2>/dev/null | awk 'NR==1{print $3}')
cea_need="native NASA CEA: make check (check-cea, required on macOS), make kit, --features cea; make check-fast and make dev work without it"
if [ -n "$gf_v" ]; then ok "gfortran $gf_v"
else warn "gfortran missing ($cea_need)" "brew install gcc"; fi
if [ -n "$cm_v" ] && version_ge "$cm_v" "$WANT_CMAKE"; then ok "cmake $cm_v"
else warn "cmake '${cm_v:-missing}', want >= $WANT_CMAKE ($cea_need)" "brew install cmake"; fi
pt_v=$(pdftotext -v 2>&1 | awk 'NR==1{print $3}')
if [ -n "$pt_v" ]; then ok "pdftotext $pt_v"
else warn "pdftotext missing (maintainers: equations from the cited literature PDFs)" "brew install poppler"; fi

# JDK 21: $JAVA_HOME, then macOS java_home, then Homebrew's keg-only
# openjdk@21 (java_home does not list it unless symlinked into
# /Library/Java/JavaVirtualMachines), then java on PATH (never macOS's
# /usr/bin/java stub, which only asks java_home and can open an install dialog).
java_major() { "$1" -version 2>&1 | awk -F'"' 'NR==1{print $2}' | cut -d. -f1; }
java_home=
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ] && [ "$(java_major "$JAVA_HOME/bin/java")" = "$WANT_JAVA_MAJOR" ]; then
  java_home=$JAVA_HOME
elif [ -x /usr/libexec/java_home ] && h=$(/usr/libexec/java_home -v "$WANT_JAVA_MAJOR" 2>/dev/null); then
  java_home=$h
elif command -v brew >/dev/null 2>&1 && h=$(brew --prefix "openjdk@$WANT_JAVA_MAJOR" 2>/dev/null)/libexec/openjdk.jdk/Contents/Home &&
  [ -x "$h/bin/java" ]; then
  java_home=$h
elif command -v java >/dev/null 2>&1 && [ "$(command -v java)" != /usr/bin/java ] && [ "$(java_major java)" = "$WANT_JAVA_MAJOR" ]; then
  java_home=$(dirname "$(dirname "$(command -v java)")")
fi
java_need="maintainers: runs OpenRocket to regenerate the oracle goldens and tests/oracle/cache that make kit and make parity read"
if [ -n "$java_home" ]; then ok "JDK $WANT_JAVA_MAJOR at $java_home"
elif [ "$(uname)" = Darwin ]; then
  warn "JDK $WANT_JAVA_MAJOR not found ($java_need)" "brew install openjdk@$WANT_JAVA_MAJOR, then export JAVA_HOME=\$(brew --prefix openjdk@$WANT_JAVA_MAJOR)/libexec/openjdk.jdk/Contents/Home"
else
  warn "JDK $WANT_JAVA_MAJOR not found ($java_need)" "install OpenJDK $WANT_JAVA_MAJOR (for example apt install openjdk-$WANT_JAVA_MAJOR-jdk) and set JAVA_HOME"
fi

if [ "$fail" -ne 0 ]; then echo "env-check: FAILED"; exit 1; fi
echo "env-check: ok"
