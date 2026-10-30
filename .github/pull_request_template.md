<!--
Read CONTRIBUTING.md before opening a PR. Review capacity is limited, and meeting
the requirements does not guarantee review or merging. Solve one problem per PR.
Use a conventional commit title in plain language, such as
"fix(sim): recovery deploys at apogee when the delay is zero".
-->

## Problem

<!-- The problem in a sentence or two, with expected behavior and reproduction
steps where relevant. For a physics change, the reference (source, equation,
validation case) and the numbers before and after. -->

## Change

<!-- How this fixes the problem. If it spans Rust, the schema, and TypeScript,
explain why those changes belong to the same fix. -->

## Scope and approval

<!-- Link the issue that establishes the bug, or the maintainer comment that
approves the feature's direction and scope. For a very small fix of an obvious
bug, explain why it qualifies without an issue. -->

## Verification

<!-- The focused tests or manual checks you ran and what you observed
(`cargo test -p <crate>`, `pnpm --dir app --filter <package> test`, `rw`
commands, `make check-fast`). State anything you could not check. For UI
changes, attach before/after screenshots (and a short recording when motion
matters); never commit PR-only assets. -->

## Clean room

- [ ] No code copied or translated from GPL or LGPL projects (OpenRocket, openMotor, JSBSim, OpenSCAD); reading them for the approach is fine.
- [ ] Code reused from MIT, BSD, or Apache-2.0 projects has a `Ported from` note and a `NOTICE.md` row.
- [ ] New physics functions cite their source (`docs/dev/citations.toml`).

<!-- I license this contribution under AGPL-3.0-or-later (CONTRIBUTING.md).
If you used an agent, end with the model and harness that did the work. -->
