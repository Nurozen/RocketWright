# Parity log

Diagnostics comparing RocketWright terms with the oracle goldens in
`tests/oracle/` (numbers only; no oracle internals). Each entry names the test
that reproduces it, the observed deltas, and the cause when known. Model
choices flagged by the literature map's Errata are logged here too.

## M1.34 rw-mass: case 1 per-component mass and static mass/CG

Reproduce: `cargo test -p rw-mass --test parity_case1 -- --nocapture`
(model built from `tests/oracle/case1.geometry.json`; motor `RW_C6G` at launch,
aft end at inner-tube aft + overhang; golden `case1-generic.json` `static`).

| component | oracle kg | ours kg | delta |
|---|---|---|---|
| nose cone (ogive, 2 mm wall, capped shoulder) | 1.315598e-2 | 1.318996e-2 | +0.26% |
| body tube | 1.538124e-2 | 1.538124e-2 | 0.000% |
| parachute | 7.975951e-3 | 4.735951e-3 | −40.6% |
| shock cord | 7.2e-4 | 7.2e-4 | 0.000% |
| wadding (mass component) | 2.0e-3 | 2.0e-3 | 0.000% |
| launch lug | 4.486194e-4 | 4.486194e-4 | 0.000% |
| trapezoidal fin set (3) | 6.155741e-3 | 6.217920e-3 | +1.01% |
| centering ring ×2 | 1.794478e-4 | 1.794478e-4 | 0.000% |
| inner tube | 1.482046e-3 | 1.482046e-3 | 0.000% |
| engine block | 4.806637e-4 | 4.806637e-4 | 0.000% |

Static, at launch with the motor: mass 0.069252 vs 0.072396 kg (−4.34%), CG
0.26674 vs 0.26159 m (+5.15 mm).

Causes:

- **Parachute shroud lines (the whole static delta).** The oracle parachute
  mass is canopy (σ π d²/4 = 4.736 g) plus lines (6 × 0.3 m × 1.8 g/m = 3.24 g).
  IF2 `EvalShape::Parachute` has no `line_count`/`line_length` (the source
  `Parachute` does, `rw-model` component.rs), so rw-mass weighs the canopy
  only. Adding the 3.24 g at the canopy CG gives mass +0.133% and CG +0.06 mm
  (printed by the test as `what-if`). **Resolved (M1.24 + M1.39
  integration):** IF2 `EvalShape::Parachute` carries `line_count`,
  `line_length`, `line_material`, and `rw-mass/src/component.rs::lump_mass`
  adds `line_count · line_length · λ(line_material)`. The parachute now
  matches the oracle (7.975951e-3 kg, 0.000%); static mass +0.133%, CG
  +0.06 mm.
- **Fin set +1.0%.** Our plate is ρ t A with A = 1.524e-3 m² per fin (the
  oracle's own `planform_area_m2` agrees). The oracle mass implies an
  effective area of 1.509e-3 m² (−1.5e-5 m² per fin, about 0.3 mm of root
  chord depth). Cause not identified; no tab (tab height 0) and no fillet.
- **Nose cone +0.26%.** Our cavity is the inward normal offset of the outer
  curve with a 45° chamfer down to the shoulder bore and a capped shoulder
  (rw-geom `profile.rs`); the oracle's wall/shoulder construction evidently
  differs slightly. Outer volume, shoulder, and density agree. **Resolved
  (M2-parity):** the chamfer had no source; without it (wall MI-07 +
  shoulder tube MI-18 + cap, MI-25) the nose is 1.315640e-2 kg (+0.003%).

Errata-driven model choices in rw-mass:

- Fin roll inertia keeps the cross term 2 r_t η̄ m that amcp-706-280 Table 6-1
  (and mil-hdbk-762 Table 7-1) omit; rw-mass integrates the plate exactly
  (`tests/analytic.rs::trapezoidal_fin_set` checks the corrected closed form
  and the size of the dropped term).
- CG override follows MI-04 literally: the group's transverse inertia about
  the new CG is I_yy + m Δ² (not a rigid move).



Deltas between RocketWright physics and the OpenRocket oracle goldens
(`tests/oracle/`), and the model choices behind them. Oracle numbers are a
diagnostic: we do not tune coefficients to them. Every coefficient stays
cited to `literature-map.md`. Delta = (ours / oracle − 1).

## rw-aero (M1.37 + M1.38)

### Model choices

| Term | Choice | Rows | Note |
|---|---|---|---|
| Subsonic C_f compressibility | Niskanen 1 − 0.1 M² for smooth and rough | CC-03 | Barrowman uses 0.09 / 0.12 (Errata). |
| Fin LE drag | Niskanen (3.89) | PD-05 | Barrowman's transonic slope is 1.5, not 1.785, and adds +0.0231/M⁶ supersonic (Errata). |
| Roughness-limited C_f | Used as a floor on the turbulent C_f | SF-03, SF-05, SF-06 | (3.79) only approximates where (3.78) meets (3.80) (Fig 3.10). Switching on Re_crit,ε alone leaves a jump of about 7% at the switch. |
| Boundary layer | Fully turbulent by default (thesis §3.4.1); laminar/transitional (Barrowman 4-2, 4-6) via `AeroModel::with_boundary_layer` | SF-B67-002, SF-B67-006 | |
| K_T(B) | 1 + r_t/(s + r_t) | BW-32 | The slender-body form (3-96) with +π/4 is kept as a cross-check (`fins::kt_b_slender_body`); within 3% at τ = 2. |
| K_B(T) (M1.38-p) | Included: fin-set row = (C_Nα)_N [K_T(B) + K_B(T)] = (C_Nα)_N (1 + r_t/(s + r_t))² subsonic | BW-B67-068, BW-B67-071, BW-B67-078 | Niskanen (3.55) neglects K_B(T); Barrowman (3-94)/(3-98)/(3-106) keeps it. Supersonic K'_B(T) (Fig 3-9) is not digitised, so K_B(T) fades to 0 over M 0.9 to 1.5 with the fin transonic blend. |
| CP of the K_B(T) load | At the fin CP | BW-B67-070, BW-B67-074 | Barrowman (3-101) needs β·AR ≥ 4 (case 1: β·AR ≈ 1.1); Fig 3-10 for lower β·AR is not digitised. Using (3-101) anyway would move the case-1 total CP about 0.9 mm forward. |
| K_3 (Busemann) | Barrowman, with −12 M² | BW-B67-008 | Niskanen (3.44) drops it (Errata). |
| N-fin factor (M1.38-p) | niskanen-2013 (3.54): N/2 × fin–fin factor (1.000 for N ≤ 4; 0.948, 0.913, 0.854, 0.810 for N = 5..8; 0.750 above) | BW-B67-012, BW-29 | Barrowman (3-11) gives N/2 for N = 3, 4. The 2009 thesis roll reduction (−15 % for N = 3, −6 % for N = 4) is dropped, as niskanen-2013 pdf 42 does. N = 3 now gives 1.50 (was 1.3875 roll-averaged). |
| Fin C_Nα and roll damping, M 0.9 to 1.5 | C¹ cubic blend between (3.40)/(3.69) and (3.49)/(3.72) | BW-19, BW-26, DM-10, DM-13 | The thesis prints no transonic rule. This blend follows the constraint style of (3.36). |
| Supersonic fin CP fit (3.35) | Clamped to 0.25 to 0.5 of the MAC | BW-14 | At low AR·β the fit's denominator nears 0. |
| Nose drag, ellipsoid/power/parabolic/Haack | Cone curve with the same l_n and d at M ≥ 1 | PD-14, PD-19 | Stoney C_3(M) data is not in any local source (Gaps 5). The `model` string says "cone fallback". |
| Subsonic nose drag | a M^b + C_0, fitted to value and slope at M = 1 | PD-02 | |
| Boattail | A_base/A_bt taken as 1 | PD-04 | Zero length then equals the base drag of the step, as the text states. |
| Shoulders | Nose drag of base radius r_1 − r_0, on area A_1 − A_0 | PD-03 | |
| Axial drag vs α | Cubic Hermite pieces through the stated constraints | PD-11 | Coefficients are not printed (Gaps 4). |
| Pitch damping | Niskanen (3.59), (3.60) | DM-03, DM-04 | Barrowman's C_mq (3-115) is blank in the scan. `eval` uses the outer-body volume centroid as the CG; `eval_with_cg` takes the real CG. |
| Roll interference k_T(B), k_R(B) | Not applied (Niskanen model) | DM-B67-028, DM-B67-042 | |
| Lug / button friction | Not counted (thesis (3.85) uses body + fins only) | SF-08 | |

### Case 1, α = 0, sea level (2026-10-16)

Test model: `crates/rw-aero/src/testutil.rs` `case_model("case1")`, built from `case1.geometry.json`.

The fin cross-section is not in the geometry JSON, so we assume rounded. With rounded fins our body base plus half the fin trailing-edge base drag reproduces the oracle `cd_base` to 0.1%. With square fins it does not.

The oracle reports parasitic drag inside `cd_pressure` and fin trailing-edge drag inside `cd_base`. In our breakdown, fin TE drag is part of the fin pressure drag (3.93). Below, "pr+par" is our pressure plus parasitic, which includes the fin TE.

| M | CD ours | CD oracle | Δ CD | Δ friction | pr+par ours / oracle | Δ base | Δ CNα | Δ CP |
|---|---|---|---|---|---|---|---|---|
| 0.05 | 0.6470 | 0.6208 | +4.2% | −0.1% | 0.0890 / 0.0401 | −15.5% | −24.8% | −4.36% |
| 0.30 | 0.6664 | 0.6376 | +4.5% | −0.1% | 0.1009 / 0.0473 | −15.5% | −24.8% | −4.32% |
| 0.50 | 0.7055 | 0.6752 | +4.5% | −0.1% | 0.1261 / 0.0673 | −15.5% | −24.9% | −4.26% |
| 0.70 | 0.7796 | 0.7458 | +4.5% | −0.1% | 0.1795 / 0.1115 | −15.5% | −24.9% | −4.17% |
| 0.80 | 0.8491 | 0.8080 | +5.1% | −0.1% | 0.2361 / 0.1572 | −15.5% | −25.0% | −4.11% |
| 0.90 | 0.9966 | 0.9285 | +7.3% | −0.1% | 0.3690 / 0.2590 | −15.5% | −25.1% | −4.03% |

The base delta is the bucket difference: ours has the body base only, while the oracle base includes fin TE.

Open deltas for M1.38-p:

1. **Friction.** Within 0.1% at every Mach number, roughness floor included.
2. **Pressure + parasitic, +0.03 to +0.05 too high.** The launch lug (3.95)/(3.96) gives 0.068 at M 0.3, and the lug alone exceeds the oracle's whole `cd_pressure` (0.047). The lug is the leading suspect: it has l/d = 5, so (3.96) counts the full disc π r_ext². Above M 0.8, the subsonic rounded-LE term (3.89) adds most of the remaining growth.
3. **(Resolved in M1.38-p, below.) CNα −25%, CP −4.3% (0.014 m, 0.57 cal).** Our fin set gives 9.2. A combination of the oracle's CP with our fin CP station (0.3746) needs the fins to give about 12.9. The nose terms match closed forms (C_Nα = 2, CP from Barrowman (3-89)/(3-90)). The gap is in the fin-set C_Nα: the (3.40) slope × (3.54) factor × (3.56) K_T(B). The oracle's internal model is unknown to us, so nothing was changed. Revisit with the literature agent: check (3.54)/(3.56) against Barrowman (3-10)/(3-12) and AMCP 706-280, and check whether the oracle sweep is at α > 0.

### M1.38-p: case 1 fin-set C_Nα (2026-10-16)

Reproduce: `cargo test -p rw-aero --test parity_case1_cna -- --nocapture`
(model built from `case1.geometry.json`, golden `case1.aero_sweep.json`, M 0.3, α = 0).

The oracle fin row divided by our (3.40) single-fin slope is 2.512110726 at every
Mach number from 0.05 to 0.9, which is exactly 1.5 × (1 + r_t/(s + r_t))² with
r_t = 0.0125, s = 0.03. So (3.40), including β and AR = 2s²/A_fin, already
agreed. The gap was in the two factors after it:

- **N-fin factor.** The 2009 thesis (3.54) gives 1.50 (1 − 0.15 cos²(3θ/2)) for
  N = 3 (1.3875 roll-averaged). Barrowman (3-11) and niskanen-2013 (3.54), pdf
  42-43, use N/2 = 1.50 with no roll term.
- **Body-in-presence-of-tail lift.** Niskanen (3.55) keeps K_T(B) only.
  Barrowman (3-94)/(3-98)/(3-106) adds K_B(T) = (1 + 1/τ)² − K_T(B), so the
  fin-induced total is (1 + r_t/(s + r_t))² = 1.6747 rather than 1.2941. The
  oracle reports this body-carried load on the fin row, at the fin CP.

| term | oracle | ours before | ours now | delta now |
|---|---|---|---|---|
| nose C_Nα | 2.0037 | 2.0000 | 2.0000 | −0.19% |
| body tube C_Nα | 0.0168 | 0 | 0 | (body lift is 0 at α = 0) |
| fin set C_Nα | 12.9026 | 9.22 | 12.9026 | +0.00% |
| fin set CP (m) | 0.3746 | 0.3746 | 0.3746 | 0.00 mm |
| total C_Nα | 14.9231 | 11.22 | 14.9026 | −0.14% |
| total CP (m) | 0.3304 | 0.3161 | 0.3306 | +0.16 mm |

At α = 5° (secant C_N/α, oracle numbers from a black-box probe, not yet an
exported golden): nose 2.3236 vs 2.324, body tube 1.4629 vs 1.463 (eq 3.26 body
lift), fins 12.9026 vs 12.903.

Supersonic K_B(T) is a gap: Barrowman's (3-98) holds until the fin-tip Mach
cone reaches the body (3-99); beyond that K'_B(T) comes from Fig 3-9, which is
not digitised. We fade K_B(T) to 0 over M 0.9 to 1.5. The sweep golden stops at
M 0.9, so this range is unchecked.

### M1.38-p: case 1 drag, launch lug (open, literature disagrees with oracle)

`case1_drag_report` in the same test. At M 0.3, CD total is 0.6664 vs 0.6376
(+4.52%). The lug term alone is 0.0682 vs 0.0388. With the oracle's lug value
in its place, our total is within −0.09%.

The lug has l/d = 0.035/0.007 = 5. Niskanen (3.95)/(3.96) (identical in
niskanen-2009 pdf 62, niskanen-2013 and the 2026 technical documentation
(3.102)/(3.103)) give factor max(1.3 − 0.3 l/d, 1) = 1 on the full disc
π r_ext² = 3.85e-5 m², so 0.0784 C_D,stag on A_ref. The oracle lug term fits
C_D,stag × 1.896e-5 m² (the annulus π(r_ext² − r_int²) is 1.885e-5 m²) plus a
Reynolds-dependent residual of about 0.0054 that rises at low Mach. That fits a
friction-like term, which (3.85) does not include. No source in the literature
map supports the annulus-only area for l > d or a lug friction term, so the
lug model is unchanged. Revisit if a source turns up (literature agent).


## rw-sim flight (M1.39b-p, M1.39c-p, M1.39d-p) (2026-10-16)

Case 1 (`Simulation 5`, RW_C6G-7, parachute at ejection). Parity runs use
RK4 at 0.05 s, as the golden's `conditions` block records; DP5(4) (the
production default) is reported beside it. Δ = ours − oracle.

