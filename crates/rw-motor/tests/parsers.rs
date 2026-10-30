//! M1.36b: the `.eng`/`.rse` readers and interpolation, against the committed
//! generic files (`lib/motors/generic/`) and hand-written edge-case snippets.

use rw_motor::class::impulse_class;
use rw_motor::generic::{
    GENERIC_IDS, MotorQuery, generic_motor, generic_motors, generic_source, nearest_generic,
    search_generic,
};
use rw_motor::{MotorSource, ThrustCurve, parse_eng, parse_rse};

macro_rules! generic {
    ($f:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../lib/motors/generic/",
            $f
        ))
    };
}

const FILES: [(&str, &str, &str); 3] = [
    ("RW_A8G", generic!("RW_A8G.rse"), generic!("RW_A8G.eng")),
    ("RW_B4G", generic!("RW_B4G.rse"), generic!("RW_B4G.eng")),
    ("RW_C6G", generic!("RW_C6G.rse"), generic!("RW_C6G.eng")),
];

fn src(id: &str) -> MotorSource {
    MotorSource::Generic { id: id.into() }
}

fn lib() -> MotorSource {
    MotorSource::Library {
        path: "lib/motors/test".into(),
    }
}

fn one_rse(text: &str) -> ThrustCurve {
    let mut v = parse_rse(text, lib()).expect("parse_rse");
    assert_eq!(v.len(), 1);
    v.remove(0)
}

fn one_eng(text: &str) -> ThrustCurve {
    let mut v = parse_eng(text, lib()).expect("parse_eng");
    assert_eq!(v.len(), 1);
    v.remove(0)
}

/// Header attribute of the `<engine>` start tag (test-local, for cross-checks).
fn header_attr(rse: &str, key: &str) -> f64 {
    let start = rse.find("<engine ").expect("<engine");
    let tag = &rse[start..start + rse[start..].find('>').expect(">")];
    let pat = format!(" {key}=\"");
    let i = tag.find(&pat).expect(key) + pat.len();
    tag[i..i + tag[i..].find('"').expect("\"")]
        .parse()
        .expect("number")
}

