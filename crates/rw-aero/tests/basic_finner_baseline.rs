//! Baseline error report: rw-aero vs DREV-TM-9703 (Dupuis & Hathaway 1997)
//! Table IX multiple-fit aerodynamic coefficients for the Basic Finner
//! reference projectile. This test reports but does NOT fail on the error
//! magnitudes — it establishes the Phase 1 baseline before any supersonic
//! physics is added.
//!
//! Cmq is printed but NOT scored: rw-aero uses a quadratic pitch-damping
//! model (Niskanen eq 3.59) incompatible with the linear Cmq from BARDAS, and
//! the DREV report does not state its qd/V vs qd/(2V) normalisation. See
//! tests/validation/basic_finner_drev/PROVENANCE.md.

use rw_aero::drag::pressure::{fin_le_cd, fin_te_cd};
use rw_aero::fins::{kb_t, kt_b};
use rw_aero::{AeroModel, AeroOptions, AeroState, DragKind};
use rw_model::{EvaluatedModel, FinCrossSection};
use serde_json::{Value, json};

struct DragDiag {
    mach: f64,
    ns_fric: f64,
    ns_pres: f64,
    bd_fric: f64,
    bd_base: f64,
    fn_fric: f64,
    fn_le: f64,
    fn_te: f64,
    total: f64,
}

const D: f64 = 0.030; // reference diameter in m (1 caliber)
const X_CG: f64 = 5.50 * D; // CG at 5.50 cal from nose tip
const A0: f64 = 340.294; // sea-level speed of sound (USSA 1976)
const NU0: f64 = 1.4607e-5; // kinematic viscosity

fn basic_finner() -> EvaluatedModel {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/evaluated-model.json"
    )))
    .expect("fixture json");
    let mut m: EvaluatedModel =
        serde_json::from_value(fixture["payload"].clone()).expect("fixture model");

    // d = 30 mm; cone 2.84 cal; body to 10.0 cal; 4 fins 1 cal × 1 cal, TE flush.
    // Roughness 0.5 µm (steel surface).
    //
    // Fin cross-section: "airfoil" (eq 3.89 LE, zero TE).
    // DREV wedge fins have sharp LE (0.004 cal ≈ 0.12 mm radius) and blunt TE
    // (0.08 cal). rw-aero has no wedge cross-section (Gap fin-wedge); "airfoil" is
    // the best available choice: it uses the rounded LE formula (eq 3.89) which is
    // lower than stagnation drag ("square"), though still higher than a true sharp
    // wedge LE. TE drag is zero for "airfoil"; the correct value is full base_cd
    // (as "square" gives). See drag breakdown table in the test output.
    let nose = json!({
        "id": "nose", "name": "Nose cone", "parent": null, "children": [],
        "containment": "axial", "aero": true, "cut": false,
        "x_fore": 0.0, "x_aft": 2.84 * D,
        "radial": 0.0, "roll": 0.0,
        "instances": [{"index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0}],
        "anchors": [], "roughness": 5e-7,
        "shape": {
            "type": "nose_cone", "shape": "conical", "shape_param": 0.0,
            "length": 2.84 * D, "od": D, "thickness": 0.0,
            "shoulder": {"length": 0.0, "od": D, "thickness": 0.0, "capped": false}
        }
    });
    let body = json!({
        "id": "body", "name": "Body tube", "parent": "nose", "children": [],
        "containment": "axial", "aero": true, "cut": false,
        "x_fore": 2.84 * D, "x_aft": 10.0 * D,
        "radial": 0.0, "roll": 0.0,
        "instances": [{"index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0}],
        "anchors": [], "roughness": 5e-7,
        "shape": {
            "type": "body_tube",
            "length": (10.0 - 2.84) * D,
            "od": D,
            "id": D - 2.0 * 0.001  // 1 mm wall
        }
    });
    // Rectangular fins: root = tip = chord = span = 1 cal; TE flush with base.
    // Wedge section at 0.08 cal full thickness. No sweep → gamma_le = 0.
    let fins = json!({
        "id": "fins", "name": "Fin set", "parent": "body", "children": [],
        "containment": "surface", "aero": true, "cut": false,
        "x_fore": 9.0 * D, "x_aft": 10.0 * D,
        "radial": 0.0, "roll": 0.0,
        "instances": [{"index": 0, "offset": [0.0, 0.0, 0.0], "roll": 0.0}],
        "anchors": [], "roughness": 5e-7,
        "shape": {
            "type": "trapezoidal_fin_set",
            "count": 4u32,
            "thickness": 0.08 * D,
            "cross_section": "airfoil",
            "cant": 0.0,
            "fillet_radius": 0.0,
            "root_chord": D,
            "tip_chord": D,
            "span": D,
            "sweep": 0.0
        }
    });
    m.components = [nose, body, fins]
        .into_iter()
        .map(|v| serde_json::from_value(v).expect("component"))
        .collect();
    m.reference.diameter = D;
    m.reference.area = std::f64::consts::PI * D * D / 4.0;
    m
}

struct DrevRow {
    mach: f64,
    cx0: f64,
    cna: f64,
    cma: f64,
    cmq: f64,
    clp: f64,
}

fn parse_table_ix() -> Vec<DrevRow> {
    let csv = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/validation/basic_finner_drev/drev-tm-9703_table-IX_multiple-fit.csv"
    ));
    // group(0),shots(1),mach(2),dbsq_deg2(3),abarm(4),CX(5),pe_CX(6),CNa(7),
    // pe_CNa(8),Cma(9),pe_Cma(10),Cmq(11),pe_Cmq(12),...,Clp(23),...
    csv.lines()
        .filter(|l| !l.starts_with('#') && !l.starts_with("group"))
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split(',').collect();
            let p = |i: usize| cols[i].trim().parse::<f64>().unwrap_or(f64::NAN);
            DrevRow {
                mach: p(2),
                cx0: p(5),
                cna: p(7),
                cma: p(9),
                cmq: p(11),
                clp: p(23),
            }
        })
        .collect()
}

