# Parts presets (plan M2.13, D21)

Catalog parts (body tubes, couplers, nose cones, transitions, rings,
bulkheads, launch lugs, parachutes, streamers) and the materials they use,
listed by `rw lib search` / `library_search` after the project's own library
(kind `preset` and `material`, ids `preset:<file>/<part>`). They are compiled
into the binary (`crates/rw-project/src/presets.rs`), so every project sees
them offline. Without `--limit`, a search lists every project item and at
most 100 presets; narrow it with a query or `--kind`.

```
rw lib search bt-20 --kind preset --json
rw lib show preset:estes_classic/bt_20j_30326_30332_30408 --json
```

## Source and license

Converted from the parts catalogs (`orc/*.orc`) of
[openrocket-database](https://github.com/openrocket/openrocket-database)
@ c2e7c29, licensed under the Apache License 2.0. Each file records its
upstream file (`source`), revision (`upstream`), and license; every search
result carries `source = "openrocket-database (Apache-2.0) orc/<file>"`.
The conversion changes the format (RocketWright component fields with the
catalog's own units) and drops parts with no RocketWright mapping; it is
listed in `NOTICE.md`.

## Format

```json
{"upstream": "...", "source": "orc/estes_classic.orc", "license": "Apache-2.0",
 "materials": {"<slug>": {"density": "680 kg/m^3", "doc": "Paper"}},
 "presets": [{"id": "...", "manufacturer": "...", "part_number": "...",
              "description": "...", "component": {"type": "body_tube", ...}}]}
```

Densities are SI by material type (bulk kg/m^3, surface kg/m^2, line kg/m).
A catalog mass becomes `override.mass`. Required fields the catalogs do not
record (parachute `cd`, packed sizes) are listed in each search result's
`data.preset.needs`; set them when adding the part.

## Regenerating

Python 3, standard library only, byte-deterministic, from a checkout of
[openrocket-database](https://github.com/openrocket/openrocket-database) at
the revision above:

```
git clone https://github.com/openrocket/openrocket-database ../openrocket-database
git -C ../openrocket-database checkout c2e7c29
python3 -I scripts/presets/gen_presets.py ../openrocket-database lib/presets
python3 -I scripts/presets/gen_presets.py ../openrocket-database lib/presets --check
```

Use the standalone `openrocket-database` checkout, never the copy inside the
OpenRocket source tree. A new file also needs a line in
`crates/rw-project/src/presets.rs` (`FILES`; the `files_match_directory`
test enforces it).