fn rel(a: f64, b: f64) -> f64 {
    ((a - b) / b).abs()
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

// ---- generic files ---------------------------------------------------------

#[test]
fn rse_generic_impulse_matches_header_within_0p1_percent() {
    for (id, rse, _) in FILES {
        let m = &parse_rse(rse, src(id)).expect(id)[0];
        let itot = header_attr(rse, "Itot");
        assert!(
            rel(m.total_impulse, itot) < 1e-3,
            "{id}: {} vs {itot}",
            m.total_impulse
        );
        assert!(rel(m.impulse_at(m.burn_time + 1.0), itot) < 1e-3, "{id}");
        assert!(
            rel(m.burn_time, header_attr(rse, "burn-time")) < 1e-9,
            "{id}"
        );
        assert!(
            rel(m.average_thrust, header_attr(rse, "avgThrust")) < 1e-3,
            "{id}"
        );
        assert!(
            rel(m.max_thrust, header_attr(rse, "peakThrust")) < 1e-9,
            "{id}"
        );
    }
}

#[test]
fn rse_generic_header_fields() {
    for (id, rse, _) in FILES {
        let m = &parse_rse(rse, src(id)).expect(id)[0];
        assert_eq!(m.designation, id);
        assert_eq!(m.manufacturer.as_deref(), Some("RocketWright"));
        assert_eq!(m.class, &id[3..4], "{id}: class");
        assert_eq!(impulse_class(m.total_impulse).as_deref(), Some(&id[3..4]));
        assert!(close(m.diameter, 0.018, 1e-12));
        assert!(close(m.length, 0.070, 1e-12));
        assert!(close(
            m.total_mass,
            header_attr(rse, "initWt") / 1000.0,
            1e-12
        ));
        assert!(close(
            m.prop_mass,
            header_attr(rse, "propWt") / 1000.0,
            1e-12
        ));
        assert_eq!(m.source, src(id));
        assert_eq!(m.sha256.len(), 64);
        assert!(m.points.iter().all(|p| p.mass.is_some() && p.cg.is_some()));
    }
    let c = &parse_rse(FILES[2].1, src("RW_C6G")).expect("c")[0];
    assert_eq!(c.delays, vec![3.0, 5.0, 7.0]);
}

#[test]
fn rse_generic_mass_endpoints() {
    for (id, rse, _) in FILES {
        let m = &parse_rse(rse, src(id)).expect(id)[0];
        let dry = m.total_mass - m.prop_mass;
        assert!(close(m.mass_at(0.0), m.total_mass, 1e-12), "{id}: m(0)");
        assert!(close(m.mass_at(m.burn_time), dry, 1e-12), "{id}: m(tb)");
        assert!(close(m.mass_at(-1.0), m.total_mass, 1e-12), "{id}: before");
        assert!(
            close(m.mass_at(m.burn_time + 5.0), dry, 1e-12),
            "{id}: after"
        );
        // Monotone, and within 1 mg of the depletion law at every sample.
        let mut prev = f64::INFINITY;
        for k in 0..=200 {
            let t = m.burn_time * f64::from(k) / 200.0;
            let mt = m.mass_at(t);
            assert!(mt <= prev + 1e-15, "{id}: m not monotone at {t}");
            prev = mt;
        }
        for p in &m.points {
            let law = dry + m.prop_mass * (1.0 - m.impulse_at(p.t) / m.total_impulse);
            assert!(close(m.mass_at(p.t), law, 1e-6), "{id}: law at {}", p.t);
        }
        assert!(close(m.cg_at(0.5 * m.burn_time), 0.035, 1e-12), "{id}: cg");
    }
}

#[test]
fn eng_generic_matches_rse() {
    for (id, rse, eng) in FILES {
        let r = &parse_rse(rse, src(id)).expect(id)[0];
        let e = &parse_eng(eng, src(id)).expect(id)[0];
        assert_eq!(e.designation, id);
        assert_eq!(e.manufacturer.as_deref(), Some("RocketWright"));
        assert_eq!(e.class, r.class);
        assert_eq!(e.delays, r.delays);
        assert!(close(e.diameter, r.diameter, 1e-12));
        assert!(close(e.length, r.length, 1e-12));
        assert!(close(e.prop_mass, r.prop_mass, 1e-12));
        assert!(close(e.total_mass, r.total_mass, 1e-12));
        // The (0, 0) point is implicit in RASP and restored by the reader.
        assert_eq!(e.points.len(), r.points.len(), "{id}");
        assert_eq!((e.points[0].t, e.points[0].thrust), (0.0, 0.0));
        assert!(
            rel(e.total_impulse, header_attr(rse, "Itot")) < 1e-3,
            "{id}"
        );
        assert!(close(e.total_impulse, r.total_impulse, 1e-12), "{id}");
        assert!(e.points.iter().all(|p| p.mass.is_none() && p.cg.is_none()));
        // Derived mass equals the .rse column at every sample (1 mg rounding).
        let dry = e.total_mass - e.prop_mass;
        assert!(close(e.mass_at(0.0), e.total_mass, 1e-12));
        assert!(close(e.mass_at(e.burn_time), dry, 1e-12));
        for p in &r.points {
            assert!(
                close(e.mass_at(p.t), r.mass_at(p.t), 6e-7),
                "{id}: m({})",
                p.t
            );
            assert!(close(e.thrust_at(p.t), r.thrust_at(p.t), 1e-12));
        }
        assert!(close(e.cg_at(0.1), e.length / 2.0, 1e-12));
        assert_ne!(e.sha256, r.sha256, "{id}: digests differ by file");
    }
}

// ---- interpolation ---------------------------------------------------------

const TRI_RSE: &str = r#"<engine-database><engine-list>
<engine code="T1" mfg="Test" dia="24" len="100" initWt="30" propWt="10" delays="P">
<data>
  <eng-data t="0" f="0" m="30" cg="40"/>
  <eng-data t="1" f="10" m="25" cg="45"/>
  <eng-data t="2" f="0" m="20" cg="50"/>
</data></engine></engine-list></engine-database>"#;

#[test]
fn linear_interpolation_of_thrust_mass_cg() {
    let m = one_rse(TRI_RSE);
    assert!(close(m.total_impulse, 10.0, 1e-12));
    assert_eq!(m.class, "C", "10 N s is the top of C");
    assert!(close(m.burn_time, 2.0, 0.0));
    assert!(close(m.average_thrust, 5.0, 1e-12));
    assert!(m.delays.is_empty(), "P = plugged");
    assert!(close(m.thrust_at(0.25), 2.5, 1e-12));
    assert!(close(m.thrust_at(1.5), 5.0, 1e-12));
    assert_eq!(m.thrust_at(-0.1), 0.0);
    assert_eq!(m.thrust_at(2.1), 0.0);
    assert!(close(m.thrust_at(2.0), 0.0, 1e-12));
    assert!(close(m.mass_at(0.5), 0.0275, 1e-12));
    assert!(close(m.mass_at(1.5), 0.0225, 1e-12));
    assert!(close(m.cg_at(0.5), 0.0425, 1e-12));
    assert!(close(m.cg_at(-1.0), 0.040, 1e-12));
    assert!(close(m.cg_at(9.0), 0.050, 1e-12));
    // Exact integral of the piecewise-linear thrust.
    assert!(close(m.impulse_at(0.5), 1.25, 1e-12));
    assert!(close(m.impulse_at(1.0), 5.0, 1e-12));
    assert!(close(m.impulse_at(1.5), 8.75, 1e-12));
    assert!(close(m.impulse_at(3.0), 10.0, 1e-12));
    assert_eq!(m.impulse_at(-1.0), 0.0);
}

#[test]
fn eng_mass_derived_from_impulse_and_cg_midpoint() {
    let m = one_eng("; triangle\nT1 24 100 0 0.010 0.030 Test\n 1 10\n 2 0\n");
    assert_eq!(m.delays, vec![0.0]);
    assert!(close(m.mass_at(0.5), 0.030 - 0.010 * 1.25 / 10.0, 1e-12));
    assert!(close(m.mass_at(1.0), 0.025, 1e-12));
    assert!(close(m.mass_at(5.0), 0.020, 1e-12));
    assert!(close(m.cg_at(0.7), 0.050, 1e-12));
}

// ---- edge-case snippets ----------------------------------------------------

#[test]
fn eng_multiple_motors_comments_and_crlf() {
    let text = "; two motors\r\n\
        M1 18 70 3-5 0.003 0.015 Maker One ; trailing comment\r\n\
        0.0 0.0\r\n0.1 20 0.2 10\r\n0.3 0\r\n\
        ;\r\n\
        M2 29 124 P 0.040 0.090 Other\r\n\
        0.5 100\r\n1.0 0\r\n";
    let v = parse_eng(text, lib()).expect("parse");
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].designation, "M1");
    assert_eq!(v[0].manufacturer.as_deref(), Some("Maker One"));
    assert_eq!(v[0].delays, vec![3.0, 5.0]);
    assert_eq!(v[0].points.len(), 4, "explicit (0,0) is kept once");
    assert!(close(v[0].total_impulse, 1.0 + 1.5 + 0.5, 1e-12));
    assert_eq!(v[0].class, "B");
    assert_eq!(v[1].designation, "M2");
    assert!(v[1].delays.is_empty());
    assert!(close(v[1].diameter, 0.029, 1e-12));
    assert!(close(v[1].total_impulse, 50.0, 1e-12));
    assert_eq!(v[1].class, "F");
    assert_eq!(v[0].sha256, v[1].sha256, "digest is of the whole file");
}

