# NASA CEA, vendored for RocketWright

- Upstream: <https://github.com/nasa/cea> at commit `2f79a64` (CEA 3.3.4).
- License: Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`). Listed in the repo
  `NOTICE.md` under "Vendored code and data".
- Copied with `git archive 2f79a64`, minus: `docs/`, `Doxyfile`, the Python
  (`source/bind/python`, `source/bind/libcea.pyx`, `pyproject.toml`,
  `pytest.ini`, `environment.yml`, `test/**/*.py`), MATLAB, and Excel
  bindings, and upstream agent/CI files (`.github/`, `.codex/`, `AGENTS.md`,
  `CLAUDE.md`).

## Modifications (Apache-2.0 section 4)

The files here are otherwise unmodified. RocketWright's change is a patch
applied at build time to a copy of this tree, never to the tree itself:

- `patches/0001-bindc-libtype.patch`: `source/bind/c/CMakeLists.txt`
  hard-codes `cea_bindc` as `SHARED`; the patch adds a `CEA_BINDC_LIBTYPE`
  cache variable (default `SHARED`, upstream behavior) so `rw-cea-sys` can
  build it `STATIC`.

## How it is built

`crates/rw-cea-sys/build.rs` (feature `cea` only) copies this directory to
`$OUT_DIR/cea-src`, applies the patch, and builds it with cmake and gfortran
(CEA's top-level build writes `data/*.lib` into its source tree, so never build
here). It links `libcea_bindc.a`, `libcea_core.a`, `libfbasics_core.a`, and the
GCC runtime archives statically, and compiles `thermo.lib`/`trans.lib`, which
are compiler-ABI specific and never committed. See `docs/dev/environment.md`.

To update: re-run the `git archive` copy at the new commit, re-apply the
removals above, check the patch still applies (`patch -p1 --dry-run`), and
update the commit in this file, `NOTICE.md`, and the `rw-cea-sys` version test.
