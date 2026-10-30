# Page 05 twin-tank layout (plan M4.6b)

The dimensioned layout of the liquid propulsion module that page 05 (Propulsion >
Liquid propulsion design, `bar/visual/05-liquid-propulsion-design.png`) draws, and
how `fixtures/research-vehicle/engines/demo.rw.toml` encodes it. M4.7 builds the
procedural assembly from the engine's evaluated feed graph
(`EvaluatedModel.engines.demo`) and `engine_design` (chamber and nozzle), never
from the numbers below directly; this page records where those numbers came from.

## Frame

- **Station** (`station`): metres along the vehicle axis from the nose tip, +aft
  (the model's convention). In the image, aft is down.
- **Radial** (`radial`): signed offset in the layout plane, +right in the image
  (body +Y).
- **Depth** (`depth`, waypoints only): normal to the layout plane (body +Z),
  0 for every point here.
- Node `station`/`radial` place the node's centre. The engine node sits at the
  injector face; the chamber, throat, and nozzle follow aft of it with the
  lengths `engine_design` computes.
- **Tank axes are radial** in this module, as drawn: the two tanks lie side by
  side across the vehicle axis, heads facing the engine. (Tank components inside
  a rocket body are axial; this module is a propulsion test layout outside the
  54 mm airframe, so its tanks are inline `tank` tables on the feed nodes.)

## Measurement

The image is a perspective render at 1536×1024 px. Scale: Tank A's visible
length (about 230 px between its head tangents) is its computed length,
411.2 mm, so 1 px ≈ 1.79 mm near the tanks. Positions were read at the
centres of the parts in image space and converted relative to the engine's
injector head (image x ≈ 705 px, y ≈ 300 px), which sits at station 420 mm,
radial 0.

| Part | Image centre (px) | Δ from injector (px) | Layout (mm) | Encoded |
|---|---|---|---|---|
| Tank A (left) | 520, 245 | −185, −55 | radial −331, 98 above | `tank_a`: station 360, radial −350 |
| Tank B (right) | 915, 290 | +210, −10 | radial +376, 18 above | `tank_b`: station 360, radial +350 |
| Valve A | 630, 295 | −75, −5 | radial −134, 9 above | `valve_a`: station 390, radial −110 |
| Valve B | 765, 320 | +60, +20 | radial +107, 36 below | `valve_b`: station 390, radial +110 |
| Injector head | 705, 300 | 0, 0 | origin | `engine`: station 420, radial 0 |
| Nozzle exit | 710, 540 | +5, +240 | 430 below | computed: 460 mm below (see below) |

The two tanks are placed symmetrically at the mean of their measured offsets
(±350 mm radial, 60 mm above the injector face): the camera's perspective
lowers Tank B by about 80 mm. The valves sit symmetrically at ±110 mm.

## Dimensions

| Part | Length | Diameter | Wall | Ends | Volume | Source |
|---|---|---|---|---|---|---|
| Tank A (N2O) | 411.2 mm | 152.4 mm OD | 3 mm 6061-T6 | hemispherical | 6.000 L | spec R6.13 volume; OD chosen (6 in), length solved for 6 L |
| Tank B (ethanol) | 313.5 mm | 114.3 mm OD | 3 mm 6061-T6 | hemispherical | 2.500 L | spec R6.13 volume; OD chosen (4.5 in), length solved for 2.5 L |
| Chamber (cylinder) | 373.2 mm | 52.3 mm | - | - | L* At = 0.806 L | `engine_design`: L* 1.5 m, Ac/At 4 (SP-125 eq 4-4, 4-5) |
| Convergent cone | 35.9 mm | 52.3 → 26.2 mm | - | 20° half-angle | - | SP-125 eq 4-5 |
| Throat | - | 26.16 mm | - | - | At = 537.4 mm² | SP-125 eq 1-34 |
| Nozzle (conical) | 50.5 mm | 26.2 → 52.3 mm | - | 15° half-angle | Ae = 2150 mm² | SP-125 eq 4-7, ε 4 |
| Feed lines A | 0.45 m + 0.12 m | 10 mm ID | - | - | - | routed below |
| Feed lines B | 0.35 m + 0.12 m | 6 mm ID | - | - | - | routed below |

Tank A's hoop stress at 50 bar is 124.5 MPa (safety factor 2.22 on 276 MPa);
Tank B's is 64.9 MPa (4.25). Loads: Tank A 60% N2O (3.60 L, 2.83 kg, 40%
ullage of N2 at 50 bar); Tank B 76% ethanol (1.90 L, 1.50 kg). The fills keep
the ullage volumes near the 4:1 volume-flow ratio, so both tanks blow down at
the same relative rate and O/F stays within 4.0-4.6 over the burn.

