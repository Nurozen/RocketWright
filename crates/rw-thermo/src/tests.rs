use super::*;

fn def(id: &str) -> ReactantDef {
    ReactantDef {
        id: id.into(),
        name: id.to_uppercase(),
        t_k: 298.15,
        formula: None,
        h_j_per_mol: None,
    }
}

fn header(of: Vec<f64>, pc: Vec<f64>, eps: Vec<f64>) -> Header {
    Header {
        format: FORMAT,
        pair: "ox-fu".into(),
        oxidizer: def("ox"),
        fuel: def("fu"),
        cea_version: "3.3.4".into(),
        thermo_sha256: "0".repeat(64),
        of,
        pc_pa: pc,
        eps,
        modes: vec![Mode::Equilibrium, Mode::Frozen],
        frozen_station: 1,
        chamber_fields: CHAMBER_FIELDS.map(String::from).to_vec(),
        nozzle_fields: NOZZLE_FIELDS.map(String::from).to_vec(),
    }
}

/// A field value linear in (O/F, ln Pc, ln eps): multilinear interpolation
/// reproduces it exactly (to f32 storage precision).
fn lin(mode: usize, field: usize, of: f64, pc: f64, eps: f64) -> f64 {
    1000.0 + 100.0 * mode as f64 + 10.0 * field as f64 + 50.0 * of + 7.0 * pc.ln() + 3.0 * eps.ln()
}

fn synthetic() -> Table {
    let h = header(
        vec![1.0, 1.5, 2.0, 2.5],
        vec![5e5, 1e6, 2e6],
        vec![2.0, 4.0, 8.0],
    );
    let mut v = vec![0.0f32; h.value_count()];
    for m in 0..h.modes.len() {
        for (i, &of) in h.of.iter().enumerate() {
            for (j, &pc) in h.pc_pa.iter().enumerate() {
                let base = h.node_offset(m, i, j);
                for f in 0..CHAMBER_FIELDS.len() {
                    v[base + f] = lin(m, f, of, pc, 1.0) as f32;
                }
                for (k, &e) in h.eps.iter().enumerate() {
                    for f in 0..NOZZLE_FIELDS.len() {
                        v[base + CHAMBER_FIELDS.len() + k * NOZZLE_FIELDS.len() + f] =
                            lin(m, 20 + f, of, pc, e) as f32;
                    }
                }
            }
        }
    }
    Table::new(h, v).unwrap()
}

fn close(a: f64, b: f64) -> bool {
    ((a - b) / b).abs() < 2e-7
}

#[test]
fn reproduces_linear_fields_exactly() {
    let t = synthetic();
    for (m, mode) in [(0, Mode::Equilibrium), (1, Mode::Frozen)] {
        for (of, pc, eps) in [
            (1.0, 5e5, 2.0),
            (2.5, 2e6, 8.0),
            (1.37, 7.3e5, 3.1),
            (2.1, 1.9e6, 7.99),
            (1.5, 1e6, 4.0),
        ] {
            let c = t.chamber(mode, of, pc).unwrap();
            assert!(close(c.t_c, lin(m, 0, of, pc, 1.0)), "{c:?}");
            assert!(close(c.gamma_t, lin(m, 8, of, pc, 1.0)));
            let n = t.nozzle(mode, of, pc, eps).unwrap();
            assert!(close(n.pc_pe, lin(m, 20, of, pc, eps)), "{n:?}");
            assert!(close(n.isp_vac, lin(m, 25, of, pc, eps)));
            assert!(close(n.cf, n.isp / c.c_star));
        }
    }
}

#[test]
fn bytes_round_trip_and_are_deterministic() {
    let t = synthetic();
    let b = t.to_bytes();
    assert_eq!(&b[..8], MAGIC);
    let back = Table::from_bytes(&b).unwrap();
    assert_eq!(back, t);
    assert_eq!(back.to_bytes(), b);
}

#[test]
fn rejects_malformed_bytes() {
    let b = synthetic().to_bytes();
    assert!(matches!(
        Table::from_bytes(b"nope"),
        Err(ThermoError::Format(_))
    ));
    assert!(matches!(
        Table::from_bytes(&b[..b.len() - 4]),
        Err(ThermoError::Format(_))
    ));
    assert!(matches!(
        Table::from_bytes(&b[..b.len() - 1]),
        Err(ThermoError::Format(_))
    ));
    let mut bad = b.clone();
    bad[7] = b'2';
    assert!(Table::from_bytes(&bad).is_err());
    let mut h = synthetic().header().clone();
    h.of = vec![2.0, 1.0];
    assert!(Table::new(h.clone(), vec![0.0; h.value_count()]).is_err());
    h.of = vec![1.0, 2.0];
    h.nozzle_fields.pop();
    assert!(Table::new(h.clone(), vec![0.0; h.value_count()]).is_err());
}

