# Literature map: page-cited equation sheet

Every equation the physics crates (`rw-aero`, `rw-mass`, `rw-atmos`, motor mass, `rw-liquid`) implement has a row here. A physics `pub fn` cites a row's source as `/// cite: <lit-id> eq <eq> p <pdf-p>`. Lit-ids resolve in [`citations.toml`](citations.toml).

Conventions:

- **Equations are re-derived in our notation** (symbols below). The table contains no copied prose and no figures. `niskanen-2009` (CC BY-NC-ND) and `niskanen-2013` (no stated license) are cited for equations only.
- **pdf-p** is the 1-based PDF page index. This is the number to use in `cite:` lines. **printed-p** is the page number printed on that page (`-` if none). Offsets: niskanen-2009 printed = pdf − 10; niskanen-2013 printed = pdf − 9; barrowman-1967 printed = pdf − 10; ussa-1976 printed = pdf − 16 in Part 1. The handbooks use chapter-page numbers (e.g. `6-3`).
- **eq** is the source's printed number. `unnumbered` rows name the display or paragraph in the note. `Table n` rows hold data values.
- Primary-source preference: niskanen-2009, barrowman-1967, amcp-706-280, mil-hdbk-762, ussa-1976. `rocketpy` rows (MIT code, `path:function`) are implementation cross-checks used only where no primary source prints the equation. They are listed under Gaps.
- When niskanen-2009 and barrowman-1967 both give a term, both rows are kept. The Niskanen row is the model we implement unless Errata says otherwise. The Barrowman row is the cross-check, and also the primary source for terms Niskanen omits: laminar/transitional C_f, fin thickness and trailing-edge drag, K_B(T), roll-damping interference, and supersonic body.
- Text extraction: `pdftotext -layout` into `/tmp/rw-lit/` (per-page split `pages/<lit-id>/pNNNN.txt`). Garbled equations and the scanned USSA pages were checked on rendered page images.


## Row counts

| prefix | system | rows |
|---|---|---|
| CO | Coefficient definitions | 11 |
| CC | Compressibility corrections | 21 |
| SF | Skin friction (laminar, turbulent, roughness by finish) | 19 |
| PD | Pressure drag (body, nose, shoulder, boattail, fins) and drag totals | 39 |
| BD | Base drag (body and fin trailing edge) | 16 |
| PA | Parasitic drag (launch lugs, rail buttons) | 8 |
| BW | Barrowman normal force and CP (nose, body, transitions, fins, fin-body interference, combination) | 130 |
| DM | Roll and pitch damping, roll forcing | 59 |
| TF | Tube fins as annular (ring) wings, ringtails | 11 |
| GE | Nose and transition geometry | 10 |
| MI | Mass and inertia (Pappus/shell/solid, parallel axis, combination) | 32 |
| MM | Motor mass over the burn | 15 |
| AT | USSA 1976 atmosphere, 0-86 km | 33 |
| RC | Recovery, descent, tumbling | 7 |
| RB | Rigid-body 6DOF (impl.) | 4 |
| LQ | Liquid engines: thrust chamber, injector, feed, pressurant, tanks (sp-125) | 19 |
| | **total** | **434** |

## Symbols

### Core notation

| symbol | meaning |
|---|---|
| x | axial station from nose tip, positive aft [m] |
| L | total rocket length (also Reynolds length unless stated) |
| l_c | component length |
| d_ref, A_ref | reference (max body) diameter; A_ref = π d_ref²/4 |
| r(x), A(x) | local body radius; cross-section area π r² |
| r_0, r_1; A_0, A_1 | fore/aft radius and area of a body component (r_1 = nose base radius) |
| d_0, d_1 | fore/aft diameter of a transition |
| r_b, d_b | base radius/diameter at the aft end |
| V_c | component volume |
| A_wet | wetted area |
| A_plan, X_plan | planform (side-projected) area and its centroid from component front |
| l_n, f_n | nose length; nose fineness l_n/d_ref |
| N | fin count |
| c_r, c_t | fin root and tip chord |
| s | fin span, root to tip (from body surface) |
| x_t | axial distance from root LE to tip LE |
| L_f | mid-chord line length |
| Γ_c, Γ_L | mid-chord and leading-edge sweep angles |
| A_fin | one-sided planform area of one fin |
| AR | aspect ratio 2s²/A_fin |
| λ | taper ratio c_t/c_r |
| t_f | fin thickness |
| r_t | body radius at the fins |
| c̄, y_mac, x_mac | mean aerodynamic chord; its spanwise position; its LE axial position from root LE |
| c(ξ) | local chord at span coordinate ξ |
| A_lug, l_lug, d_lug | lug frontal area, length, outer diameter |
| V, M, a | airspeed, Mach number V/a, speed of sound |
| β | sqrt(\|1 − M²\|) |
| ρ, μ, ν | air density, dynamic viscosity, kinematic viscosity μ/ρ |
| q_dyn | dynamic pressure ½ρV² |
| Re, Re_crit | Reynolds number V l/ν; critical (transition) Reynolds number |
| ε | surface roughness height (by finish) |
| α | angle of attack |
| ω_pitch, ω_roll | pitch/yaw rate; roll rate |
| δ | fin cant angle |
| C_N, C_Nα | normal-force coefficient and its slope |
| C_m, C_mα | pitching-moment coefficient (about nose tip) and its slope |
| C_m,damp | pitch-damping moment coefficient |
| X_cp, X_c | CP from nose tip; component CP from component front |
| C_f, C_fc | skin-friction coefficient; compressibility-corrected |
| C_D,fric, C_D,press, C_D,base, C_D,par | friction, pressure, base, parasitic drag coefficients |
| C_D,0, C_A | zero-α drag coefficient; axial-force coefficient |
| C_D,stag | stagnation-pressure (blunt cylinder) drag coefficient |
| C_l,f, C_l,d | roll-forcing and roll-damping coefficients |
| K_T(B), K_B(T) | tail-in-presence-of-body, body-in-presence-of-tail interference factors |
| m | mass |
| ρ_m, σ_m | material bulk density [kg/m³]; surface density [kg/m²] |
| t_w | wall thickness |
| x_cg | CG station |
| I_xx, I_yy = I_zz | roll inertia; pitch/yaw inertia (about own CG unless subscripted _ref) |
| d_axis | distance between parallel axes |
| z, H | geometric altitude; geopotential altitude |
| r_0 (atmosphere rows) | effective Earth radius 6 356 766 m |
| g_0, g(z) | standard gravity; gravity at altitude |
| T, T_M | kinetic temperature; molecular-scale temperature |
| L_M,b | layer gradient dT_M/dH |
| H_b, T_M,b, P_b | layer base values (b = 0..7) |
| P | pressure |
| M_0, R*, γ | sea-level molar mass; universal gas constant; ratio of specific heats |
| β_S, S | Sutherland constants |
| t, t_b | time since ignition; burn time |
| F(t), I(t), I_tot | thrust; cumulative impulse ∫₀ᵗ F dτ; total impulse |
| m_launch, m_empty | motor launch and burnout mass |
| m_p(t), m_mot(t) | propellant remaining; motor mass |

### Additional symbols used in rows

| symbol | meaning |
|---|---|
| L_ref | Barrowman reference length (L_r) used in C_l, C_m, C_lp, C_mq and roughness ratio; typically d_ref. |
| x_f | axial station of fin root leading edge from nose tip (Barrowman l_T). |
| X_f | fin-set CP station from nose tip (Barrowman X̄_T); X_B body CP; X_T(B), X_B(T) interference CP stations. |
| y_cp,f | fin spanwise CP from body axis (Barrowman Ȳ_T) = r_t + y_mac. |
| y | spanwise coordinate from fin root chord; k_c = (λ − 1)/s chord slope; L* = s/(1 − λ) virtual-apex span. |
| C_Nα0 | 2-D airfoil lift-curve slope; F_D: Diederich planform correlation parameter; (C_Nα)_1 single fin; (C_Nα)_T fin set; (C_Nα)_B body. |
| Λ_dih | fin dihedral angle relative to lateral flow plane (Barrowman Λ). |
| Γ_1/4 | quarter-chord sweep angle. m_L = cot Γ_L. |
| τ | (s + r_t)/r_t, body-to-fin-tip radius ratio. |
| K_T(B), K_B(T) (already listed); K'_B(T) | supersonic corrected body-in-tail factor (chart); k_T(B): canted-fin roll-forcing interference factor; k_R(B): roll-damping interference factor. |
| C_l | rolling-moment coefficient = l_roll/(q_dyn A_ref L_ref); l_roll rolling moment; C_lδ = ∂C_l/∂δ; C_lp = ∂C_l/∂(ω_roll L_ref/2V); C_mq = ∂C_m/∂(ω_pitch L_ref/2V); k_l: roll-damping constant / reduced roll rate (context). |
| ξ | radial distance from body axis to fin strip (notation uses ξ spanwise; here measured from axis); F(ξ): strip normal force; α(ξ), α_0, α_1, α_B: local AoA alone / with body / at body surface; α', v: pitch-induced fin AoA and velocity; Δx = X_T(B) − x_cg. |
| n(x) | running normal load per unit length; m(x): local pitching moment; w: downwash velocity; A(x): local cross-section area; A_1,n: nose base area; A_b: body base area A(L). |
| f_B | total body fineness ratio L/d_ref; f_n, d (in 3-90): nose fineness and base diameter. |
| Supersonic body | P local pressure, P_c cone pressure at same slope, P_0, C_s, S_n series constants, s_w surface coordinate, δ_s surface slope angle (subscripts 1/2/3 = previous TE / current LE / current TE, v = initial cone vertex), η_s decay parameter, μ Mach angle, C_1 first characteristic coordinate, λ_c = 2γ/sin2μ, B, Ω shock-expansion functions, Λ_n nondimensional running load, φ circumferential angle, tcx/tcv equivalent-cone values. |
| Supersonic fin | C_p,i strip pressure coefficient; η_i local surface inclination; η_L leading-edge surface inclination; K_1, K_2, K_3, B_3 (= K*) Busemann coefficients; d_i, n_i streamwise/normal region lengths; l_i region length; r_i fraction of region behind tip Mach cone; x_p,i region forward boundary station; F_l, F_d, M_p, M_r strip/fin lift, drag, pitching and rolling moments (per q_dyn Δy); Δy strip width; A, L program reference area/length; l_w tip-Mach-cone intersection distance. |
| Drag | D_fric friction drag; ΔC_f transitional increment, k_tr = 1700; k_w heat-transfer constant; C_D,fric friction drag; ΔC_D,LE cylinder-in-crossflow LE drag increment; r_LE fin leading-edge radius; A_LE LE frontal area; h_r fin root trailing-edge thickness; C_fB TE/base friction parameter; A_base,f base area of one fin; C_p,base base pressure coefficient; C_D,BT fin trailing-edge drag; C_D,TT fin thickness drag; C_D,LE fin leading-edge drag; C_D,wave,T supersonic fin wave drag; A_wet,B body (or component) wetted area; P_f, P'_f swept Prandtl factor and corrected form; K_P Prandtl correction constant fixed by sonic value; superscript * = sonic (M = 1) value; M_cr base-drag crossover Mach; ζ = AR (t_f/c_r)^(1/3). |
| r_o, r_i | outer / inner radius of a tube or grain [m]. |
| A_r | fin root-section area (= c_r t_f for flat plate) [m²]; b = 2s fin-pair span in AMCP/MIL tables; d_c = 2 r_t. |
| y_cg | spanwise CG of a fin measured from the rocket axis [m]; η̄ = y_cg − r_t (from fin root). |
| I_yy,own | fin pitch inertia about its own CG. |
| m_i, x_i, I_xx,i, I_yy,i | mass, CG station, inertias of component i; m_p,i: propellant mass in component i. |
| m', x_cg' | overridden (measured) mass / CG. |
| m_0 | rocket gross mass at ignition; m_p,0: initial (loaded) propellant mass; ṁ: propellant mass-flow rate (>0 consumed); I_sp: specific impulse [s]; v_e = I_tot/m_p,0 effective exhaust velocity. |
| x_p, x_empty | propellant and empty-motor CG stations; I_xx,p, I_yy,p, I_xx,e, I_yy,e: propellant / empty-motor inertias about own CG. |
| r_ch, l_ch | motor chamber (propellant envelope) radius and length; n_g, m_g, l_g: grain count, grain mass, grain length; d_k: grain-k CG offset from propellant CG. |
| F_T | thrust (= F(t)); F_A: axial aerodynamic force; F_N,i, M_i: normal force / moment at station i; θ: flight-path/pitch angle as used in MIL (7-7); θ̈ pitch angular acceleration; a: axial acceleration. |
| S_noz | nozzle gyration tensor; r_noz: nozzle radius; l_noz: nozzle-to-CG distance; İ: inertia-tensor time derivative; ω: body angular-velocity vector. |
| Γ | g_0/g_0' = 1 m'/m, unit-conversion factor between geopotential and geometric metres. |
| g_0' | geopotential-metre constant, numerically 9.80665 m²/(s²·m'). |
| M (AT rows only) | local mean molar mass of air (kg/kmol); equals M_0 below 80 km. Elsewhere M is Mach number. |
| F_i, M_i | sea-level volume fraction and molar mass of gas species i (Table 3). |
| T_7 | kinetic temperature at z = 86 km (186.8673 K). |
| a_0, μ_0, ν_0 | sea-level speed of sound, dynamic and kinematic viscosity. |
| F_N, M_pitch, M_roll, D | normal force, pitching moment (about nose tip unless stated), rolling moment, drag force. |
| C_D• | drag coefficient referenced to the component's own frontal area A_comp (converted by CO-11). |
| P_G | Prandtl factor 1/β. |
| q_stag | stagnation pressure; C_D•,stag blunt-cylinder (stagnation) drag coefficient. |
| Re_crit,ε | roughness-limited critical Reynolds number. |
| f_B | rocket fineness ratio L/d_ref; f_n: nose fineness ratio l_n/d_ref. |
| φ_j | nose–body joint angle (0 for a tangent joint); φ_n: cone half-apex angle. |
| a_i, b_i | high-subsonic interpolation constants (PD-02); a_n, b_n: fineness-scaling constants (PD-17). |
| A_base, A_bt | base area and boattail frontal area; γ_bt = l_c/(d_0 − d_1) boattail length-to-height ratio. |
| A_motor,thrusting | nozzle-exit area of burning motors subtracted from base area. |
| r_ext, r_int, l_lug, d_lug | lug outer radius, inner radius, length, outer diameter. |
| K_lift ≈ 1.1 | body-lift constant; X_lift: body-lift CP; A_plan: planform area. |
| x_LE(ξ) | leading-edge station at span ξ; X_f: fin CP (from root LE in BW-11..15, from nose tip in BW-B67-029/031). |
| C_Nα0 | 2-D lift-curve slope; F_D: Diederich parameter; (C_Nα)_1 single fin; (C_Nα)_N fin set; (C_Nα)_T(B) fins with interference. |
| Λ_i, Λ_k | dihedral angle between fin k and the crossflow plane; θ: roll angle (BW-30); also pitch angle in MIL rows (MM-12/13). |
| K_1, K_2, K_3 | Busemann coefficients; η_i: strip surface inclination; C_P,i: strip pressure coefficient; c_i, Δξ: strip chord and width. |
| ξ | in BW (MAC) rows, spanwise distance from fin root; in DM rows, radial distance from body axis; ξ_f fin-CP distance from CG. |
| u_i | strip tangential velocity; f_eq, ω_eq: equilibrium roll frequency and rate. |
| ρ_t, ρ_o | tangent-ogive and actual ogive arc radii; κ: nose shape parameter; θ_h: Haack angle variable; r_1: nose base radius. |
| f_A(α) | axial-drag angle-of-attack scaling; C_0, C_3: nose pressure drag at f_n = 0 and f_n = 3. |
| C_A | axial-force coefficient. |

## Equations

### CO — Coefficient definitions

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| CO-01 | coefficients | normal-force coefficient | niskanen-2009 | (3.1) | 36 | 26 | C_N = F_N / (q_dyn A_ref) |  |
| CO-02 | coefficients | pitching-moment coefficient | niskanen-2009 | (3.2) | 36 | 26 | C_m = M_pitch / (q_dyn A_ref d_ref) | reference point = nose tip |
| CO-03 | coefficients | moment transfer between reference points | niskanen-2009 | (3.3) | 36 | 26 | C_m' d_ref = C_m d_ref − C_N Δx |  |
| CO-04 | coefficients | CP from coefficients (α > 0) | niskanen-2009 | (3.4) | 37 | 27 | X_cp = (C_m / C_N) d_ref |  |
| CO-05 | coefficients | CP limit at α → 0 | niskanen-2009 | (3.5) | 37 | 27 | X_cp = (C_mα / C_Nα) d_ref |  |
| CO-06 | coefficients | secant-slope definition of C_Nα, C_mα | niskanen-2009 | (3.8) | 37 | 27 | C_Nα = C_N/α ; C_mα = C_m/α (α > 0); derivative at α = 0 | defined by (3.6) at α = 0 |
| CO-07 | coefficients | drag coefficient | niskanen-2009 | (3.9) | 37 | 27 | C_D = D / (q_dyn A_ref) |  |
| CO-08 | coefficients | roll-moment coefficient | niskanen-2009 | (3.10) | 38 | 28 | C_l = M_roll / (q_dyn A_ref d_ref) |  |
| CO-09 | coefficients | Mach number | niskanen-2009 | (3.11) | 38 | 28 | M = V / a |  |
| CO-10 | coefficients | Reynolds number | niskanen-2009 | (3.12) | 39 | 29 | Re = V L / ν | L = rocket length unless stated |
| CO-11 | coefficients | component-to-global reference area | niskanen-2009 | (3.75) | 51 | 41 | C_D,0 = (A_comp / A_ref) C_D• | C_D• uses component frontal area |