#[test]
fn eng_errors_carry_line_numbers() {
    let e = parse_eng("; x\nM1 18 70 P 0.01\n0.1 1\n", lib()).unwrap_err();
    assert_eq!(e.line, 2, "{e:?}");
    let e = parse_eng("0.1 1\n", lib()).unwrap_err();
    assert_eq!(e.line, 1);
    let e = parse_eng("M1 18 70 P 0.01 0.02 X\n0.2 1\n0.1 1\n", lib()).unwrap_err();
    assert!(e.message.contains("time decreases"), "{e:?}");
    let e = parse_eng("M1 18 70 P 0.01 0.02 X\n0.1 -1\n", lib()).unwrap_err();
    assert!(e.message.contains("negative"), "{e:?}");
    let e = parse_eng("M1 18 70 P 0.01 0.02 X\n0.1 1 0.2\n", lib()).unwrap_err();
    assert_eq!(e.line, 2);
    let e = parse_eng("M1 18 70 P 0.03 0.02 X\n0.1 1\n", lib()).unwrap_err();
    assert!(e.message.contains("exceeds"), "{e:?}");
    let e = parse_eng("M1 18 70 P 0.01 0.02 X\n", lib()).unwrap_err();
    assert!(e.message.contains("no thrust samples"), "{e:?}");
    let e = parse_eng("M1 18 70 P 0.01 0.02 X\n0.1 0\n", lib()).unwrap_err();
    assert!(e.message.contains("outside classes"), "{e:?}");
    assert!(parse_eng("; only comments\n\n", lib()).is_err());
    assert!(parse_eng("M1 18 70 3-x 0.01 0.02 X\n0.1 1\n", lib()).is_err());
}

