//! Error report: rw-aero vs DREV-TM-9703 (Dupuis & Hathaway 1997) for the
//! Basic Finner reference projectile: Table IX multiple-fit coefficients
//! (static slope, CP, roll damping, drag) and Table X roll moment due to fin
//! cant. Report mode: the tests print the errors and fail only on a
//! non-finite output, a malformed reference table, or an error above a sanity
//! ceiling set about 10 % over the current model's value, so a change that
//! makes the supersonic fin model worse fails here.
//!
//! The fixture geometry is inline in `basic_finner()`. Sources in the report:
//! d, l and CG from Table I (pdf p 36); cone, fin planform, fin thickness
//! 0.08 cal and LE radius 0.004 cal from section 3.1 and Figure 2 (pdf p 53).
//! The fins are single wedges (sharp leading edge, blunt 0.08 cal base), so
//! the fixture uses `cross_section = "wedge"`.
//!
//! Cmq is scored in the report's qd/(2V) normalisation (section 7, eqs
//! [1]-[2]): the range value is C_mq + C_mα̇, which the model's linear pitch
//! damping also is. Each Mach group from M 1.2 must be within a factor of 1.5
//! (spec R5); M 1.077 sits in the transonic blend and is printed only. See
//! tests/validation/basic_finner_drev/PROVENANCE.md.

use rw_aero::carryover::Carryover;
use rw_aero::drag::pressure::{fin_le_cd, fin_te_cd};
use rw_aero::fins::{FinPlanform, Strip, kt_b};
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
    basic_finner_canted(0.0)
}

/// The Basic Finner with all four fins canted by `cant` radians (Table X
/// models: 2° and 4°).
fn basic_finner_canted(cant: f64) -> EvaluatedModel {
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
    // Fin cross-section: "wedge". The DREV fins have a sharp LE (0.004 cal,
    // about 0.12 mm radius) and a blunt 0.08 cal TE. The wedge section takes
    // the attached-shock forebody pressure at the half-angle atan(0.04) and
    // the full base drag on the blunt TE, and adds the thickness lift of the
    // two inclined faces. See the drag breakdown table in the test output.
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
    // Thickness 0.08 cal, the value section 3.1 gives at the fin base. No sweep
    // → gamma_le = 0.
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
            "cross_section": "wedge",
            "cant": cant,
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
    let rows: Vec<DrevRow> = csv
        .lines()
        .filter(|l| !l.starts_with('#') && !l.starts_with("group"))
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split(',').collect();
            // A cell that does not parse must stop the test: a NaN reference
            // would otherwise flow into the RMS and the printed table.
            let p = |i: usize| {
                let v = cols[i]
                    .trim()
                    .parse::<f64>()
                    .unwrap_or_else(|e| panic!("Table IX column {i} {:?}: {e}", cols[i]));
                assert!(v.is_finite(), "Table IX column {i} is {v}");
                v
            };
            DrevRow {
                mach: p(2),
                cx0: p(5),
                cna: p(7),
                cma: p(9),
                cmq: p(11),
                clp: p(23),
            }
        })
        .collect();
    // Table IX has 8 Mach groups.
    assert_eq!(rows.len(), 8, "Table IX row count");
    rows
}