### CC — Compressibility corrections

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| CC-01 | compressibility | compressibility parameter | niskanen-2009 | (3.13) | 40 | 30 | β = sqrt(\|M² − 1\|) |  |
| CC-02 | compressibility | Prandtl factor | niskanen-2009 | (3.14) | 40 | 30 | P_G = 1/β = 1/sqrt(1 − M²) | M < 1 |
| CC-03 | compressibility | subsonic skin-friction correction | niskanen-2009 | (3.82) | 55 | 45 | C_fc = C_f (1 − 0.1 M²) | M < 1; turbulent and roughness-limited |
| CC-04 | compressibility | supersonic turbulent skin-friction correction | niskanen-2009 | (3.83) | 55 | 45 | C_fc = C_f / (1 + 0.15 M²)^0.58 | M > 1 |
| CC-05 | compressibility | supersonic roughness-limited skin-friction correction | niskanen-2009 | (3.84) | 55 | 45 | C_fc = C_f / (1 + 0.18 M²) ; use max(this, CC-04 value) | M > 1 |
| CC-06 | compressibility | stagnation-pressure ratio | niskanen-2009 | (B.1) | 116 | 106 | q_stag/q_dyn = 1 + M²/4 + M⁴/40 (M < 1); 1.84 − 0.76/M² + 0.166/M⁴ + 0.035/M⁶ (M > 1) |  |
| CC-B67-001 | fin | 2-D lift slope, Gothert compressibility | barrowman-1967 | (3-4) | 13 | 3 | C_Nα0 = 2π/β | M < 1; cross-check: niskanen-2009 eq (3.38) p 29 |
| CC-B67-002 | skin friction | subsonic compressible smooth turbulent | barrowman-1967 | (4-9) | 57 | 47 | C_fc = C_f (1 − 0.09 M²) | M < 1; laminar unchanged |
| CC-B67-003 | skin friction | subsonic compressible rough turbulent | barrowman-1967 | (4-10) | 57 | 47 | C_fc = C_f (1 − 0.12 M²) | M < 1, rough |
| CC-B67-004 | skin friction | supersonic laminar | barrowman-1967 | (4-11) | 57 | 47 | C_fc = C_f / (1 + 0.045 M²)^(1/4) | M > 1, laminar |
| CC-B67-005 | skin friction | supersonic smooth turbulent | barrowman-1967 | (4-12) | 58 | 48 | C_fc = C_f / (1 + k_w M²)^0.58 | k_w=0.15 adiabatic; 0.0512 cooled wall |
| CC-B67-006 | skin friction | supersonic rough turbulent | barrowman-1967 | (4-13) | 58 | 48 | C_fc = C_f / (1 + 0.18 M²) | not below smooth value |
| CC-B67-007 | fin | swept-fin Prandtl factor | barrowman-1967 | (4-25) | 63 | 53 | P_f = 1 / sqrt(1 − M² cos² Γ_c) | M < 1 |
| CC-B67-008 | fin | corrected Prandtl factor (finite at M=1) | barrowman-1967 | (4-26) | 63 | 53 | P'_f = 1 / sqrt(K_P − M² cos² Γ_c) | K_P fitted at M = 1 |
| CC-B67-009 | fin base | Prandtl constant from TE drag match | barrowman-1967 | (4-31) | 65 | 55 | K_P = cos² Γ_c + [0.223 + 4.02 C*_fc (t_f/h_r)²]² / [(c_r/h_r) C*_fc]^(2/3) | match (4-28)=(4-30) at M=1 |
| CC-B67-010 | fin pressure | Prandtl constant from thickness drag | barrowman-1967 | (4-36) | 66 | 56 | K_P = cos² Γ_c + [((C*_D,TT/C*_fc)(A_ref/A_fin) − 4(t_f/c_r) cos Γ_c) / (120 (t_f/c_r)⁴ cos² Γ_c)]^(2/3) | as printed; inverting (4-34) gives reciprocal bracket |
| CC-B67-011 | body pressure | Prandtl constant, forebody | barrowman-1967 | (4-44) | 67 | 57 | K_P = 1 + [6 A_wet,B C*_fc / (f_B³ A_ref C*_D,press)]^(5/3) |  |
| CC-B67-012 | body pressure | Prandtl constant, cone | barrowman-1967 | (4-45) | 69 | 59 | K_P,cone = 1 + [6.82 A_wet,B C*_fc (f_n + 0.7)^1.29 / (f_B³ A_ref)]^(5/3) |  |
| CC-B67-013 | body pressure | Prandtl constant, ogive | barrowman-1967 | (4-46) | 69 | 59 | K_P,ogive = 1 + [6.82 A_wet,B C*_fc (f_n + 1)^2.22 / (f_B³ A_ref)]^(5/3) |  |
| CC-B67-014 | body base | Prandtl constant, base | barrowman-1967 | (4-52) | 70 | 60 | K_P = 1 + [0.029 (A_b/A_ref)]² / (C*_fc (A_wet/A_b)(C*_D,base)²) |  |
| CC-B67-015 | body base | Prandtl constant, base simplified | barrowman-1967 | (4-53) | 70 | 60 | K_P = 1 + 1 / ([6.38 + 39.7 (h_r/c_r)] C*_fc (A_wet/A_b)) | use in (4-50) |

### SF — Skin friction (laminar, turbulent, roughness by finish)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| SF-01 | skin friction | transition Reynolds number | niskanen-2009 | (3.76) | 52 | 42 | Re_crit = V x / ν ; Re_crit ≈ 5·10⁵ | laminar ahead of x; thesis assumes fully turbulent |
| SF-02 | skin friction | skin-friction coefficient definition | niskanen-2009 | (3.77) | 53 | 43 | C_f = D_fric / (q_dyn A_wet) |  |
| SF-03 | skin friction | turbulent smooth-wall C_f | niskanen-2009 | (3.78) | 53 | 43 | C_f = 1 / (1.50 ln Re − 5.6)² | 10⁴ < Re < Re_crit,ε |
| SF-04 | skin friction | roughness height by finish (table) | niskanen-2009 | Table 3.2 | 54 | 44 | ε [µm]: glass 0.1; polished 0.5; optimum paint 5; planed wood 15; production paint 20; smooth cement 50; dip-galvanized 150; poor spray paint 200; raw wood 500; concrete 1000 | data from Hoerner; finish → ε |
| SF-05 | skin friction | roughness-limited critical Reynolds number | niskanen-2009 | (3.79) | 54 | 44 | Re_crit,ε = 51 (ε / L)^(−1.039) |  |
| SF-06 | skin friction | roughness-limited C_f | niskanen-2009 | (3.80) | 54 | 44 | C_f = 0.032 (ε / L)^0.2 | Re > Re_crit,ε |
| SF-07 | skin friction | piecewise turbulent C_f | niskanen-2009 | (3.81) | 54 | 44 | C_f = 1.48·10⁻² (Re < 10⁴); SF-03 (10⁴ < Re < Re_crit,ε); SF-06 (Re > Re_crit,ε) |  |
| SF-08 | skin friction | friction drag on global reference area | niskanen-2009 | (3.85) | 56 | 46 | C_D,fric = C_fc [ (1 + 1/(2 f_B)) A_wet,body + (1 + 2 t_f/c̄) A_wet,fins ] / A_ref | A_wet,fins counts both sides |
| SF-B67-001 | skin friction | skin-friction coefficient definition | barrowman-1967 | (4-1) | 53 | 43 | C_f = D_fric / (q_dyn A_wet) |  |
| SF-B67-002 | skin friction | laminar flat plate | barrowman-1967 | (4-2) | 53 | 43 | C_f = 1.328 / sqrt(Re) | laminar, Re < ~5e5 |
| SF-B67-003 | skin friction | Schoenherr turbulent (implicit) | barrowman-1967 | (4-3) | 53 | 43 | log10(Re C_f) = 0.242 / sqrt(C_f) | turbulent, smooth |
| SF-B67-004 | skin friction | Hama turbulent | barrowman-1967 | (4-4) | 53 | 43 | C_f = 1 / (3.46 log10 Re − 5.6)² | within ±2% of (4-3) |
| SF-B67-005 | skin friction | transitional increment | barrowman-1967 | (4-5) | 53 | 43 | ΔC_f = k_tr / Re, k_tr = 1700 | Prandtl value |
| SF-B67-006 | skin friction | transitional/turbulent smooth | barrowman-1967 | (4-6) | 57 | 47 | C_f = 1/(3.46 log10 Re − 5.6)² − 1700/Re | Re > 5e5 |
| SF-B67-007 | skin friction | roughness critical Reynolds number | barrowman-1967 | (4-7) | 57 | 47 | Re_crit = 51 (ε/L_ref)^(−1.039) | L_r printed (reference length) |
| SF-B67-008 | skin friction | fully rough turbulent | barrowman-1967 | (4-8) | 57 | 47 | C_f = 0.032 (ε/L_ref)^0.2 | Re > Re_crit |
| SF-B67-009 | skin friction | friction drag to reference area | barrowman-1967 | (4-14) | 58 | 48 | C_D,fric = C_fc A_wet / A_ref |  |
| SF-B67-010 | skin friction | tail friction drag | barrowman-1967 | (4-15) | 58 | 48 | (C_D,fric)_T = 2 N C_fc A_fin / A_ref | wetted = 2 × planform |
| SF-B67-011 | skin friction | body friction drag, fineness correction | barrowman-1967 | (4-16) | 58 | 48 | (C_D,fric)_B = (1 + 0.5/f_B) C_fc A_wet,B / A_ref |  |

### PD — Pressure drag (body, nose, shoulder, boattail, fins) and drag totals

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| PD-01 | body pressure drag | nose low-subsonic pressure drag | niskanen-2009 | (3.86) | 57 | 47 | C_D•,press(M=0) = 0.8 sin²φ_j | φ_j nose–body joint angle; 0 if tangent |
| PD-02 | body pressure drag | nose high-subsonic interpolation | niskanen-2009 | (3.87) | 58 | 48 | C_D•,press = a_i M^(b_i) + C_D•,press(M=0) | a_i, b_i fit value and slope at M = 0.8 |
| PD-03 | body pressure drag | shoulder pressure drag | niskanen-2009 | unnumbered | 58 | 48 | C_D•,press,shoulder = nose-cone value (PD-01/PD-02 …) with A_comp = A_1 − A_0 | rule stated in text, "Shoulder pressure drag" paragraph |
| PD-04 | body pressure drag | boattail pressure drag | niskanen-2009 | (3.88) | 59 | 49 | C_D•,press = (A_base/A_bt) C_D•,base · {1 if γ_bt < 1; (3 − γ_bt)/2 if 1 < γ_bt < 3; 0 if γ_bt > 3}, γ_bt = l_c/(d_0 − d_1) | C_D•,base from BD-01 |
| PD-05 | fin pressure drag | rounded leading-edge drag (normal to LE) | niskanen-2009 | (3.89) | 59 | 49 | C_D•,LE⊥ = (1 − M²)^(−0.417) − 1 (M < 0.9); 1 − 1.785(M − 0.9) (0.9 < M < 1); 1.214 − 0.502/M² + 0.1095/M⁴ (M > 1) |  |
| PD-06 | fin pressure drag | square leading edge | niskanen-2009 | (3.90) | 60 | 50 | C_D•,LE⊥ = C_D•,stag | C_D•,stag from PD-12 |
| PD-07 | fin pressure drag | swept leading edge (cross-flow) | niskanen-2009 | (3.91) | 60 | 50 | C_D•,LE = C_D•,LE⊥ cos²Γ_L |  |
| PD-08 | fin pressure drag | trailing-edge (fin base) drag | niskanen-2009 | (3.92) | 60 | 50 | C_D•,TE = C_D•,base (square TE); 0.5 C_D•,base (rounded); 0 (tapered) | rounded/tapered factors stated below (3.92) |
| PD-09 | fin pressure drag | total fin pressure drag | niskanen-2009 | (3.93) | 60 | 50 | C_D•,press,fins = C_D•,LE + C_D•,TE ; A_comp = N t_f s |  |
| PD-10 | body pressure drag | zero-α total drag sum | niskanen-2009 | (3.97) | 62 | 52 | C_D,0 = Σ_T (A_T/A_ref) C_D•,T + C_D,fric | T over pressure, base, parasitic |
| PD-11 | body pressure drag | axial drag vs angle of attack | niskanen-2009 | unnumbered | 63 | 53 | C_A = C_D,0 f_A(α); f_A two-part polynomial: f_A(0°)=1, f_A(17°)=1.3, f_A(90°)=0, f_A'=0 at all three | constraints only; no coefficients printed |
| PD-12 | body pressure drag | blunt-cylinder (stagnation) drag | niskanen-2009 | (B.2) | 117 | 107 | C_D•,stag = 0.85 q_stag/q_dyn | q_stag from CC-06 |
| PD-13 | body pressure drag | cone half-angle vs fineness | niskanen-2009 | (B.3) | 117 | 107 | tan φ_n = (d_ref/2)/l_n = 1/(2 f_n) |  |
| PD-14 | body pressure drag | supersonic cone wave drag | niskanen-2009 | (B.4) | 117 | 107 | C_D•,press = 2.1 sin²φ_n + 0.5 sin φ_n / sqrt(M² − 1) = 2.1/(1 + 4f_n²) + 0.5/sqrt((1 + 4f_n²)(M² − 1)) | M ≳ 1.3 |
| PD-15 | body pressure drag | cone drag slope at M = 1 | niskanen-2009 | (B.5) | 117 | 107 | dC_D•,press/dM (M=1) = (4/(γ + 1)) (1 − 0.5 C_D•,M=1) | γ = 1.4 |
| PD-16 | body pressure drag | cone drag at M = 1 | niskanen-2009 | (B.6) | 118 | 108 | C_D•,M=1 = 1.0 sin φ_n | 1 < M < 1.3: polynomial through (B.4)–(B.6) |
| PD-17 | body pressure drag | fineness-ratio scaling of nose drag | niskanen-2009 | (B.7) | 118 | 108 | C_D•,press = a_n / (f_n + 1)^(b_n) | a_n, b_n from f_n = 0 and f_n = 3 points |
| PD-18 | body pressure drag | ogive transonic/supersonic drag | niskanen-2009 | (B.8) | 120 | 110 | C_D•,press,ogive = (0.72 (κ − 0.5)² + 0.82) C_D•,press,cone | same l_n, d_ref cone |
| PD-19 | body pressure drag | other nose shapes from f_n = 3 data | niskanen-2009 | (B.9) | 120 | 110 | C_D•,press = C_0/(f_n + 1)^(log₄(C_0/C_3)) = C_0 (C_3/C_0)^(log₄(f_n + 1)) | C_0 = PD-12; C_3(M) data not in thesis |
| PD-B67-001 | fin pressure | LE cylinder drag increment, subsonic | barrowman-1967 | (4-17) | 60 | 50 | ΔC_D,LE = (1 − M²)^(−0.417) − 1 | M < 0.9 |
| PD-B67-002 | fin pressure | LE drag increment, transonic | barrowman-1967 | (4-18) | 60 | 50 | ΔC_D,LE = 1 − 1.5 (M − 0.9) | 0.9 ≤ M ≤ 1 |
| PD-B67-003 | fin pressure | LE drag increment, supersonic | barrowman-1967 | (4-19) | 60 | 50 | ΔC_D,LE = 1.214 − 0.502/M² + 0.1095/M⁴ + 0.0231/M⁶ | M > 1 |
| PD-B67-004 | fin pressure | crossflow sweep law | barrowman-1967 | (4-20) | 60 | 50 | C_D,swept / C_D,normal = cos³ Γ |  |
| PD-B67-005 | fin pressure | LE frontal area ratio | barrowman-1967 | (4-21) | 60 | 50 | A_LE/A_ref = 2 s r_LE / (A_ref cos Γ_L) | A_LE = 2 L_LE r_LE, L_LE = s/cos Γ_L |
| PD-B67-006 | fin pressure | N-fin leading-edge drag | barrowman-1967 | (4-22) | 60 | 50 | C_D,LE = 2N (s r_LE/A_ref) cos² Γ_L ΔC_D,LE |  |
| PD-B67-007 | fin pressure | 2-D thickness drag, subsonic | barrowman-1967 | (4-32) | 65 | 55 | C_D,TT = C_fc [4(t_f/c) + 120 (t_f/c)⁴ / (sqrt(1 − M²))³] | 2-D airfoil |
| PD-B67-008 | fin pressure | fin thickness drag, reference area | barrowman-1967 | (4-33) | 65 | 55 | C_D,TT = C_fc (A_fin/A_ref)[4(t_f/c_r) + 120 (t_f/c_r)⁴ / (sqrt(1 − M² cos² Γ_c))³] |  |
| PD-B67-009 | fin pressure | swept thickness drag with K_P | barrowman-1967 | (4-34) | 66 | 56 | C_D,TT = C_fc (A_fin/A_ref)[4(t_f/c_r) cos Γ_c + 120 (t_f/c_r)⁴ cos² Γ_c / (K_P − M² cos² Γ_c)^(3/2)] | one fin |
| PD-B67-010 | fin pressure | sonic thickness drag fit | barrowman-1967 | (4-35) | 66 | 56 | C*_D,TT = 1.15 (t_f/c_r)^(5/3) [1.61 + ζ − sqrt((ζ − 1.43)² + 0.578)], ζ = AR (t_f/c_r)^(1/3) | M = 1 |
| PD-B67-011 | fin pressure | subsonic thickness drag, N fins | barrowman-1967 | (4-37) | 66 | 56 | C_D,TT = 4N C_fc (A_fin/A_ref)[(t_f/c_r) cos Γ_c + 30 (t_f/c_r)⁴ cos² Γ_c / (sqrt(K_P − M² cos² Γ_c))³] | M < 1 |
| PD-B67-012 | fin total | subsonic tail drag sum | barrowman-1967 | (4-38) | 66 | 56 | (C_D)_T = (C_D,fric)_T + C_D,LE + C_D,BT + C_D,TT | uses 4-15, 4-22, 4-28, 4-37 |
| PD-B67-013 | fin total | supersonic tail drag sum | barrowman-1967 | (4-39) | 67 | 57 | (C_D)_T = (C_D,fric)_T + C_D,LE + C_D,BT + C_D,wave,T | wave drag from Appendix A |
| PD-B67-014 | body pressure | forebody pressure drag, subsonic | barrowman-1967 | (4-40) | 67 | 57 | C_D,press = 6 A_wet,B C_fc / (f_B³ A_ref (sqrt(1 − M²))^1.2) | M < 1 |
| PD-B67-015 | body pressure | forebody pressure drag with K_P | barrowman-1967 | (4-41) | 67 | 57 | C_D,press = 6 A_wet,B C_fc / (f_B³ A_ref (K_P − M²)^0.6) | nose: A_wet,NA, f_NA; shoulder: A_wet,SA, f_SA |
| PD-B67-016 | body pressure | sonic forebody drag, cone | barrowman-1967 | (4-42) | 67 | 57 | C*_D,press,cone = 0.88 / (f_n + 0.7)^1.29 | 1 ≤ f_B ≤ 10 |
| PD-B67-017 | body pressure | sonic forebody drag, ogive | barrowman-1967 | (4-43) | 67 | 57 | C*_D,press,ogive = 0.88 / (f_n + 1)^2.22 | 1 ≤ f_B ≤ 10 |
| PD-B67-018 | body pressure | supersonic body pressure drag | barrowman-1967 | (4-47) | 69 | 59 | C_D,press = (4/(γ M²)) ∫_0^L ∫_0^π P sin δ_s dφ dx | M > 1; P from shock-expansion |
| PD-B67-019 | body total | body drag sum | barrowman-1967 | (4-57) | 72 | 62 | (C_D)_B = C_D,press + C_D,base | sub: 4-41,4-50; super: 4-47,4-54/55 |
| PD-B67-020 | total | vehicle drag | barrowman-1967 | (4-58) | 72 | 62 | C_D = (C_D)_T + (C_D)_B | no interference drag considered |