#[test]
fn rse_without_mass_column_derives_from_header() {
    let m = one_rse(
        r#"<engine code='T2' dia='18' len='70' initWt='20' propWt='8' delays='4'>
           <data><eng-data t='0.5' f='8'/><eng-data t='1' f='0'/></data></engine>"#,
    );
    assert_eq!(m.points.len(), 3, "t = 0 prepended");
    assert_eq!((m.points[0].t, m.points[0].thrust), (0.0, 0.0));
    assert!(close(m.total_impulse, 4.0, 1e-12));
    assert!(close(m.mass_at(0.0), 0.020, 1e-12));
    assert!(close(m.mass_at(0.5), 0.020 - 0.008 * 0.5, 1e-12));
    assert!(close(m.mass_at(1.0), 0.012, 1e-12));
    assert!(close(m.cg_at(0.3), 0.035, 1e-12));
    assert_eq!(m.delays, vec![4.0]);
    assert_eq!(m.manufacturer, None);
}

#[test]
fn rse_masses_from_column_when_header_lacks_them() {
    let m = one_rse(
        r#"<engine code="T3" dia="18" len="70"><data>
           <eng-data t="0" f="0" m="24" cg="35"/>
           <eng-data t="1" f="10" m="16" cg="36"/>
           <eng-data t="1.5" f="0" m="12" cg="37"/></data></engine>"#,
    );
    assert!(close(m.total_mass, 0.024, 1e-12));
    assert!(close(m.prop_mass, 0.012, 1e-12));
}

#[test]
fn rse_tolerates_comments_entities_case_and_multiple_engines() {
    let text = r#"<?xml version="1.0"?>
<!-- <eng-data t="9" f="9"/> inside a comment is ignored -->
<engine-database><engine-list>
  <engine MFG="A &amp; B" CODE="X1" DIA="13" LEN="45" INITWT="5" PROPWT="2" DELAYS="2,4">
    <comments><![CDATA[ <eng-data t="7" f="7"/> ]]></comments>
    <data><eng-data T="0" F="0" M="5" CG="20"/><eng-data T="0.5" F="4" M="3.5" CG="21"/>
    <eng-data T="1" F="0" M="3" CG="22"/></data>
  </engine>
  <engine code="X2" dia="13" len="45" initWt="6" propWt="2.5">
    <data><eng-data t="0" f="0" m="6" cg="20"/><eng-data t="2" f="2" m="3.5" cg="20"/>
    <eng-data t="2" f="0" m="3.5" cg="20"/></data>
  </engine>
</engine-list></engine-database>"#;
    let v = parse_rse(text, lib()).expect("parse");
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].manufacturer.as_deref(), Some("A & B"));
    assert_eq!(v[0].delays, vec![2.0, 4.0]);
    assert_eq!(v[0].points.len(), 3);
    assert!(close(v[0].total_impulse, 2.0, 1e-12));
    assert_eq!(v[0].class, "A");
    // A repeated time (instant cutoff) is allowed.
    assert!(close(v[1].total_impulse, 2.0, 1e-12));
    assert!(close(v[1].thrust_at(1.0), 1.0, 1e-12));
    assert_eq!(v[1].thrust_at(2.5), 0.0);
}

#[test]
fn rse_errors() {
    let e = parse_rse(
        "<engine dia='18'><data><eng-data t='1' f='1'/></data></engine>",
        lib(),
    )
    .unwrap_err();
    assert!(e.message.contains("code"), "{e:?}");
    let e = parse_rse("\n\n<eng-data t='1' f='1'/>", lib()).unwrap_err();
    assert_eq!(e.line, 3, "{e:?}");
    let e = parse_rse(
        "<engine code='Z' dia='18' initWt='5' propWt='2'>\n<data>\n<eng-data t='x' f='1'/>",
        lib(),
    )
    .unwrap_err();
    assert_eq!(e.line, 3, "{e:?}");
    let e = parse_rse(
        "<engine code='Z' dia='18'><eng-data t='1' f='1'/></engine>",
        lib(),
    )
    .unwrap_err();
    assert!(e.message.contains("initWt"), "{e:?}");
    assert!(parse_rse("<engine code='Z' dia='18' initWt='5' propWt='2'", lib()).is_err());
    assert!(parse_rse("<!-- unterminated", lib()).is_err());
    assert!(parse_rse("<root/>", lib()).is_err());
}

