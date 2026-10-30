# Viewport fixtures

`contract-vehicle.glb`: the M1.5 contract-fixture model
(`fixtures/contracts/evaluated-model.json`) meshed by `rw-geom` (`rw_geom::build`
then `rw_geom::mesh_glb`, default `MeshOptions`: 64 radial segments, explode 0,
internals on). The page 01 viewport falls back to it until rw-wasm exposes
`mesh_glb` (M1.32); the viewport marks it with `data-glb-source="contract-fixture"`.
Illustrative geometry, not a result. Regenerate after a rw-geom or fixture change:

    cargo run --release --manifest-path app/apps/web/scripts/fixture-glb/Cargo.toml \
      > app/apps/web/public/fixtures/contract-vehicle.glb

`viewport.test.ts` checks that its `asset.extras.model_hash` equals the fixture's.