### BD — Base drag (body and fin trailing edge)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| BD-01 | base drag | base drag | niskanen-2009 | (3.94) | 60 | 50 | C_D•,base = 0.12 + 0.13 M² (M < 1); 0.25/M (M > 1) |  |
| BD-02 | base drag | thrusting-motor base-area reduction | niskanen-2009 | unnumbered | 61 | 51 | A_base,eff = max(A_base − A_motor,thrusting, 0) | rule in text, top paragraph |
| BD-B67-001 | fin base | fin trailing-edge (2-D base) drag, incompressible | barrowman-1967 | (4-23) | 60 | 50 | C_D,BT = 0.135 / C_fB^(1/3) |  |
| BD-B67-002 | fin base | TE friction parameter | barrowman-1967 | (4-24) | 63 | 53 | C_fB = 2 C_f (c_r/h_r) |  |
| BD-B67-003 | fin base | TE friction parameter, compressible | barrowman-1967 | (4-27) | 63 | 53 | C_fB = 2 C_fc (c_r/h_r) |  |
| BD-B67-004 | fin base | subsonic TE drag, N fins | barrowman-1967 | (4-28) | 63 | 53 | C_D,BT = 0.135 N (A_base,f/A_ref) / (C_fB^(1/3) sqrt(K_P − M² cos² Γ_c)) | M < 1 |
| BD-B67-005 | fin base | 2-D supersonic base pressure | barrowman-1967 | unnumbered | 63 | 53 | C_p,base = (1 − 0.52 M^(−1.19)) / M² | display before (4-29); M > 1 |
| BD-B67-006 | fin base | base pressure with fin boattailing | barrowman-1967 | (4-29) | 63 | 53 | C_p,base = (1 − 0.52 M^(−1.19)) / ([1 + 18 C_fc (t_f/h_r)²] M²) | M > 1 |
| BD-B67-007 | fin base | supersonic TE drag, N fins | barrowman-1967 | (4-30) | 65 | 55 | C_D,BT = N (1 − 0.52 M^(−1.19)) (A_base,f/A_ref) / ([1 + 18 C_fc (t_f/h_r)²] M²) | M > 1 |
| BD-B67-008 | body base | incompressible body base drag | barrowman-1967 | (4-48) | 69 | 59 | C_D,base = 0.029 / sqrt(C_fB), C_fB = C_f A_wet/A_b | based on base area |
| BD-B67-009 | body base | subsonic base drag, reference area | barrowman-1967 | (4-49) | 69 | 59 | C_D,base = 0.029 (A_b/A_ref) / sqrt(C_fc (A_wet/A_b)(1 − M²)) | M < 1 |
| BD-B67-010 | body base | subsonic base drag with K_P | barrowman-1967 | (4-50) | 70 | 60 | C_D,base = 0.29 (A_b/A_ref) / sqrt(C_fc (A_wet/A_b)(K_P − M²)) | 0.29 printed; likely typo for 0.029 |
| BD-B67-011 | body base | sonic base drag vs fin TE thickness | barrowman-1967 | (4-51) | 70 | 60 | C*_D,base = (A_b/A_ref)[0.185 + 1.15 (h_r/c_r)] | M = 1; C*_p,base = 0.185 no fins |
| BD-B67-012 | body base | supersonic base drag, low range | barrowman-1967 | (4-54) | 72 | 62 | C_D,base = C*_D,base [0.88 + 0.12 e^(−3.58 (M − 1))] | 1 ≤ M ≤ M_cr |
| BD-B67-013 | body base | supersonic base drag, inverse square | barrowman-1967 | (4-55) | 72 | 62 | C_D,base = 0.7 (A_b/A_ref) / M² | M > M_cr |
| BD-B67-014 | body base | base-drag crossover Mach | barrowman-1967 | (4-56) | 72 | 62 | M_cr = 0.892 / sqrt(C*_D,base) |  |

### PA — Parasitic drag (launch lugs, rail buttons)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| PA-01 | parasitic drag | launch lug / guide drag | niskanen-2009 | (3.95) | 62 | 52 | C_D•,par = max(1.3 − 0.3 l_lug/d_lug, 1) C_D•,stag |  |
| PA-02 | parasitic drag | launch lug reference area | niskanen-2009 | (3.96) | 62 | 52 | A_par = π r_ext² − π r_int² max(1 − l_lug/d_lug, 0) |  |
| PA-03 | parasitic drag | rail button / pin | niskanen-2009 | unnumbered | 62 | 52 | rail button = lug with A_par = pin frontal area, l_lug = d_lug, then PA-01 | rule in text after (3.96); rw-aero takes the projected spool, A_par = d_o h_base + d_neck h_neck + d_o h_flange |
| PA-04 | boundary layer | turbulent flat-plate thickness | naca-tm-1218 | (17.8), (17.9) | 34, 35 | 32, 33 | δ = 0.37 x Re_x^(−1/5), Re_x = V x/ν ; u/U = (y/δ)^(1/7) is (17.3) pdf 34 | 1/7-power law, Re_x < 10⁷ (pdf 35); x from the nose tip for a guide on the body |
| PA-05 | parasitic drag | mean dynamic pressure over a wall element | naca-tm-1299 | Fig 27 | 36 | 35 | q̄/Q = (1/h)∫₀ʰ (u/U)² dy = (7/9)(h/δ)^(2/7) for h ≤ δ ; 1 − (2/9) δ/h for h ≥ δ | definition of q̄ in symbols pdf 3 (printed 2); curve is the 1/7-power law, checked against measurements at Re_x 4·10⁵ and 5.2·10⁶ |
| PA-06 | parasitic drag | protuberance drag on the mean dynamic pressure | naca-tm-1299 | unnumbered (sec 4) | 5 | 4 | D = C_w q̄ f (f frontal area) ; for h/δ > 1, C_w on q̄ ≈ the free-stream value (square plates 1.14 vs 1.16) | text on Figs 1-2; for elements submerged in the layer C_w becomes a function of Re(h) = ū h/ν (same page), not modelled |
| PA-07 | parasitic drag | stepped protuberance in the boundary layer | naca-tm-1299 | Fig 27 (q̄ definition) | 36 | 35 | D ∝ Σ_sections w ∫_{y₀}^{y₁} (u/U)² dy = Σ w [y q̄(y)/Q]_{y₀}^{y₁}, divided by Σ w (y₁ − y₀) for the factor on A_par | PA-05 applied per section of constant width (rail button: base d_o, neck d_neck, flange d_o) |
| PA-08 | parasitic drag | rail-button immersion, linear layer profile | naca-tm-1299 | symbols (q̄ definition) | 3 | 2 | u/U = min(y/δ, 1) in PA-05/PA-07: q̄/Q = (1/3)(h/δ)² for h ≤ δ ; 1 − (2/3) δ/h for h ≥ δ | the q̄ definition is TM 1299's; the linear profile is a model choice with no source in the folder (Gaps 10); lugs keep the 1/7-power profile (PA-05) |