// ---- generic library and search -------------------------------------------

#[test]
fn generic_library_loads_offline() {
    let all = generic_motors();
    assert_eq!(all.len(), GENERIC_IDS.len());
    for (m, id) in all.iter().zip(GENERIC_IDS) {
        assert_eq!(m.designation, id);
        assert_eq!(m.source, src(id));
        assert!(generic_source(id).is_some());
    }
    assert_eq!(
        generic_motor("generic:rw_c6g").map(|m| m.designation),
        Some("RW_C6G".into())
    );
    assert!(generic_motor("RW_Z9G").is_none());
}

/// Backend of `rw motor search --class C --json` (the CLI lands in M1.30).
#[test]
fn search_class_c_returns_rw_c6g() {
    let q = MotorQuery {
        class: Some("C".into()),
        ..MotorQuery::default()
    };
    let hits: Vec<String> = search_generic(&q)
        .into_iter()
        .map(|m| m.designation)
        .collect();
    assert_eq!(hits, vec!["RW_C6G".to_string()]);
    let q = MotorQuery {
        diameter: Some(0.018),
        min_impulse: Some(2.0),
        max_impulse: Some(5.0),
        ..MotorQuery::default()
    };
    let hits: Vec<String> = search_generic(&q)
        .into_iter()
        .map(|m| m.designation)
        .collect();
    assert_eq!(hits, vec!["RW_A8G".to_string(), "RW_B4G".to_string()]);
    let q = MotorQuery {
        query: Some("b4".into()),
        ..MotorQuery::default()
    };
    assert_eq!(search_generic(&q).len(), 1);
    let q = MotorQuery {
        diameter: Some(0.024),
        ..MotorQuery::default()
    };
    let hits: Vec<String> = search_generic(&q)
        .into_iter()
        .map(|m| m.designation)
        .collect();
    assert_eq!(hits, vec!["RW_D10G".to_string()]);
    let q = MotorQuery {
        diameter: Some(0.038),
        ..MotorQuery::default()
    };
    let hits: Vec<String> = search_generic(&q)
        .into_iter()
        .map(|m| m.designation)
        .collect();
    assert_eq!(hits, ["RW_I261G", "RW_I1294G", "RW_I60G"]);
    let q = MotorQuery {
        diameter: Some(0.054),
        ..MotorQuery::default()
    };
    assert!(search_generic(&q).is_empty());
}

#[test]
fn nearest_generic_maps_by_class() {
    let d = |c: &str| nearest_generic(c, 0.018).map(|m| m.designation);
    assert_eq!(d("C").as_deref(), Some("RW_C6G"));
    assert_eq!(d("a").as_deref(), Some("RW_A8G"));
    assert_eq!(d("D").as_deref(), Some("RW_D10G"));
    assert_eq!(d("E").as_deref(), Some("RW_D10G"));
    // Same class wins; within it the impulse nearest the class midpoint.
    assert_eq!(
        nearest_generic("I", 0.038)
            .map(|m| m.designation)
            .as_deref(),
        Some("RW_I60G")
    );
    assert_eq!(
        nearest_generic("H", 0.029)
            .map(|m| m.designation)
            .as_deref(),
        Some("RW_I261G")
    );
    assert_eq!(d("1/2A").as_deref(), Some("RW_A8G"));
    assert_eq!(d("Q"), None);
}

#[test]
fn thrust_curve_json_round_trip() {
    let m = generic_motor("RW_B4G").expect("b4");
    let json = serde_json::to_string(&m).expect("ser");
    let back: ThrustCurve = serde_json::from_str(&json).expect("de");
    // serde_json (no `float_roundtrip`) may differ in the last ulp.
    assert_eq!(
        (&back.designation, &back.class, &back.sha256),
        (&m.designation, &m.class, &m.sha256)
    );
    assert_eq!(back.points.len(), m.points.len());
    for (a, b) in back.points.iter().zip(&m.points) {
        assert!(close(a.t, b.t, 1e-15) && close(a.thrust, b.thrust, 1e-12));
        assert!(close(a.mass.expect("m"), b.mass.expect("m"), 1e-15));
    }
}
