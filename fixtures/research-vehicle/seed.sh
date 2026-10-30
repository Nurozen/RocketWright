#!/usr/bin/env bash
# Seeds a copy of this fixture with real history and runs (plan M1.55, D10a):
# every step, revision, and run below is made by an ordinary `rw` command
# under a pinned RW_CLOCK, so the hashes are real and the times repeat.
#
#   01 Initial concept    the fixture as committed (the snapshot `rw fmt` records)
#   02 Assembly layout    flight computer moved 5 mm aft in the electronics bay
#      run Fin revision   flown on step 02's model
#   03 Fin revision       fin span 90 -> 100 mm, sweep 45 -> 40 mm (Fin revision -> Outdated)
#   04 Flight runs        launch rail 1.5 -> 2 m on the Baseline and Higher altitude
#                         sims (the flights about to run) and Baseline ejection delay
#                         2 -> 3 s, tagged Rev 07 "Flight-ready fins"
#      runs Baseline, Higher altitude right after, on step 04's model (Complete);
#      Recovery test Not run
#
# seed.expected.json lists what this produces; `make seed-fixture DEST=<dir>`
# runs this script and then checks it (scripts/fixtures/seed.ts --check).
#
# Usage: RW=<rocketwright binary> fixtures/research-vehicle/seed.sh <dest>
# (default RW: `rocketwright` on PATH). <dest> must be missing or empty.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${1:?usage: seed.sh <dest>}"
rw="${RW:-rocketwright}"

if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ]; then
  echo "seed.sh: $dest exists and is not empty" >&2
  exit 2
fi
mkdir -p "$dest"
cp -R "$here/." "$dest/"
rm -rf "$dest/seed.sh" "$dest/seed.expected.json" "$dest/.rw" "$dest/runs"

# Offline, no test hooks (no artificial sim delays), never an owner's socket.
export RW_OFFLINE=1
unset RW_TEST_HOOKS RW_TEST_SIM_DELAY_MS

# `at <RW_CLOCK time> <rw args...>`. An edit (`rw set`) runs its own strict
# check, and the vehicle's B4G liftoff T/W warning (RW-W102) makes it exit 1
# after the step is recorded; any other failure stops the seed.
at() {
  local when="$1"
  shift
  local out rc=0
  out=$(RW_CLOCK="$when" "$rw" -C "$dest" "$@") || rc=$?
  if [ "$rc" -ne 0 ] && ! { [ "$rc" -eq 1 ] && grep -q '^recorded step:' <<<"$out" &&
    grep -q '^check --strict: warnings' <<<"$out"; }; then
    printf '%s\n' "$out" >&2
    exit "$rc"
  fi
}

at 2026-10-12T09:30:00Z --snapshot-label "Initial concept" fmt
at 2026-10-13T10:15:00Z call --label "Assembly layout" model_patch \
  '{"ops":[{"op":"replace","path":"/c/flight_computer/attach/offset","value":"25 mm"}]}'
at 2026-10-13T16:40:00Z sim fin_revision
at 2026-10-14T11:05:00Z set --label "Fin revision" \
  params.fin_span.value="100 mm" params.fin_sweep.value="40 mm"
at 2026-10-15T14:02:00Z set --label "Flight runs" \
  sims.baseline.launch.rail_length="2 m" sims.higher_altitude.launch.rail_length="2 m" \
  configs.baseline.motors.motor_casing.delay="3 s"
at 2026-10-15T14:03:00Z history tag "Flight-ready fins" --number 7
at 2026-10-15T14:04:00Z sim baseline
at 2026-10-15T14:04:00Z sim higher_altitude

"$rw" -C "$dest" history log
