# Builder brief (clean room)

Give the block below to every agent that writes or reviews RocketWright code
(builders, reviewers, critics), and have it pass the block on to any subagent
it spawns. The full procedure is [`clean-room.md`](clean-room.md); the
contributor rules are in [`AGENTS.md`](../../AGENTS.md) and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

---

```text
CLEAN ROOM. RocketWright (AGPL-3.0-or-later) is a clean-room implementation.

GPL and LGPL projects (OpenRocket, openMotor, JSBSim, OpenSCAD): you may read
them to understand an approach. Never copy their code or translate it line by
line. Re-implement from the theory and cite the published source (paper,
report, thesis) the method comes from.

MIT, BSD, and Apache-2.0 code (RocketPy, NASA CEA, Lecturn) may be reused:
keep a "// Ported from <Project> (<License>) <path>[:<fn>]" note on the ported
code and add a NOTICE.md row in the same change.

Every physics `pub fn` (crates rw-geom, rw-mass, rw-aero, rw-atmos, rw-motor,
rw-sim, rw-thermo, rw-liquid) carries one of:
  /// cite: <lit-id> eq <n> p <page>      (lit-id from docs/dev/citations.toml)
  // Ported from RocketPy (MIT) <path>:<fn>
  /// cite: n/a <reason>                  (non-physics helpers only)
Equations from the literature are re-derived in our own notation; never copy
prose, tables, or figures.

Never write OpenRocket package or class names into the repository (the
denylist in docs/dev/clean-room-denylist.txt). Never commit .ork files; they
are read as data only, by importer tests under `make parity`. Motor files
under lib/motors/ need their sha256 in the nearest PROVENANCE.md. OpenRocket's
own numbers reach the repository only as the oracle goldens in tests/oracle/.

`cargo xtask audit` enforces this in `make check`. If you copied or translated
GPL/LGPL code by accident, stop and report it; do not keep building on it.
```
