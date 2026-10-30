#!/usr/bin/env bash
# Kit smoke test (`make kit` runs it last): the kit's own binary, with no
# RW_CEA_DATA and no repository paths, designs a custom-propellant engine
# through native CEA, finding the databases at <kit>/share/rocketwright/cea/.
#
#   scripts/kit/test-kit.sh [<kit dir>]   (default dist/kit)
#
# The engine is the research vehicle's demo engine with CEA species names
# (N2O(L)/IPA(L)), which no shipped table covers. Checks: exit 0, thermo
# `cea:native N2O(L)/IPA(L)`, a positive c*, chamber temperature, and burn
# time, and c* within 0.5% of the committed n2o-ipa table at the same point.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd -P)
kit=$(cd "${1:-$root/dist/kit}" && pwd -P)
rw=$kit/bin/rw
die() { echo "kit test: $*" >&2; exit 1; }

[ -x "$rw" ] || die "no $rw"
for f in thermo.lib trans.lib; do
  [ -f "$kit/share/rocketwright/cea/$f" ] || die "missing $kit/share/rocketwright/cea/$f"
done
case "$("$rw" --version)" in *cea*) ;; *) die "$rw was built without --features cea ($("$rw" --version))" ;; esac
case "$("$rw" --version)" in *doubles*) die "$rw was built with doubles" ;; esac

work=$(mktemp -d /tmp/rw-kit-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
cp -R "$root/fixtures/research-vehicle" "$work/p"
demo=$work/p/engines/demo.rw.toml
grep -q 'propellants = { oxidizer = "n2o", fuel = "ethanol" }' "$demo" || die "unexpected $demo"
sed -e 's/propellants = { oxidizer = "n2o", fuel = "ethanol" }/propellants = { oxidizer = "N2O(L)", fuel = "IPA(L)" }/' \
    -e 's/fluid = "n2o"/fluid = "N2O(L)"/' -e 's/fluid = "ethanol"/fluid = "IPA(L)"/' "$demo" >"$work/p/engines/native.rw.toml"
sed -e 's/"N2O(L)"/"n2o"/g' -e 's/"IPA(L)"/"ipa"/g' "$work/p/engines/native.rw.toml" >"$work/p/engines/tabled.rw.toml"

# A clean environment: only PATH and HOME, run from outside the repository.
run() { (cd "$work" && env -i PATH=/usr/bin:/bin HOME="$work" RW_OFFLINE=1 "$rw" --json --project "$work/p" "$@"); }
native=$(run engine design native) || die "rw engine design native failed: $native"
tabled=$(run engine design tabled) || die "rw engine design tabled failed: $tabled"

node -e '
const [native, tabled] = process.argv.slice(1).map((s) => JSON.parse(s.slice(s.indexOf("{"))));
const fail = (m) => { console.error("kit test: " + m); process.exit(1); };
const d = native.design;
if (d.thermo !== "cea:native N2O(L)/IPA(L)") fail("thermo is " + d.thermo);
const s = d.sizing;
for (const k of ["c_star", "chamber_temperature", "cf_vac"]) if (!(s[k] > 0)) fail(k + " = " + s[k]);
if (!(d.blowdown.burn_time > 1)) fail("burn_time = " + d.blowdown.burn_time);
if (tabled.design.thermo !== "table:n2o-ipa") fail("tabled thermo is " + tabled.design.thermo);
const rel = Math.abs(s.c_star - tabled.design.sizing.c_star) / s.c_star;
if (!(rel < 5e-3)) fail("c* native " + s.c_star + " vs table " + tabled.design.sizing.c_star);
console.log("kit test: ok: N2O(L)/IPA(L) through native CEA: c* " + s.c_star.toFixed(1) + " m/s, Tc " +
  s.chamber_temperature.toFixed(0) + " K, burn " + d.blowdown.burn_time.toFixed(2) + " s (table c* within " + (rel * 100).toFixed(2) + "%)");
' "$native" "$tabled"
