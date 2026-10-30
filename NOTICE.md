# NOTICE

RocketWright, Copyright (C) 2026 The RocketWright Authors, is free software:
you can redistribute it and/or modify it under the terms of the GNU Affero
General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version
(SPDX `AGPL-3.0-or-later`). The full text is in [`LICENSE`](LICENSE).

RocketWright is a clean-room implementation built from published literature
(NACA/NASA reports, theses, and papers). It contains no code copied or
translated from GPL or LGPL projects such as OpenRocket, openMotor, or JSBSim
(policy: [`docs/dev/clean-room.md`](docs/dev/clean-room.md)). The only
GPL-licensed material in the repository is test data derived from OpenRocket
(the parity goldens and case fixtures, credited under "Vendored code and data"
below), distributed under OpenRocket's GPL-3.0-or-later.

This file lists third-party code and data that RocketWright reuses or ships,
with its license and attribution. License texts the upstream licenses require
to be passed on are in [`LICENSES/`](LICENSES/), one file per upstream (NASA
CEA's are in `third_party/cea/`, the fonts' OFL texts beside the fonts). Add an
entry, and the license text if its license requires one, in the same change
that brings the material in.

## Ported source code

Files that port code keep a `// Ported from <project> (<license>) <path>` header.
Only permissively licensed projects (MIT, BSD, Apache-2.0) are ported.

| Project | License | Upstream | Used in |
|---|---|---|---|
| RocketPy | MIT (Copyright (c) 2018 Giovani Hidalgo Ceotto; [LICENSES/RocketPy-MIT.txt](LICENSES/RocketPy-MIT.txt)) | https://github.com/RocketPy-Team/RocketPy @ 9bd6ad3 | `crates/rw-geom/tests/frames_rocketpy.rs` (test oracle: fin rotation matrices, leading-edge placement, fin force, rail-button placement); `crates/rw-atmos/src/gravity.rs` (`somigliana`: WGS84 normal gravity with height correction); `crates/rw-atmos/tests/rocketpy_isa.rs` (test oracle: ISO 2533 ISA pressure, temperature, density, speed of sound, viscosity); `crates/rw-mass/src/motor.rs` (MM-09 motor-as-solid-cylinder inertia formula, `GenericMotor.propellant_I_11`); `crates/rw-sim/src/sixdof.rs` (6DOF structure from `Flight.u_dot`: Euler-parameter rotation matrix and rates, rotational equations with time-varying inertia, lift force/moment from `AeroSurface.compute_forces_and_moments`); `crates/rw-sim/tests/frames.rs` (test oracle: coast-phase `Flight.u_dot` transcription); `crates/rw-atmos/src/profile.rs` (tabulated pressure, temperature, and wind against geometric height, from `Environment.process_forecast_reanalysis`); `crates/rw-sim/tests/validation.rs` and `tests/validation/bella_lui/` (Bella Lui inputs from RocketPy's Bella Lui acceptance test); `scripts/validation/extract_era5.py` (bilinear interpolation and geopotential-to-geometric height, from `tools.bilinear_interpolation` and `Environment.process_forecast_reanalysis`) |
| three.js | MIT (Copyright © 2010-2026 three.js authors; [LICENSES/three.js-MIT.txt](LICENSES/three.js-MIT.txt)) | https://github.com/mrdoob/three.js @ r186 | `app/apps/web/src/fluid/mpm.ts` (the five-kernel MLS-MPM in TSL with fixed-point atomics, from the upstream example webgpu_compute_particles_fluid.html, which follows matsuoka-601/WebGPU-Ocean, MIT, Copyright (c) 2025 matsuoka-601, <https://github.com/matsuoka-601/WebGPU-Ocean> @ 3bd9327, [LICENSES/WebGPU-Ocean-MIT.txt](LICENSES/WebGPU-Ocean-MIT.txt); adapted to a tank SDF, a gravity vector, draining, and a density texture); `app/apps/web/src/fluid/surface.ts` (the object-space box ray setup of the upstream addon tsl/utils/Raymarching.js) |
| Lecturn | MIT (Copyright (c) 2026 T3 Tools Inc.; Copyright (c) 2026 Cloud Gatherer Labs LLC (Lecturn contributions); [LICENSES/Lecturn-MIT.txt](LICENSES/Lecturn-MIT.txt)) | https://github.com/Nurozen/lecturn @ 27ceac9 | `app/apps/server/src/mcp/http.ts`, `app/apps/server/src/broker/ViewportBroker.ts` (designs rewritten in plain TS: the HTTP MCP route, now the live tools route Lecturn calls; viewport automation broker). B17 removed the other ported files with the old chat engine (session registry, provider adapter, runtime instructions, chat timeline, composer, approval panel) |

## Vendored code and data

