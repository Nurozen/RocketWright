#!/usr/bin/env bash
# make wasm: builds rw-wasm for wasm32 and runs wasm-bindgen (--target web)
# into app/packages/rw-wasm/pkg/. Asserts the CLI equals the crate pin first,
# because a mismatch produces glue that fails at load time.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

pin=$(sed -n 's/^wasm-bindgen *= *"=\([0-9.]*\)".*/\1/p' Cargo.toml)
cli=$(wasm-bindgen --version | awk '{print $2}')
if [ -z "$pin" ] || [ "$pin" != "$cli" ]; then
  echo "make wasm: wasm-bindgen CLI '$cli' != crate pin '$pin'" >&2
  echo "  fix: cargo install wasm-bindgen-cli --version $pin --locked" >&2
  exit 1
fi

target_dir=${CARGO_TARGET_DIR:-target}
# `wasm` profile (Cargo.toml): opt-level z, fat LTO, one codegen unit, abort.
cargo build -p rw-wasm --profile wasm --target wasm32-unknown-unknown
out=app/packages/rw-wasm/pkg
rm -rf "$out"
wasm-bindgen --target web --remove-name-section --remove-producers-section \
  --out-dir "$out" "$target_dir/wasm32-unknown-unknown/wasm/rw_wasm.wasm"
# Thermo tables ship beside the wasm and load from the local bundle (D19d, M4.3).
mkdir -p "$out/thermo"
cp data/thermo/*.rwtbl "$out/thermo/"
n=$(ls "$out/thermo"/*.rwtbl | wc -l | tr -d ' ')
if [ "$n" -lt 6 ]; then
  echo "make wasm: expected 6 thermo tables in $out/thermo, found $n (cargo xtask tables)" >&2
  exit 1
fi
bytes=$(wc -c < "$out/rw_wasm_bg.wasm" | tr -d ' ')
gz=$(gzip -9 -c "$out/rw_wasm_bg.wasm" | wc -c | tr -d ' ')
printf 'make wasm: %s (%s bytes, %s gzip)\n' "$out/rw_wasm_bg.wasm" "$bytes" "$gz"
# Size gate (M1.32). The plan budget is 1.5 MB; without binaryen's wasm-opt the
# module is ~1.83 MB raw (~0.5 MB gzip), so the gate ratchets at 2.0 MB raw
# until wasm-opt lands in the toolchain (docs/dev/wasm.md). M4.4-M4.6 raised it
# to 2.1 MB: liquid engines in the evaluated model plus the engine_design
# chamber preview took the module from 1.963 MB to 2.069 MB. REV-phys raised it
# to 2.11 MB: CD overrides, tank propellant mass, and the apogee fallback took
# it from 2.0992 MB to 2.1063 MB. REV2-web raised it to 2.12 MB: cutter nodes
# for viewport cuts (`MeshOptions.cutters`, `mesh_model_glb`) took it to 2.1121 MB.
# ThrustCurve raised it to 2.13 MB: the model's `[lib.source]` provenance table
# (`LibSource`) and the RW-E015..017 code rows took it from 2.1140 MB to 2.1240 MB.
max=${RW_WASM_MAX_BYTES:-2130000}
if [ "$bytes" -gt "$max" ]; then
  echo "make wasm: rw_wasm_bg.wasm is $bytes bytes, over the $max-byte gate" >&2
  exit 1
fi