### BW — Barrowman normal force and CP (nose, body, transitions, fins, fin-body interference, combination)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| BW-01 | Barrowman body | local normal-force coefficient | niskanen-2009 | (3.17) | 32 | 22 | C_N(x) = (2 sin α / A_ref) dA/dx |  |
| BW-02 | Barrowman body | body component C_Nα (nose, transition, tube) | niskanen-2009 | (3.19) | 32 | 22 | (C_Nα)_c = (2/A_ref)(A_1 − A_0)(sin α/α) | tube: 0; cross-check: barrowman-1967 |
| BW-03 | Barrowman body | body component C_mα | niskanen-2009 | (3.25) | 33 | 23 | (C_mα)_c = (2/(A_ref d_ref)) (l_c A_1 − V_c)(sin α/α) |  |
| BW-04 | Barrowman body | body-lift normal force | niskanen-2009 | (3.26) | 34 | 24 | C_N,lift = K_lift (A_plan/A_ref) sin²α ; K_lift ≈ 1.1 | Galejs extension, all body components |
| BW-05 | Barrowman body | body-lift CP | niskanen-2009 | (3.27) | 34 | 24 | X_lift = ∫₀^l_c x 2 r(x) dx / A_plan | planform centroid |
| BW-06 | Barrowman body | body component CP | niskanen-2009 | (3.28) | 34 | 24 | X_c = (l_c A_1 − V_c)/(A_1 − A_0) | from component front |
| BW-07 | Barrowman combine | total CP moment sum | niskanen-2009 | (3.29) | 35 | 25 | X_cp = Σ_i X_i (C_Nα)_i / Σ_i (C_Nα)_i | X_i from nose tip |
| BW-08 | Barrowman fins | MAC length | niskanen-2009 | (3.30) | 36 | 26 | c̄ = (1/A_fin) ∫₀^s c(ξ)² dξ | any planform |
| BW-09 | Barrowman fins | MAC spanwise position | niskanen-2009 | (3.31) | 36 | 26 | y_mac = (1/A_fin) ∫₀^s ξ c(ξ) dξ |  |
| BW-10 | Barrowman fins | MAC leading-edge position | niskanen-2009 | (3.32) | 36 | 26 | x_mac = (1/A_fin) ∫₀^s x_LE(ξ) c(ξ) dξ |  |
| BW-11 | Barrowman fins | subsonic fin CP on quarter chord | niskanen-2009 | unnumbered | 36 | 26 | X_f = x_mac + 0.25 c̄ | last display on page |
| BW-12 | Barrowman fins | trapezoid MAC spanwise position | niskanen-2009 | (3.33) | 37 | 27 | y_mac = (s/3)(c_r + 2c_t)/(c_r + c_t) |  |
| BW-13 | Barrowman fins | trapezoid fin CP | niskanen-2009 | (3.34) | 37 | 27 | X_f = (x_t/3)(c_r + 2c_t)/(c_r + c_t) + (1/6)(c_r² + c_t² + c_r c_t)/(c_r + c_t) | from root LE |
| BW-14 | Barrowman fins | supersonic fin CP | niskanen-2009 | (3.35) | 37 | 27 | X_f/c̄ = (AR β − 0.67)/(2 AR β − 1), β = sqrt(M² − 1) | M > 2 |
| BW-15 | Barrowman fins | fin CP transonic blend | niskanen-2009 | (3.36) | 37 | 27 | X_f/c̄ = p(M), 5th-order: p(0.5)=0.25, p'(0.5)=0, p(2)=f(2), p'(2)=f'(2), p''(2)=0, p'''(2)=0, f = BW-14 | 0.5 < M < 2 |
| BW-16 | Barrowman fins | single-fin C_Nα (Diederich form) | niskanen-2009 | (3.37) | 38 | 28 | (C_Nα)_1 = C_Nα0 F_D (A_fin/A_ref) cos Γ_c / (2 + F_D sqrt(1 + 4/F_D²)) |  |
| BW-17 | Barrowman fins | 2D airfoil lift slope | niskanen-2009 | (3.38) | 39 | 29 | C_Nα0 = 2π/β | M < 1 |
| BW-18 | Barrowman fins | Diederich planform parameter | niskanen-2009 | (3.39) | 39 | 29 | F_D = AR / ((1/(2π)) C_Nα0 cos Γ_c) | AR = 2s²/A_fin |
| BW-19 | Barrowman fins | single-fin C_Nα, simplified | niskanen-2009 | (3.40) | 39 | 29 | (C_Nα)_1 = 2π (s²/A_ref) / (1 + sqrt(1 + (β s²/(A_fin cos Γ_c))²)) | subsonic |
| BW-20 | Barrowman fins | supersonic strip pressure coefficient | niskanen-2009 | (3.41) | 40 | 30 | C_P,i = K_1 η_i + K_2 η_i² + K_3 η_i³ | Busemann 3rd order, flat plate |
| BW-21 | Barrowman fins | Busemann K_1 | niskanen-2009 | (3.42) | 40 | 30 | K_1 = 2/β | M > 1 |
| BW-22 | Barrowman fins | Busemann K_2 | niskanen-2009 | (3.43) | 40 | 30 | K_2 = ((γ + 1) M⁴ − 4β²)/(4β⁴) |  |
| BW-23 | Barrowman fins | Busemann K_3 | niskanen-2009 | (3.44) | 40 | 30 | K_3 = ((γ + 1) M⁸ + (2γ² − 7γ − 5) M⁶ + 10(γ + 1) M⁴ + 8)/(6β⁷) |  |
| BW-24 | Barrowman fins | supersonic strip force | niskanen-2009 | (3.45) | 41 | 31 | F_i = C_P,i q_dyn c_i Δξ |  |
| BW-25 | Barrowman fins | supersonic fin C_N from strips | niskanen-2009 | (3.47) | 41 | 31 | C_N = (1/A_ref) Σ_i C_P,i c_i Δξ |  |
| BW-26 | Barrowman fins | supersonic single-fin C_Nα | niskanen-2009 | (3.49) | 41 | 31 | (C_Nα)_1 = (A_fin/A_ref)(K_1 + K_2 α + K_3 α²) | uncanted, no roll |
| BW-27 | Barrowman fins | fin local angle of attack by dihedral | niskanen-2009 | (3.50) | 42 | 32 | α_i = α sin Λ_i |  |
| BW-28 | Barrowman fins | fin-set sum over dihedral | niskanen-2009 | (3.52) | 42 | 32 | Σ_k (C_Nα)_Λk = (C_Nα)_1 Σ_k sin²Λ_k | per fin: (3.51) |
| BW-29 | Barrowman fins | equal-spacing identity | niskanen-2009 | (3.53) | 42 | 32 | Σ_{k=1..N} sin²(2πk/N + θ) = N/2 | N ≥ 3 |
| BW-30 | Barrowman fins | N-fin C_Nα with roll angle | niskanen-2009 | (3.54) | 44 | 34 | (C_Nα)_N = Σ sin²Λ_k (C_Nα)_1 (N=1,2); 1.50(1 − 0.15 cos²(3θ/2))(C_Nα)_1 (N=3); 2.00(1 − 0.06 sin²(2θ))(C_Nα)_1 (N=4); 2.37, 2.74, 2.99, 3.24 ×(C_Nα)_1 (N=5..8) | θ = 0: one fin into crossflow |
| BW-31 | Barrowman interference | tail-in-presence-of-body C_Nα | niskanen-2009 | (3.55) | 44 | 34 | (C_Nα)_T(B) = K_T(B) (C_Nα)_N | K_B(T) neglected |
| BW-32 | Barrowman interference | fin–body interference factor | niskanen-2009 | (3.56) | 44 | 34 | K_T(B) = 1 + r_t/(s + r_t) |  |
| BW-B67-001 | fin | single-fin C_Nα, Diederich general form | barrowman-1967 | (3-1) | 13 | 3 | (C_Nα)_1 = C_Nα0 F_D (A_fin/A_ref) cos Γ_c / (2 + F_D sqrt(1 + 4/F_D²)) | subsonic; cross-check: niskanen-2009 eq (3.37) p 28 |
| BW-B67-002 | fin | Diederich planform correlation parameter | barrowman-1967 | (3-2) | 13 | 3 | F_D = AR / ((1/(2π)) C_Nα0 cos Γ_c) | cross-check: niskanen-2009 eq (3.39) p 29 |
| BW-B67-003 | fin | 2-D airfoil lift slope, incompressible | barrowman-1967 | (3-3) | 13 | 3 | C_Nα0 = 2π | thin-airfoil theory |
| BW-B67-004 | fin | F_D with compressibility | barrowman-1967 | (3-5) | 13 | 3 | F_D = β AR / cos Γ_c | M < 1 |
| BW-B67-005 | fin | single-fin C_Nα, subsonic closed form | barrowman-1967 | (3-6) | 13 | 3 | (C_Nα)_1 = 2π AR (A_fin/A_ref) / (2 + sqrt(4 + (β AR / cos Γ_c)²)) | AR=2s²/A_fin; cross-check: niskanen-2009 eq (3.40) p 29 |
| BW-B67-006 | fin | supersonic strip pressure coefficient (Busemann 3rd order) | barrowman-1967 | (3-7) | 13 | 3 | C_p,i = K_1 η_i + K_2 η_i² + K_3 η_i³ + B_3 η_L³ | M > 1; cross-check: niskanen-2009 eq (3.41) p 30 (no B_3) |
| BW-B67-007 | fin | Busemann coefficients K_1, K_2 | barrowman-1967 | (3-7) | 13 | 3 | K_1 = 2/β ; K_2 = ((γ+1) M⁴ − 4 β²) / (4 β⁴) | "where" lines; cross-check: niskanen-2009 eq (3.42)-(3.43) p 30 |
| BW-B67-008 | fin | Busemann coefficients K_3, B_3 | barrowman-1967 | (3-7) | 14 | 4 | K_3 = ((γ+1)M⁸ + (2γ² − 7γ − 5)M⁶ + 10(γ+1)M⁴ − 12M² + 8) / (6 β⁷) ; B_3 = (γ+1) M⁴ [(5 − 3γ)M⁴ + 4(γ − 3)M² + 8] / 48 | niskanen-2009 eq (3.44) p 30 omits −12M² term |
| BW-B67-009 | fin | two-panel dihedral effect | barrowman-1967 | (3-8) | 14 | 4 | (C_Nα)_t = 2 (C_Nα)_1 cos² Λ_dih | small α |
| BW-B67-010 | fin | three-fin set C_Nα | barrowman-1967 | (3-9) | 14 | 4 | (C_Nα)_T = (3/2) (C_Nα)_1 | N = 3 |
| BW-B67-011 | fin | four-fin set C_Nα | barrowman-1967 | (3-10) | 14 | 4 | (C_Nα)_T = (4/2) (C_Nα)_1 | N = 4 |
| BW-B67-012 | fin | N-fin set C_Nα | barrowman-1967 | (3-11) | 14 | 4 | (C_Nα)_T = (N/2) (C_Nα)_1 | N = 3 or 4; cross-check: niskanen-2009 eq (3.53) p 32 |
| BW-B67-013 | fin | N-fin set C_Nα, subsonic | barrowman-1967 | (3-12) | 16 | 6 | (C_Nα)_T = N π AR (A_fin/A_ref) / (2 + sqrt(4 + (β AR / cos Γ_c)²)) | N = 3 or 4, M < 1 |
| BW-B67-014 | fin | mean aerodynamic chord definition | barrowman-1967 | (3-13) | 16 | 6 | c̄ = (1/A_fin) ∫_0^s c(y)² dy | cross-check: niskanen-2009 eq (3.30) p 26 |
| BW-B67-015 | fin | chord proportionality (trapezoid) | barrowman-1967 | (3-14) | 16 | 6 | c_r/L* = c/(L* − y) = c_t/(L* − s) | straight-edged trapezoid |
| BW-B67-016 | fin | local chord vs span | barrowman-1967 | (3-15) | 16 | 6 | c = c_r − (y/L*) c_r |  |
| BW-B67-017 | fin | taper ratio | barrowman-1967 | (3-16) | 16 | 6 | λ = c_t/c_r |  |
| BW-B67-018 | fin | virtual apex span | barrowman-1967 | (3-17) | 19 | 9 | L* = s/(1 − λ) |  |
| BW-B67-019 | fin | linear chord law | barrowman-1967 | (3-18) | 19 | 9 | c = c_r (1 + k_c y) |  |
| BW-B67-020 | fin | chord slope constant | barrowman-1967 | (3-19) | 19 | 9 | k_c = −1/L* = (λ − 1)/s |  |
| BW-B67-021 | fin | MAC integral, trapezoid | barrowman-1967 | (3-20) | 19 | 9 | c̄ = (c_r²/A_fin) ∫_0^s (1 + k_c y)² dy |  |
| BW-B67-022 | fin | MAC integrated | barrowman-1967 | (3-21) | 19 | 9 | c̄ = (c_r² s/A_fin) [1 + k_c s + (1/3) k_c² s²] | unnumbered first line: (c_r²/(3 k_c A_fin))[(1+k_c s)³ − 1] |
| BW-B67-023 | fin | MAC in taper ratio | barrowman-1967 | (3-22) | 19 | 9 | c̄ = (1/3)(c_r² s/A_fin)(λ² + λ + 1) |  |
| BW-B67-024 | fin | trapezoid fin area | barrowman-1967 | (3-23) | 19 | 9 | A_fin = (1/2)(c_r + c_t) s |  |
| BW-B67-025 | fin | MAC length, trapezoid | barrowman-1967 | (3-24) | 20 | 10 | c̄ = (2/3) [c_r + c_t − c_r c_t/(c_r + c_t)] | unnumbered precursor on p9: (2/3) c_r²(λ²+λ+1)/(c_r+c_t) |
| BW-B67-026 | fin | MAC spanwise position (intermediate) | barrowman-1967 | (3-25) | 20 | 10 | y_mac = [(2/3)(c_r + c_t) − 2 c_r c_t/(3(c_r + c_t)) − c_r] · s/(c_r − c_t) | sign as printed; derivation needs s/(c_t − c_r) |
| BW-B67-027 | fin | MAC spanwise position | barrowman-1967 | (3-26) | 20 | 10 | y_mac = (s/3)(c_r + 2 c_t)/(c_r + c_t) | from root chord; cross-check: niskanen-2009 eq (3.33) p 27 |
| BW-B67-028 | fin | fin spanwise CP from body axis | barrowman-1967 | (3-27) | 20 | 10 | y_cp,f = r_t + (s/3)(c_r + 2 c_t)/(c_r + c_t) | subsonic |
| BW-B67-029 | fin | fin axial CP (quarter-chord of MAC) | barrowman-1967 | (3-28) | 20 | 10 | X_f = x_f + x_mac + c̄/4 | subsonic; CP fixed with Mach |
| BW-B67-030 | fin | MAC leading-edge axial offset | barrowman-1967 | (3-29) | 20 | 10 | x_mac = y_mac tan Γ_L = (y_mac/s) x_t |  |
| BW-B67-031 | fin | fin CP from nose tip, closed form | barrowman-1967 | (3-30) | 20 | 10 | X_f = x_f + (x_t/3)(c_r + 2c_t)/(c_r + c_t) + (1/6)[c_r + c_t − c_r c_t/(c_r + c_t)] | subsonic; cross-check: niskanen-2009 eq (3.34) p 27 (from root LE) |
| BW-B67-032 | body | slender-body running normal load | barrowman-1967 | (3-57) | 28 | 18 | n(x) = ρ V ∂/∂x [A(x) w(x)] | subsonic; cross-check: niskanen-2009 eq (3.15) p 22 |
| BW-B67-033 | body | running normal load, small α | barrowman-1967 | (3-59) | 30 | 20 | n(x) = ρ V² α dA(x)/dx | w = V α |
| BW-B67-034 | body | local normal-force coefficient definition | barrowman-1967 | (3-60) | 30 | 20 | C_N(x) = n(x)/(q_dyn A_ref) |  |
| BW-B67-035 | body | local normal-force coefficient | barrowman-1967 | (3-61) | 30 | 20 | C_N(x) = (2α/A_ref) dA(x)/dx | cross-check: niskanen-2009 eq (3.17) p 22 |
| BW-B67-036 | body | integrated normal force | barrowman-1967 | (3-62) | 30 | 20 | C_N = (2α/A_ref) ∫_0^L (dA/dx) dx = (2α/A_ref) ∫ dA |  |
| BW-B67-037 | body | body normal force | barrowman-1967 | (3-63) | 30 | 20 | C_N = (2α/A_ref) [A(L) − A(0)] | cross-check: niskanen-2009 eq (3.18) p 22 |
| BW-B67-038 | body | C_Nα definition | barrowman-1967 | (3-64) | 30 | 20 | C_Nα = ∂C_N/∂α at α = 0 |  |
| BW-B67-039 | body/nose/transition | component C_Nα, general | barrowman-1967 | (3-65) | 30 | 20 | C_Nα = (2/A_ref) [A(L) − A(0)] | shape-independent; cross-check: niskanen-2009 eq (3.19) p 22 |
| BW-B67-040 | nose/body | body C_Nα, pointed nose | barrowman-1967 | (3-66) | 31 | 21 | (C_Nα)_B = 2 A_1,n / A_ref | = 2 when nose base area = A_ref |
| BW-B67-041 | body | supersonic frustum pressure series | barrowman-1967 | (3-67) | 31 | 21 | P = −P_0 + C_s exp(S_0 s_w + S_1 s_w²/2 + S_2 s_w³/3 + …) | 2nd-order shock-expansion, M > 1 |
| BW-B67-042 | body | supersonic frustum pressure distribution | barrowman-1967 | (3-68) | 31 | 21 | P = P_c − (P_c − P_2) e^{−η_s}, η_s = (∂P/∂s_w)_2 (x − x_2)/((P_c − P_2) cos δ_s,2) | M > 1 |
| BW-B67-043 | body | axisymmetric characteristic equation | barrowman-1967 | (3-69) | 33 | 23 | ∂P/∂s_w − λ_c ∂δ_s/∂s_w = (1/cos μ) ∂P/∂C_1 − (λ_c/cos μ)(∂δ_s/∂C_1 + sin μ sin δ_s / r), λ_c = 2γ/sin 2μ | M > 1 |
| BW-B67-044 | body | pressure gradient at frustum leading edge | barrowman-1967 | (3-70) | 33 | 23 | (∂P/∂s_w)_2 = (B_2/r)((Ω_1/Ω_2) sin δ_s,1 − sin δ_s,2) + (B_2 Ω_1/(B_1 Ω_2)) (∂P/∂s_w)_1 ; B = γ M²/(2(M² − 1)) ; Ω = (1/M)[(1 + (γ−1)M²/2)/((γ+1)/2)]^((γ+1)/(2(γ−1))) | M > 1 |
| BW-B67-045 | body | pressure gradient at frustum trailing edge | barrowman-1967 | (3-71) | 33 | 23 | (∂P/∂s_w)_3 = ((P_c − P_3)/(P_c − P_2)) (∂P/∂s_w)_2 | M > 1 |
| BW-B67-046 | body | nondimensional running normal load | barrowman-1967 | (3-72) | 34 | 24 | Λ_n = n(x)/(α q_dyn d) = (2/(γ M² π)) ∫_0^π (d(P/P_∞)/dα) cos φ dφ | M > 1; d local diameter |
| BW-B67-047 | body | pressure derivative w.r.t. α | barrowman-1967 | (3-73) | 34 | 24 | d(P/P_∞)/dα = (1 − e^{−η_s}) d(P_c/P_∞)/dα + e^{−η_s} (Λ_n,2/Λ_n,1) d(P_1/P_∞)/dα | M > 1 |
| BW-B67-048 | body | running load recursion | barrowman-1967 | (3-74) | 34 | 24 | Λ_n = (1 − e^{−η_s}) tan δ_s (C_Nα)_tcx + (Λ_n,2/Λ_n,1) e^{−η_s} Λ_n,1 | tcx = equivalent cone |
| BW-B67-049 | body | running load, initial cone | barrowman-1967 | (3-75) | 34 | 24 | Λ_n,1 = tan δ_s,v (C_Nα)_tcv | cone tables 3-1..3-3 |
| BW-B67-050 | body | supersonic body C_Nα | barrowman-1967 | (3-76) | 34 | 24 | (C_Nα)_B = (2π/A_b) ∫_0^L Λ_n r dx | M > 1; based on base area |
| BW-B67-051 | body | local pitching moment about nose | barrowman-1967 | (3-77) | 38 | 28 | m(x) = x n(x) | cross-check: niskanen-2009 eq (3.20) p 23 |
| BW-B67-052 | body | pitch moment coefficient definition | barrowman-1967 | (3-78) | 38 | 28 | C_m = m / (q_dyn A_ref L_ref) |  |
| BW-B67-053 | body | local pitch moment coefficient | barrowman-1967 | (3-79) | 38 | 28 | C_m = x n(x)/(q_dyn A_ref L_ref) |  |
| BW-B67-054 | body | normal-force coefficient definition | barrowman-1967 | (3-80) | 38 | 28 | C_N = n/(q_dyn A_ref) |  |
| BW-B67-055 | body | local C_m from C_N | barrowman-1967 | (3-81) | 38 | 28 | C_m(x) = x C_N(x)/L_ref |  |
| BW-B67-056 | body | local C_m, subsonic | barrowman-1967 | (3-82) | 38 | 28 | C_m(x) = (2 α x/(A_ref L_ref)) dA(x)/dx | cross-check: niskanen-2009 eq (3.22) p 23 |
| BW-B67-057 | body | integrated C_m | barrowman-1967 | (3-83) | 38 | 28 | C_m = (2α/(A_ref L_ref)) ∫_0^L x (dA/dx) dx |  |
| BW-B67-058 | body | C_m by parts | barrowman-1967 | (3-84) | 39 | 29 | C_m = (2α/(A_ref L_ref)) [L A(L) − ∫_0^L A(x) dx] | cross-check: niskanen-2009 eq (3.23) p 23 |
| BW-B67-059 | body | C_m via volume | barrowman-1967 | (3-85) | 39 | 29 | C_m = (2α/(A_ref L_ref)) [L A(L) − V_c] | cross-check: niskanen-2009 eq (3.24) p 23 |
| BW-B67-060 | body | C_mα definition | barrowman-1967 | (3-86) | 39 | 29 | C_mα = ∂C_m/∂α at α = 0 |  |
| BW-B67-061 | body/nose/transition | component C_mα | barrowman-1967 | (3-87) | 39 | 29 | (C_mα)_B = (2/(A_ref L_ref)) [L A(L) − V_c] | cross-check: niskanen-2009 eq (3.25) p 23 |
| BW-B67-062 | body | CP from moment/force ratio | barrowman-1967 | (3-88) | 39 | 29 | X_B = ((C_mα)_B/(C_Nα)_B) L_ref |  |
| BW-B67-063 | body/nose | body/nose CP, volume form | barrowman-1967 | (3-89) | 39 | 29 | X_B = L − V_c / A(L) | A(0)=0; cross-check: niskanen-2009 eq (3.28) p 24 |
| BW-B67-064 | nose | tangent-ogive volume | barrowman-1967 | (3-90) | 40 | 30 | V_c/(d A(L)) = f_n (f_n² + 1/4)² − (1/3) f_n³ − (f_n² − 1/4)(f_n² + 1/4)² sin⁻¹(f_n/(f_n² + 1/4)), f_n = l_n/d | RHS numerically equals V_c/(π d³), not V_c/(dA) |
| BW-B67-065 | body | supersonic body C_mα | barrowman-1967 | (3-91) | 40 | 30 | C_mα = −(2π/(A_b d)) ∫_0^L Λ_n r x dx | M > 1 |
| BW-B67-066 | body | supersonic body CP | barrowman-1967 | (3-92) | 40 | 30 | X_B = (C_mα/C_Nα) d | M > 1 |
| BW-B67-067 | interference | tail in presence of body | barrowman-1967 | (3-93) | 40 | 30 | (C_Nα)_T(B) = (C_Nα)_T K_T(B) | cross-check: niskanen-2009 eq (3.55) p 34 |
| BW-B67-068 | interference | body in presence of tail | barrowman-1967 | (3-94) | 40 | 30 | (C_Nα)_B(T) = (C_Nα)_T K_B(T) |  |
| BW-B67-069 | interference | K_T(B) slender-body factor | barrowman-1967 | (3-96) | 41 | 31 | K_T(B) = (2/(π(1 − 1/τ)²)) {(1 + 1/τ⁴)[(1/2) tan⁻¹((1/2)(τ − 1/τ))] − (1/τ²)[(τ − 1/τ) + 2 tan⁻¹(1/τ)]} | as printed lacks +π/4 in [ ]; Niskanen (3.56) simplified |
| BW-B67-070 | interference | tail CP unaffected by interference | barrowman-1967 | (3-97) | 41 | 31 | X_T(B) = X_f |  |
| BW-B67-071 | interference | K_B(T) slender-body factor | barrowman-1967 | (3-98) | 41 | 31 | K_B(T) = (1 − 1/τ²)²/(1 − 1/τ)² − K_T(B) | subsonic; supersonic until (3-99) holds |
| BW-B67-072 | interference | fin-tip Mach cone hits body | barrowman-1967 | (3-99) | 41 | 31 | β AR (1 + λ)(1/(β m_L) + 1) > 4 | M > 1 criterion |
| BW-B67-073 | interference | supersonic body-in-presence-of-tail C_Nα | barrowman-1967 | (3-100) | 42 | 32 | (C_Nα)_B(T) = K'_B(T) β (1 + λ)(τ − 1) | faint print; K'_B(T) from Fig 3-9 |
| BW-B67-074 | interference | subsonic CP of body interference lift | barrowman-1967 | (3-101) | 42 | 32 | X_B(T) = x_f + c_r/4 + [ (sqrt(s² − r_t²) cosh⁻¹(s/r_t) − s + (π/2) r_t) / ((r_t/sqrt(s² − r_t²)) cosh⁻¹(s/r_t) + s/r_t − π/2) − r_t ] tan Γ_1/4 | s > r_t, βAR ≥ 4; else Fig 3-10 |
| BW-B67-075 | interference | supersonic CP of body interference lift | barrowman-1967 | (3-102) | 42 | 32 | X_B(T) = ((C_mα)_B(T)/(C_Nα)_B(T)) d + x_f | M > 1 |
| BW-B67-076 | interference | body interference C_mα, supersonic LE | barrowman-1967 | (3-103) | 42 | 32 | (C_mα)_B(T) = −(8 (m_L β)^{3/2}/(A_ref π β (β m_L + 1))) ∫_0^d dy ∫_{βy}^{c_r} x cos⁻¹((x/β − β m_L y)/(m_L x − y)) dx | m_L β > 1; faint, verify |
| BW-B67-077 | interference | body interference C_mα, subsonic LE | barrowman-1967 | (3-104) | 42 | 32 | (C_mα)_B(T) = −(4 β m_L/(A_ref π β sqrt(β² m_L² − 1))) ∫_0^d dy ∫_{βy}^{c_r} x sqrt(x/β + y)/sqrt(m_L x − y) dx | m_L β < 1 as printed; faint, verify |
| BW-B67-078 | combine | total C_Nα | barrowman-1967 | (3-106) | 47 | 37 | C_Nα = (C_Nα)_B + (C_Nα)_T(B) + (C_Nα)_B(T) |  |
| BW-B67-079 | combine | total CP | barrowman-1967 | (3-107) | 47 | 37 | X_cp = [X_B (C_Nα)_B + X_T(B) (C_Nα)_T(B) + X_B(T) (C_Nα)_B(T)] / C_Nα | total ȳ = 0 |
| BW-1307-01 | interference | fin load in presence of body, slender body | naca-tr-1307 | (14) | 8 | 4 | K_F(B) = 2/(π(1 − τ)²) {(1 + τ⁴)[½ tan⁻¹(½(1/τ − τ)) + π/4] − τ²[(1/τ − τ) + 2 tan⁻¹ τ]}, τ = r/s (s from the axis) | = barrowman (3-96) in τ_B = 1/τ with the +π/4 (Errata) |
| BW-1307-02 | interference | body load, slender body | naca-tr-1307 | (21) | 10 | 6 | K_B(F) = (1 + τ)² − K_F(B) | total (1 + τ)², as BW-B67-071 |
| BW-1307-03 | interference | subsonic body-load CP, lifting line | naca-tr-1307 | (D5), (D6) | 40 | 36 | x̄_B(F) − c_r/4 = tan Λ_¼ ∫_r^s Γ (η − r)/η² dη / ∫_r^s Γ/η² dη, Γ = √((s − r)² − (η − r)²); closed form (D6) for s > 2r | elliptic loading on the quarter-chord line and its image; chart 16 uses it for βA ≥ 4; same as BW-B67-074 |
| BW-1307-04 | interference | subsonic body-load CP, low aspect ratio | naca-tr-1307 | chart 16 | 72-74 | 68-70 | (x̄/c_r)_B(F) vs βA for r/s = 0, 0.2, 0.4, 0.6 and λ = 0, ½, 1 with no leading-edge, mid-chord, or trailing-edge sweep; ½ x_LE,t at βA = 0 (slender body, no lift aft of the maximum span, pdf 22), (D5) from βA = 4 | dotted (extrapolated) below βA = 4; A = 4s/(c_r + c_t) of the two joined panels; digitised by us (rw-aero `body_load.rs`, ±0.005 c_r) |
| BW-1307-05 | combine | fin-set CP with the body load | naca-tr-1307 | (71), (73) text | 23 | 19 | x̄_F+B = (K_F(B) x̄_F + K_B(F) x̄_B(F)) / (K_F(B) + K_B(F)), x̄_F the wing-alone CP | applicability (trapezoid on a constant-radius tube, r/s ≤ 0.6, no forward-swept LE, no aft-swept TE, not λ < ½ with forward-swept mid-chord) from openrocket-techdoc-2026 pdf 47 |
| BW-B67-080 | fin (App. A) | Busemann local pressure coefficient with shock term | barrowman-1967 | (1) | 92 | 82 | C_p,i = (P_i − P_∞)/q_dyn = K_1 η_i + K_2 η_i² + K_3 η_i³ − K* η_L³ | sign of K* term differs from (3-7) |
| BW-B67-081 | fin (App. A) | Busemann coefficients | barrowman-1967 | (2a)-(2c) | 94 | 84 | K_1 = 2/β ; K_2 = ((γ+1)M⁴ − 4β²)/(4β⁴) ; K_3 as (3-7) | faint print; same as (3-7) |
| BW-B67-082 | fin (App. A) | shock irreversibility coefficient | barrowman-1967 | (3) | 94 | 84 | K* = (γ+1) M⁴ [(5 − 3γ)M⁴ + 4(γ − 3)M² + 8] / 48 | K* = 0 if upstream shock-free |
| BW-B67-083 | fin (App. A) | strip region lift | barrowman-1967 | (4) | 94 | 84 | F_l,i = C_p,i d_i (1 − r_i/2) | r_i = fraction behind tip Mach cone |
| BW-B67-084 | fin (App. A) | strip region drag | barrowman-1967 | (5) | 94 | 84 | F_d,i = C_p,i n_i (1 − r_i/2) |  |
| BW-B67-085 | fin (App. A) | strip region CP | barrowman-1967 | (6) | 94 | 84 | x̄_i = (1/2) d_i [1 − r_i + r_i/2 + (x_p,i/l_i)(2 − r_i)] / (1 − r_i/2) | faint print; verify |
| BW-B67-086 | fin (App. A) | strip region pitching moment | barrowman-1967 | (7) | 94 | 84 | M_p,i = F_l,i x̄_i |  |
| BW-B67-087 | fin (App. A) | lift coefficient, fin pair | barrowman-1967 | (16) | 97 | 87 | C_L = 2 F_l Δy / A | 2 fins; A = program reference area |
| BW-B67-088 | fin (App. A) | wave drag coefficient, fin pair | barrowman-1967 | (17) | 97 | 87 | C_D,wave = 2 F_d Δy / A | 2 fins |
| BW-B67-089 | fin (App. A) | pitching moment coefficient, fin pair | barrowman-1967 | (18) | 97 | 87 | C_m = 2 M_p Δy / (A L) | 2 fins |
| BW-B67-090 | fin (App. A) | supersonic fin CP coordinates | barrowman-1967 | (20)-(21) | 97 | 87 | X̄ = M_p / (F_l cos α) ; Ȳ = M_r / F_l |  |
| BW-B67-091 | fin (App. A) | slopes from 1-degree values | barrowman-1967 | (22)-(24) | 97 | 87 | C_Lα = (180/π) C_L at α=1° ; C_mα = (180/π) C_m at α=1° ; C_lδ = (180/π) C_l at δ=1° | per radian |
| BW-B67-092 | fin (App. A) | Mach angle | barrowman-1967 | (36) | 101 | 91 | μ = tan⁻¹(1/β) = sin⁻¹(1/M) | M > 1 |
| BW-B67-093 | fin (App. A) | tip Mach-cone intersection distance | barrowman-1967 | (38) | 101 | 91 | l_w = (s − y)(tan Γ_L + β) | (37): (s − y)[tan Γ_L + tan(90° − μ)] |