### 3DOF replay (injected thrust, mass, C_D(t))

Reproduce: `cargo test -p rw-sim --test replay_3dof -- --nocapture`. Thrust,
mass, CG, inertia and C_D come from `case1-generic.series.json` through the
IF5 doubles `TimedCd`/`TimedMass`/`sampled_curve` (the injected thrust equals
our RW_C6G curve to 4e-15 N), so this isolates the rail, integrator,
atmosphere, gravity, and equations of motion.

| key | oracle | ours | Δ |
|---|---|---|---|
| apogee (m) | 345.783 | 345.692 | −0.026% |
| time to apogee (s) | 7.7437 | 7.7256 | −0.018 s |
| max velocity (m/s) | 103.771 | 103.756 | −0.015% |
| rail-exit velocity (m/s) | 18.645 | 18.334 | −1.67% |
| altitude, rail exit → apogee | | | worst +0.69% (at rail exit), −0.03% from 0.3 s on |
| vertical velocity, rail exit → apogee | | | worst 0.17% of peak |

Rail exit: we locate s = 1.000 m exactly; the oracle reports the first of
its own steps past the rail (altitude 1.0147 m), so its value is
step-quantized high. At 1.0147 m our velocity is 18.64 m/s.

### 6DOF with our aero and mass

Reproduce: `cargo test -p rw-sim --test replay_6dof -- --nocapture`
(`rw_sim::simulate` on the model built from `case1.geometry.json`, our
`AeroModel` with damping via `eval_with_cg`, our `MassModel` + RW_C6G).
Gate model = the oracle geometry; the parachute's shroud lines
(6 × 0.3 m × 1.8 g/m = 3.24 g) come from its `line_count` / `line_length` /
`line_material` fields and rw-mass weighs them with the canopy (M1.34 entry
above). The results are unchanged from the earlier workaround (the lines as
a separate mass component over the same packed envelope).

| key | oracle | rk4 0.05 s | Δ | dp54 | Δ |
|---|---|---|---|---|---|
| apogee_m | 345.783 | 344.407 | −0.40% | 344.554 | −0.36% |
| max_velocity_ms | 103.771 | 104.812 | +1.00% | 104.845 | +1.03% |
| max_accel_ms2 | 217.056 | 216.790 | −0.12% | 216.790 | −0.12% |
| max_mach | 0.3052 | 0.3084 | +1.03% | 0.3085 | +1.06% |
| time_to_apogee_s | 7.7437 | 7.6762 | −0.067 s | 7.6772 | −0.067 s |
| optimum_delay_s | 6.1437 | 6.0762 | −0.067 s | 6.0772 | −0.067 s |
| rail_exit_velocity_ms | 18.645 | 18.326 | −1.72% | 18.471 | −0.93% |
| flight_time_s | 90.694 | 90.113 | −0.581 s | 90.150 | −0.544 s |
| landing_velocity_ms | 4.1272 | 4.1305 | +0.08% | 4.1305 | +0.08% |
| deployment_velocity_ms | 8.3413 | 8.9712 | +7.55% | 8.9619 | +7.44% |

B2 case 1 bar (apogee ±3%, max velocity ±3%, time to apogee ±0.3 s) is met
with both integrators. RK4 vs DP5(4) apogee: −0.04% (< 0.5%, no integrator
flag). Without the shroud lines (mass −4.3%, measured before the line fields
landed): apogee +1.52%, max velocity +4.75% (fails), time to apogee
−0.094 s.

Per-term causes, from the same runs:

- **Mass**: +0.15% along the burn with the lines (−4.3% without).
- **C_D while thrusting: −6%** (0.599 vs 0.638 at 1.4 s). We remove the
  motor exhaust area from the base area while thrusting (niskanen-2009
  sec 3.4.5, pdf 61; see the model choice below). The oracle's powered C_D
  equals its power-off sweep value, so it keeps the full base.
- **C_D coasting: +4.5%**, the launch-lug term (next section).
- The two C_D deltas nearly cancel on apogee; the burn deficit shows as
  max velocity +1.0%.
