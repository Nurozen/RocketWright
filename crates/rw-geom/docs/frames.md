# rw-geom frames and sign conventions

Code: `crates/rw-geom/src/frames.rs`. Test against RocketPy:
`crates/rw-geom/tests/frames_rocketpy.rs` (Calisto example, RocketPy commit 9bd6ad3).

## Frames

| Frame | Axes | Use |
|---|---|---|
| Station | x in metres from the nose tip, +aft | Profiles, planforms, CG/CP |
| Body | +X aft (= station axis), +Z up in the side view, +Y = Z × X (right-handed) | Geometry, GLB |
| Component-local | Body frame of one component at roll 0, zero offset | Meshes, instances |
| three.js | Y-up; the loader rotates body → Y-up once (body (x, y, z) → (x, z, −y)) | Viewer |
| World | ENU, launch-site origin | Sim (not in rw-geom) |

## Signs

| Quantity | Convention |
|---|---|
| Roll φ | Right-handed about +X, measured from +Y: φ = +90° puts a part on +Z |
| Instance placement | `p_body = Rx(roll) · p_local + offset` (`InstanceGeometry`); `roll` is absolute (component roll + instance roll) |
| Fin plate (local) | Planform `[x, y]`: x station, y height above the root; plate stands on +Y from `root_radius`, thickness along Z; polygon CCW |
| Fin cant δ | Right-handed rotation about the outward span axis through the root mid-chord; δ > 0 turns the chord (LE→TE) toward −Z on a fin at φ = 0 and gives a positive rolling moment about +X in forward flight |
| Fin tab | Polygon in the planform frame with y ≤ 0 (inside the body) |
| Lug, tube fin, cluster tube | Built on their own axis (local X axis); `offset` carries the radial placement |
| Rail button | `outer` holds the spool meridian along the button's own axis: x = distance from the body axis (base on the body surface), r = spool radius; the spool stands on +Y at station (x_fore + x_aft)/2 |

## RocketPy mapping

RocketPy's user frame has z along the rocket axis (`tail_to_nose`: +z to the nose, `_csys = 1`;
`nose_to_tail`: `_csys = −1`), angular positions Γ measured from +y, right-handed about its +z,
and cant δ with "positive cant → negative roll moment about +z".

| RocketPy | Ours |
|---|---|
| point (x, y, z) | X = csys (z_nose − z), Y = y, Z = csys x |
| direction (x, y, z), internal body frame | (−z, y, x) |
| `angular_position` Γ (fins, rail buttons) | roll φ = −Γ |
| `cant_angle` δ | cant δ (same sign) |
| roll moment M3 about +z | −M3 about +X |
| fin set `position` (root chord point nearest the nose) | `x_fore` = root LE station |
| default `sweep_length` | c_r − c_t |

## Per-component metrics (`ComponentGeometry`)

| Field | Meaning |
|---|---|
| `outer` / `inner` | Outer contour and cavity, fore to aft; vertical steps allowed; shoulders included in `outer`; the cavity starts/ends on the axis where closed |
| `volume` | Material volume of all instances (outer solid minus cavity; fin plates include the tab) |
| `wetted_area` | Exposed outer area of all instances when `aero`, else 0. Bodies: lateral area of the shaped length (shoulders excluded); fins: 2·N·A_fin; tube fins add the bore |
| `planform_area` | One instance: side projection ∫2r dx of the shaped length (bodies), A_fin (one fin) |
| `FinGeometry.mid_chord_sweep_length` | Axial offset of the tip mid-chord from the root mid-chord (+aft) |
| `bbox` | Body-frame box over all instances |

## GLB

One top-level node per component, named by the component id, with `extras.rw_frame = "body"`,
`extras.rw_explode` (body-frame displacement at explode = 1, from `explode_dirs()`) and
`extras.rw_type`. Its translation is exactly `explode · rw_explode`. A component with one
untransformed instance carries its mesh directly; otherwise each instance is a child node
`<id>/<n>` (n = instance index) with the instance translation and roll quaternion
`[sin(φ/2), 0, 0, cos(φ/2)]`, all children sharing one mesh. Cut components are omitted;
`MeshOptions::internals = false` omits internal parts.

`explode_dirs()` lays the external chain out fore to aft along +X with each body's internal
parts pulled out right behind it, gaps of half the maximum diameter, centred on the assembly;
surface parts move with their body.