/// Error report: rw-aero vs DREV-TM-9703 Table IX. This test prints a
/// comparison table and asserts that all outputs are finite and that the RMS
/// errors in CX0, CNα, Cmα and CP, and the signed CP error at every Mach
/// group, stay within sanity bounds set just outside the current model's
/// values.
#[test]
fn basic_finner_baseline_vs_drev() {
    let model = basic_finner();
    let geometry = rw_geom::build(&model);
    let am = AeroModel::new(&model, &geometry, &AeroOptions::default());
    let rows = parse_table_ix();
    // K_B(T) as the model builds it: the fins end at the base (section 3.1,
    // Figure 2), so there is no body behind the root trailing edge.
    let fin_geometry = geometry
        .components
        .iter()
        .find(|g| g.id == "fins")
        .and_then(|g| g.fins.as_ref())
        .expect("fin geometry");
    let carry = Carryover::new(&FinPlanform::from_geometry(fin_geometry), 0.0);

    // Reference area and fin geometry for drag breakdown.
    let a_ref = std::f64::consts::PI * D * D / 4.0; // 7.069e-4 m²
    let fin_area_ratio = 4.0 * (0.08 * D) * D / a_ref; // N t s / A_ref ≈ 0.4074

    // K_T(B) = 1 + r_t/(span+r_t); r_t = D/2, span = D → 1.333 (fixed, no Mach dep.)
    let r_t = D / 2.0;
    let kt_b_val = kt_b(r_t, D);

    println!("\n=== Basic Finner vs DREV-TM-9703 Table IX (report mode) ===");
    println!(
        "Ref: A_ref = π d²/4 = {:.4e} m²  d = {:.3} m  CG = {:.4} m from nose",
        a_ref, D, X_CG
    );
    println!("Fin cross-section: wedge (half-angle atan(0.04) = 2.29 deg, blunt 0.08 cal TE).");
    println!(
        "DREV fins are sharp-LE wedges (LE radius 0.004 cal ≈ 0.12 mm, 0.08 cal\n\
         thickness at the base). The wedge section gives the fin LE the forebody\n\
         pressure K1 δ + C2 δ² + K3 δ³ (zero below M 0.9, blended to M 1.5), the TE\n\
         the full base_cd, and the fin lift the thickness term 4 C2 δ + 6 K3 δ²."
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
    let (mut d_cal_min, mut d_cal_max) = (f64::INFINITY, f64::NEG_INFINITY);
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

        // Cmq + Cmα̇ in qd/(2V), the normalisation eqs [1]-[2] of the report's
        // section 7 imply. cm_damping is a magnitude: the linear term plus
        // Niskanen's quadratic crossflow term, which at 1e-3 rad/s is below
        // 1e-6 of the linear one.
        let q_ref = 1e-3_f64;
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
        let cmq_rw = -c_pitch.cm_damping * 2.0 * speed / (q_ref * D);

        // CP sign: d_cal = model_CP − DREV_CP, in calibers from nose, positive = aft.
        // Positive d_cal: model CP aft of DREV, static margin over-predicted.
        // Negative d_cal: model CP forward of DREV, static margin under-predicted.
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
        d_cal_min = d_cal_min.min(cp_cal_rw - cp_cal_ref);
        d_cal_max = d_cal_max.max(cp_cal_rw - cp_cal_ref);
        sq_clp += (clp_rw - row.clp).powi(2);

        println!(
            "       Cmq ref={:>7.1}  rw (qd/(2V))={:>8.1}",
            row.cmq, cmq_rw
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
        // One strip is enough for a rectangular fin (constant chord).
        let strip = [Strip {
            xi: D,
            chord: D,
            width: D,
        }];
        let fin_le =
            fin_area_ratio * fin_le_cd(FinCrossSection::Wedge, 0.0, 0.08 * D, &strip, row.mach);
        let fin_te = fin_area_ratio * fin_te_cd(FinCrossSection::Wedge, row.mach);
        // The two edge terms are the whole fin pressure row.
        let fin_press = cd_sum("fins", DragKind::Pressure);
        assert!(
            (fin_le + fin_te - fin_press).abs() <= 1e-12 * fin_press.abs().max(1.0),
            "fin LE + TE {} vs pressure term {fin_press}",
            fin_le + fin_te
        );
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
        // Nose and tube together: above M 0.9 the tube carries lift
        // (shock-expansion afterbody loading, naca-tr-1328).
        let cna_nose: f64 = c
            .components
            .iter()
            .filter(|k| k.id != "fins")
            .map(|k| k.cn_alpha)
            .sum();
        let cna_fins_int = c
            .components
            .iter()
            .find(|k| k.id == "fins")
            .map_or(0.0, |k| k.cn_alpha);
        let kb_t_val = carry.kb_t(row.mach);
        cna_rows.push((row.mach, cna_nose, cna_fins_int, kb_t_val, cna_rw, row.cna));

        clp_rows.push((row.mach, clp_p05, clp_p1, row.clp));
        cmq_rows.push((row.mach, row.cmq, cmq_rw));
    }

    println!("{}", "-".repeat(130));
    let rms_cx = (sq_cx / n).sqrt();
    let rms_cna = (sq_cna / n).sqrt();
    let rms_cp = (sq_cp / n).sqrt();
    let rms_cma = (sq_cma / n).sqrt();
    println!(
        "RMS err%: CX0={:.1}%  CNα={:.1}%  Cmα={:.1}%  CP={:.4} cal  Clp={:.3} (abs)",
        rms_cx * 100.0,
        rms_cna * 100.0,
        rms_cma * 100.0,
        rms_cp,
        (sq_clp / n).sqrt()
    );
    println!("CP d_cal range: {d_cal_min:+.3} to {d_cal_max:+.3} cal");

    // === CP sign convention ===
    println!();
    println!(
        "CP sign: d_cal = model_CP − DREV_CP, cal from nose, positive = aft.\n\
         Positive d_cal: model CP aft of DREV, static margin OVER-predicted by d_cal.\n\
         Negative d_cal: model CP forward of DREV, static margin UNDER-predicted."
    );

    // === Drag breakdown ===
    println!();
    println!("=== Drag breakdown (zero yaw, wedge cross-section) ===");
    println!(
        "fin_LE: wedge forebody pressure (N t s/A_ref)(K1 δ + C2 δ² + K3 δ³) from M 1.5,\n\
         blended down to zero at M 0.9. fin_TE: full base_cd on the blunt 0.08 cal base.\n\
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
        "K_B(T) is the slender-body {:.4} up to M {:.3} (naca-tr-1307 eq 22), the\n\
         supersonic lift integral (eq 23, no afterbody) from M {:.3}, a cubic between.",
        kt_b_val * kt_b_val - kt_b_val, // K_B(T) subsonic = K_T(B)² − K_T(B)
        carry.window().0,
        carry.window().1
    );
    println!(
        "fn_bare = fins_int / (K_T(B) + K_B(T)): single-fin CNα × fin_count_factor(4) = 2.\n\
         Supersonic single-fin slope = (A_fin/A_ref)*(2(K1 + K3 α²) + 4 C2 δ + 6 K3 δ²)*tip,\n\
         both fin faces (barrowman-1967 App. A) at the wedge half-angle δ = atan(0.04), with\n\
         the tip Mach-cone factor, 1 − 1/(2 β AR) for this rectangular AR 2 panel.\n\
         bd_CNα = nose + tube: slender-body 2 up to M 0.9, second-order\n\
         shock-expansion (naca-tr-1328) from M 1.5, a cubic between.\n\
         DREV_fin = (DREV_CNα − bd_CNα) / int: the bare fin term DREV implies.\n\
         ratio = fn_bare / DREV_fin."
    );
    println!(
        "{:>6} | {:>8} {:>8} {:>8} {:>7} {:>7} {:>7} | {:>8} {:>8} {:>6}",
        "Mach",
        "tot_CNα",
        "bd_CNα",
        "fn_bare",
        "K_T(B)",
        "K_B(T)",
        "int",
        "DREV_CNα",
        "DREV_fin",
        "ratio"
    );
    println!("{}", "-".repeat(96));
    for (mach, cna_nose, cna_fins_int, kb_t_v, tot, drev_cna) in &cna_rows {
        let interference = kt_b_val + kb_t_v;
        let fins_bare = if interference.abs() > 1e-15 {
            cna_fins_int / interference
        } else {
            0.0
        };
        let drev_fin = (drev_cna - cna_nose) / interference;
        println!(
            "{:>6.3} | {:>8.3} {:>8.3} {:>8.3} {:>7.4} {:>7.4} {:>7.4} | {:>8.3} {:>8.3} {:>6.2}",
            mach,
            tot,
            cna_nose,
            fins_bare,
            kt_b_val,
            kb_t_v,
            interference,
            drev_cna,
            drev_fin,
            fins_bare / drev_fin
        );
    }

    // === Clp linearity and normalization ===
    println!();
    println!("=== Clp linearity check ===");
    println!(
        "Normalization: pd/(2V). DREV BARDAS uses pd/(2V) (AMCP-706-280 §3.2 convention).\n\
         Clp = −cl_damping × 2V/(p×d). cl_damping is a positive magnitude (damping.rs:7).\n\
         Subsonic formula is linear in p; the supersonic strip load is linear for small p.\n\
         ratio = Clp(p=0.5)/Clp(p=1.0) ≈ 1.0 confirms linearity.\n\
         M=1.077–1.293: Hermite blend may overshoot because subsonic CNα(0.9) = 2π/β(0.9) is large."
    );
    println!(
        "{:>6} | {:>10} {:>10} {:>7} | {:>10} {:>8}",
        "Mach", "Clp(p=0.5)", "Clp(p=1.0)", "ratio", "DREV_Clp", "DREV/rw"
    );
    println!("{}", "-".repeat(64));
    for (mach, clp05, clp10, drev_clp) in &clp_rows {
        let ratio = if clp10.abs() > 1e-15 {
            clp05 / clp10
        } else {
            0.0
        };
        println!(
            "{:>6.3} | {:>10.3} {:>10.3} {:>7.4} | {:>10.3} {:>8.2}",
            mach,
            clp05,
            clp10,
            ratio,
            drev_clp,
            drev_clp / clp10
        );
    }

    // === Cmq ===
    println!();
    println!("=== Cmq + Cmα̇ (qd/(2V)) ===");
    println!(
        "rw: −[2 Σ C_Nα,i ((x_i − x_cg)/d)² + 8 V_b (x_c − x_cg)/(S d²)] over the zero-α\n\
         C_Nα rows (damping.rs pitch_damping_linear, pitch_damping_volume). DREV's\n\
         range value is Cmq + Cmα̇. Gate: each group from M 1.2 within a factor of\n\
         1.5 (spec R5); range data scatter 30-50 %."
    );
    println!(
        "{:>6} | {:>10} {:>10} {:>7}",
        "Mach", "DREV_Cmq", "rw", "rw/ref"
    );
    println!("{}", "-".repeat(42));
    let (mut sq_cmq, mut n_cmq) = (0.0_f64, 0usize);
    let (mut cmq_lo, mut cmq_hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (mach, drev_cmq, cmq_rw) in &cmq_rows {
        let ratio = cmq_rw / drev_cmq;
        let scored = *mach >= 1.2;
        println!(
            "{:>6.3} | {:>10.1} {:>10.1} {:>7.2}{}",
            mach,
            drev_cmq,
            cmq_rw,
            ratio,
            if scored { "" } else { "  (blend, not scored)" }
        );
        if scored {
            sq_cmq += (ratio - 1.0).powi(2);
            n_cmq += 1;
            cmq_lo = cmq_lo.min(ratio);
            cmq_hi = cmq_hi.max(ratio);
        }
    }
    let rms_cmq = (sq_cmq / n_cmq as f64).sqrt();
    println!(
        "M ≥ 1.2 ({n_cmq} groups): rw/ref {cmq_lo:.2} to {cmq_hi:.2}, RMS {:.1}%",
        100.0 * rms_cmq
    );
    assert_eq!(n_cmq, 7, "Cmq groups from M 1.2");
    // R5: every scored group within a factor of 1.5 of the range value
    // (today 0.80 to 1.09, RMS 13 %).
    assert!(
        cmq_lo >= 1.0 / 1.5 && cmq_hi <= 1.5,
        "Cmq rw/ref {cmq_lo:.2} to {cmq_hi:.2} outside a factor of 1.5"
    );

    // Sanity bounds only (report mode), about 10 % over the current model
    // (wedge section: forebody and base drag, two-face strip load with tip
    // relief and thickness lift; supersonic K_B(T) from the TR 1307 lift
    // integral; nose and tube lift by second-order shock-expansion):
    // RMS CX0 0.217, CNα 0.052, Cmα 0.039, CP 0.085 cal, d_cal −0.083 to
    // +0.142 cal. Without the supersonic body lift the same model gave
    // CNα 0.166, Cmα 0.043, CP 0.337 cal, d_cal +0.073 to +0.446.
    assert!(rms_cx <= 0.24, "RMS CX0 error {:.1}%", 100.0 * rms_cx);
    assert!(rms_cna <= 0.058, "RMS CNα error {:.1}%", 100.0 * rms_cna);
    assert!(rms_cma <= 0.043, "RMS Cmα error {:.1}%", 100.0 * rms_cma);
    assert!(rms_cp <= 0.094, "RMS CP error {rms_cp:.3} cal");
    // Signed: the model CP may sit at most 0.10 cal forward and 0.16 cal aft
    // of the measured one at any Mach group (aft = margin over-predicted).
    assert!(
        d_cal_min >= -0.10 && d_cal_max <= 0.16,
        "CP d_cal range {d_cal_min:+.3} to {d_cal_max:+.3} cal"
    );
}

/// Table X rows joined to their Mach number: (model, Mach, cant in rad,
/// measured Cl_δ per rad).
fn parse_table_x() -> Vec<(String, f64, f64, f64)> {
    let table = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/validation/basic_finner_drev/drev-tm-9703_table-X_fin-cant-roll.csv"
    ));
    let machs = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/validation/basic_finner_drev/drev-tm-9703_table-X_model-mach.csv"
    ));
    let data = |csv: &'static str| {
        csv.lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .skip(1)
            .map(|l| l.split(',').map(str::trim).collect::<Vec<_>>())
            .collect::<Vec<_>>()
    };
    let num = |cell: &str, what: &str| -> f64 {
        cell.parse()
            .unwrap_or_else(|_| panic!("Table X {what} cell {cell:?} does not parse"))
    };
    let mach_rows = data(machs);
    let rows: Vec<_> = data(table)
        .into_iter()
        .map(|r| {
            // model(0), fin_cant_rad(1), Cl_delta_times_delta(2), Cl_delta_per_rad(3)
            let m = mach_rows
                .iter()
                .find(|m| m[0] == r[0])
                .unwrap_or_else(|| panic!("no Mach for Table X model {}", r[0]));
            // model(0), shot(1), mach_single_fit(2), mach_mid_range(3)
            let (single, mid) = (num(m[2], "mach_single_fit"), num(m[3], "mach_mid_range"));
            assert!((single - mid).abs() < 0.011, "{}: {single} vs {mid}", r[0]);
            (
                r[0].to_string(),
                single,
                num(r[1], "cant"),
                num(r[3], "Cl_delta"),
            )
        })
        .collect();
    // Table X has 16 canted-fin models.
    assert_eq!(rows.len(), 16, "Table X row count");
    rows
}