### DM — Roll and pitch damping, roll forcing

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| DM-01 | pitch damping | body strip damping force | niskanen-2009 | (3.57) | 45 | 35 | dF = 1.1 · ½ ρ (ω_pitch ξ)² · 2 r_t dξ | ξ from CG |
| DM-02 | pitch damping | body damping moment | niskanen-2009 | (3.58) | 45 | 35 | M_damp = 0.275 ρ r_t l⁴ ω_pitch² | l: body length fore or aft of CG |
| DM-03 | pitch damping | body damping coefficient | niskanen-2009 | (3.59) | 45 | 35 | C_m,damp,body = 0.55 (l⁴ r_t/(A_ref d_ref)) (ω_pitch²/V²) | fore and aft of CG separately, mean r_t |
| DM-04 | pitch damping | fin damping coefficient | niskanen-2009 | (3.60) | 46 | 36 | C_m,damp,fin = 0.6 (N A_fin ξ_f³/(A_ref d_ref)) (ω_pitch²/V²) | ξ_f fin–CG distance; N capped at 4; also yaw |
| DM-05 | roll damping | strip tangential velocity | niskanen-2009 | (3.61) | 47 | 37 | u_i = ω_roll ξ_i | ξ_i from centerline |
| DM-06 | roll damping | strip induced incidence | niskanen-2009 | (3.62) | 47 | 37 | η_i = atan(ω_roll ξ_i / V) ≈ ω_roll ξ_i / V |  |
| DM-07 | roll damping | strip net incidence with cant | niskanen-2009 | (3.63) | 47 | 37 | α_i = δ − η_i |  |
| DM-08 | roll forcing | roll-forcing coefficient (cant) | niskanen-2009 | (3.66) | 48 | 38 | C_l,f = N (y_mac + r_t) (C_Nα)_1 δ / d_ref | sub- and supersonic |
| DM-09 | roll damping | subsonic strip roll damping | niskanen-2009 | (3.68) | 49 | 39 | (C_l,d)_i = (C_Nα0/(A_ref d_ref)) ξ_i c_i Δξ_i η_i |  |
| DM-10 | roll damping | subsonic roll-damping coefficient | niskanen-2009 | (3.69) | 49 | 39 | C_l,d = (N C_Nα0 ω_roll / (A_ref d_ref V)) Σ_i c_i ξ_i² Δξ_i |  |
| DM-11 | roll damping | trapezoid strip-sum closed form | niskanen-2009 | (3.70) | 49 | 39 | Σ c ξ² Δξ = ((c_r + c_t)/2) r_t² s + ((c_r + 2c_t)/3) r_t s² + ((c_r + 3c_t)/12) s³ |  |
| DM-12 | roll damping | elliptical strip-sum closed form | niskanen-2009 | (3.71) | 49 | 39 | Σ c ξ² Δξ = c_r ((π/4) r_t² s + (2/3) r_t s² + (π/16) s³) |  |
| DM-13 | roll damping | supersonic roll-damping coefficient | niskanen-2009 | (3.72) | 49 | 39 | C_l,d = (N/(A_ref d_ref)) Σ_i C_P,i c_i ξ_i Δξ_i , η_i from DM-06 | C_P,i from BW-20 |
| DM-14 | roll damping | subsonic equilibrium roll frequency | niskanen-2009 | (3.73) | 50 | 40 | f_eq = ω_eq/(2π) = A_ref β V y_mac (C_Nα)_1 δ / (4π² Σ c ξ² Δξ) |  |
| DM-15 | roll damping | supersonic equilibrium roll frequency (linear) | niskanen-2009 | (3.74) | 50 | 40 | f_eq = A_ref β V y_mac (C_Nα)_1 δ / (4π Σ c ξ² Δξ) | denominator 4π as printed (vs 4π² in 3.73) |
| DM-B67-001 | roll | cant-induced rolling moment | barrowman-1967 | (3-31) | 21 | 11 | l_roll = N y_cp,f (C_Nα)_1 δ q_dyn A_ref | subsonic |
| DM-B67-002 | roll | rolling moment coefficient definition | barrowman-1967 | (3-32) | 21 | 11 | C_l = l_roll / (q_dyn A_ref L_ref) |  |
| DM-B67-003 | roll | roll-forcing coefficient | barrowman-1967 | (3-33) | 21 | 11 | C_l = N y_cp,f (C_Nα)_1 δ / L_ref | cross-check: niskanen-2009 eq (3.66) p 38 |
| DM-B67-004 | roll | roll-forcing derivative definition | barrowman-1967 | (3-34) | 21 | 11 | C_lδ = ∂C_l/∂δ at δ = 0 |  |
| DM-B67-005 | roll | roll-forcing derivative, subsonic | barrowman-1967 | (3-35) | 21 | 11 | C_lδ = N (C_Nα)_1 y_cp,f / L_ref | supersonic via strip method (Appendix A) |
| DM-B67-006 | roll | strip roll-moment element | barrowman-1967 | (3-36) | 25 | 15 | d l_roll = ξ F(ξ) |  |
| DM-B67-007 | roll | local AoA from roll rate | barrowman-1967 | (3-37) | 25 | 15 | α(ξ) = tan⁻¹(v(ξ)/V) |  |
| DM-B67-008 | roll | local AoA, roll rate | barrowman-1967 | (3-38) | 25 | 15 | α(ξ) = tan⁻¹(−ω_roll ξ / V) | v(ξ) = −ω_roll ξ (unnumbered) |
| DM-B67-009 | roll | local AoA, small-angle | barrowman-1967 | (3-39) | 25 | 15 | α(ξ) = −ω_roll ξ / V | V ≫ ω_roll ξ; cross-check: niskanen-2009 eq (3.62) p 37 |
| DM-B67-010 | roll | strip normal force | barrowman-1967 | (3-40) | 25 | 15 | F(ξ) = C_Nα0 q_dyn α(ξ) c(ξ) dξ | subsonic; cross-check: niskanen-2009 eq (3.67) p 39 |
| DM-B67-011 | roll | span coordinate shift | barrowman-1967 | (3-41) | 25 | 15 | y = ξ − r_t |  |
| DM-B67-012 | roll | chord vs radial station | barrowman-1967 | (3-42) | 25 | 15 | c(ξ) = (c_r(1 − λ)/s) (s/(1 − λ) − ξ + r_t) | trapezoid |
| DM-B67-013 | roll | roll-damping moment element | barrowman-1967 | (3-43) | 26 | 16 | d l_roll = −(C_Nα0 q_dyn ω_roll c_r (1 − λ)/(V s)) (L* + r_t − ξ) ξ² dξ |  |
| DM-B67-014 | roll | roll-damping coefficient element | barrowman-1967 | (3-44) | 26 | 16 | dC_l = −(C_Nα0 ω_roll c_r (1 − λ)/(A_ref L_ref V s)) (L* + r_t − ξ) ξ² dξ |  |
| DM-B67-015 | roll | roll-damping integral | barrowman-1967 | (3-45) | 26 | 16 | C_l = k_l ∫_{r_t}^{s + r_t} [(L* + r_t) − ξ] ξ² dξ |  |
| DM-B67-016 | roll | roll-damping constant | barrowman-1967 | (3-46) | 26 | 16 | k_l = −ω_roll c_r (1 − λ) C_Nα0 / (A_ref L_ref V s) |  |
| DM-B67-017 | roll | roll-damping integrated | barrowman-1967 | (3-47) | 26 | 16 | C_l = (k_l s²/(12(1 − λ))) [(1 + 3λ)s² + 4(1 + 2λ) s r_t + 6(1 + λ) r_t²] |  |
| DM-B67-018 | roll | roll-damping coefficient, single fin | barrowman-1967 | (3-48) | 26 | 16 | C_l = −(ω_roll c_r s C_Nα0/(12 β A_ref L_ref V)) [(1 + 3λ)s² + 4(1 + 2λ) s r_t + 6(1 + λ) r_t²] | β factor as printed |
| DM-B67-019 | roll | roll-damping derivative definition | barrowman-1967 | (3-49) | 26 | 16 | C_lp = ∂C_l / ∂(ω_roll L_ref/(2V)) at ω_roll L_ref/(2V) = 0 |  |
| DM-B67-020 | roll | roll-damping derivative, 2-D slope | barrowman-1967 | (3-50) | 27 | 17 | C_lp = −(c_r s C_Nα0/(6 L_ref² A_ref)) [(1 + 3λ)s² + 4(1 + 2λ) s r_t + 6(1 + λ) r_t²] | before 3-D correction |
| DM-B67-021 | roll | roll-damping derivative, N fins, subsonic | barrowman-1967 | (3-51) | 27 | 17 | C_lp = −(N c_r s/(6 L_ref²)) [(1 + 3λ)s² + 4(1 + 2λ) s r_t + 6(1 + λ) r_t²] (C_Nα)_1 | cross-check: niskanen-2009 eq (3.69)-(3.70) p 39 |
| DM-B67-022 | roll | supersonic roll-damping linearity parameter | barrowman-1967 | (3-52) | 27 | 17 | ω_roll L_ref/(2V) = k_l, k_l ≪ 1 | supersonic strip method |
| DM-B67-023 | roll | max local AoA from roll | barrowman-1967 | (3-53) | 27 | 17 | α_max ≈ tan⁻¹[−2 k_l (s + r_t)/L_ref] |  |
| DM-B67-024 | roll | max local AoA, slender vehicle | barrowman-1967 | (3-54) | 27 | 17 | α_max ≈ tan⁻¹(4 k_l) | assumes 2(s + r_t)/L_ref ≈ 4 |
| DM-B67-025 | roll | imposed AoA distribution | barrowman-1967 | (3-55) | 28 | 18 | α(y) = −0.002 (y + r_t)/L_ref | k_l = 10⁻³ |
| DM-B67-026 | roll | supersonic roll-damping derivative, N fins | barrowman-1967 | (3-56) | 28 | 18 | C_lp = 1000 N C_l | C_l from strip method at k_l = 10⁻³ |
| DM-B67-027 | interference | canted tail roll forcing in presence of body | barrowman-1967 | (3-95) | 40 | 30 | (C_lδ)_T(B) = (C_lδ)_T k_T(B) |  |
| DM-B67-028 | interference | roll-forcing interference factor k_T(B) | barrowman-1967 | (3-105) | 47 | 37 | k_T(B) = (1/π²)[ π²(τ+1)²/(4τ²) + π(τ²+1)²/(τ²(τ−1)²) sin⁻¹((τ²−1)/(τ²+1)) − 2π(τ+1)/(τ(τ−1)) + (τ²+1)²/(τ²(τ−1)²) (sin⁻¹((τ²−1)/(τ²+1)))² − 4(τ+1)/(τ(τ−1)) sin⁻¹((τ²−1)/(τ²+1)) + 8/(τ−1)² ln((τ²+1)/(2τ)) ] | no CP needed for cant |
| DM-B67-029 | pitch | fin pitch-damping moment | barrowman-1967 | (3-108) | 50 | 40 | m = F Δx, Δx = X_T(B) − x_cg |  |
| DM-B67-030 | pitch | induced fin force | barrowman-1967 | (3-109) | 50 | 40 | F = (C_Nα)_T(B) α' A_ref q_dyn | α' = tan⁻¹(v/V) unnumbered |
| DM-B67-031 | pitch | induced AoA, small | barrowman-1967 | (3-110) | 50 | 40 | α' = v/V | V ≫ v |
| DM-B67-032 | pitch | local pitch velocity at fins | barrowman-1967 | (3-111) | 50 | 40 | v = ω_pitch Δx |  |
| DM-B67-033 | pitch | pitch-damping moment | barrowman-1967 | (3-112) | 50 | 40 | m = (C_Nα)_T(B) Δx² A_ref q_dyn (ω_pitch/V) |  |
| DM-B67-034 | pitch | pitch-damping moment coefficient | barrowman-1967 | (3-113) | 50 | 40 | C_m = (C_Nα)_T(B) (Δx²/L_ref)(ω_pitch/V) | tail only |
| DM-B67-035 | pitch | pitch-damping derivative definition | barrowman-1967 | (3-114) | 50 | 40 | C_mq = ∂C_m / ∂(ω_pitch L_ref/(2V)) at 0 | (3-115) result blank in scan |
| DM-B67-036 | interference | general interference factor ratio | barrowman-1967 | (3-116) | 51 | 41 | K = ∫_{r_t}^{s+r_t} α_1(ξ) c(ξ) dξ / ∫_{r_t}^{s+r_t} α_0(ξ) c(ξ) dξ |  |
| DM-B67-037 | interference | AoA on fin in presence of body | barrowman-1967 | (3-117) | 51 | 41 | α_1(ξ) = α + (r_t²/ξ²) α_B |  |
| DM-B67-038 | interference | body-surface AoA, rolling | barrowman-1967 | (3-118) | 51 | 41 | α_B = −ω_roll r_t / V ; α_0(ξ) = −ω_roll ξ / V | α = 0 rolling |
| DM-B67-039 | interference | rolling fin AoA with body | barrowman-1967 | (3-119) | 51 | 41 | α_1(ξ) = −(ω_roll/V)(ξ + r_t³/ξ²) |  |
| DM-B67-040 | interference | roll-damping interference factor (integral) | barrowman-1967 | (3-120) | 52 | 42 | k_R(B) = ∫ −(ω_roll/V)(ξ + r_t³/ξ²) c(ξ) dξ / ∫ −(ω_roll/V) ξ c(ξ) dξ, limits r_t..s+r_t |  |
| DM-B67-041 | interference | roll-damping interference factor (simplified) | barrowman-1967 | (3-121) | 52 | 42 | k_R(B) = 1 + ∫_{r_t}^{s+r_t} (c(ξ)/ξ²) dξ / ∫_{r_t}^{s+r_t} ξ c(ξ) dξ | r_t³ factor omitted as printed |
| DM-B67-042 | interference | roll-damping interference factor, trapezoid | barrowman-1967 | (3-122) | 52 | 42 | k_R(B) = 1 + [(τ − λ)/τ − ((1 − λ)/(τ − 1)) ln τ] / [(τ + 1)(τ − λ)/2 − (1 − λ)(τ³ − 1)/(3(τ − 1))] |  |
| DM-B67-043 | interference | roll damping in presence of body | barrowman-1967 | (3-123) | 52 | 42 | (C_lp)_T(B) = (C_lp)_T k_R(B) |  |
| DM-B67-044 | fin (App. A) | rolling moment coefficient, 4 fins | barrowman-1967 | (19) | 97 | 87 | C_l = 4 M_r Δy / (A L) | 4 fins |

