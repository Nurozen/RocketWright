# Bella Lui validation (plan M2.12, spec B2)

The EPFL Rocket Team's Bella Lui flew an AeroTech K828FJ from Kaltbrunn,
Switzerland (47.213476 N, 9.003336 E, 407 m) on 2020-02-22 at 13:00 UTC and
reached **458.97 m** above the pad (`flight_data.csv`). RocketWright must
predict that apogee within **±10 %**.

```
cargo test -p rw-sim --test validation -- bella_lui --nocapture
```

Last result: apogee 470.59 m (+2.53 %), time to apogee 10.74 s (measured
10.53 s), DP5(4), ERA5 sounding.

## Files

| File | What | Source and license |
|---|---|---|
| `rocketwright.toml`, `rocket.rw.toml`, `configs/`, `sims/` | The vehicle and flight as an rw project, evaluated by rw-model | RocketWright-authored from the parameters in RocketPy `tests/acceptance/test_bella_lui_rocket.py` (MIT) |
| `lib/motors/AeroTech_K828FJ.eng` | Thrust curve | RocketPy `data/motors/aerotech/AeroTech_K828FJ.eng` @ 9bd6ad3 (MIT), byte-identical; see `lib/motors/PROVENANCE.md` |
| `flight_data.csv` | Filtered measured flight (time, altitude above the pad, vertical velocity) | RocketPy `data/rockets/EPFL_Bella_Lui/bella_lui_flight_data_filtered.csv` @ 9bd6ad3 (MIT); flight data from the EPFL Rocket Team, used in RocketPy with permission of Antoine Scardigli (2020) |
| `era5_profile.csv` | Pressure, temperature, and wind against geometric height at the launch site and hour | Extracted once by `scripts/validation/extract_era5.py` from RocketPy `data/weather/bella_lui_weather_data_ERA5.nc`. Contains modified Copernicus Climate Change Service information 2020 (ERA5 hourly data on pressure levels, Hersbach et al. 2018, doi:10.24381/cds.bd0915c6). Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains |

Re-check the extraction (needs a
[RocketPy](https://github.com/RocketPy-Team/RocketPy) checkout at 9bd6ad3):

```
git clone https://github.com/RocketPy-Team/RocketPy ../RocketPy
git -C ../RocketPy checkout 9bd6ad3
python3 -I scripts/validation/extract_era5.py \
  ../RocketPy/data/weather/bella_lui_weather_data_ERA5.nc \
  tests/validation/bella_lui/era5_profile.csv --check
```

## Translation choices

- **Stations.** RocketPy positions are measured from the dry CG. The CG sits
  1.542 m aft of the nose tip (nose position 1.3 m + nose length 0.242 m), so
  every RocketPy position `p` maps to station `1.542 - p`.
- **Airframe.** Tangent-ogive nose (242 mm), 156 mm body to the boattail at
  2.6276 m, conical boattail 50 mm long to 135 mm, three trapezoidal fins
  (root 280 mm, tip 125 mm, span 200 mm) with the root leading edge at
  2.292 m. The fin sweep is RocketPy's default (root chord minus tip chord,
  155 mm). Fin thickness (4 mm, rounded edges) and the 3 mm walls are not in
  the source; they are plausible values for this vehicle. All surfaces use the
  `smooth_paint` finish.
- **Drag.** Our own model from the geometry (no Cd override). RocketPy's test
  instead prescribes a fitted Cd(Mach) of about 0.43.
- **Mass.** The team's measured dry properties: 17.227 kg, transverse inertia
  0.78267 kg m^2 about the dry CG. They sit in one `mass_component` centred at
  1.542 m, a solid cylinder 726.85 mm long and 150 mm across, which reproduces
  that inertia. The aerodynamic shells carry no material.
- **Motor.** The committed `.eng` thrust curve with RocketPy's motor masses:
  1 kg dry plus propellant from three BATES grains (density 782.4 kg/m^3,
  radii 42.799/33.147 mm, height 152.4 mm), 0.824 kg. The `.eng` header's
  own masses (1.45/2.255 kg) are not used. The nozzle exits at the boattail's
  aft end.
- **Launch.** 4.2 m rail, 89 deg elevation (`rod_angle` 1 deg) toward
  heading 45 deg, constant gravity 9.81 m/s^2, flat earth.
- **Atmosphere and wind.** The ERA5 sounding nearest the launch hour,
  bilinear in latitude and longitude, geopotential converted to geometric
  height on the WGS84 radius at the site (as RocketPy does). The test
  replaces the sim file's standard atmosphere and calm wind with this
  profile (`Environment::with_profile`).
- **Recovery.** A drogue with Cd S = pi/4 m^2 opens 1 s after apogee. It
  does not affect the apogee gate.