| Component | Version | License | Location |
|---|---|---|---|
| NASA CEA (Chemical Equilibrium with Applications), Copyright (c) 2025 United States Government as represented by the Administrator of the National Aeronautics and Space Administration, <https://github.com/nasa/cea> @ 2f79a64 | 3.3.4 | Apache-2.0 (`third_party/cea/LICENSE.txt`, `third_party/cea/NOTICE.txt`) | `third_party/cea/` (source; built and statically linked by `crates/rw-cea-sys` with feature `cea`). Modified: docs, Python, MATLAB, and Excel bindings and agent/CI files removed; `patches/0001-bindc-libtype.patch` applied at build time (static `cea_bindc`). See `third_party/cea/ROCKETWRIGHT.md` |
| NASA CEA thermodynamic and transport databases (`thermo.inp`, `trans.inp`), NASA TP-2002-211556 | 3.3.4 | Apache-2.0 (with CEA) | `third_party/cea/data/`; compiled to `thermo.lib`/`trans.lib` at build time, never committed (`make kit` installs them in `dist/kit/share/rocketwright/cea/`). `data/thermo/*.rwtbl` are rocket-performance tables CEA computes from them (`cargo xtask tables`, M4.2) |
| NASA RP-1311 example inputs and reference outputs | 3.3.4 | Apache-2.0 (with CEA) | `third_party/cea/test/main_interface/`, `third_party/cea/samples/` (test oracle for `crates/rw-cea-sys/tests/{cea,rp1311}.rs`) |
| Lecturn server (`lecturn`) and embed helper (`@lecturn/embed`), Copyright (c) 2026 T3 Tools Inc.; Copyright (c) 2026 Cloud Gatherer Labs LLC (Lecturn contributions), <https://github.com/Nurozen/lecturn> @ the commit in `vendor/lecturn/PIN` (847fc19f3f) | 0.0.50 | MIT ([LICENSES/Lecturn-MIT.txt](LICENSES/Lecturn-MIT.txt)) | `vendor/lecturn/` (built by `scripts/vendor-lecturn.sh`; the `lecturn.tgz` and `lecturn-embed.tgz` tarballs and `patches/` are gitignored; the tarballs install into `app/` as `file:` dependencies; `patches/` holds Lecturn's patches for `@ff-labs/fff-node` 0.11.0 (MIT) and `node-pty` 1.2.0-beta.15 (MIT), applied by pnpm through `app/pnpm-workspace.yaml`; `lecturn-pack.json` is Lecturn's kit descriptor). The server's runtime dependencies install from npm under their own licenses (see below) |
| openrocket-database parts catalogs (`orc/*.orc`), <https://github.com/openrocket/openrocket-database> @ c2e7c29 | c2e7c29 | Apache-2.0 ([LICENSES/openrocket-database-Apache-2.0.txt](LICENSES/openrocket-database-Apache-2.0.txt); upstream has no NOTICE file) | `lib/presets/*.json` (converted by `scripts/presets/gen_presets.py`, which changes the format and drops unmapped parts; each file records its upstream file, revision, and license; see `lib/presets/README.md`). Compiled into the `rocketwright` binary by `crates/rw-project/src/presets.rs` |
| OpenRocket-derived test data: the B2 parity goldens, exported by the oracle harness from OpenRocket runs of seven example designs bundled with OpenRocket (`A simple model rocket.ork`, `3D printable nose cone and fins.ork`, `Clustered motors.ork`, `Tube fin rocket.ork`, `Dual parachute deployment.ork`, `Three stage low power rocket.ork`, `Two stage high power rocket.ork`), and the case fixtures re-authored from those goldens. OpenRocket, Copyright (C) 2007-2025 Sampo Niskanen and others, <https://github.com/openrocket/openrocket> @ 591c5e5f7b73 | 26.xx-SNAPSHOT | GPL-3.0-or-later, with OpenRocket's additional permission under GPL section 7 to convey covered works with non-compilable data files ([LICENSES/OpenRocket-GPL-3.0-or-later.txt](LICENSES/OpenRocket-GPL-3.0-or-later.txt), OpenRocket's `LICENSE.TXT` verbatim) | `tests/oracle/case<n>-generic.json`, `case<n>-generic.series.json`, `case<n>-original.json`, `case<n>.aero_sweep.json`, `case<n>.geometry.json`, `case<n>.provenance.json` (n = 1-7; numbers and component names only, see `tests/oracle/README.md`); `tests/oracle/denylist.or.txt` (OpenRocket class names, used only by the clean-room audit); `fixtures/case1/` to `fixtures/case7/` (generated from the goldens, see `fixtures/README.md`). No `.ork` file is committed. `make kit` copies OpenRocket's `A simple model rocket.ork` from an OpenRocket checkout, a generic-motor variant of it, and the case 1 golden into `dist/kit/data/` |
| RocketPy Bella Lui data: K828FJ thrust curve (`data/motors/aerotech/AeroTech_K828FJ.eng`) and filtered flight data (`data/rockets/EPFL_Bella_Lui/bella_lui_flight_data_filtered.csv`, EPFL Rocket Team, used with permission), <https://github.com/RocketPy-Team/RocketPy> @ 9bd6ad3 | 9bd6ad3 | MIT (Copyright (c) 2018 Giovani Hidalgo Ceotto; [LICENSES/RocketPy-MIT.txt](LICENSES/RocketPy-MIT.txt)) | `tests/validation/bella_lui/lib/motors/`, `tests/validation/bella_lui/flight_data.csv` |
| ERA5 hourly data on pressure levels (Hersbach et al. 2018, doi:10.24381/cds.bd0915c6), Kaltbrunn 2020-02-22 13:00 UTC, via RocketPy `data/weather/bella_lui_weather_data_ERA5.nc` | 2020-02-22 | Copernicus licence: contains modified Copernicus Climate Change Service information 2020. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains | `tests/validation/bella_lui/era5_profile.csv` (extracted by `scripts/validation/extract_era5.py`) |