#[test]
fn out_of_range_is_an_error_not_an_extrapolation() {
    let t = synthetic();
    let e = t.chamber(Mode::Equilibrium, 0.9, 1e6).unwrap_err();
    assert!(
        matches!(e, ThermoError::OutOfRange { axis: "of", .. }),
        "{e}"
    );
    assert!(t.chamber(Mode::Equilibrium, 1.2, 2.1e6).is_err());
    assert!(t.nozzle(Mode::Equilibrium, 1.2, 1e6, 1.5).is_err());
    assert!(t.nozzle(Mode::Equilibrium, 1.2, 1e6, f64::NAN).is_err());
    // Endpoints are inside.
    t.nozzle(Mode::Frozen, 2.5, 5e5, 8.0).unwrap();
}

#[test]
fn unconverged_nodes_poison_only_their_cells() {
    let t = synthetic();
    let h = t.header().clone();
    let mut v = t.values().to_vec();
    // Node (eq, of 2.5, pc 2e6) failed.
    let base = h.node_offset(0, 3, 2);
    for x in &mut v[base..base + h.node_len()] {
        *x = f32::NAN;
    }
    let t = Table::new(h, v).unwrap();
    assert_eq!(
        t.chamber(Mode::Equilibrium, 2.4, 1.5e6),
        Err(ThermoError::NoData)
    );
    t.chamber(Mode::Equilibrium, 1.2, 1.5e6).unwrap();
    t.chamber(Mode::Frozen, 2.4, 1.5e6).unwrap();
}

#[test]
fn lookup_checks_ids_and_mode() {
    let t = synthetic();
    let q: Query =
        serde_json::from_str(r#"{"oxidizer":"ox","fuel":"fu","of":1.2,"pc":1e6,"eps":3}"#).unwrap();
    let p = t.lookup(&q).unwrap();
    assert_eq!(p.mode, Mode::Equilibrium);
    assert!(p.nozzle.is_some());
    let fr = t
        .lookup(&Query {
            frozen: true,
            eps: None,
            ..q.clone()
        })
        .unwrap();
    assert_eq!(fr.mode, Mode::Frozen);
    assert!(fr.nozzle.is_none());
    let wrong = Query {
        fuel: Some("rp1".into()),
        ..q
    };
    assert!(matches!(
        t.lookup(&wrong),
        Err(ThermoError::InvalidQuery(_))
    ));
    assert!(serde_json::from_str::<Query>(r#"{"of":1,"pc":1,"bogus":1}"#).is_err());
}

/// The committed tables (`data/thermo/`, M4.2) parse and reproduce the
/// feasibility probe's native-CEA golden points (findings §6, Pc 20 bar,
/// eps 4) within 0.5% (Acceptance 8a's bound).
#[test]
fn committed_tables_reproduce_golden_points() {
    let tables: [(&str, &[u8]); 6] = [
        (
            "lox-ethanol",
            include_bytes!("../../../data/thermo/lox-ethanol.rwtbl"),
        ),
        (
            "lox-rp1",
            include_bytes!("../../../data/thermo/lox-rp1.rwtbl"),
        ),
        (
            "lox-ch4",
            include_bytes!("../../../data/thermo/lox-ch4.rwtbl"),
        ),
        (
            "lox-ipa",
            include_bytes!("../../../data/thermo/lox-ipa.rwtbl"),
        ),
        (
            "n2o-ethanol",
            include_bytes!("../../../data/thermo/n2o-ethanol.rwtbl"),
        ),
        (
            "n2o-ipa",
            include_bytes!("../../../data/thermo/n2o-ipa.rwtbl"),
        ),
    ];
    for (id, bytes) in tables {
        let t = Table::from_bytes(bytes).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(t.header().pair, id);
        assert_eq!(t.header().cea_version, "3.3.4");
        assert_eq!(t.header().modes, [Mode::Equilibrium, Mode::Frozen]);
    }
    // (pair, O/F, Tc K, c* m/s, Isp m/s, Ivac m/s)
    let golden = [
        ("lox-ethanol", 1.4, 3107.20, 1714.28, 2456.38, 2764.79),
        ("lox-ipa", 1.6, 3175.47, 1730.20, 2479.56, 2792.87),
        ("n2o-ethanol", 4.0, 2980.32, 1554.19, 2227.49, 2483.78),
        ("n2o-ipa", 4.5, 3009.82, 1558.33, 2233.65, 2488.93),
    ];
    for (id, of, tc, cstar, isp, ivac) in golden {
        let bytes = tables.iter().find(|(i, _)| *i == id).unwrap().1;
        let t = Table::from_bytes(bytes).unwrap();
        let p = t
            .performance(Mode::Equilibrium, of, 20e5, Some(4.0))
            .unwrap();
        let n = p.nozzle.unwrap();
        for (what, got, want) in [
            ("Tc", p.chamber.t_c, tc),
            ("c*", p.chamber.c_star, cstar),
            ("Isp", n.isp, isp),
            ("Ivac", n.isp_vac, ivac),
        ] {
            let e = ((got - want) / want).abs();
            assert!(e < 5e-3, "{id} {what}: {got} vs {want} ({e:.2e})");
        }
    }
}