### TF — Tube fins as annular (ring) wings, ringtails

d is the ring diameter (TN 4117: inner diameter), c the chord (tube length L), A = d/c, S = d c the projected area. Rows TF-01..TF-05 are low-speed (M 0.13) data and theory for isolated rings; TF-06..TF-09 are the handbook ringtail statements; TF-10..TF-11 are the rw-aero tube-fin drag paths (PARITY-tubes).

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| TF-01 | annular wing | definitions | naca-tn-4117 | unnumbered | 4 | 2 | A = d/c ; S = d c ; C_L = L/(q S) | symbols list; d is the inner diameter |
| TF-02 | annular wing | lift-curve slope vs plane wing | naca-tn-4117 | unnumbered | 8 | 6 | C_Lα,ring(A) ≈ 2 C_Lα,rect(A) (both on S) | conclusion 3; also summary pdf 3 and curve D of Fig 11 (pdf 21): doubling the rectangular wing that spans the diameter |
| TF-03 | annular wing | low-A theory (Ribner) | naca-tn-4117 | Fig 11 legend, curve B | 21 | 19 | C_Lα = π A (per rad, on S) | agrees with experiment for A < 1 (pdf 7); experiment at A = 1/3 ≈ 0.018 per deg |
| TF-04 | annular wing | high-A lifting-line theory (Ribner) | naca-tn-4117 | Fig 11 legend, curve A | 21 | 19 | C_Lα = 2π A a/(4A + a), a section lift slope | agrees for A > 2.4 (pdf 7) |
| TF-05 | annular wing | aerodynamic centre and induced drag | naca-tn-4117 | unnumbered | 7, 8 | 5, 6 | x_ac(A) follows the plane unswept wing's trend (Fig 8, pdf 18: −0.11 c at A = 1/3, 0.20 c at A = 1, 0.35 c at A = 3) ; C_Di = C_L²/(2π A) | conclusions 1 and 4; Fig 8 is isolated rings, not digitised for use |
| TF-06 | ringtail | ringtail vs planar fins | mil-hdbk-762 | unnumbered | 252 | 5-14 | restoring moment of a ringtail ≈ 2 × that of a cruciform planar fin set of equal total span and chord, subsonic and supersonic | prose; same statement amcp-706-280 pdf 221 (8-1); Fig 5-61 (pdf 367, 5-129) charts the ratio vs (a_t)_rg including fin–body interference (pdf 256-257, 5-18/5-19) |
| TF-07 | ringtail | CP of a body-mounted ring | amcp-706-280 | unnumbered | 241 | 8-22 | x_cp at the ring mid-chord | §8-2.3; C_Nα charts Fig 8-17 (M 0.8-3.0, 4° rings) not digitised |
| TF-08 | ringtail | ring drag on rolled-out planform | amcp-706-280 | (8-24) | 267 | 8-48 | C_D = π d c C_d,2D / S_ref | same as mil-hdbk-762 (5-39) pdf 287 (5-49); 2D section drag from the section's own method |
| TF-09 | ringtail | ring friction | mil-hdbk-762 | (5-40) | 288 | 5-50 | C_D,f = C_f S_wet / A_ref with the flat-plate C_f on fin and ringtail surfaces (no 1.15 body factor) | prose; same amcp-706-280 §8-3.2 pdf 270 (8-51) |
| TF-10 | tube fin | bore loss as pipe flow | sp-125 | (7-7), (7-8), Fig 7-20 | 292, 293 | 283, 284 | C_D,bore = f (L/d) (π d²/4)/A_ref ; f = 64/Re_d (Re_d < 1200), else the Moody chart (Colebrook: 1/√f = −2 log₁₀(ε/(3.7 d) + 2.51/(Re_d √f))), Re_d = V d/ν | Darcy–Weisbach drop over the bore at the flight speed; replaces flat-plate friction on the bore |
| TF-11 | tube fin | corner channels as blunt faces | niskanen-2009 | (B.2), (3.94) | 117, 60 | 107, 50 | C_D = (A_ann + A_c)(C_D•,stag + C_D,base)/A_ref ; A_c = r_t √((r_b + r_t)² − r_t²) − r_t² ψ_t − r_b² ψ_b, cos ψ_t = r_t/(r_b + r_t), ψ_b = π/2 − ψ_t ; outside friction on 2(π − ψ_t) r_t L − 2ψ_b r_b L | geometry ours (rays from the body axis tangent to the tube); the channel is taken as closed because its Darcy loss f L/D_h exceeds C_D•,stag + C_D,base (case 4: D_h ≈ 2.5 mm, ≈ 1.6 vs 1.0) |

### GE — Nose and transition geometry

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| GE-01 | geometry | conical nose profile | niskanen-2009 | (A.1) | 110 | 100 | r(x) = (x/l_n) r_1 | r_1 nose base radius |
| GE-02 | geometry | tangent-ogive radius | niskanen-2009 | (A.2) | 111 | 101 | ρ_t = (r_1² + l_n²)/(2 r_1) |  |
| GE-03 | geometry | ogive shape parameter | niskanen-2009 | (A.3) | 111 | 101 | κ = ρ_t/ρ_o | κ = 1 tangent, 0 cone |
| GE-04 | geometry | secant-ogive radius | niskanen-2009 | (A.4) | 111 | 101 | ρ_o² = (l_n² + r_1²)(((2 − κ) l_n)² + (κ r_1)²)/(4 (κ r_1)²) |  |
| GE-05 | geometry | ogive profile | niskanen-2009 | (A.5) | 111 | 101 | r(x) = sqrt(ρ_o² − (l_n/κ − x)²) − sqrt(ρ_o² − (l_n/κ)²) |  |
| GE-06 | geometry | elliptical profile | niskanen-2009 | (A.6) | 111 | 101 | r(x) = r_1 sqrt(1 − (1 − x/l_n)²) |  |
| GE-07 | geometry | parabolic-series profile | niskanen-2009 | (A.7) | 112 | 102 | r(x) = r_1 (x/l_n) (2 − κ x/l_n)/(2 − κ) |  |
| GE-08 | geometry | power-series profile | niskanen-2009 | (A.8) | 112 | 102 | r(x) = r_1 (x/l_n)^κ |  |
| GE-09 | geometry | Haack-series profile | niskanen-2009 | (A.9) | 113 | 103 | r(x) = (r_1/sqrt(π)) sqrt(θ_h − ½ sin(2θ_h) + κ sin³θ_h) | κ = 0 Von Kármán, 1/3 LV |
| GE-10 | geometry | Haack angle variable | niskanen-2009 | (A.10) | 113 | 103 | θ_h = acos(1 − 2x/l_n) |  |

### MI — Mass and inertia (Pappus/shell/solid, parallel axis, combination)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| MI-01 | mass/inertia | component mass from volume | niskanen-2009 | unnumbered | 74 | 64 | m = ρ_m V_c | §4.2.3 para 1, prose only; cross-check niskanen-2013 p75/66 |
| MI-02 | mass/inertia | axisymmetric inertia simplification | niskanen-2009 | unnumbered | 74 | 64 | I_zz = I_yy; per component compute only I_xx (roll) and I_yy (pitch) | §4.2.3 para 1, prose; centerline taken as principal axis |
| MI-03 | mass/inertia | mass-override inertia scaling | niskanen-2009 | unnumbered | 74 | 64 | I_xx' = I_xx · m'/m ; I_yy' = I_yy · m'/m (m' = overridden mass) | §4.2.3 para 4, prose; assumes extra mass spread evenly |
| MI-04 | mass/inertia | CG-override inertia shift | niskanen-2009 | unnumbered | 74 | 64 | I_yy' = I_yy + m (x_cg' − x_cg)² (parallel-axis shift to overridden CG) | §4.2.3 para 4, prose; shift direction not stated explicitly |
| MI-05 | mass/inertia | solid body-of-revolution volume | niskanen-2009 | (3.23) | 33 | 23 | V_c = ∫_0^{l_c} A(x) dx = π ∫_0^{l_c} r(x)² dx | identity stated in text after (3.23); cross-check barrowman-1967 (3-84) p39/29 |
| MI-06 | mass/inertia | tangent-ogive nose volume | barrowman-1967 | (3-90) | 40 | 30 | V_c / (d_1 A_1) = f (f² + 1/4)² − f³/3 − (f² − 1/4)(f² + 1/4)² asin( f / (f² + 1/4) ), f = l_n/d_1 | AS PRINTED low by ×4; correct: V_c = π d_1³·[RHS] (verified numerically) |
| MI-07 | mass/inertia | thin-shell material volume | amcp-706-280 | unnumbered | 103 | 6-2 | V_c ≈ A_wet t_w ; m = ρ_m A_wet t_w | §6-2.1 prose; cross-check mil-hdbk-762 p533/7-9 prose |
| MI-08 | mass/inertia | mass-moment-of-inertia definitions | mil-hdbk-762 | (7-20) | 564 | 7-40 | I_xx = ∫(y² + z²) dm ; I_yy = ∫(x² + z²) dm ; I_zz = ∫(x² + y²) dm (CG axes) | basis for volume/shell integrals over r(x) |
| MI-09 | mass/inertia | cone (solid) wetted area & volume | amcp-706-280 | Table 6-1 | 104 | 6-3 | A_wet = π r_1 sqrt(r_1² + l_c²) ; V_c = π r_1² l_c / 3 | r_1 base radius; lateral area only; cross-check mil-hdbk-762 Table 7-1 p534/7-10 |
| MI-10 | mass/inertia | cone (solid) CG | amcp-706-280 | Table 6-1 | 104 | 6-3 | x_cg = l_c/4 forward of base (= 3 l_c/4 aft of apex) | solid cone only; cross-check mil-hdbk-762 Table 7-1 p534 |
| MI-11 | mass/inertia | cone (solid) inertia | amcp-706-280 | Table 6-1 | 104 | 6-3 | I_yy = (3m/20)(r_1² + l_c²/4) ; I_xx = 3 m r_1² / 10 | about component CG; cross-check mil-hdbk-762 Table 7-1 p534 |
| MI-12 | mass/inertia | cone-frustum wetted area & volume | amcp-706-280 | Table 6-1 | 104 | 6-3 | A_wet = π (r_0 + r_1) sqrt(l_c² + (r_0 − r_1)²) ; V_c = (π l_c/3)(r_0² + r_1² + r_0 r_1) | solid frustum (transition) |
| MI-13 | mass/inertia | cone-frustum (solid) CG | amcp-706-280 | Table 6-1 | 104 | 6-3 | x_cg = l_c (r_0² + 2 r_0 r_1 + 3 r_1²) / (4 (r_0² + r_0 r_1 + r_1²)), measured from r_0 face | valid for either taper direction |
| MI-14 | mass/inertia | cone-frustum (solid) inertia | amcp-706-280 | Table 6-1 | 104 | 6-3 | I_xx = (3m/10)(r_0⁵ − r_1⁵)/(r_0³ − r_1³) ; I_yy = difference of two solid cones | I_yy given only as "difference of two cones" |
| MI-15 | mass/inertia | paraboloid (solid) area & volume | amcp-706-280 | Table 6-1 | 104 | 6-3 | A_wet = (4π r_1/(3 l_c²)) [ (r_1²/4 + l_c²)^{3/2} − (r_1/2)³ ] ; V_c = π l_c r_1² / 2 | cross-check mil-hdbk-762 Table 7-1 p534/7-10 |
| MI-16 | mass/inertia | paraboloid (solid) CG & inertia | amcp-706-280 | Table 6-1 | 104 | 6-3 | x_cg = l_c/3 forward of base ; I_yy = m (3 r_1² + l_c²)/18 ; I_xx = m r_1²/3 | cross-check mil-hdbk-762 Table 7-1 p534 |
| MI-17 | mass/inertia | paraboloid frustum (solid) V, CG, I_xx | amcp-706-280 | Table 6-1 | 104 | 6-3 | V_c = (π l_c/2)(r_0² + r_1²) ; x_cg = l_c [r_0²(r_0⁴ − r_1⁴) − (2/3)(r_0⁶ − r_1⁶)] / ((r_0² − r_1²)(r_0⁴ − r_1⁴)) from r_0 face ; I_xx = (m/3)(r_0⁴ + r_0² r_1² + r_1⁴)/(r_0² + r_1²) | I_yy: difference of two paraboloids; r_0 larger end |
| MI-18 | mass/inertia | annular cylinder (tube) area, V, CG | amcp-706-280 | Table 6-1 | 104 | 6-3 | A_wet = 2π r_o l_c (outside) ; V_c = π (r_o² − r_i²) l_c ; x_cg = l_c/2 | cross-check mil-hdbk-762 Table 7-1 p534/7-10 |
| MI-19 | mass/inertia | annular cylinder (tube) inertia | amcp-706-280 | Table 6-1 | 104 | 6-3 | I_yy = m (3 r_o² + 3 r_i² + l_c²)/12 ; I_xx = m (r_o² + r_i²)/2 | solid cyl r_i = 0; thin tube r_i→r_o: I_xx = m r², I_yy = m(r²/2 + l_c²/12) |
| MI-20 | mass/inertia | trapezoidal fin volume | amcp-706-280 | Table 6-1 | 104 | 6-3 | V_c = (A_r b/4)(1 + λ), b = 2s, A_r = c_r t_f ⇒ V_c = t_f s (c_r + c_t)/2 | constant thickness along span; single fin |
| MI-21 | mass/inertia | fin spanwise CG (from body axis) | amcp-706-280 | Table 6-1 | 104 | 6-3 | y_cg = (s/3)(1 + 2λ)/(1 + λ) + r_t | printed with b/6 and d_c/2 (b = 2s, d_c = 2 r_t); axial CG = planform centroid |
| MI-22 | mass/inertia | fin inertia (single fin) | amcp-706-280 | Table 6-1 | 104 | 6-3 | I_yy,own ≈ 0 ; I_xx = m [ (s²/6)(1 + 3λ)/(1 + λ) + r_t² ] | printed omits cross term 2 r_t m η̄; see GAPS |
| MI-23 | mass/inertia | fin-set pitch inertia (lumped at base) | amcp-706-280 | (6-2) | 108 | 6-7 | I_yy,ref ≈ m_fins d_axis², d_axis = rocket-CG-to-base distance | <4% error if c_r < d_axis/3, s < 2 d_axis/3 |
| MI-24 | mass/inertia | parallel-axis theorem | amcp-706-280 | (6-1) | 103 | 6-2 | I_yy,ref = I_yy + m d_axis² | cross-check mil-hdbk-762 (7-6) p546/7-22, (7-21) p564/7-40 |
| MI-25 | mass/inertia | hollow/composite parts by superposition | amcp-706-280 | unnumbered | 108 | 6-7 | I = I_solid − I_cavity (about a common axis); likewise m, V | §6-2.2 prose; cross-check mil-hdbk-762 p546/7-22 |
| MI-26 | mass/inertia | total roll inertia | amcp-706-280 | unnumbered | 108 | 6-7 | I_xx,tot = Σ_i I_xx,i (all coaxial, no transfer term) | §6-2.3 prose; cross-check mil-hdbk-762 §7-2.3 p546/7-22 |
| MI-27 | mass/inertia | total mass | mil-hdbk-762 | (7-27) | 566 | 7-42 | m = Σ_i (m_i + m_p,i) | fixed hardware + variable propellant masses |
| MI-28 | mass/inertia | total CG | mil-hdbk-762 | (7-28) | 566 | 7-42 | x_cg = Σ_i (m_i + m_p,i) x_i / Σ_i (m_i + m_p,i) | x_i component CG stations; cross-check amcp-706-280 p103/6-2 prose |
| MI-29 | mass/inertia | total pitch inertia about rocket CG | mil-hdbk-762 | (7-22) | 564 | 7-40 | I_yy,tot = Σ_i (m_i x_i² + I_yy,i) − x_cg² Σ_i m_i | x_i from any common origin; equals Σ[I_yy,i + m_i (x_i − x_cg)²] |
| MI-30 | mass/inertia | parallel-axis (impl.) | rocketpy | - | - | - | I_ref = I + m d_axis² | rocketpy:rocketpy/tools.py:parallel_axis_theorem_from_com |
| MI-31 | mass/inertia | rocket CG with motor (impl.) | rocketpy | - | - | - | x_cg(t) = (m_dry x_cg,dry + m_mot(t) x_cg,mot(t)) / (m_dry + m_mot(t)) | rocketpy:rocketpy/rocket/rocket.py:Rocket.evaluate_center_of_mass |
| MI-32 | mass/inertia | rocket inertia combine (impl.) | rocketpy | - | - | - | I_yy = Σ_i [I_yy,i + m_i (x_i − x_ref)²] ; I_xx = Σ_i I_xx,i | rocketpy:rocketpy/rocket/rocket.py:Rocket.evaluate_dry_inertias / evaluate_inertias |

