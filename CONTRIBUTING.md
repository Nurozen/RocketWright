# Contributing

## Developer setup

Follow the [README](README.md#setup) for a first checkout and
[`docs/dev/environment.md`](docs/dev/environment.md) for toolchain versions,
make targets, and pitfalls. Coding agents (and people) should also read
[`AGENTS.md`](AGENTS.md) for the repository's conventions.

## Read this first

RocketWright is pre-release and maintained by a small team with limited review
capacity. Opening a PR does not create an obligation to review or merge it. We
may close or defer it, ask for a smaller scope, or reimplement the idea later.
Meeting this guide's requirements makes a PR eligible for review; it does not
guarantee acceptance. The same requirements apply to drafts.

Focused bug fixes, wrong physics results backed by a reference, reliability
fixes, and documentation fixes are the most likely to be accepted. Unsolicited
features, opinionated rewrites, and unrelated cleanup are not.

Report bugs with the bug report form and propose features with the feature
request form in [issues](https://github.com/Nurozen/RocketWright/issues).
Search existing issues first. Report security problems privately, as described
in [`SECURITY.md`](SECURITY.md).

<a id="prior-approval"></a>

## Establish the problem and scope first

Features and intentional changes to product behavior need an issue where a
maintainer has explicitly agreed to the direction and scope. Link that comment
in your PR. Calling a behavior change a bug fix does not exempt it.

For a substantial bug fix, link an issue that establishes the failure and the
intended behavior. A very small, focused fix for an obvious bug can be sent
without an issue; explain the defect and why the fix is that small.

A change to a physics result (aerodynamics, mass, flight, thermochemistry)
needs a reference: the published source and equation, a validation case, or a
measured flight, and the numbers before and after. Agreement with another
simulator alone is a hint, not a reference.

<a id="one-problem"></a>

## Solve one problem per PR

A PR that solves several independent problems must be split, even when each
fix is useful. Include the Rust, schema, TypeScript, test, and documentation
changes that one problem needs, and explain how they relate when it is not
obvious. An adjacent cleanup or second fix gets its own PR.

<a id="verification"></a>

## Show that the change works

Explain how you established the problem, how you checked the change, and what
you observed: reproduction steps, environment, the focused test commands you
ran (`cargo test -p <crate>`, `pnpm --dir app --filter <package> test`, a
`rw` command on a project), and their results. State what you could not
check. "Tests pass" alone does not show that the change works.

- Changes that cross Rust, the schema, and TypeScript should pass
  `make check-fast`. `make check` additionally needs gfortran, cmake, and a
  GUI session; say if you could not run it.
- Changed wire types: run `make schema` and commit the regenerated files.
- Changed commands, flags, or diagnostics: `make docs-check` must pass, and
  `cargo xtask diag-docs` regenerates the tables in `docs/agents/`.
- UI changes need before/after screenshots, and a short recording when motion
  or timing matters. Attach them to the PR; do not commit them.

<a id="clean-room"></a>

## Clean room and provenance

RocketWright is a clean-room implementation. The full procedure is in
[`docs/dev/clean-room.md`](docs/dev/clean-room.md); in short:

- You may read GPL and LGPL projects (OpenRocket, openMotor, JSBSim, OpenSCAD)
  to understand an approach. Never copy their code or translate it line by
  line. Re-implement from the theory and cite the published source.
- MIT, BSD, and Apache-2.0 code may be reused with a
  `// Ported from <Project> (<License>) <path>[:<fn>]` note on the ported code
  and a `NOTICE.md` row in the same PR.
- Every `pub fn` in the physics crates cites its source
  (`/// cite: <lit-id> eq <n> p <page>`, lit-ids in
  [`docs/dev/citations.toml`](docs/dev/citations.toml)) or carries a
  `Ported from` note. Add new literature to `citations.toml` with its URL and
  license.
- Do not commit `.ork` files or OpenRocket class names. Motor files under
  `lib/motors/` need their sha256 and source in the nearest `PROVENANCE.md`.
- Data and assets need a license that allows redistribution under the
  project's license; record the source.

`cargo xtask audit`, part of every gate, checks most of this. The same rules
apply to code an AI agent wrote for you; you are responsible for what you
submit.

## License of contributions

RocketWright is licensed under the GNU Affero General Public License v3.0 or
later ([`LICENSE`](LICENSE)). Contributions are accepted under the same
license (inbound = outbound): by opening a PR you agree that your contribution
is licensed under AGPL-3.0-or-later, and you confirm that you have the right to
submit it under that license. Third-party code keeps its own license and must
be listed in [`NOTICE.md`](NOTICE.md).

## Commits and pull requests

- Conventional commit titles in plain language, for example
  `fix(sim): recovery deploys at apogee when the delay is zero`.
- PR body: the problem in a sentence or two, then how you fixed it, then the
  evidence. If an agent did the work, end with the model and harness.
- Keep plans, notes, and scratch files out of the repository.

## Closure and reconsideration

PRs that miss these requirements can be closed before review. A closure names
the rule and what is missing, such as the independent fixes to split or the
verification to add. Fix it and ask for reconsideration, or open focused
replacement PRs that link the original.