- **Deployment velocity +7.6%**: with no wind the 6DOF stays exactly
  vertical and falls tail-first from apogee (axial C_D only), so the speed at
  ejection is close to free fall. The oracle's vehicle pitches over after
  apogee (its zenith drifts from 90° to 50° by ejection), so it sees
  cross-flow drag. A symmetric vertical flight has no torque to start that.
  Landing velocity and flight time are set by the parachute and are within
  0.1% and 0.6%.

### Recovery replay

Reproduce: `cargo test -p rw-sim --test replay_recovery -- --nocapture`.
The gate run injects the ascent from the series (as in the 3DOF replay) and
flies our event sequence and recovery: ejection at burnout + 7 s,
parachute C_D·A = 0.8 · π 0.3²/4, point-mass descent with all drag from the
device (niskanen-2013 sec 4.2.5, pdf 78-79; the oracle's descent C_D is
also canopy-only: 115.2 on A_ref = 0.8 on the canopy).

| key | oracle | ours | Δ |
|---|---|---|---|
| ejection t (s) | 8.600 | 8.600 | 0 |
| deployment t (s) | 8.601 | 8.600 | −0.001 s |
| deployment_velocity_ms | 8.3413 | 8.5007 | +1.91% |
| ground_hit_velocity_ms | 4.1272 | 4.1272 | 0.000% |
| flight_time_s | 90.694 | 90.603 | −0.10% |

`tolerances.json` has no descent keys; the test uses 3% (the B2 group) for
velocities and flight time and 0.05 s for event times.

### Launch-lug drag (open delta, unchanged)

Our lug term is 0.0682 vs the oracle's 0.0388 at M 0.3 (+4.5% total C_D,
all of it). Literature checked for a lug model that does not use the full
disc:

- niskanen-2009 (3.95)/(3.96) pdf 62, niskanen-2013 (same equations), and
  the 2026 technical documentation (3.102)/(3.103): for l > d the reference
  area includes the inside of the tube ("no appreciable airflow" through a
  long lug), so a 35 × 7 mm lug uses π r_ext².
- The Hoerner values the same texts quote (rectangular protrusion with
  l ≥ 2h: C_D 0.74 on its frontal area; wire 1.1; pin 0.80) are frontal-area
  values. They do not support the annulus area.
- AMCP-706-280: no launch-lug or protuberance drag model. MIL-HDBK-762 §5-5.5
  (pdf p 5-56): protuberances are left out of preliminary design and refer to
  a report we do not have. Hoerner's *Fluid-Dynamic Drag* is not in
  the maintainers' reference library (`citations.toml`).
- niskanen-2009 ch. 6 validation (pdf 95): a 24 × 5 mm lug lowered the measured apogee by
  2-3%, while the full-disc model predicted 1.3%. The literature's own data
  argue against a smaller lug term.

Outcome: no citable source gives the annulus area or a lug friction term,
so the lug model is unchanged. The delta stays recorded here. Revisit if
Hoerner (protuberance chapter) is added to the literature folder.

### Model choices

| Term | Choice | Source | Note |
|---|---|---|---|
| Base drag while thrusting | Base area minus the thrusting motors' exhaust area (`AeroOptions::base_drag_power_off_only` now defaults to `false`) | niskanen-2009 sec 3.4.5 p 61 | The old default zeroed the whole base while burning (C_D −16% in the case-1 burn). |
| Gravity | `Conditions.gravity` if set; absent: WGS84 Somigliana at the site latitude (the documented engine default), or inverse-square for `geodetic = spherical` | ussa-1976 eq 17; rocketpy somigliana | The oracle's series gravity is WGS84 at 45° (9.8062 m/s², falling with altitude) under `geodetic = flat`. |
| 6DOF equations | RocketPy `Flight.u_dot` structure: Euler parameters, `I ω̇ = M − ω×Iω − İω`, lift at the CP, plus jet damping ṁ l_n² ω⊥ (MM-15) | rocketpy (MIT), `tests/frames.rs` | Pitch damping is Niskanen's C_m,damp (3.59)/(3.60), not RocketPy's ω×r at each surface; `tests/frames.rs` checks that both oppose the rate. |
| Quaternion norm | Constraint term −λ(\|e\|² − 1)e, λ = 10 s⁻¹ | n/a | Norm drift < 1e-5 over 10⁴ RK4 steps at h·\|ω\| = 0.4. |
| Tail-first flight | Axial drag uses α folded into [0, 90°] and opposes the axial velocity | niskanen-2009 PD-11 | The f_A(α) fit is only defined to 90°. |
| Descent | 3DOF point mass; drag from the deployed devices only | niskanen-2013 sec 4.2.5 p 78-79 | Parachute C_D default 0.8; streamer C_D from (C.6) when unset. |
| Tumble | Ejection with no device deployed: C_D·A = 1.42 A_f,eff + 0.56 A_bt | niskanen-2013 eq 3.98, 3.99, Table 3.4, pdf 63-64 | A_f,eff = one fin's area × the Table 3.4 efficiency factor. |

### Case 1 end to end: `rw sim` + `rw diff run --golden` (M1.28-M1.31, 2026-10-16)

Reproduce: `cargo test -p rw-cli --test cli_e2e case1` (or `rw sim simulation_5`
then `rw diff run <run> --golden tests/oracle/case1-generic.json` in a copy of
`fixtures/case1`). The fixture's fins now say `cross_section = "rounded"`, the
same assumption as the replay builder above; with the default (square) the
fixture's C_D was 0.868 vs 0.666 at M 0.3 and apogee −13.5%.

| key | oracle | ours | Δ | tol |
|---|---|---|---|---|
| apogee_m | 345.78 | 344.41 | −0.40% | 3% |
| max_velocity_ms | 103.77 | 104.81 | +1.00% | 3% |
| time_to_apogee_s | 7.7437 | 7.6762 | −0.068 s | 0.3 s |
| mass.cg | 0.26159 | 0.26165 | +0.06 mm | 1 mm |
| aero.cp | 0.3304 | 0.33056 | +0.16 mm | 3 mm |
| stability.liftoff | 2.7524 | 2.7562 | +0.004 cal | 0.1 cal |

No setup mismatch (conditions hash, config id, sim name, motor digest).

## M1.42 BC1: case 1 end to end from `fixtures/case1` (2026-10-16)

Reproduce: `cargo test -p rw-check --test parity_case1_static -- --nocapture`
(`fixtures/case1` opened with a read-only `rw_project::Session`: the real
evaluation and static check, then `rw_sim::simulate` on the fixture's own
`Simulation 5`, RK4 at 0.05 s; DP5(4) beside it). Scoreboard:
`make bar-parity CASE=1` (the same test writes `target/parity/ours/case1-generic.json`;
setup identity matches the golden: geometry sha256, conditions hash, config id,
sim name, motor digest).