### MM — Motor mass over the burn

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| MM-01 | motor mass | specific impulse / mass-flow relation | mil-hdbk-762 | (3-20) | 83 | 3-19 | I_sp = F / (ṁ g_0) | integrating at constant I_sp gives MM-05 form |
| MM-02 | motor mass | average propellant mass-flow rate | mil-hdbk-762 | (3-21) | 83 | 3-19 | ṁ = m_p,0 / t_b |  |
| MM-03 | motor mass | rocket mass vs time (linear) | mil-hdbk-762 | (3-22) | 83 | 3-19 | m(t) = m_0 − ṁ t | 0 ≤ t ≤ t_b; cross-check mil-hdbk-762 p533/7-9 prose |
| MM-04 | motor mass | rocket mass vs time (linear, explicit) | mil-hdbk-762 | (3-23) | 83 | 3-19 | m(t) = m_0 − m_p,0 t / t_b | 0 ≤ t ≤ t_b |
| MM-05 | motor mass | propellant mass ∝ cumulative impulse (impl.) | rocketpy | - | - | - | ṁ(t) = −F(t)/v_e, v_e = I_tot/m_p,0 ⇒ m_p(t) = m_p,0 (1 − I(t)/I_tot) | rocketpy:rocketpy/motors/motor.py:Motor.total_mass_flow_rate, Motor.propellant_mass |
| MM-06 | motor mass | motor mass (impl.) | rocketpy | - | - | - | m_mot(t) = m_empty + m_p(t), m_p,0 = m_launch − m_empty | rocketpy:rocketpy/motors/motor.py:Motor.total_mass; special case of mil (7-27) |
| MM-07 | motor mass | motor CG (case + propellant) | mil-hdbk-762 | (7-28) | 566 | 7-42 | x_cg,mot(t) = (m_empty x_empty + m_p(t) x_p) / (m_empty + m_p(t)) | (7-28) applied to motor; cross-check rocketpy Motor.center_of_mass |
| MM-08 | motor mass | motor inertia (case + propellant) (impl.) | rocketpy | - | - | - | I_yy,mot = I_yy,p + m_p (x_p − x_cg,mot)² + I_yy,e + m_empty (x_empty − x_cg,mot)² ; I_xx,mot = I_xx,p + I_xx,e | rocketpy:rocketpy/motors/motor.py:Motor.I_11, Motor.I_33 |
| MM-09 | motor mass | propellant as solid cylinder (impl.) | rocketpy | - | - | - | I_yy,p = m_p(t)(3 r_ch² + l_ch²)/12 ; I_xx,p = m_p(t) r_ch²/2 ; x_p = chamber position (fixed) | rocketpy:rocketpy/motors/motor.py:GenericMotor.propellant_I_11, propellant_I_33 |
| MM-10 | motor mass | BATES-grain propellant inertia (impl.) | rocketpy | - | - | - | per grain I_yy,g = m_g[(r_o² + r_i²)/4 + l_g²/12]; I_yy,p = n_g I_yy,g + m_g Σ_k d_k² ; I_xx,p = m_p (r_o² + r_i²)/2 | rocketpy:rocketpy/motors/solid_motor.py:SolidMotor.propellant_I_11, propellant_I_33 |
| MM-11 | motor mass | inertia vs time (loaded→burnout) | mil-hdbk-762 | unnumbered | 546 | 7-22 | I_yy(t) ≈ I_yy,launch + (I_yy,burnout − I_yy,launch) t/t_b (bilinear for boost-sustain) | §7-2.2 para 1 prose; preliminary-design estimate |
| MM-12 | motor mass | axial EOM with time-varying mass | mil-hdbk-762 | (7-33) | 567 | 7-43 | a = (F_T − F_A − m(t) g_0 cos θ) / m(t) | from (7-7) p549/7-25; θ from vertical? see GAPS |
| MM-13 | motor mass | pitch EOM with rocket-CG inertia | mil-hdbk-762 | (7-30) | 567 | 7-43 | θ̈ = (1/I_yy,tot) Σ_i [F_N,i (x_cg − x_i) + M_i] | I_yy,tot, x_cg evaluated at current t |
| MM-14 | motor mass | 6-DOF variable-mass simplifications | mil-hdbk-762 | unnumbered | 161 | 4-49 | neglect dI/dt, jet damping, CG motion in body frame; use m(t), I(t) quasi-statically | §4-5.2 prose, list items 1–3 |
| MM-15 | motor mass | variable-mass rotational terms (impl.) | rocketpy | - | - | - | rotational RHS adds (ṁ S_noz − İ) ω ; S_noz,33 = r_noz²/2, S_noz,11 = S_noz,33/2 + l_noz²/4 | rocketpy:rocketpy/simulation/flight.py:Flight.u_dot_generalized; evaluate_nozzle_gyration_tensor |