## Fonts and assets

| Asset | License | Location |
|---|---|---|
| Inter 4.1 (Regular, SemiBold), © 2016 The Inter Project Authors, <https://github.com/rsms/inter> | SIL OFL 1.1 (`crates/rw-cli/assets/fonts/OFL.txt`) | `crates/rw-cli/assets/fonts/`, `app/apps/web/public/fonts/`; Latin subsets (woff2, `Inter-OFL.txt` beside them) in `app/packages/ui/generated/fonts/` |
| JetBrains Mono 2.304 (Regular), © 2020 The JetBrains Mono Project Authors, <https://github.com/JetBrains/JetBrainsMono>, from the official release archive <https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip> (sha256 in `app/packages/ui/fonts/PROVENANCE.md`) | SIL OFL 1.1 (`app/packages/ui/fonts/OFL.txt`) | `app/packages/ui/fonts/` (source); Latin subset (woff2, `JetBrainsMono-OFL.txt` beside it) in `app/packages/ui/generated/fonts/`, embedded in `app/packages/ui/generated/lecturn-theme.json` |
| RocketWright mark, wordmark, and 31 line icons: original artwork created for RocketWright, hand-authored SVG with no third-party icon set, embedded raster, or external reference (`app/apps/web/public/brand/PROVENANCE.md`) | AGPL-3.0-or-later (the project license) | `app/apps/web/public/brand/` |
| Desktop app icon: the RocketWright mark in `#61b5ad` on `#1b1e20`, a rasterization made for RocketWright from the same SVG mark (the 1024 px original and a 128 px downscale; the 128 px file's sha256 is `aea5f56195d77cb38a15958feaf4aaeaf32028d8a5ca2e828460a5fe647e2a65`) | AGPL-3.0-or-later (the project license) | `app/apps/desktop/assets/app-icon-1024.png` (packaged app icon), `app/apps/desktop/assets/app-icon-128.png` (Lecturn registration icon) |
| Studio environment panorama (2048×1024 LDR equirectangular): generated for RocketWright with Codex's built-in image-generation tool from a project prompt and resampled without cropping; no third-party image or stock source (`app/apps/web/public/env/PROVENANCE.md`) | AGPL-3.0-or-later (the project license) | `app/apps/web/public/env/` |

## Rust and npm dependencies

Crate and package licenses are recorded by their own manifests
(`Cargo.lock`, `app/pnpm-lock.yaml`). Only MIT, Apache-2.0, BSD, ISC, Zlib,
CC0, Unlicense, MPL-2.0 (unmodified), and OFL (fonts) dependencies are allowed,
except the two proprietary agent-provider SDKs below. Both resolve in
`app/pnpm-lock.yaml`, neither is in this repository, and neither is part of a
RocketWright release build:

| Package | License | Where |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` 0.3.301 (and its platform packages) | Anthropic commercial terms (`SEE LICENSE IN README.md`) | Only `app/packages/bar-agent`, the bar-only package that `make bar-agent` (`scripts/bar/agent-loop.ts`) loads. The app does not depend on it and it is never shipped |
| `@cursor/sdk` 1.0.35 and `@cursor/sdk-<platform>` | Cursor SDK License: © Anysphere Inc., all rights reserved, use subject to Cursor's Terms of Service | A runtime npm dependency of the vendored `lecturn` server. It is not in this repository and is left out of RocketWright release builds (`EXCLUDE_CURSOR_SDK` in `scripts/desktop/package.ts`); Lecturn loads it only when present |