## Line routing (feed-edge waypoints)

Lines leave each tank's inboard head on its forward side, rise to a routing
level above the tanks, cross inboard, drop to the valve, then turn into the
injector manifold. Waypoints are listed in flow order; the edge's end points
are the two nodes.

| Edge | From → to | Waypoints (station, radial) mm | bc |
|---|---|---|---|
| 0 | `tank_a` → `valve_a` | (175, −190), (175, −110) | open |
| 1 | `valve_a` → `engine` | (405, −110), (405, −30) | check_valve |
| 2 | `tank_b` → `valve_b` | (200, 170), (200, 110) | open |
| 3 | `valve_b` → `engine` | (405, 110), (405, 30) | check_valve |
| 4 | `tank_a` → `pt_a` | none (transducer stub) | closed |
| 5 | `engine` → `pt_c` | none (chamber-pressure tap) | closed |

The manifold is the 60 mm span between the two valve-side waypoints at
station 405 mm (radial ±30 mm) above the injector face.

## Where the art and the engineering disagree

- **Engine size.** The art's nozzle exit is about 110 px (≈ 197 mm at the tank
  scale); the computed exit is 52.3 mm. The art's engine is drawn about 3.8×
  larger relative to the tanks than a 1.5 kN, 20 bar engine is. The page draws
  the computed engine.
- **Tank sizes.** The art draws both tanks the same size; Tank B holds 2.5 L
  against Tank A's 6 L, so it is drawn smaller (313 × 114 mm against
  411 × 152 mm).
- **Valve drops.** The tanks hold more pressure than the design point needs, so
  the valves are sized as metering orifices that take 25.6 bar (A, 10.9 mm²)
  and 10.8 bar (B, 4.2 mm²) at the design flow; ignition is exactly at
  Pc = 20 bar and 1.5 kN, and the blowdown decays to 8.4 bar after 8.5 s.
- **Fairings.** The curved fins under the tanks in the art are decorative and
  not part of the feed model.

## How page 05 draws it (M4.7)

`app/apps/web/src/pages/liquid/scene3d.ts` builds the module from
`EvaluatedModel.engines.<id>` and `engine_design`'s sizing:

- **Frame.** Body = (radial, −depth, −station), so after the viewer's one
  body → Y-up rotation the module stands with aft down and the tanks side by
  side; page 05 frames it with its own Iso (from the front, a little right
  and above).
- **Lines.** Each edge runs from its source node's centre along that node's
  station to the first waypoint's radial line, through the waypoints, then
  square into the target node (never a diagonal); without waypoints, one
  elbow. Bends are filleted at about 3.5 line radii. A line is drawn with a
  1.5 mm wall over its `diameter`. Where a line leaves a tank it gets a boss.
- **Engine.** Injector head and manifold dome above the injector face, then
  the chamber, convergent, throat, and conical bell with `engine_design`'s
  lengths and diameters (a proportional stand-in until the design answers).
  The computed chamber liner wears a cooling jacket (bolted end collars,
  coolant bosses joined by a return line) and a bolted flange to the nozzle,
  so the engine reads as one machined module; the liner, throat, and bell
  keep the computed dimensions (D29), the jacket is visual. With L* 1.5 m and
  Ac/At 4 the chamber is long (373 mm by 52 mm); a shorter, fatter chamber
  needs a larger contraction ratio in the engine file, not a different
  drawing.
- **Manifolds.** Where a line reaches the injector head a bolted manifold
  block sits on the head, with a tee and capped purge port on top. The
  thrust ring the struts hang from sits on the jacket just under its top
  collar, clear of the manifold blocks.
- **Valves.** A ball-valve body with union nuts on the line at the valve
  node, and its actuator (yoke, pneumatic cylinder with tie rods, pilot,
  position indicator) on the side away from the viewer, so the body stays in
  view in page 05's Iso.
- **Lines.** Bolted flange pairs at the middle of each line's longest
  straight run (and the second longest when it is over 120 mm).
- **Tanks.** A pressurant fill-and-vent fitting (boss, riser, valve with
  handle, elbow, capped quick-disconnect) on each tank's top, outboard of
  centre.
- **Decorative.** The shell panels under each tank (the art's fairings) tuck
  up under the tank and hang from a hinge line on the tank's outboard head
  (pin, knuckles, mount lug), peeled open about it. They, the clamp bands,
  weld seams, valve actuators, and fittings are visual only
  (`rwProvenance: "visual"`, I13).

## Review

Overlaying this wireframe on image 05 and having one fresh critic review the
fit is part of the BAR step for page 05 (`make bar-visual PAGES=05`); it has
not been done yet.