### AT — USSA 1976 atmosphere, 0-86 km

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| AT-01 | atmosphere | standard gravity g_0 | ussa-1976 | Table 2B | 18 | 2 | g_0 = 9.80665 m/s² | also defined in text, pdf 19 / p.3 |
| AT-02 | atmosphere | geopotential unit constant g_0' | ussa-1976 | Table 2B | 18 | 2 | g_0' = 9.80665 m²/(s²·m'); Γ = g_0/g_0' = 1 m'/m | Γ defined under eq (19), pdf 24 p.8 |
| AT-03 | atmosphere | effective Earth radius r_0 | ussa-1976 | unnumbered | 20 | 4 | r_0 = 6356.766 km = 6 356 766 m | r_0 entry, left column; Table 2 p.2 value misprinted ×1000 |
| AT-04 | atmosphere | universal gas constant R* | ussa-1976 | unnumbered | 19 | 3 | R* = 8.31432e3 N·m/(kmol·K) = 8314.32 J/(kmol·K) | R* entry, p.3; Table 2 p.2 exponent misprinted (10^-3) |
| AT-05 | atmosphere | sea-level mean molar mass M_0 | ussa-1976 | (21) | 25 | 9 | M_0 = Σ(F_i M_i)/Σ F_i = 28.9644 kg/kmol | value stated in text below eq (21) |
| AT-06 | atmosphere | sea-level pressure P_0 | ussa-1976 | unnumbered | 19 | 3 | P_0 = 1.013250e5 Pa | P_0 entry; restated p.12 (pdf 28) as 101325.0 N/m² |
| AT-07 | atmosphere | sea-level temperature T_0 | ussa-1976 | unnumbered | 20 | 4 | T_0 = 288.15 K; T_M,0 = T_0 | T_0 entry, left column; T_M,0 = T_0 follows from AT-18 |
| AT-08 | atmosphere | ratio of specific heats γ | ussa-1976 | unnumbered | 20 | 4 | γ = 1.400 | γ entry; Table 2B p.2 gives 1.40 |
| AT-09 | atmosphere | Sutherland constants β_S, S | ussa-1976 | unnumbered | 35 | 19 | β_S = 1.458e-6 kg/(s·m·K^½); S = 110.4 K | text under eq (51); p.2/p.4 print S=110 (use 110.4) |
| AT-10 | atmosphere | sea-level density ρ_0 | ussa-1976 | Table 10 | 36 | 20 | ρ_0 = 1.2250 kg/m³ (derived, = P_0 M_0/(R* T_0)) | not a defining constant; tabulated sea-level value |
| AT-11 | atmosphere | layer table H_b, L_M,b (b = 0..7) | ussa-1976 | Table 4 | 19 | 3 | H_b [km'] = 0, 11, 20, 32, 47, 51, 71, 84.8520; L_M,b [K/km'] = -6.5, 0.0, +1.0, +2.8, 0.0, -2.8, -2.0 (b=0..6); derived T_M,b [K] = 288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.946; derived P_b [Pa] = 101325, 22632.1, 5474.89, 868.019, 110.906, 66.9389, 3.95642, 0.373384 | T_M,b, P_b computed by us via (23),(33a/b) |
| AT-12 | atmosphere | geopotential definition (differential) | ussa-1976 | (16) | 24 | 8 | g_0' dH = g(z) dz | basis for H transformation |
| AT-13 | atmosphere | gravity vs geometric altitude | ussa-1976 | (17) | 24 | 8 | g(z) = g_0 (r_0/(r_0 + z))² | inverse-square law |
| AT-14 | atmosphere | geometric → geopotential altitude | ussa-1976 | (18) | 24 | 8 | H = (g_0/g_0') r_0 z/(r_0 + z) = Γ r_0 z/(r_0 + z) | e.g. z=11019 m → H≈11000 m'; cross-check: rocketpy:rocketpy/environment/environment.py:pressure_ISA |
| AT-15 | atmosphere | geopotential → geometric altitude | ussa-1976 | (19) | 24 | 8 | z = r_0 H/(Γ r_0 − H) | cross-check: rocketpy:rocketpy/tools.py:geopotential_height_to_geometric_height (default radius 63781370 suspicious) |
| AT-16 | atmosphere | equation of state (pressure) | ussa-1976 | (1) | 22 | 6 | P = ρ R* T / M | perfect gas, dry air |
| AT-17 | atmosphere | hydrostatic equation | ussa-1976 | (5) | 22 | 6 | d ln P = dP/P = −g M/(R* T) dz | integrated form gives (33a)/(33b) |
| AT-18 | atmosphere | molecular-scale temperature definition | ussa-1976 | (22) | 25 | 9 | T_M = T M_0/M, i.e. T = T_M (M/M_0) | M/M_0 = 1 for z ≤ 80 km |
| AT-19 | atmosphere | M/M_0 correction 80–86 km | ussa-1976 | Table 8 | 25 | 9 | M/M_0 at z [km] = 80.0:1.000000, 80.5:0.999996, 81.0:0.999989, 81.5:0.999971, 82.0:0.999941, 82.5:0.999909, 83.0:0.999870, 83.5:0.999829, 84.0:0.999786, 84.5:0.999741, 85.0:0.999694, 85.5:0.999641, 86.0:0.999579; T = T_M (M/M_0) | main tables omit this correction (text p.9) |
| AT-20 | atmosphere | T_M(H) linear law | ussa-1976 | (23) | 26 | 10 | T_M = T_M,b + L_M,b (H − H_b), H_b ≤ H < H_b+1, b = 0..6 | valid 0 to 84.852 km' (−5 km' allowed for b=0) |
| AT-21 | atmosphere | kinetic temperature at 86 km | ussa-1976 | (25) | 26 | 10 | T_7 = 186.8673 K (= T_M,7 · 0.9995788) | end-point check for M/M_0 correction |
| AT-22 | atmosphere | pressure, L_M,b ≠ 0 | ussa-1976 | (33a) | 28 | 12 | P = P_b [T_M,b / (T_M,b + L_M,b (H − H_b))]^(g_0' M_0 / (R* L_M,b)) | cross-check: rocketpy:rocketpy/environment/environment.py:pressure_ISA (ISO 2533, R=287.05287) |
| AT-23 | atmosphere | pressure, L_M,b = 0 | ussa-1976 | (33b) | 28 | 12 | P = P_b exp[−g_0' M_0 (H − H_b) / (R* T_M,b)] | P_b from chaining (33a)/(33b) at H = H_b+1 |
| AT-24 | atmosphere | mass density | ussa-1976 | (42) | 31 | 15 | ρ = P M_0/(R* T_M) = P M/(R* T) | cross-check: rocketpy:rocketpy/environment/environment.py:calculate_density_profile |
| AT-25 | atmosphere | speed of sound | ussa-1976 | (50) | 34 | 18 | a = sqrt(γ R* T_M / M_0) | tabulated only to 86 km; cross-check: rocketpy calculate_speed_of_sound_profile |
| AT-26 | atmosphere | dynamic viscosity (Sutherland) | ussa-1976 | (51) | 35 | 19 | μ = β_S T^(3/2) / (T + S) | uses kinetic T; cross-check: rocketpy calculate_dynamic_viscosity |
| AT-27 | atmosphere | kinematic viscosity | ussa-1976 | (52) | 35 | 19 | ν = μ/ρ | tabulated only to 86 km |
| AT-28 | atmosphere | check: sea-level values | ussa-1976 | Table 10 | 36 | 20 | T_0=288.15 K; P_0=1.01325e5 Pa; ρ_0=1.2250 kg/m³; a_0=340.294 m/s; μ_0=1.7894e-5 kg/(m·s); ν_0=1.4607e-5 m²/s; M_0=28.9644; g_0=9.80665 | μ_0 reproduces only with S=110.4 K |
| AT-29 | atmosphere | check: Table I at H = 0 | ussa-1976 | Table I | 67 | 52 | H=0, z=0: T=T_M=288.150 K; P=1.01325e3 mb; ρ=1.2250 kg/m³ | geopotential-altitude half of Table I |
| AT-30 | atmosphere | check: Table I at H = 11000 m' | ussa-1976 | Table I | 73 | 58 | H=11000, z=11019 m: T=T_M=216.650 K; P=2.2632e2 mb (22632 Pa); ρ=3.6392e-1 kg/m³; P/P_0=2.2336e-1; ρ/ρ_0=2.9708e-1 | our (33a) gives 22632.06 Pa, 0.363918 kg/m³ |
| AT-31 | atmosphere | check: Table I, geopotential half | ussa-1976 | Table I | 67-81 | 52-66 | (H [m'], T_M [K], P [Pa], ρ [kg/m³]): (1000, 281.650, 89874, 1.1116) p67; (15000, 216.650, 12044, 0.19367) p73; (20000, 216.650, 5474.8, 0.088035) and (25000, 221.650, 2511.0, 0.039466) p75; (32000, 228.650, 868.01, 0.013225) p77; (40000, 251.050, 277.52, 3.8510e-3), (47000, 270.650, 110.90, 1.4275e-3), (51000, 270.650, 66.938, 8.6160e-4), (55000, 259.450, 39.969, 5.3668e-4) p79; (71000, 214.650, 3.9564, 6.4211e-5), (80000, 196.650, 0.88627, 1.5701e-5) p81 | tested in `rw-atmos` `ussa1976::tests`; main tables print T = T_M (no M/M_0 correction) |
| AT-32 | atmosphere | check: Table I, geometric half | ussa-1976 | Table I | 72 | 57 | Z = 10000 m: H = 9984 m', T = 223.252 K, P = 26499 Pa, ρ = 0.41351 kg/m³ | exercises the z → H transform (AT-14) |
| AT-33 | atmosphere | check: Table III sound speed and viscosity | ussa-1976 | Table III | 116-130 | 101-115 | (Z [m], a [m/s], μ [Pa s], ν [m²/s]): (0, 340.29, 1.7894e-5, 1.4607e-5), (1000, 336.43, 1.7579e-5, 1.5813e-5) p116; (11000, 295.15, 1.4223e-5, 3.8988e-5), (15000, 295.07, 1.4216e-5, 7.2995e-5) p122; (30000, 301.71, 1.4753e-5, 8.0134e-4) p126; (50000, 329.80, 1.7037e-5, 1.6591e-2) p128; (80000, 282.54, 1.3208e-5, 0.71557), (85000, 275.52, 1.2647e-5, 1.5386) p130 | above 80 km the table's μ uses T = T_M; (51) with kinetic T is 2.7e-4 lower at 85 km |

### RC — Recovery, descent, tumbling

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| RC-01 | recovery | descent model | niskanen-2013 | sec 4.2.5 | 78-79 | 69-70 | after deployment: 3DOF point mass, drag only from deployed devices, D = −½ ρ \|v_rel\| v_rel Σ C_D A | |
| RC-02 | recovery | parachute drag area | niskanen-2013 | sec 4.2.5 | 79 | 70 | C_D A = C_D π (d² − d_s²)/4, C_D default 0.8 | spill hole d_s removed (ours) |
| RC-03 | recovery | streamer drag (unit area) | niskanen-2013 | (C.3) | 125 | 116 | C_D A = 0.034 (l + 1 m) w | 80 g/m² polyethylene |
| RC-04 | recovery | streamer drag coefficient | niskanen-2013 | (C.6) | 126 | 117 | C_D = 0.034 ((ρ_m + 25 g/m²)/105 g/m²) (l + 1 m)/l on A = w l | ρ_m surface density |
| RC-05 | recovery | terminal velocity | niskanen-2013 | (3.98) | 63 | 54 | ½ ρ v_0² C_D A = m g | |
| RC-06 | recovery | tumbling drag | niskanen-2013 | (3.99) | 64 | 55 | C_D A_ref = C_D,f A_f + C_D,bt A_bt, C_D,f = 1.42, C_D,bt = 0.56 | A_bt body profile area; A_f one fin × RC-07 factor |
| RC-07 | recovery | tumbling fin efficiency | niskanen-2013 | Table 3.4 | 64 | 55 | N = 1..8: 0.50, 1.00, 1.50, 1.41, 1.81, 1.73, 1.90, 1.85 | N > 8 uses 1.85 (ours) |

### RB — Rigid-body 6DOF (impl.)

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| RB-01 | 6DOF | body→world matrix of Euler parameters | rocketpy | - | - | - | K(e) rows a11..a33 | rocketpy:rocketpy/simulation/flight.py:Flight.u_dot; body axis 3 toward the nose |
| RB-02 | 6DOF | Euler-parameter rates | rocketpy | - | - | - | ė = ½ Ω(ω) e | rocketpy:rocketpy/simulation/flight.py:Flight.u_dot; plus −λ(\|e\|² − 1)e (ours) |
| RB-03 | 6DOF | rotational equations, axisymmetric, variable inertia | rocketpy | - | - | - | I_t ω̇_1 = M_1 − (I_r − I_t) ω_2 ω_3 − İ_t ω_1; I_t ω̇_2 = M_2 − (I_t − I_r) ω_1 ω_3 − İ_t ω_2; I_r ω̇_3 = M_3 − İ_r ω_3 | rocketpy:rocketpy/simulation/flight.py:Flight.u_dot (motor-free part); jet damping MM-15 |
| RB-04 | 6DOF | lift force and moment of a surface | rocketpy | - | - | - | F_⊥ = q A C_N s_⊥/\|s_⊥\| (s = stream velocity in body axes), M = (−z_cp F_2, z_cp F_1, 0) | rocketpy:rocketpy/rocket/aero_surface/aero_surface.py:AeroSurface.compute_forces_and_moments |

### LQ — Liquid engines: thrust chamber, injector, feed, pressurant, tanks (sp-125)

SI forms (SP-125 writes weight flow ẇ and g; here ṁ = ẇ/g). sp-125 printed = pdf − 9. `rw-liquid` cites each row's eq and pdf page.

| row-id | system | quantity | lit-id | eq | pdf-p | printed-p | equation (our notation) | note |
|---|---|---|---|---|---|---|---|---|
| LQ-01 | thrust chamber | characteristic velocity | sp-125 | (1-32) | 21 | 12 | c* = P_c A_t / ṁ | `sizing::mass_flow` solves for ṁ; c* from CEA (tables or native) |
| LQ-02 | thrust chamber | thrust from the thrust coefficient | sp-125 | (1-33) | 21 | 12 | F = C_f A_t P_c | `sizing::thrust` |
| LQ-03 | thrust chamber | thrust coefficient at ambient p_a | sp-125 | (1-33a) | 21 | 12 | C_f = √(2γ²/(γ−1) (2/(γ+1))^((γ+1)/(γ−1)) [1 − (p_e/P_c)^((γ−1)/γ)]) + ε (p_e − p_a)/P_c | implemented as C_f = C_f,vac − ε p_a/P_c with C_f,vac from CEA; the ideal-gas form is the acceptance cross-check (3%) |
| LQ-04 | thrust chamber | throat area for a thrust target | sp-125 | (1-34) | 22 | 13 | A_t = F / (C_f P_c) | Acceptance 8b hand calculation |
| LQ-05 | thrust chamber | characteristic length | sp-125 | (4-4) | 95 | 86 | L* = V_c / A_t | V_c from injector face to throat |
| LQ-06 | thrust chamber | L* range | sp-125 | text | 96 | 87 | 15 in ≤ L* ≤ 120 in (0.381-3.048 m) | rule RW-E221; Table 4-1 per pair |
| LQ-07 | thrust chamber | chamber volume, cylinder + convergent cone | sp-125 | (4-5) | 97 | 88 | V_c = A_t [L_c ε_c + ⅓ √(A_t/π) cot θ (ε_c^⅓ − 1)] | solved for L_c; θ = 20° (sample calc. 4-2) |
| LQ-08 | thrust chamber | contraction ratio range, pressure-fed | sp-125 | text | 97 | 88 | 2 ≤ ε_c ≤ 5 | rule RW-E222 (ε_c ≥ 2) |
| LQ-09 | nozzle | conical nozzle length | sp-125 | (4-7) | 99 | 90 | L_n = [R_t (√ε − 1) + R (sec α − 1)] / tan α | α = 15° (12-18°), R = R_t (0.5-1.5 R_t) |
| LQ-10 | injector | injection velocity | sp-125 | (4-39) | 137 | 128 | V = ṁ / (A ρ) | |
| LQ-11 | injector | orifice pressure drop | sp-125 | (4-40) | 137 | 128 | ΔP = (ṁ / (C_d A))² / (2ρ) | C_d 0.5-0.92 (default 0.7); also every valve and orifice resistance R = 1/(2ρ (C_d A)²) |
| LQ-12 | injector | injector drop rule of thumb | sp-125 | text | 137 | 128 | ΔP_inj ≈ 15-20% of P_c | rule RW-E220 accepts 15-25% |
| LQ-13 | pressurant | perfect-gas pressurant mass | sp-125 | (5-1) | 161 | 152 | m_g = P V / (R_g T) | ullage gas mass at loading (20 °C) |
| LQ-14 | pressurant | polytropic expansion | sp-125 | (5-15) | 168 | 159 | T_2/T_1 = (P_2/P_1)^((n−1)/n) ⇒ P V^n = const | n = 1 isothermal, n = γ adiabatic (default); Acceptance 8c |
| LQ-15 | feed | straight-line friction loss | sp-125 | (7-7) | 292 | 283 | ΔP = f (L/d) ρ v² / 2 | f = 0.02 (smooth tubing, fig. 7-20 range); R = f (L/d)/(2ρA²) |
| LQ-16 | tanks | tank design volume | sp-125 | (8-1) | 341 | 332 | V_t = V + T + B + U | rule RW-E224: V_t ≥ 1.10 V |
| LQ-17 | tanks | ellipsoidal / spherical end volume | sp-125 | (8-16) | 347 | 338 | V_end = ⅔ π a² b (b = a sphere, b = a/2 for 2:1 heads) | partial fill: π a² (h²/b − h³/(3b²)) (integrated) |
| LQ-18 | tanks | cylindrical section volume | sp-125 | (8-29) | 348 | 339 | V = π a² l | liquid level, centroid, and shell volume integrate LQ-17/18 |
| LQ-19 | tanks | cylinder wall for membrane (hoop) stress | sp-125 | (8-30) | 348 | 339 | t_c = P a / (S_w e_w) ⇒ σ = P a / t | a = mean radius, e_w = 1; rule RW-E225: S_y/σ ≥ 2 |

## Errata (errors and discrepancies found in the original sources)

| source | location | issue | use |
|---|---|---|---|
| niskanen-2009 | (3.44), pdf 40 | K_3 omits the −12 M² term that barrowman-1967 (3-7), pdf 14, prints. | Use Barrowman's K_3 (BW-B67-008). |
| niskanen-2009 | (3.73)/(3.74), pdf 50 | The equilibrium roll rate uses y_mac, but the forcing term (3.66) uses (y_mac + r_t). | Equate DM-08 and DM-10 directly; do not use the printed f_eq. |
| niskanen-2009 vs barrowman-1967 | (3.82) vs (4-9)/(4-10), pdf 55/57 | Subsonic C_f correction: Niskanen uses 1 − 0.1 M² for both smooth and rough. Barrowman uses 1 − 0.09 M² (smooth) and 1 − 0.12 M² (rough). | Model choice: Niskanen. Flag in the parity log. |
| niskanen-2009 vs barrowman-1967 | (3.89) vs (4-18)/(4-19), pdf 59/60 | LE drag: the transonic slope is 1.785 vs 1.5, and Niskanen drops the supersonic +0.0231/M⁶ term. | Model choice: Niskanen. Flag in the parity log. |
| barrowman-1967 | (3-25), pdf 20 | Sign of s/(c_r − c_t) is inverted relative to its own derivation; (3-26) is correct. | Use (3-26) / BW-12. |
| barrowman-1967 | (3-90), pdf 40 | The tangent-ogive volume RHS equals V_c/(π d³), not V_c/(d A(L)), so it is low by 4 (checked numerically). | V_c = π d_1³ · RHS (MI-06). |
| barrowman-1967 | (3-96), pdf 41 | K_T(B) as printed lacks +π/4 in the first bracket (it tends to 0.5 as r_t → 0). The standard slender-body form includes it. | Use K_T(B) = 1 + r_t/(s + r_t) (BW-32); verify any exact form before use. |
| niskanen-2009 vs niskanen-2013 / barrowman-1967 | (3.54)/(3.55), pdf 44; niskanen-2013 (3.54), pdf 42-43; barrowman-1967 (3-11), (3-98), (3-106), pdf 14/41/47 | The thesis cuts the N = 3, 4 fin-set slope by up to 15 % / 6 % with roll angle and neglects K_B(T). niskanen-2013 drops the roll term (N/2 × fin–fin factor 1.000, 0.948, 0.913, 0.854, 0.810, 0.750), and Barrowman keeps K_B(T) = (1 + r_t/(s + r_t))² − K_T(B). | Use niskanen-2013 (3.54) and add K_B(T) subsonically (M1.38-p, parity-log). |
| barrowman-1967 | (3-121), pdf 52 | The r_t³ factor is dropped from the numerator integral. | Use (3-120). |
| barrowman-1967 | (4-36), pdf 66 | The bracket is inverted relative to solving (4-34) for K_P. | Re-derive from (4-34). |
| barrowman-1967 | (4-50), pdf 70 | Constant printed as 0.29; (4-48)/(4-49) and (4-52) use 0.029. | 0.029. |
| barrowman-1967 | (3-115), pdf 51 | The pitch-damping C_mq result is blank in the scan. | Not used; see DM-01..DM-04. |
| ussa-1976 | Table 2, pdf 18 | Misprints: the R* exponent, r_0 ×1000, and S = 110 (should be 110.4). Page 4 prints β_S with 10⁶ for 10⁻⁶. The errata sheet is at pdf 242. | Values in AT-03, AT-04, AT-09. |
| rocketpy | `rocketpy/environment/environment.py` `Environment.__init__` `__standard_atmosphere_layers` | The 80 km' layer base pressure is 8.86272e-2 Pa; USSA Table I (pdf 81) gives 0.88627 Pa (8.8627e-1 mb), so RocketPy is 10× low. It only matters above 80 km', where RocketPy clamps to that value. | Cross-check only to 80 km (`crates/rw-atmos/tests/rocketpy_isa.rs`). |
| amcp-706-280 | Table 6-1, pdf 104 (same in mil-hdbk-762 Table 7-1, pdf 535) | Fin roll inertia omits the cross term 2 r_t η̄ m. | Exact: I_xx = m [r_t² + 2 r_t η̄ + (s²/6)(1 + 3λ)/(1 + λ)], η̄ = (s/3)(1 + 2λ)/(1 + λ). |

## Gaps (no primary-source equation found)

1. **Pappus–Guldinus, thin-shell and solid body-of-revolution mass/CG/inertia integrals.** No primary source prints them. The sourced pieces are: inertia definitions (MI-08, mil-hdbk-762 (7-20)), V = π∫r² dx (MI-05), thin-wall mass ≈ ρ_m A_wet t_w (MI-07), and closed forms for cone, frustum, paraboloid and tube (MI-09..MI-19). The general forms are standard mechanics derived from MI-08: dm = ρ_m t_w 2π r sqrt(1 + r'²) dx (shell), dm = ρ_m π r² dx (solid), I_xx = ∫ r² dm (shell) or ∫ r²/2 dm (solid), I_yy = ∫ (r²/2 + (x − x_cg)²) dm (shell) or ∫ (r²/4 + (x − x_cg)²) dm (solid). RocketPy has no geometry-based mass, so there is no cross-check.
2. **Fin axial CG and own pitch inertia.** AMCP gives only "centroid of area" and I ≈ 0. The trapezoid centroid from the root LE is [x_t (c_r + 2c_t) + c_r² + c_r c_t + c_t²] / (3 (c_r + c_t)) (standard).
3. **Motor propellant mass vs time.** Primary sources give only the linear-in-time form (MM-03/MM-04, mil-hdbk-762 (3-22)/(3-23)). Propellant mass ∝ remaining impulse (MM-05) and motor/propellant inertia (MM-08..MM-10) are sourced only from RocketPy. Niskanen 2009/2013 print no motor-mass equation.
4. **Axial drag vs angle of attack (PD-11).** Only the constraints are printed (1 at 0°, 1.3 at 17°, 0 at 90°, zero slope); there are no polynomial coefficients.
5. **Nose pressure drag data C_3(M) at f_n = 3** for power, parabolic, Haack and ellipsoid shapes (PD-19). The source is Stoney's data, which is not in any local reference. Transonic interpolation polynomials (PD-02, PD-16) are defined by constraints only.
6. **Shoulder pressure drag (PD-03).** It is a stated rule, with no supersonic data.
7. **Pitch damping.** Barrowman's C_mq result (3-115) is unreadable. Niskanen's DM-01..DM-04 are rough estimates.
8. **Closed-form nose/transition CP for specific shapes.** Not printed. Derive from BW-06 with V_c from MI-05 or the GE profiles.
9. **USSA layer base values P_b, T_M,b for b ≥ 1.** Part 1 does not tabulate them; AT-11 values are derived via (23), (33a) and (33b) and checked against Table I at 11 km.
10. **Rail buttons.** Modelled only as a lug of equal frontal area with l = d (PA-03); there is no dedicated equation. Every launch guide takes its free-stream drag (PA-01..PA-03) on the boundary-layer mean dynamic pressure over its height (PA-04..PA-07); PA-06 states the free-stream coefficient on q̄ only for h/δ > 1, so the Re(h) dependence of a submerged guide is not modelled. Hoerner's protuberance data (quoted by niskanen-2009 for the 0.74 and 0.80 values) are not in the folder, so whether those values already include immersion is unknown. The pin frontal area is the projected spool (base and flange at the outer diameter, neck at the neck diameter; PA-03, PA-07, PARITY-buttons). Rail buttons take q̄ from a linear velocity profile through δ (PA-08, PARITY-buttons-2); no source in the folder gives that profile for a turbulent layer (TM 1218 and TM 1299 use the 1/7-power law), so it is a model choice, kept for the strong immersion short pins show (drag falling with station and rising with speed). Lugs keep the 1/7-power profile.
11. **Tube fins (clusters of rings on a body).** No source treats N tubes around a body. The rw-aero model (`tube_fins`) takes each tube as an isolated ring (TF-02, via the (3.40)/(3.49) rectangular wing at AR = A), sums N tubes without the planar sin² roll weighting (a ring is axisymmetric), and keeps the planar panel's (3.54) fin–fin factor and Barrowman K_T(B) + K_B(T) (TF-06 says the ring/planar ratio includes the fin–body interference). Tube–tube interference of touching tubes, and the CP of a body-mounted ring at low speed (TF-05 isolated vs TF-07 body-mounted), have no source; CP uses (3.36) at AR = A. Drag: TN 4117 Fig 5 (pdf 15) gives C_D ≈ 0.02-0.03 on S = d c at α = 0 for every A (Clark Y rings, 11.7 % thick, Re_c 0.7-2.1·10⁶), friction-dominated. No public source treats thin blunt tubes clustered on a body (PARITY-drag searches: NTRS ring tail, ring wing drag, tube/annular fin, lattice/grid fin; DTIC tube-fin projectiles), so the drag is assembled from cited pieces on our own split of the flow (PARITY-tubes): pipe flow in the bore (TF-10), the corner channels between tube and body as blunt faces (TF-11; the closed-channel argument is ours), flat-plate friction on the rest of the outside (TF-09), and the wall edges (TF-08).
12. **Nose/transition wall-to-shoulder joint.** MI-07 (wall of thickness t_w), MI-18 (shoulder tube) and MI-25 (superposition) define the parts; no source adds material where the wall meets the shoulder, so rw-geom adds none (the M2.1 45° chamfer was removed in M2-parity).
13. **Body-load CP outside chart 16.** NACA TR 1307 chart 16 covers subsonic trapezoids with λ = 0..1 between the no-leading-edge and no-trailing-edge sweep families; other planforms (elliptical, freeform, aft-swept trailing edge, forward-swept leading edge, λ < ½ with a forward-swept mid-chord) keep the body load at the fin CP. The supersonic body-load CP (TR 1307 charts 14-15, eqs 66-70) is not implemented: rw-aero fades the body load and its CP shift with K_B(T) from M 0.9 to 1.5 (BW-1307-05, `fin_body_cp`), freezing β at M 0.9.
14. **Liquid propellant and pressurant properties.** SP-125 tabulates no N2O or alcohol data; `rw_liquid::props` uses NIST Chemistry WebBook reference values at 20 °C (N2O 786.6, ethanol 789.3, IPA 785.1 kg/m³; N2 R = 296.8 J/(kg K), γ = 1.40; He 2077.1, 1.667) and treats N2O as single-phase liquid (spec S:129).

## Verification

- 2026-10-16: a fresh reviewer took a stratified random sample of 5 rows (BW-31, BD-B67-007, AT-07, MM-03, PD-B67-012) and checked each against the rendered PDF page for equation number, printed page, equivalence in our notation, and validity range. All 5 passed. One clarification was applied: AT-07's T_M,0 = T_0 is marked as derived.
- The row builders verified each row against the page text, using rendered images where the text was garbled. The Errata entries for niskanen-2009 (3.44) and barrowman-1967 (3-96) were re-confirmed on page images (pdf 14 and pdf 41).