/// Roll forcing vs DREV-TM-9703 Table X (roll moment due to fin cant, 16
/// models at 2° and 4° cant). Report mode: prints model/measured for every
/// model and asserts sanity bounds on the 12 models at M 1.80-4.47, above the
/// M 1.5 end of the blend, where the supersonic strip load applies. The four models at M 1.06-1.38 sit in the
/// M 0.9-1.5 blend and are printed, not scored.
#[test]
fn basic_finner_roll_forcing_vs_drev_table_x() {
    let rows = parse_table_x();
    println!("\n=== Basic Finner vs DREV-TM-9703 Table X: Cl_δ per rad (report mode) ===");
    println!(
        "Cl_δ = cl_forcing / δ at zero spin and α = 0. spin = steady pd/(2V)/δ, the\n\
         small-rate balance Cl_δ / |Clp| (Clp from a 1 rad/s roll rate)."
    );
    println!(
        "{:>5} | {:>6} {:>8} | {:>8} {:>8} {:>6} | {:>7}",
        "model", "Mach", "cant", "DREV", "rw", "rw/ref", "spin"
    );
    println!("{}", "-".repeat(62));
    let (mut sq, mut sum, mut n) = (0.0_f64, 0.0_f64, 0usize);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (model, mach, cant, cl_delta) in &rows {
        let m = basic_finner_canted(*cant);
        let am = AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default());
        let speed = mach * A0;
        let state = AeroState {
            mach: *mach,
            speed,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: NU0,
            thrusting: false,
        };
        let rw = am.eval_with_cg(&state, X_CG).cl_forcing / cant;
        let spun = am.eval_with_cg(
            &AeroState {
                roll_rate: 1.0,
                ..state
            },
            X_CG,
        );
        assert!(rw.is_finite(), "{model}: cl_forcing not finite");
        assert!(
            spun.cl_damping.is_finite(),
            "{model}: cl_damping not finite"
        );
        let clp = spun.cl_damping * 2.0 * speed / D;
        let ratio = rw / cl_delta;
        // Above the M 1.5 end of the transonic blend: M 1.80 to 4.47.
        let scored = *mach >= 1.5;
        println!(
            "{:>5} | {:>6.3} {:>8.5} | {:>8.2} {:>8.2} {:>6.2} | {:>7.3}{}",
            model,
            mach,
            cant,
            cl_delta,
            rw,
            ratio,
            rw / clp,
            if scored { "" } else { "  (blend, not scored)" }
        );
        if scored {
            sq += (ratio - 1.0).powi(2);
            sum += ratio - 1.0;
            lo = lo.min(ratio);
            hi = hi.max(ratio);
            n += 1;
        }
    }
    println!("{}", "-".repeat(62));
    assert_eq!(n, 12, "models above M 1.5");
    let (rms, mean) = ((sq / n as f64).sqrt(), sum / n as f64);
    println!(
        "M 1.80-4.47 ({n} models): rw/ref {lo:.2} to {hi:.2}, mean {:+.1}%, RMS {:.1}%",
        100.0 * mean,
        100.0 * rms
    );
    // Sanity bounds, about 10 % over the current model with the wedge
    // section (rw/ref 0.92 to 1.12, mean +3.3 %, RMS 5.8 %). The flat-plate
    // load ("airfoil" section) sat at 0.75 to 1.01, mean −10.5 %, RMS
    // 12.7 %; the one-face model at 0.40 to 0.60. The upper ratio bound is
    // wider than the flat-plate one (1.10): the thickness lift raises the
    // twelve ratios by 10 to 23 %, which centres the set on 1 and puts the
    // two M 1.80-1.85 models, nearest the blend, 9 and 12 % high.
    assert!(rms <= 0.064, "RMS Cl_δ error {:.1}%", 100.0 * rms);
    assert!(lo >= 0.84 && hi <= 1.23, "rw/ref range {lo:.2} to {hi:.2}");
}