Static block (check at M 0.3, the golden's `mach`):

| key | oracle | ours | Δ | tolerance |
|---|---|---|---|---|
| mass.cg (m) | 0.261590 | 0.261653 | +0.063 mm | 1 mm |
| aero.cp (m) | 0.330400 | 0.330558 | +0.158 mm | 3 mm |
| stability.liftoff (cal) | 2.75240 | 2.75619 | +0.0038 | 0.1 |
| aero.cna | 14.9231 | 14.9026 | −0.14% | report |
| mass.liftoff (kg) | 0.072396 | 0.072492 | +0.133% | report |

Flight (gate keys; the other summary keys equal the 6DOF replay table above
to the printed digits):

| key | oracle | rk4 0.05 s | Δ | dp54 | Δ | tolerance |
|---|---|---|---|---|---|---|
| apogee_m | 345.783 | 344.407 | −0.40% | 344.554 | −0.36% | 3% |
| max_velocity_ms | 103.771 | 104.812 | +1.00% | 104.845 | +1.03% | 3% |
| time_to_apogee_s | 7.7437 | 7.6762 | −0.067 s | 7.6772 | −0.067 s | 0.3 s |

Fixture fix: `fixtures/case1/rocket.rw.toml` had no fin `cross_section`, so it
took the default `square`. Square fins put C_D at M 0.3 at 0.868 (oracle
0.638): apogee −13.5%, max velocity −4.6%, time to apogee −0.69 s, all out of
tolerance. The oracle geometry does not record the cross-section; the fixture
now says `rounded`, the choice the rw-aero parity above already makes (rounded
reproduces the oracle `cd_base`), and the fixture flight then equals the
geometry-built 6DOF replay. The `[deploy.chute] altitude = "200 m"` that the
generator writes has no effect with `event = "ejection"` (checked: the same
summary without it).

## M1.42b: case 1 through the CLI, with per-term triage (2026-10-16)

Reproduce: `cargo test -p rw-cli --test parity_case1 -- --nocapture` (a copy of
`fixtures/case1`: `rw check --json`, `rw sim simulation_5`, `rw diff run <run>
--golden tests/oracle/case1-generic.json`; the same sim with the shipped
DP5(4) as `simulation_5_dp54`, then `rw diff run <rk4> <dp54>`). Scoreboard and
triage: `make bar-parity CASE=1` (the test is the case-1 producer; then
`scripts/bar/triage.ts`).

The gate run is the fixture's own RK4 at 0.05 s, because the golden's
`conditions` record RK4 and the conditions hash would otherwise mismatch.
The DP5(4) run's diff lists exactly `conditions_hash` and `sim_name`
mismatches; the test scores its rows against the same tolerances. Every
`keymap.json` key has a row; every case-1 key in `tolerances.json` passes,
with the tolerance string the diff reports. The static rows equal the
`rw check` values. No setup mismatch on the gate run (geometry sha256,
conditions hash, config id, sim name, motor digest).

| key | oracle | rk4 0.05 s | Δ | dp54 | Δ | tol | result |
|---|---|---|---|---|---|---|---|
| apogee_m | 345.783 | 344.407 | −0.40% | 344.578 | −0.35% | 3% | pass |
| max_velocity_ms | 103.771 | 104.812 | +1.00% | 104.853 | +1.04% | 3% | pass |
| time_to_apogee_s | 7.7437 | 7.6762 | −0.067 s | 7.6774 | −0.066 s | 0.3 s | pass |
| mass.cg (m) | 0.261590 | 0.261653 | +0.063 mm | | | 1 mm | pass |
| aero.cp (m) | 0.330400 | 0.330558 | +0.158 mm | | | 3 mm | pass |
| stability.liftoff (cal) | 2.75240 | 2.75619 | +0.0038 | | | 0.1 cal | pass |
| aero.cna | 14.9231 | 14.9026 | −0.14% | | | | report |
| max_accel_ms2 | 217.056 | 216.790 | −0.12% | 216.790 | −0.12% | | report |
| max_mach | 0.3052 | 0.3084 | +1.03% | 0.3085 | +1.07% | | report |
| flight_time_s | 90.694 | 90.113 | −0.581 s | 90.156 | −0.537 s | | report |
| landing_velocity_ms | 4.1272 | 4.1305 | +0.08% | 4.1305 | +0.08% | | report |
| rail_exit_velocity_ms | 18.645 | 18.326 | −1.72% | 18.471 | −0.93% | | report |
| deployment_velocity_ms | 8.3413 | 8.9712 | +7.55% | 8.9599 | +7.42% | | report |
| optimum_delay_s | 6.1437 | 6.0762 | −0.067 s | 6.0774 | −0.066 s | | report |

Per-term triage (`scripts/bar/triage.ts`; Δ = ours − oracle):

| term | row | ours | oracle | Δ |
|---|---|---|---|---|
| mass/CG | liftoff mass (kg) | 0.072492 | 0.072396 | +0.13% |
| mass/CG | mass(t), worst over the burn | | | +0.14% (t 0.14 s) |
| mass/CG | CG(t), worst over the burn | | | +0.11 mm (t 1.60 s) |
| CP/CNa | CP / CNα / stability | | | +0.16 mm / −0.14% / +0.004 cal |
| CD(M) | coast CD at M 0.05 … 0.30 (vs `aero_sweep`) | 0.647 … 0.666 | 0.621 … 0.638 | +4.2% … +4.5% |
| CD(M) | mean burn CD (vs series) | 0.594 | 0.630 | −5.8% |
| thrust | total impulse (N s) / burnout (s) / worst thrust(t) | 9.600 / 1.6 | 9.600 / 1.6 | 0.000% / 0 / < 1e-6% |
| integrator | apogee, rk4 0.05 s vs dp54 | 344.407 | 344.578 (dp54) | −0.05% (< 0.5%, not flagged) |

Reading: thrust and integrator are clean; mass, CG, CP, and CNα are within
0.15%. The flight deltas come from C_D: +4.5% while coasting (the launch-lug
term, open above) and −5.8% while thrusting (base area minus the exhaust
area, the model choice above). They nearly cancel on apogee; the burn deficit
shows as max velocity +1.0%.

## M2.1-M2.3: components, clusters, multi-stage; cases 2-7 (2026-10-23)

### Model choices

- **Tube fins (M2.1, no primary source; normal force and CP superseded by
  M2-parity below).** Niskanen 2009/2013 and the
  OpenRocket technical documentation give no tube-fin method; MIL-HDBK-762
  §5-3.3 (ringtails) is charts only. `rw-aero/src/tube_fins.rs` models each
  tube as an equivalent planar fin: chord L (tube length), span d (tube OD),
  root on the body at the tube's radial station minus d/2, square section,
  no sweep, thickness = wall. Normal force, CP, and damping reuse the fin
  path (niskanen-2009 (3.40)/(3.49) slope, niskanen-2013 (3.54) count
  factor, (3.56) K_T(B), (3.36) CP). Drag: skin friction (3.85) on the
  geometry wetted area (outside plus bore); the planar leading-edge term is
  replaced by stagnation drag (B.2) on each tube's annulus, plus base drag
  (3.94) on the same annulus. Mass is the instanced tube geometry.
- **Clusters (M2.2).** A clustered inner tube's instances (`pattern =
  "cluster"`, presets `2-row` … `7-hex`, `scale` = centre distance) each carry
  a motor (`MountedMotor.count`); thrust and propellant mass scale with the
  count; parts inside the tube repeat per instance (`eval::replicate`); each
  instance's exhaust is removed from the base area while thrusting.
- **Multi-stage (M2.3).** Ignition and separation times are resolved before
  the flight (`rw-sim/src/stages.rs`): `launch`, `previous_burnout`,
  `stage_separation` ignitions; `upper_ignition`, `burnout`, `ejection`,
  `launch`, `never` separations, plus delays. The vehicle flies in legs on
  the stage-reduced model (aero, mass, motors, recovery of the attached
  stages; reference area and length stay the whole vehicle's). Each released
  stack flies on as a branch from the separation state, in tumbling descent,
  with its own recovery devices, to its own landing
  (`runs/<sim>/<id>/branches/<stage>/`, events tagged `branch`). Ejection
  charges of a released stack fire in its branch. Known limit: a device set
  to `ejection` takes the first ejection charge of the motors still attached
  in its leg, so an upper-stage ejection device would fire on a lower stage's
  charge if the stage separated after that charge (no case does this).
- **Dual deploy.** `apogee` and `altitude` devices are independent; an
  `altitude` device whose altitude the flight never climbed above deploys at
  apogee. `deployment_velocity_ms` is the speed at the last deployment (the
  main), as the oracle reports it (case 7: 19.483 vs 19.478 m/s).
- **Burnout events.** One `burnout` per distinct motor burnout time; the
  summary's burnout (and `optimum_delay_s`) is the last one.
- **Fixtures `fixtures/case2..7`** are generated by
  `scripts/fixtures/oracle_case.py` from the geometry and golden only.
  Inputs not in the geometry export: fin cross-section (chosen per case by
  the total C_D at M 0.3 against `case<n>.aero_sweep.json`, like case 1:
  rounded for 2 and 6, square for 3, 5, 7; with the other choice C_D is
  0.989/0.772 (case 2), 1.97/1.19 (case 6), 0.472/0.628 (case 3),
  0.731/0.818 (case 5), 0.626/0.897 (case 7)); a body tube that is itself
  the motor mount (case 4) gets a 0.001 mm inner tube of the motor length at
  its aft end (our mounts are inner tubes; 5 µg); a zero-thickness oracle
  shoulder is left out (it carries no mass in the oracle, ours would be
  solid: case 7 nose 0.465 → 0.0985 kg, matching). Rail buttons sit with
  `mid` at the oracle station. Degrees are evaluated rounded to 1e-9 deg so
  `28.61 deg` hashes like the golden (case 5 conditions hash).

### Cases 2-7 against `case<n>-generic.json` (`rw diff run --golden`, rk4 0.05 s)

Δ = ours − oracle. Spec B2 targets: cases 2, 3, 5 apogee and max velocity
±3 %, time to apogee ±0.3 s; case 4 ±5 %; cases 6, 7 apogee ±7 %.

| key | c2 | c3 | c4 | c5 | c6 | c7 |
|---|---|---|---|---|---|---|
| apogee_m | +0.86% pass | −0.36% pass | **+7.12% FAIL** | −0.27% pass | +0.93% pass | −0.16% pass |
| max_velocity_ms | +1.22% pass | +0.89% pass | +5.96% | **+26.42% FAIL** | +2.54% | +0.15% |
| time_to_apogee_s | +0.010 s pass | −0.028 s pass | +0.217 s | **−0.780 s FAIL** | −0.032 s | −0.041 s |
| max_accel_ms2 | −0.16% | −0.40% | −0.33% | +26.74% | +11.66% | −0.06% |
| max_mach | +1.25% | +0.92% | +5.99% | +26.47% | +2.56% | +0.16% |
| flight_time_s | +0.54% | −1.05% | +4.14% | +11.62% | +0.77% | +0.03% |
| landing_velocity_ms | +0.10% | +0.24% | +0.00% | −12.94% | +0.08% | +0.00% |
| rail_exit_velocity_ms | −1.55% | −6.28% | −4.92% | +8.79% | −3.99% | −2.59% |
| deployment_velocity_ms | +12.83% | +26.30% | +96.05% | −12.95% | +28.63% | +0.03% |
| optimum_delay_s | +0.010 s | −0.078 s | +0.167 s | −0.830 s | −0.083 s | −0.091 s |
| mass.cg | +0.09 mm pass | **−1.40 mm FAIL** (1 mm) | +0.01 mm | +30.7 mm | +0.1 mm | +0.0 mm |
| aero.cp | +0.10 mm pass | +0.35 mm pass | −20.7 mm | +3.9 mm | +0.6 mm | +1.6 mm |
| aero.cna | −0.11% | −0.11% | −47.26% | −0.19% | +0.33% | −0.08% |
| stability.liftoff | +0.0003 cal pass | +0.032 cal pass | −0.835 cal | −0.472 cal | +0.021 cal | +0.016 cal |

Gate result: cases 2, 6, 7 pass every toleranced key; case 3 passes the
flight keys (apogee, max velocity, t_apogee) and fails mass.cg by 0.4 mm;
cases 4 and 5 fail.

Triage:

- **Case 3 mass.cg −1.40 mm.** Every component matches the oracle within
  0.02 % except the ellipsoid nose cone (+1.0 g, 0.04266 vs 0.04163 kg):
  the thin-shell integral (MI-07) over-weights the blunt ellipsoid tip,
  where the wall is far from normal to the axis. Rail exit −6.3 % with a
  matching liftoff mass (+0.4 %) is the four-motor cluster's thrust ramp on
  the 1 m rod (no toleranced key).
- **Case 4 (tube fins), apogee +7.1 %.** Mass and CG match exactly. The
  oracle's C_Nα of the tube set is 37.85 against our 19.03 (×1.99), CP at
  the same station (0.5199 m). Drag at M 0.3: ours 1.667 (friction 1.193,
  pressure 0.301, base 0.173) vs oracle 1.784 (0.636, 1.017, 0.132). The
  oracle per-tube split in the sweep (×6 tubes) is friction 0.031, pressure
  0.166, no base; ours per tube is friction 0.124, pressure 0.046, base
  0.007. The planar-fin approximation is the open delta; the oracle's
  tube-fin method is not in any clean-room source, so it is not tuned.
- **Case 5, max velocity +26 %.** Every component's mass and CG match the
  oracle, and our liftoff mass (1.4362 kg) equals the oracle's component sum
  (1.4361 kg), but the oracle's static and series mass at t = 0 is
  1.8181 kg: 0.382 kg (21 %) that no exported component carries (its CG
  implies a mass near station 0.88 m, the drogue bay). The geometry export
  misses it (a subtree mass override or an unexported part), so ORC needs to
  re-export case 5; until then max velocity, t_apogee, CG, and stability
  cannot match. Apogee lands within 0.3 % by coincidence (lighter but with
  C_D 0.878 vs 0.818 at M 0.3).
- **Case 6 (three stages)** and **case 7 (two stages, dual deploy).** Event
  sequences match the oracle (case 6 separations at 1.60 and 3.20 s, case 7
  at 1.36 s; case 7 drogue at apogee, main at 81.14 vs 81.34 s). Booster
  branches: case 6 `booster` lands at 10.5 s, `middle` at 28.8 s; case 7
  `booster` deploys at its apogee (3.53 s), ejects at 15.36 s, lands at
  19.1 s. The oracle exports no branch events yet (contract-changes M2.3
  adds `branch` so it can).
- **Deployment velocity at an ejection deployment** stays +7 … +29 % (cases
  1, 2, 3, 6), as in case 1 (M1.42b): untoleranced, open.

## M2.5 `rw import ork`: OpenRocket examples 1-7 (original matrix, report mode)

Reproduce: `make parity` (`RW_PARITY=1 cargo test -p rw-cli --test import_parity -- --nocapture`;
examples read as data from the sibling `openrocket` checkout or `$RW_ORK_EXAMPLES`;
report in `target/parity/import.json`). Offline, every motor without an
embedded curve is a generic stand-in (`RW-W103`), so flight numbers compare
generic curves against OpenRocket's real ones and are not scored.

| case | `rw check` | apogee ours vs original golden |
|---|---|---|
| 1 simple model rocket | clean (W103 only) | −1.2% |
| 2 3D printable nose cone and fins | 5 documented errors | +9.4% |
| 3 clustered motors | clean | +5.0% |
| 4 tube fin rocket | clean (tube-fin aero from M2.1) | +6.1% |
| 5 dual parachute deployment | clean | +33% |
| 6 three stage low power | clean (W102) | −32% |
| 7 two stage high power | 13 documented errors | −0.8% |

Documented errors (`crates/rw-cli/tests/golden/import_parity.known.json`,
gated exactly): cases 2 and 7 are fit/interference conflicts inside the
example models (OpenRocket does not check them): couplers wider than a bore,
airframe-bore bulkheads placed inside coupler lengths, small overlaps. Case 4
checks clean since the M2.1 tube-fin model merged (its E101 entry was
removed; numbers above re-run after the M2.1-M2.3 merge). Cases 5 and 6 (dual deploy, three
stages) need the multi-stage and deployment paths compared term by term
against the generic matrix before their deltas mean anything.

Check changes made for imports (rw-check `clearance.rs`): a part that runs
past its parent tube's end but stays inside the bore of coaxial tubes it fits
(a coupler across a joint) is not a protrusion; the through-the-wall rule
applies only where the part lies alongside its parent; axial overlaps under
0.1 mm (inch-rounding glue lines) are not interference.

## M2.12 Bella Lui (RocketPy validation, measured flight)

Reproduce: `cargo test -p rw-sim --test validation -- bella_lui --nocapture`
(vehicle `tests/validation/bella_lui/`, ERA5 sounding `era5_profile.csv`;
translation choices in that directory's `README.md`).

| metric | measured | ours | delta |
|---|---|---|---|
| apogee (m above the pad) | 458.97 | 470.59 | +2.53% (gate ±10%) |
| time to apogee (s) | 10.53 | 10.74 | +0.21 s |

Our drag comes from the geometry (no Cd override); fin thickness and wall
thickness are assumed (not in the source).

## M2-parity: ellipsoid nose mass (case 3) and tube fins (case 4) (2026-10-23)

Reproduce: copy `fixtures/case<n>` to a temp dir, `rw sim <sim>`, then
`rw diff run <run> --golden tests/oracle/case<n>-generic.json` (case 3
`simulation_5`, case 4 `simulation_1`; rk4 0.05 s). Unit checks:
`cargo test -p rw-mass --test analytic ellipsoid_nose_shell_and_shoulder`,
`cargo test -p rw-aero tube_fins::`. Δ = ours − oracle.

### Case 3 mass.cg: the nose wall-to-shoulder chamfer

The ellipsoid nose (100 mm, Ø55 mm, 2 mm wall, capped 35 mm × Ø48 mm
shoulder with a 2 mm wall) weighed 0.04266 kg vs 0.04163 kg. The thin-shell
integral was not the cause: rw-mass weighs bulk-density noses as the outer
solid minus the rw-geom cavity, and that cavity followed the exact inward
offset (MI-07, a wall of constant thickness t_w) except near the base,
where a 45° chamfer from the offset (r 25.5 mm) down to the shoulder bore
(r 22 mm) added a ring of about 9.3e-7 m³ (+0.98 g) that no source
describes. Removed in rw-geom `profile.rs` (noses and transitions): the
part is now the wall (outer half-spheroid minus its inward offset) + the
shoulder annulus (MI-18) + the cap disc, by superposition (MI-25), with no
joint material (literature-map Gaps 12). The new analytic test integrates
the exact parametric offset of the ellipsoid: rw-mass agrees to 1e-4 in mass
and 0.03 mm in CG, and a 10 µm wall gives ρ A_wet t with the closed-form
half-spheroid area to 2e-3.

| key | oracle | before | after | tol |
|---|---|---|---|---|
| case 3 nose mass (kg) | 0.041630 | 0.04266 (+2.5%) | 0.041683 (+0.13%) | |
| case 3 mass.cg (m) | 0.46758 | 0.46618 (−1.40 mm) FAIL | 0.46750 (−0.08 mm) pass | 1 mm |
| case 3 stability.liftoff (cal) | 1.4840 | 1.5159 (+0.032) | 1.4919 (+0.008) | 0.1 |
| case 3 apogee_m | 324.62 | −0.36% | −0.26% | 3% |
| case 3 max_velocity_ms | 106.24 | +0.89% | +1.15% | 3% |
| case 3 time_to_apogee_s | 7.2326 | −0.028 s | −0.032 s | 0.3 s |
| case 1 nose mass (kg) | 1.315598e-2 | +0.26% | +0.003% | |
| case 1 mass.cg (m) | 0.26159 | +0.06 mm | +0.11 mm | 1 mm |

Case 3 now passes every toleranced key. Other cases' CG deltas after the
change: case 2 +0.10 mm, case 6 +0.14 mm, case 7 0.0 mm; case 1 still passes
(goldens `check.simple.*`, `diff_run.case1.txt`, rw-check `simple.json`,
rw-draw `simple.profile.*` re-blessed for the 0.05 g nose change).

### Case 4 tube fins: annular-wing normal force

Literature found (`citations.toml`, literature-map
TF rows): NACA TN 4117 (Fletcher 1957, annular airfoils A = d/c = 1/3 to 3:
lift slope ≈ 2 × the plane rectangular wing of the same A; Ribner's low-A
curve C_Lα = π A on S = d c), MIL-HDBK-762 §5-3.2/§5-3.3 and AMCP 706-280
§8-2.3, §8-3.1.5 (ringtails ≈ 2 × planar fins; ring drag on the rolled-out
planform, eq 5-39 / 8-24; flat-plate friction on ring surfaces). Not
obtainable: Weissinger's ring-wing theory in translation (none found on
NTRS), Ribner 1947 (AIAA, copyrighted), the DTIC ring-wing reports (403).
No source treats a cluster of tubes around a body.

Model (`rw-aero/src/tube_fins.rs`): one tube's slope = 2 × the (3.40)/(3.49)
rectangular-wing slope at AR = A = d/L on S = d L (d = bore, TN 4117's
definition); N tubes sum N slopes (a ring's lift does not depend on its roll
position; planar fins sum N/2); the (3.54) fin–fin factor and Barrowman
K_T(B) + K_B(T) of the equivalent panel (span = OD, root at r_t) are kept as
for planar fins. CP: (3.36) at AR = A (TN 4117 conclusion 1). Drag is
unchanged in value and now cited as the ringtail rolled-out-planform rule:
friction (3.85) on both faces, stagnation (B.2) and base (3.94) on the edge
area π d̄ t = π(r_o² − r_i²).

Per tube in case 4 (A = 24.13/76.2 = 0.317, M 0.3): the ring slope is
0.989/rad on S, within 1% of curve B (π A = 0.995), so the per-element change
from the old planar panel (AR = 2d/L) is small (ring/panel = 0.96 with
d = bore); the factor of about 2 is the roll weighting (N against N/2).

| key | oracle | before (planar) | after (ring) | tol |
|---|---|---|---|---|
| tube set C_Nα (M 0.3) | 37.847 | 19.03 (−49.7%) | 36.70 (−3.0%) | |
| tube set CP (m) | 0.519938 | 0.519938 | 0.519938 | |
| aero.cna | 39.877 | 21.03 (−47.3%) | 38.70 (−2.96%) | |
| aero.cp (m) | 0.49650 | 0.47579 (−20.7 mm) | 0.49595 (−0.55 mm) | |
| stability.liftoff (cal) | 1.7516 | 0.9162 (−0.835) | 1.7293 (−0.022) | |
| mass.cg (m) | 0.45307 | +0.01 mm | +0.01 mm | |
| apogee_m | 279.83 | 299.77 (+7.12%) FAIL | 299.77 (+7.12%) FAIL | 5% |
| max_velocity_ms | 119.14 | +5.96% | +5.96% | |
| time_to_apogee_s | 5.7785 | +0.217 s | +0.217 s | |

The ×2 of the oracle's tube C_Nα is now explained by cited terms, and the
static stability is within 0.02 cal. Apogee is unchanged: the flight is
vertical with no wind, so C_Nα does not enter it; the gap is drag. C_D at
M 0.3 is ours 1.667 (friction 1.193, pressure 0.301, base 0.173) vs oracle
1.784 (0.636, 1.017, 0.132), −6.6%. The oracle's per-component rows sum to
friction 0.480 and pressure 0.188 (tube set 0.031 + 0.166, lug 0.022), so
about 0.16 of its friction and 0.83 of its pressure drag sit on no exported
component; the sources above give no term of that size for a ring of thin
tubes (TF-08 rolled-out section drag is the edge drag we already count;
TF-09 friction on both faces is what makes our friction larger). Burn-phase
C_D is also lower than the oracle's because the 24 mm motor's exhaust area
removes 94% of the body base while thrusting (niskanen-2009 sec 3.4.5,
model choice above), which shows as max velocity +6%. No cited model closes
the case-4 apogee gap; it stays open (+7.12% against ±5%), not tuned.

Case 5 is unchanged (the missing 0.382 kg in the oracle export, M2.1-M2.3
triage); cases 2, 6, 7 still pass.


## M2.4c: case 5 stage mass override; oracle fin cross-sections (2026-10-23)

Reproduce as M2-parity above (case 5 `simulation_5`). The oracle re-exported
case 5 (M2.4c): stage `Sustainer` overrides its mass to 1.3607771088 kg
including subcomponents (`stage_mass_override_kg`,
`stage_overrides_subcomponents_mass` on the stage's first component). That
is the 0.382 kg the M2.1-M2.3 triage found missing. The model takes it as
`[stage.<id>] override = { mass, cg, subtree = true }` (CG from the stage's
fore end; a stage owns no mass, so `subtree = false` or `cd` is RW-E055).
rw-mass applies stage overrides after the component overrides, scaling the
members' dry parts (motors excluded, MI-03/MI-04); `rw import ork` and
`rw export ork` carry `<stage>` overrides. The generator now reads fin
cross-sections from the geometry's `cross_section_*` fields instead of the
per-case C_D guesses; they agree with the guesses for every case (rounded 2
and 6, square 3, 5, 7; case 4 has tube fins), so only `fixtures/case5`
changed.

| key (case 5) | oracle | before | after | tol |
|---|---|---|---|---|
| mass at liftoff (kg) | 1.81806 | 1.4362 | 1.81806 | |
| mass.cg (m) | 0.99371 | +30.7 mm | +0.02 mm pass | 1 mm |
| stability.liftoff (cal) | 4.2213 | −0.472 | +0.069 pass | 0.1 |
| aero.cp (m) | 1.23281 | +3.9 mm | +3.9 mm FAIL | 3 mm |
| apogee_m | 1146.7 | −0.27% | **−4.32% FAIL** | 3% |
| max_velocity_ms | 241.33 | +26.42% | −0.79% pass | 3% |
| time_to_apogee_s | 13.376 | −0.780 s | **−0.333 s FAIL** | 0.3 s |
| rail_exit_velocity_ms | 74.869 | +8.79% | −3.87% | |
| landing_velocity_ms | 4.2672 | −12.94% | +0.00% | |

With the mass right, max velocity and stability match; apogee and t_apogee
now show the drag gap the lighter rocket hid. C_D at M 0.3 is ours 0.878 vs
oracle 0.818 (+7.4%). Friction agrees in total (0.5134 vs 0.5134). The
excess is the fin set and rail button: our square-section fin pressure
drag (3.89-3.93, LE stagnation + TE base) is 0.168 vs the oracle's 0.047
pressure + 0.009 base on the fin row, and our rail-button term (3.95) is
0.065 vs 0.002 (the case-1 lug/button delta, "Launch-lug drag" above). The
oracle total pressure (0.144) is 0.095 above its component rows, as in case
4. Open, not tuned.

Cases 2-7 after the M2-parity and M2.4c merges (flight keys; tol: apogee
±3% for 2, 3, 5, ±5% for 4, ±7% for 6, 7; max velocity ±3%; t_apogee
±0.3 s):

| key | c2 | c3 | c4 | c5 | c6 | c7 |
|---|---|---|---|---|---|---|
| apogee_m | +0.88% pass | −0.26% pass | **+7.12% FAIL** | **−4.32% FAIL** | +0.94% pass | −0.16% pass |
| max_velocity_ms | +1.25% pass | +1.15% pass | +5.96% | −0.79% pass | +2.55% | +0.15% |
| time_to_apogee_s | +0.010 s pass | −0.032 s pass | +0.217 s pass | **−0.333 s FAIL** | −0.033 s pass | −0.041 s pass |


## PARITY-drag: launch guides in the boundary layer; cases 4 and 5 (2026-10-23)

Reproduce: `cargo test -p rw-check --test parity_drag -- --nocapture`
(zero-α C_D of `fixtures/case<n>` vs `case<n>.aero_sweep.json`, sea level,
totals over M ≤ 0.6 and every term at M 0.3), and for flight copy
`fixtures/case<n>` to a temp dir, `rw sim <sim>`, `rw diff run <run>
--golden tests/oracle/case<n>-generic.json` (rk4 0.05 s). Δ = ours − oracle.

### Reading the oracle sweep: component rows are per instance

The oracle's per-component rows count **one instance** (one fin, one tube,
one rail button), while its totals count all of them. With that, every
"hidden" residual noted above closes exactly at M 0.3:

| case | row × instances | = oracle total share |
|---|---|---|
| 5 | fin pressure 0.04657 × 3 + button 0.00234 × 2 = 0.1444 | cd_pressure 0.1444 |
| 5 | fin base 0.00941 × 3 + body base 0.13170 = 0.1599 | cd_base 0.1599 |
| 5 | fin friction 0.03180 × 3 + bodies 0.4180 = 0.5134 | cd_friction 0.5134 |
| 4 | tube friction 0.03114 × 6 + nose, body 0.4488 = 0.6357 | cd_friction 0.6357 |
| 4 | tube pressure 0.16584 × 6 + lug 0.02202 = 1.0171 | cd_pressure 1.0170 |

So the M2.4c attribution of the case-5 excess to the fin set was wrong:
our square-section fin pressure + trailing-edge base (3.89-3.93, 3.94),
0.1679, equals the oracle's 3 × (0.04657 + 0.00941) = 0.1679, and fin
friction agrees (0.0954 vs 0.0954). The whole case-5 C_D excess was the
rail-button term.

### Model change: launch guides take the boundary-layer mean dynamic pressure

New sources (public domain, NTRS, added to
`citations.toml`): NACA TM 1299 (Tillmann 1951, drag of surface
irregularities in turbulent boundary layers) and NACA TM 1218 (Schlichting
1949, turbulent boundary layers). Literature-map rows PA-04..PA-06:

- δ = 0.37 x Re_x^(−1/5) with the 1/7-power profile (TM 1218 (17.8)/(17.9),
  pdf 34-35), x = the guide's station from the nose tip.
- q̄/Q = (1/h)∫₀ʰ (u/U)² dy = (7/9)(h/δ)^(2/7) for h ≤ δ, 1 − (2/9) δ/h
  for h ≥ δ (TM 1299 Fig 27, pdf 36).
- D = C_w q̄ f, with C_w on q̄ ≈ the free-stream value for h/δ > 1 (TM 1299
  pdf 5, square plates 1.14 vs 1.16).

`rw-aero/src/drag/parasitic.rs` (`turbulent_bl_thickness`, `mean_q_ratio`,
`boundary_layer_factor`): every lug and rail-button instance keeps its
Niskanen (3.95)/(3.96)/PA-03 free-stream drag, multiplied by q̄/Q at its own
station and height (lug height = OD, button height = its height). Limits: TM
1299 says a submerged element's C_w also depends on Re(h), which is not
modelled; Hoerner's protuberance data behind Niskanen's 0.74/0.80 are not
here, so whether they already include immersion is unknown (literature-map
Gaps 10). Not done: the pin frontal area still uses od × height, because
`EvalShape::RailButton` has no flange/base heights for the narrower neck
(an IF2 change; it would take about 11% off the case-5 button).

Launch-guide terms at M 0.3 (oracle row × instances):

| case | guide | oracle | before (free stream) | after (q̄) |
|---|---|---|---|---|
| 1 | lug | 0.0388 | 0.0682 | 0.0575 |
| 2 | lug | 0.0566 | 0.0693 | 0.0575 |
| 3 | 2 lugs | 0.0160 | 0.0282 | 0.0204 |
| 4 | lug | 0.0220 | 0.0273 | 0.0180 |
| 5 | rail button × 2 (9.7 × 9.7 mm) | 0.0047 | 0.0649 | 0.0417 |
| 6 | 2 lugs | 0.0775 | 0.1363 | 0.1066 |
| 7 | 2 rail buttons | 0.0015 | 0.0404 | 0.0256 |

Rail buttons stay about 9× the oracle's value (case 5), and its button term
rises with speed (0.0011 → 0.0043 per button from M 0.05 to 0.85) far more
than q̄ does (δ ∝ Re_x^(−1/5) gives q̄ ∝ Re^0.06). No source in the folder
gives a rail-button model that small; the remaining gap is open, not tuned.

### Zero-α C_D at M 0.3 (`parity_drag`)

| case | oracle | before | after |
|---|---|---|---|
| 1 | 0.6376 | +4.52% | +2.85% |
| 2 | 0.7722 | +1.52% | −0.01% |
| 3 | 0.6284 | +3.78% | +2.54% |
| 4 | 1.7844 | −6.56% | −7.08% |
| 5 | 0.8177 | +7.37% | +4.53% |
| 6 | 1.1902 | +5.00% | +2.51% |
| 7 | 0.8969 | +4.18% | +2.53% |

Every case except 4 moves toward the oracle; the remaining excess in cases
1, 3, 5, 6, 7 is the launch-guide term again.

### Flight keys after the change (rk4 0.05 s)

| key | c1 | c2 | c3 | c4 | c5 | c6 | c7 |
|---|---|---|---|---|---|---|---|
| apogee_m before | −0.40% | +0.88% | −0.26% | +7.12% | −4.32% FAIL | +0.94% | −0.16% |
| apogee_m after | +0.52% pass | +1.70% pass | +0.45% pass | **+7.52% FAIL** | −2.96% pass | +1.82% pass | +0.43% pass |
| max_velocity_ms after | +1.37% | +1.54% | +1.45% | +6.20% | −0.73% | +3.13% | +0.65% |
| time_to_apogee_s before | −0.067 s | +0.010 s | −0.032 s | +0.217 s | −0.333 s FAIL | −0.033 s | −0.041 s |
| time_to_apogee_s after | −0.025 s pass | +0.047 s pass | −0.001 s pass | +0.231 s | −0.215 s pass | +0.023 s | +0.004 s |

Case 5 apogee and t_apogee now pass (apogee with little margin: −2.96%
against ±3%). Case 5 aero.cp (+3.9 mm vs 3 mm) is a C_Nα/CP key, out of
scope here. Goldens re-blessed for the C_D change: rw-cli
`check.simple.json`, `set.dry.simple.json`, `diff_run.case1.txt`.

### Case 4 tube fins (open)

Per tube at M 0.3, ours vs oracle: friction 0.1240 vs 0.0311, pressure +
base 0.0526 vs 0.1658, total 0.1766 vs 0.1970 (−10%); set of six 1.060 vs
1.182, the whole −0.12 C_D gap. Our friction is the flat-plate C_f on both
faces (MIL-HDBK-762 (5-40), TF-09; the oracle's is about one quarter
of ours), our pressure is stagnation on the
annular edge (B.2) plus its base (3.94), the rolled-out ring rule (TF-08).
The oracle's 0.166 per tube is 3.2× the edge terms and fits no cited area.
Cross-check, TN 4117 Fig 5 (pdf 15): isolated Clark-Y rings have C_D ≈
0.02-0.03 on S = d c at α = 0 for every A (0.08-0.11 per case-4 tube),
friction-dominated, which supports the form of our model and gives no
support for a larger pressure term. Searched (NTRS: ring tail, ring wing
drag, annular/tube fin, lattice/grid fin; DTIC/web: tube-finned
projectiles): no public source on the drag of thin blunt tubes clustered on
a body. The case-4 apogee gap stays open (+7.52% against ±5%; the lug
change moved it +0.4%), not tuned.

## PARITY-buttons: rail-button neck and the fin body-load CP (2026-10-23)

Reproduce: `cargo test -p rw-check --test parity_drag -- --nocapture`
(`drag_report_cases_1_to_7` for C_D, `cp_report_cases_1_to_7` for C_Nα and
CP per component at M 0.3), and for flight copy `fixtures/case<n>` to a
temp dir, `rw sim <sim>`, `rw diff run <run> --golden
tests/oracle/case<n>-generic.json --units si` (rk4 0.05 s). Δ = ours −
oracle. Oracle per-component drag rows count one instance; its C_Nα rows
are per fin set (they sum to its total).

### Rail buttons: the neck sets the pin's frontal area

`EvalShape::RailButton` now carries `base_height` and `flange_height` (IF2,
contract-changes). The niskanen-2009 rail-pin rule (PA-03: a lug of the
pin's frontal area with l = d) takes the projected spool: base and flange at
the outer diameter, neck at the neck diameter (`rail_button_sections`), and
each section takes the boundary-layer dynamic pressure over its own heights
(PA-07, `profile_bl_factor`). Case 5/7 buttons are 9.7 mm high, Ø9.7 mm base
and flange of 2 mm each, Ø8 mm neck: 84.4 mm² instead of 94.1 mm².

| case | guide (M 0.3) | oracle | before | after |
|---|---|---|---|---|
| 5 | rail button × 2 | 0.0047 | 0.0417 | 0.0372 |
| 7 | 2 × 2 rail buttons | 0.0029 | 0.0256 | 0.0229 |

The neck is worth 11%, not the 9× gap. The oracle's button term behaves
like a much stronger immersion law than PA-04..PA-06: at a fixed station
its row scales about V^0.4 (0.00111 → 0.00448 per button from M 0.05 to
0.9 on case 5, where the stagnation C_D rises only 21%), and on case 7 the
aft pair (interstage) carries 2.3× less than the forward pair (0.00044 vs
0.00101), where q̄ predicts 1.1×. Its lugs follow the stagnation C_D (case
1: 0.0399, 0.0388, 0.0454 at M 0.05, 0.3, 0.9). No source in the folder
gives a rail-button drag with that dependence (TM 1299 only says C_w of a
submerged element becomes a function of Re(h)); open, not tuned
(literature-map Gaps 10).

### Case 5 aero.cp: the fin lift carried onto the body acts forward of the fins

Per-component C_Nα and CP at M 0.3 (`cp_report`): every C_Nα matched, and
nose and body CPs agreed to 0.1 mm; the fin-set CP was 3.46 mm aft (1.37353
vs 1.37007). The same shift showed on every trapezoid with a forward-swept
trailing edge (case 6 aft set −1.22 mm, case 7 −1.40/−1.28 mm) and on none
with an aft-swept one (cases 1, 2, 6 forward set: parallelograms, exact),
and it varied with span and Mach. That is the CP of the body-carried load
K_B(F): we put it at the fin CP (Barrowman's (3-101) needs βA ≥ 4).

New source: NACA TR 1307 (Pitts, Nielsen, Kaattari 1957; NTRS, public
domain; `citations.toml` `naca-tr-1307`). Its chart 16 gives the subsonic
CP of the body load from ½ x_LE,t at βA = 0 (slender body) to the
lifting-line value of Appendix D (D5, the same as Barrowman's (3-101)) at
βA ≥ 4, for λ = 0, ½, 1 and three sweep families; the fin load K_F(B) (eq
14) stays at the wing-alone CP and K_B(F) = (1 + τ)² − K_F(B) (eq 21), so
C_Nα is unchanged. `rw-aero/src/body_load.rs` evaluates D5 by quadrature
(checked against the closed form D6), stores our digitisation of chart 16 as
the fraction from the slender-body to the lifting-line CP (as the
openrocket-techdoc-2026 sec 3.2.2 normalisation; ±0.005 c_r against the
chart, both analytic endpoints checked), and interpolates in βA, r/s, sweep
family and λ. It applies to trapezoids on a constant-radius tube within the
chart's families (openrocket-techdoc-2026 pdf 47 bounds); other planforms
keep the old placement (literature-map BW-1307-01..05, Gaps 13). The shift
fades with K_B(T) through M 0.9-1.5 and with α from 10° to 20°.

Implied chart fraction from the oracle vs ours (case 5 at M 0.3: 0.628 vs
0.639; case 7 forward set: 0.914 vs 0.917; case 6 aft set: 0.691 vs 0.670).

| key (M 0.3) | oracle | before | after |
|---|---|---|---|
| case 5 fin-set CP (m) | 1.37007 | +3.46 mm | +0.06 mm |
| case 6 aft fin-set CP (m) | 0.50408 | +1.22 mm | −0.05 mm |
| case 7 fin-set CPs (m) | 1.30800, 1.94312 | +1.40, +1.28 mm | +0.02, +0.03 mm |
| case 5 aero.cp (m) | 1.23281 | +3.92 mm FAIL | +0.90 mm pass |
| case 6 aero.cp (m) | 0.43376 | +0.62 mm | +0.14 mm |
| case 7 aero.cp (m) | 1.55788 | +1.62 mm | +0.38 mm |

The case 5 remainder (+0.9 mm) is the oracle's small body-tube C_Nα rows
(0.03 in all, about −0.6 mm on the CP) and the nose (+0.1 mm). Cases 1-4
unchanged (no covered planform).

### Flight and static keys after both changes (rk4 0.05 s)

| key | c1 | c2 | c3 | c4 | c5 | c6 | c7 |
|---|---|---|---|---|---|---|---|
| apogee_m | +0.52% pass | +1.70% pass | +0.45% pass | **+7.52% FAIL** | −2.68% pass | +1.82% pass | +0.57% pass |
| max_velocity_ms | +1.37% pass | +1.54% pass | +1.45% pass | +6.20% | −0.71% pass | +3.13% | +0.77% |
| time_to_apogee_s | −0.024 s pass | +0.047 s pass | −0.001 s pass | +0.231 s | −0.191 s pass | +0.023 s | +0.013 s |
| mass.cg | +0.11 mm pass | +0.10 mm pass | −0.08 mm pass | +0.00 mm | +0.00 mm pass | +0.14 mm | +0.00 mm |
| aero.cp | +0.16 mm pass | +0.10 mm pass | +0.35 mm pass | −0.55 mm | +0.90 mm pass | +0.14 mm | +0.38 mm |
| stability.liftoff | +0.002 pass | −0.000 pass | +0.008 pass | −0.022 | +0.016 pass | −0.000 | +0.004 |

Case 4 (tube fins, apogee +7.52%) is unchanged and still open (PARITY-drag:
its C_D is 7% low). Case 5 apogee moved from −2.96% to −2.68% with the
smaller button term.

## REV-phys: CD overrides, apogee fallback, tank propellant (2026-10-24)

Model choices from the final review:

- **CD override** (`override = { cd, subtree }`): `cd` is a constant zero-α
  drag coefficient on the rocket reference area. It replaces every computed
  drag term of the component (friction, pressure, steps, and the vehicle base
  term on the last body), plus all its descendants' terms with
  `subtree = true`. An outer subtree override absorbs overrides inside it. The
  term is booked as pressure drag in the breakdown, and f_A(α) still scales
  it. Reproduce: `cargo test -p rw-aero --lib cd_override`. On `fixtures/case1`
  with `override = { cd = 2.0, subtree = true }` on `body`, C_D at M 0.3 goes
  from 0.656 to 2.060 and the apogee from 347.6 m to 180.9 m.
- **Apogee fallback**: an unarmed altitude device now makes apogee a stopping
  point. When the flight never climbs above the device's altitude, the device
  deploys at apogee (plus its delay) instead of the vehicle landing
  ballistic. Reproduce: `cargo test -p rw-sim --lib
  altitude_device_above_apogee`.
- **Tank propellant**: a filled `tank` component now carries
  m = ρ V_fill (V_fill is `fill.volume`, or `fill.fraction` × the internal
  volume, clamped to the cavity). ρ comes from the NIST reference density
  table, which moved to `rw_model::fluids` and is re-exported by
  `rw_liquid::props`. A tank fed by an active liquid engine
  (`MotorSource::Liquid` with a feed node `component = <tank>`) counts only
  its shell, because the engine's curve carries the propellant. An unknown
  propellant loads no mass. Reproduce: `cargo test -p rw-mass --test tank`.

Cases 1-7 (`rw sim` + `rw diff run --golden`, rk4 0.05 s): every summary and
static key is byte-identical to the previous build. No fixture uses a CD
override, an altitude-only device above its apogee, or a tank component. Case 4
apogee is +7.52% (open, as above).

## PARITY-tubes, PARITY-buttons-2: tube-fin flow paths, rail-button immersion (2026-10-29)

Reproduce: `cargo test -p rw-check --test parity_drag -- --nocapture`
(C_D per term at M 0.3, totals over M ≤ 0.6), and for flight copy
`fixtures/case<n>` to a temp dir, `rw sim <sim>`, `rw diff run <sim>
--golden tests/oracle/case<n>-generic.json --units si` (rk4 0.05 s). Unit
checks: `cargo test -p rw-aero --lib -- tube_fins parasitic`. Δ = ours −
oracle; oracle drag rows are per instance (PARITY-drag).

### Model change: tube fins by flow path (`rw-aero/src/tube_fins.rs`)

Each tube's drag is split by where the air goes (literature-map TF-10,
TF-11, Gaps 11):

- **Bore**: pipe flow. The Darcy–Weisbach drop Δp = f (L/d) ρ V²/2 (sp-125
  eq 7-7) over the bore area at the flight speed, f = 64/Re_d below 1200
  (eq 7-8), else the Moody chart (fig 7-20, Colebrook form, ε = the tube
  roughness). It replaces flat-plate friction on the bore and is booked as
  friction.
- **Corner channels**: the region between a tube, the body, and the rays
  from the body axis tangent to the tube (closed by the neighbour when the
  tubes touch, as in case 4) is taken as a blunt face: stagnation (B.2) in
  front, base (3.94) behind, on its frontal area. Its Darcy loss f L/D_h is
  above that of a closed face (case 4 at M 0.3: D_h ≈ 2.5 mm, f L/D_h ≈ 1.6
  against C_D•,stag + C_D,base ≈ 1.0), so little air passes. This is our
  argument; no source treats it.
- **Outside**: flat-plate friction (3.81)-(3.82) with no thickness factor
  (MIL-HDBK-762 (5-40)) on the outer surface outside the channels, less the
  body surface the channels cover (the body term keeps its whole surface).
  For case 4 (six tubes of the body radius, touching) that is half of each
  tube's outside.
- **Wall edges**: stagnation and base drag on π(r_o² − r_i²), unchanged
  (AMCP 706-280 eq 8-24).

C_Nα and CP of the tube set are unchanged (M2-parity ring model).

Per tube in case 4 at M 0.3:

| term | before | after | oracle row |
|---|---|---|---|
| outside friction | 0.1240 (outside + bore, flat plate) | 0.0311 | friction 0.0311 |
| bore pipe flow | (in friction) | 0.0770 | |
| blunt fronts, stagnation (before: wall edges only; after: + corner channels) | 0.0457 | 0.0903 | |
| blunt backs, base (same areas) | 0.0069 | 0.0137 | |
| total per tube | 0.1766 (−10.4%) | 0.2122 (+7.7%) | 0.1970 (pressure 0.1658) |

### Model change: rail buttons take q̄ from a linear layer profile (`rw-aero/src/drag/parasitic.rs`)

Rail buttons keep the PA-03 lug rule on the projected spool and the
per-section mean dynamic pressure of PA-07 (TM 1299's q̄ = (1/h)∫ q dy),
but the velocity profile in the q̄ integral is now u/U = min(y/δ, 1) instead
of the 1/7-power law (PA-08), with δ from TM 1218 (17.9) as before. So q̄/Q
= (1/3)(h/δ)² for a submerged pin (0.113 for the forward case-5 button at
M 0.3, δ = 16.8 mm, against 0.662 with the 1/7-power law): its drag falls with station (∝ x^−1.6) and
rises with speed (∝ Re_x^0.4), the dependence logged in PARITY-buttons. The
linear profile is a model choice with no source in the folder (TM 1218 and
TM 1299 use the 1/7-power law for turbulent layers; Gaps 10). Launch lugs
keep the 1/7-power profile.

Rail-button term at M 0.3 (oracle row × instances):

| case | guide | oracle | before | after |
|---|---|---|---|---|
| 5 | rail button × 2 | 0.0047 | 0.0372 | 0.0053 (+13%) |
| 7 | forward pair | 0.0020 | 0.0121 | 0.0023 (+14%) |
| 7 | aft pair (interstage) | 0.00088 | 0.0108 | 0.0010 (+14%) |

The aft/forward ratio on case 7 is now 0.44 (oracle 0.44); across the sweep
the case-5 pair is +14% (M 0.05) to +9% (M 0.9) of the oracle.

### Zero-α C_D (`parity_drag`)

| case | oracle (M 0.3) | before | after | worst over M ≤ 0.6, after |
|---|---|---|---|---|
| 1, 2, 3, 6 | | unchanged | unchanged | 3.05%, 0.87%, 2.77%, 2.92% |
| 4 | 1.7844 | 1.6580 (−7.08%) | 1.8714 (+4.88%) | 5.38% (was 10.18%) |
| 5 | 0.8177 | 0.8503 (+3.98%) | 0.8184 (+0.08%) | 0.10% (was 4.06%) |
| 7 | 0.8969 | 0.9168 (+2.23%) | 0.8973 (+0.05%) | 0.16% (was 2.33%) |

Case 4 is now 5% high instead of 7% low: +0.015 per tube over the oracle
row, all in the bore, channel, and edge terms together (the outside friction
equals the oracle's friction row). Burn-phase C_D still removes
the motor's exhaust area from the base (model choice, M2.1-M2.3), so case 4
burns about 7% lower than it coasts, which offsets part of the coast excess
in flight.

### Flight and static keys after both changes (rk4 0.05 s)

Tolerances: apogee ±3% (cases 1, 2, 3, 5), ±5% (4), ±7% (6, 7); max
velocity ±3% and t_apogee ±0.3 s (1, 2, 3, 5); mass.cg 1 mm, aero.cp 3 mm,
stability 0.1 cal (1, 2, 3, 5). Cases 1, 2, 3, 6 have no tube fins or rail
buttons and are byte-identical to the previous build.

| key | c1 | c2 | c3 | c4 | c5 | c6 | c7 |
|---|---|---|---|---|---|---|---|
| apogee_m before | +0.52% | +1.70% | +0.45% | **+7.52% FAIL** | −2.68% | +1.82% | +0.57% |
| apogee_m after | +0.52% pass | +1.70% pass | +0.45% pass | −0.59% pass | −0.65% pass | +1.82% pass | +1.46% pass |
| max_velocity_ms before | +1.37% | +1.54% | +1.45% | +6.20% | −0.71% | +3.13% | +0.77% |
| max_velocity_ms after | +1.37% pass | +1.54% pass | +1.45% pass | +0.91% | −0.62% pass | +3.13% | +1.54% |
| time_to_apogee_s before | −0.024 s | +0.047 s | −0.001 s | +0.231 s | −0.191 s | +0.023 s | +0.013 s |
| time_to_apogee_s after | −0.024 s pass | +0.047 s pass | −0.001 s pass | −0.046 s | −0.020 s pass | +0.023 s | +0.080 s |
| mass.cg, aero.cp, stability.liftoff | unchanged (pass) | unchanged (pass) | unchanged (pass) | unchanged | unchanged (pass) | unchanged | unchanged |

Every toleranced key of every case passes; case 4 closes (apogee −0.59%
against ±5%) and case 5 apogee moves from −2.68% to −0.65% (t_apogee from
−0.191 s to −0.020 s). Case 4 aero.cna stays −2.96% (ring C_Nα, untoleranced).

`make parity` (import report, generic stand-in motors, not scored), run with
`RW_ORK_EXAMPLES` at the local OpenRocket checkout: apogee vs the original
goldens case 1 −0.6%, 2 +10.3%, 3 +5.8%, 4 −13.4% (−9.3% before this
change), 5 +16.6%, 6 −31.1%, 7 +0.9%; `rw check` errors are the documented
ones.