/// Baseline error report: rw-aero vs DREV-TM-9703 Table IX. This test prints
/// a comparison table and asserts only that all outputs are finite. No
/// accuracy threshold is set in Phase 1.
#[test]
fn basic_finner_baseline_vs_drev() {
    let model = basic_finner();
    let am = AeroModel::new(&model, &rw_geom::build(&model), &AeroOptions::default());
    let rows = parse_table_ix();

    // Reference area and fin geometry for drag breakdown.
    let a_ref = std::f64::consts::PI * D * D / 4.0; // 7.069e-4 m²
    let fin_area_ratio = 4.0 * (0.08 * D) * D / a_ref; // N t s / A_ref ≈ 0.4074

    // K_T(B) = 1 + r_t/(span+r_t); r_t = D/2, span = D → 1.333 (fixed, no Mach dep.)
    let r_t = D / 2.0;
    let kt_b_val = kt_b(r_t, D);

    println!("\n=== Basic Finner DREV-TM-9703 baseline (Phase 1 — report only) ===");
    println!(
        "Ref: A_ref = π d²/4 = {:.4e} m²  d = {:.3} m  CG = {:.4} m from nose",
        a_ref, D, X_CG
    );
    println!("Fin cross-section: airfoil (eq 3.89 LE, zero TE).");
    println!(
        "Gap fin-wedge: DREV fins are sharp-LE wedge (LE radius 0.004 cal ≈ 0.12 mm,\n\
         0.08 cal full thickness at base). No wedge cross-section exists in rw-aero.\n\
         'airfoil' (used here) gives eq 3.89 LE drag (lower than stagnation/'square',\n\
         but still higher than a true sharp wedge) and zero TE drag (should be full\n\
         base_cd). See drag breakdown table below."
    );
    println!();

    // === Main comparison table ===
    println!(
        "{:>6} | {:>24} | {:>24} | {:>24} | {:>22} | {:>14}",
        "Mach",
        "      CX0 (zero-yaw drag)     ",
        "       CNα (per rad)          ",
        "       Cmα (moment slope)     ",
        "    CP (cal from nose)   ",
        "  Clp (roll damp)"
    );
    println!(
        "{:>6} | {:>7} {:>7} {:>7} | {:>7} {:>7} {:>7} | {:>7} {:>7} {:>7} | {:>7} {:>7} {:>5} | {:>7} {:>7}",
        "",
        "ref",
        "rw",
        "err%",
        "ref",
        "rw",
        "err%",
        "ref",
        "rw",
        "err%",
        "ref",
        "rw",
        "d_cal",
        "ref",
        "rw"
    );
    println!("{}", "-".repeat(130));

    let mut sq_cx = 0.0_f64;
    let mut sq_cna = 0.0_f64;
    let mut sq_cma = 0.0_f64;
    let mut sq_cp = 0.0_f64;
    let mut sq_clp = 0.0_f64;
    let n = rows.len() as f64;

    // Per-row data accumulated for the breakdown tables below.
    let mut drag_rows: Vec<DragDiag> = Vec::new();
    let mut cna_rows: Vec<(f64, f64, f64, f64, f64, f64)> = Vec::new();
    let mut clp_rows: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut cmq_rows: Vec<(f64, f64, f64)> = Vec::new();

    for row in &rows {
        let speed = row.mach * A0;
        let state_base = AeroState {
            mach: row.mach,
            speed,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        };
        let c = am.eval_with_cg(&state_base, X_CG);

        assert!(c.cn_alpha.is_finite(), "cn_alpha NaN at M={}", row.mach);
        assert!(c.cp.is_finite(), "cp NaN at M={}", row.mach);
        assert!(c.cd.is_finite(), "cd NaN at M={}", row.mach);
        assert!(c.cl_damping.is_finite(), "cl_damping NaN at M={}", row.mach);
        assert!(c.cm_damping.is_finite(), "cm_damping NaN at M={}", row.mach);

        let cx0_rw = c.cd;
        let cna_rw = c.cn_alpha;
        let cp_cal_rw = c.cp / D;
        let cma_rw = -c.cn_alpha * (c.cp - X_CG) / D;

        // Clp: pd/(2V) normalisation (BARDAS/AMCP-706-280 convention).
        // cl_damping is returned as a positive magnitude (damping.rs:7); negate here
        // so Clp < 0 (damping opposes roll, matching DREV sign convention).
        let p1 = 1.0_f64;
        let p05 = 0.5_f64;
        let c_p1 = am.eval_with_cg(
            &AeroState {
                roll_rate: p1,
                ..state_base
            },
            X_CG,
        );
        let c_p05 = am.eval_with_cg(
            &AeroState {
                roll_rate: p05,
                ..state_base
            },
            X_CG,
        );
        assert!(
            c_p1.cl_damping.is_finite(),
            "cl_damping(roll) NaN at M={}",
            row.mach
        );
        assert!(
            c_p05.cl_damping.is_finite(),
            "cl_damping(roll,p05) NaN at M={}",
            row.mach
        );
        let clp_p1 = -c_p1.cl_damping * 2.0 * speed / (p1 * D);
        let clp_p05 = -c_p05.cl_damping * 2.0 * speed / (p05 * D);
        let clp_rw = clp_p1;

        // Apparent Cmq (NOT SCORED). Printed at q_ref = 1 rad/s, qd/V normalisation.
        // rw-aero cm_damping is quadratic in pitch rate (Niskanen eq 3.59); apparent
        // Cmq printed here is therefore not a linear coefficient.
        let q_ref = 1.0_f64;
        let c_pitch = am.eval_with_cg(
            &AeroState {
                pitch_rate: q_ref,
                ..state_base
            },
            X_CG,
        );
        assert!(
            c_pitch.cm_damping.is_finite(),
            "cm_damping(pitch) NaN at M={}",
            row.mach
        );
        let cmq_apparent = -c_pitch.cm_damping * speed / (q_ref * D);

        // CP sign: d_cal = model_CP − DREV_CP, in calibers from nose, positive = aft.
        // Negative d_cal → model CP more forward than DREV → UNDERESTIMATES stability.
        let cp_cal_ref = 5.50 - row.cma / row.cna;
        let pct = |rw: f64, r: f64| 100.0 * (rw / r - 1.0);

        println!(
            "{:>6.3} | {:>7.3} {:>7.3} {:>+7.1} | {:>7.2} {:>7.2} {:>+7.1} | {:>7.2} {:>7.2} {:>+7.1} | {:>7.3} {:>7.3} {:>+5.3} | {:>7.2} {:>7.2}",
            row.mach,
            row.cx0,
            cx0_rw,
            pct(cx0_rw, row.cx0),
            row.cna,
            cna_rw,
            pct(cna_rw, row.cna),
            row.cma,
            cma_rw,
            pct(cma_rw, row.cma),
            cp_cal_ref,
            cp_cal_rw,
            cp_cal_rw - cp_cal_ref,
            row.clp,
            clp_rw,
        );

        sq_cx += (cx0_rw / row.cx0 - 1.0).powi(2);
        sq_cna += (cna_rw / row.cna - 1.0).powi(2);
        sq_cma += (cma_rw / row.cma - 1.0).powi(2);
        sq_cp += (cp_cal_rw - cp_cal_ref).powi(2);
        sq_clp += (clp_rw - row.clp).powi(2);

        println!(
            "       Cmq ref={:>7.1}  apparent rw (q_ref=1 rad/s, qd/V, NOT SCORED)={:>10.4}",
            row.cmq, cmq_apparent
        );

        // Drag breakdown: sum drag_terms by component id and kind.
        let terms = am.drag_terms(&state_base);
        let cd_sum = |id: &str, kind: DragKind| -> f64 {
            terms
                .iter()
                .filter(|t| t.id == id && t.kind == kind)
                .map(|t| t.cd)
                .sum()
        };
        let nose_fric = cd_sum("nose", DragKind::Friction);
        let nose_press = cd_sum("nose", DragKind::Pressure);
        let body_fric = cd_sum("body", DragKind::Friction);
        let body_base = cd_sum("body", DragKind::Base);
        let fin_fric = cd_sum("fins", DragKind::Friction);
        // Fin LE and TE computed separately (fin_press = LE + TE in drag_terms).
        let fin_le = fin_area_ratio * fin_le_cd(FinCrossSection::Airfoil, 0.0, row.mach);
        let fin_te = fin_area_ratio * fin_te_cd(FinCrossSection::Airfoil, row.mach);
        drag_rows.push(DragDiag {
            mach: row.mach,
            ns_fric: nose_fric,
            ns_pres: nose_press,
            bd_fric: body_fric,
            bd_base: body_base,
            fn_fric: fin_fric,
            fn_le: fin_le,
            fn_te: fin_te,
            total: c.cd,
        });

        // CNα breakdown from c.components.
        let cna_nose = c
            .components
            .iter()
            .find(|k| k.id == "nose")
            .map_or(0.0, |k| k.cn_alpha);
        let cna_fins_int = c
            .components
            .iter()
            .find(|k| k.id == "fins")
            .map_or(0.0, |k| k.cn_alpha);
        let kb_t_val = kb_t(row.mach, r_t, D);
        cna_rows.push((row.mach, cna_nose, cna_fins_int, kb_t_val, cna_rw, row.cna));

        clp_rows.push((row.mach, clp_p05, clp_p1, row.clp));
        cmq_rows.push((row.mach, row.cmq, cmq_apparent));
    }

    println!("{}", "-".repeat(130));
    println!(
        "RMS err%: CX0={:.1}%  CNα={:.1}%  Cmα={:.1}%  CP={:.4} cal  Clp={:.3} (abs)",
        (sq_cx / n).sqrt() * 100.0,
        (sq_cna / n).sqrt() * 100.0,
        (sq_cma / n).sqrt() * 100.0,
        (sq_cp / n).sqrt(),
        (sq_clp / n).sqrt()
    );

    // === CP sign convention ===
    println!();
    println!(
        "CP sign: d_cal = model_CP − DREV_CP, cal from nose, positive = aft.\n\
         Negative d_cal → model CP more forward → UNDERESTIMATES stability."
    );

    // === Drag breakdown ===
    println!();
    println!("=== Drag breakdown (zero yaw, airfoil cross-section) ===");
    println!(
        "fin_LE: eq 3.89 (rounded formula); for a sharp wedge LE this is too high.\n\
         fin_TE: 0 (airfoil); DREV wedge TE should give full base_cd (Gap fin-wedge).\n\
         All values on the rocket reference area A_ref = π d²/4."
    );
    println!(
        "{:>6} | {:>8} {:>8} {:>8} {:>8} | {:>8} {:>8} {:>8} | {:>8}",
        "Mach", "ns_fric", "ns_pres", "bd_fric", "bd_base", "fn_fric", "fn_LE", "fn_TE", "total"
    );
    println!("{}", "-".repeat(85));
    for d in &drag_rows {
        println!(
            "{:>6.3} | {:>8.4} {:>8.4} {:>8.4} {:>8.4} | {:>8.4} {:>8.4} {:>8.4} | {:>8.4}",
            d.mach,
            d.ns_fric,
            d.ns_pres,
            d.bd_fric,
            d.bd_base,
            d.fn_fric,
            d.fn_le,
            d.fn_te,
            d.total
        );
    }

    // === CNα component breakdown ===
    println!();
    println!("=== CNα component breakdown ===");
    println!(
        "K_T(B) = 1 + r_t/(span+r_t) = {:.4} (fixed; r_t = D/2, span = D).",
        kt_b_val
    );
    println!(
        "K_B(T) fades from ~{:.4} (subsonic) to 0 at M≥1.5 (Gap 13: supersonic fig 3-9 \
         not digitised).",
        kt_b_val * kt_b_val - kt_b_val // K_B(T) subsonic = K_T(B)² − K_T(B)
    );
    println!(
        "fins_bare = fins_int / (K_T(B) + K_B(T)): single-fin CNα × fin_count_factor(4) = 2.\n\
         Supersonic single-fin slope = (A_fin/A_ref)*2(K1 + K3 α²), both fin faces\n\
         (barrowman-1967 App. A); at α → 0 this is Ackeret (A_fin/A_ref)*4/β."
    );
    println!(
        "{:>6} | {:>8} {:>8} {:>8} {:>7} {:>7} {:>7} | {:>8}",
        "Mach", "tot_CNα", "ns_CNα", "fn_bare", "K_T(B)", "K_B(T)", "int", "DREV_CNα"
    );
    println!("{}", "-".repeat(80));
    for (mach, cna_nose, cna_fins_int, kb_t_v, tot, drev_cna) in &cna_rows {
        let interference = kt_b_val + kb_t_v;
        let fins_bare = if interference.abs() > 1e-15 {
            cna_fins_int / interference
        } else {
            0.0
        };
        println!(
            "{:>6.3} | {:>8.3} {:>8.3} {:>8.3} {:>7.4} {:>7.4} {:>7.4} | {:>8.3}",
            mach, tot, cna_nose, fins_bare, kt_b_val, kb_t_v, interference, drev_cna
        );
    }

    // === Clp linearity and normalization ===
    println!();
    println!("=== Clp linearity check ===");
    println!(
        "Normalization: pd/(2V). DREV BARDAS uses pd/(2V) (AMCP-706-280 §3.2 convention).\n\
         Clp = −cl_damping × 2V/(p×d). cl_damping is a positive magnitude (damping.rs:7).\n\
         Subsonic formula is linear in p; supersonic Busemann is linear for small p.\n\
         ratio = Clp(p=0.5)/Clp(p=1.0) ≈ 1.0 confirms linearity.\n\
         M=1.077–1.293: Hermite blend may overshoot because subsonic CNα(0.9) = 2π/β(0.9) is large."
    );
    println!(
        "{:>6} | {:>10} {:>10} {:>7} | {:>10}",
        "Mach", "Clp(p=0.5)", "Clp(p=1.0)", "ratio", "DREV_Clp"
    );
    println!("{}", "-".repeat(55));
    for (mach, clp05, clp10, drev_clp) in &clp_rows {
        let ratio = if clp10.abs() > 1e-15 {
            clp05 / clp10
        } else {
            0.0
        };
        println!(
            "{:>6.3} | {:>10.3} {:>10.3} {:>7.4} | {:>10.3}",
            mach, clp05, clp10, ratio, drev_clp
        );
    }

    // === Cmq documentation ===
    println!();
    println!("=== Cmq (NOT SCORED in Phase 1) ===");
    println!(
        "rw-aero pitch damping is QUADRATIC in pitch rate (Niskanen 2009 eq 3.59 p 45):\n\
           pitch_damping_body = 0.55 * l^4 * r̄ / (A_ref * d) * (ω/V)^2   [damping.rs:26]\n\
           pitch_damping_fins = 0.6 * N * A_fin * ξ^3 / (A_ref * d) * (ω/V)^2 [damping.rs:45]\n\
         DREV BARDAS Cmq is linear: Cm ∝ Cmq × (qd/(2V or V)). Incomparable models.\n\
         Cmq normalisation (qd/V vs qd/2V) is not stated in DREV-TM-9703 nomenclature.\n\
         Apparent Cmq below is printed at q=1 rad/s (qd/V normalisation) for reference only."
    );
    println!("{:>6} | {:>10} {:>12}", "Mach", "DREV_Cmq", "rw_apparent");
    println!("{}", "-".repeat(35));
    for (mach, drev_cmq, cmq_app) in &cmq_rows {
        println!("{:>6.3} | {:>10.1} {:>12.4}", mach, drev_cmq, cmq_app);
    }
}