/// Slender-body limit of the linear pitch damping: the Basic Finner body
/// alone (no fins) at M 0.3 gives C_mq + C_mα̇ = −4 (S_b/S)((L − x_cg)/d)²
/// per qd/(2V), naca-tn-3283 eq 58 (per ql/V there, C_Lα = 2 S_b/S, table I)
/// doubled. Here S_b = S, L = 10 cal and x_cg = 5.5 cal: 4 × 4.5² = 81.0. The
/// nose row acts at its point CP instead of being spread along the cone,
/// which costs about 2.2 %.
#[test]
fn basic_finner_body_alone_matches_the_slender_body_limit() {
    let mut model = basic_finner();
    model.components.retain(|c| c.id != "fins");
    let am = AeroModel::new(&model, &rw_geom::build(&model), &AeroOptions::default());
    let speed = 0.3 * A0;
    let q = 1e-3;
    let c = am.eval_with_cg(
        &AeroState {
            mach: 0.3,
            speed,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: q,
            kinematic_viscosity: NU0,
            thrusting: false,
        },
        X_CG,
    );
    let cmq = c.cm_damping * 2.0 * speed / (q * D);
    let slender = 4.0 * 4.5_f64.powi(2);
    println!("body alone M 0.3: |Cmq + Cmα̇| = {cmq:.2}, slender body {slender:.1}");
    assert!(
        (cmq / slender - 1.0).abs() < 0.03,
        "{cmq:.2} vs slender-body {slender:.1}"
    );
}
