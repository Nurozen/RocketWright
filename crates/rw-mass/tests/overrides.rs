//! Mass and CG overrides on one component and on a subtree (MI-03, MI-04).

mod common;

use common::{assert_close, build, comp, model};
use rw_mass::ComponentMass;
use serde_json::{Value, json};

/// tube ⊃ {ring, payload}; a separate nose with no overrides.
fn vehicle(over: Option<(&str, Value)>) -> Vec<ComponentMass> {
    let mut comps = vec![
        comp(
            "nose",
            None,
            0.0,
            0.1,
            json!({"type": "nose_cone", "shape": "conical",
            "shape_param": 0.0, "length": 0.1, "od": 0.05, "thickness": 0.0}),
        ),
        comp(
            "tube",
            Some("nose"),
            0.1,
            0.6,
            json!({"type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.046}),
        ),
        comp(
            "ring",
            Some("tube"),
            0.3,
            0.306,
            json!({"type": "centering_ring", "length": 0.006, "od": 0.046, "id": 0.02}),
        ),
        comp(
            "payload",
            Some("tube"),
            0.35,
            0.45,
            json!({"type": "mass_component", "mass": 0.2, "length": 0.1, "od": 0.04}),
        ),
    ];
    if let Some((id, o)) = over {
        let c = comps.iter_mut().find(|c| c["id"] == id).unwrap();
        c["override"] = o;
    }
    let (_, mm) = build(&model(comps, 1000.0));
    mm.breakdown()
}

fn get<'a>(b: &'a [ComponentMass], id: &str) -> &'a ComponentMass {
    b.iter().find(|c| c.id == id).unwrap()
}

#[test]
fn mass_override_scales_inertia() {
    let base = vehicle(None);
    let o = vehicle(Some(("tube", json!({"mass": 0.5, "subtree": false}))));
    let (b, t) = (get(&base, "tube"), get(&o, "tube"));
    assert!(t.overridden && !get(&o, "ring").overridden);
    assert_close("m", t.mass, 0.5, 1e-14);
    assert_close("cg kept", t.cg, b.cg, 1e-14);
    let k = 0.5 / b.mass;
    assert_close("Ixx k", t.ixx, k * b.ixx, 1e-12);
    assert_close("Iyy k", t.iyy, k * b.iyy, 1e-12);
    assert_eq!(get(&o, "ring"), get(&base, "ring"));
}

#[test]
fn cg_override_adds_parallel_axis_term() {
    let base = vehicle(None);
    let o = vehicle(Some(("tube", json!({"cg": 0.4, "subtree": false}))));
    let (b, t) = (get(&base, "tube"), get(&o, "tube"));
    assert!(t.overridden);
    assert_close("cg", t.cg, 0.4, 1e-14);
    assert_close("m kept", t.mass, b.mass, 1e-14);
    let d = 0.4 - b.cg;
    assert_close("Iyy + mΔ²", t.iyy, b.iyy + b.mass * d * d, 1e-12);
    assert_close("Ixx kept", t.ixx, b.ixx, 1e-14);
}

#[test]
fn subtree_override_replaces_the_group() {
    let base = vehicle(None);
    let o = vehicle(Some((
        "tube",
        json!({"mass": 1.0, "cg": 0.42, "subtree": true}),
    )));
    let group = ["tube", "ring", "payload"];
    let m: f64 = group.iter().map(|id| get(&o, id).mass).sum();
    let x: f64 = group
        .iter()
        .map(|id| get(&o, id).mass * get(&o, id).cg)
        .sum::<f64>()
        / m;
    assert_close("Σm", m, 1.0, 1e-13);
    assert_close("cg", x, 0.42, 1e-13);
    for id in group {
        assert!(get(&o, id).overridden, "{id} flagged");
    }
    assert!(!get(&o, "nose").overridden);
    assert_eq!(get(&o, "nose"), get(&base, "nose"));
    // Mass ratios inside the group are preserved (k applies uniformly).
    let r0 = get(&base, "payload").mass / get(&base, "ring").mass;
    let r1 = get(&o, "payload").mass / get(&o, "ring").mass;
    assert_close("ratio", r1, r0, 1e-12);
}

#[test]
fn subtree_false_leaves_children() {
    let base = vehicle(None);
    let o = vehicle(Some(("tube", json!({"mass": 1.0, "subtree": false}))));
    assert_eq!(get(&o, "payload"), get(&base, "payload"));
    assert_eq!(get(&o, "ring"), get(&base, "ring"));
}

#[test]
fn nested_overrides_apply_deepest_first() {
    let mut comps = vec![
        comp(
            "tube",
            None,
            0.0,
            0.5,
            json!({"type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.046}),
        ),
        comp(
            "payload",
            Some("tube"),
            0.1,
            0.2,
            json!({"type": "mass_component", "mass": 0.2, "length": 0.1, "od": 0.04}),
        ),
    ];
    comps[1]["override"] = json!({"mass": 0.3, "subtree": false});
    comps[0]["override"] = json!({"mass": 1.0, "subtree": true});
    let (_, mm) = build(&model(comps, 1000.0));
    let b = mm.breakdown();
    let total: f64 = b.iter().map(|c| c.mass).sum();
    assert_close("subtree total", total, 1.0, 1e-13);
    assert_close("dry", mm.dry().mass, 1.0, 1e-13);
    // The child's 0.3 kg override survives as its share of the subtree.
    let tube_m = get(&b, "tube").mass;
    let pay_m = get(&b, "payload").mass;
    let tube_base = {
        let (_, mm) = build(&model(
            vec![comp(
                "tube",
                None,
                0.0,
                0.5,
                json!({"type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.046}),
            )],
            1000.0,
        ));
        mm.dry().mass
    };
    assert_close("share", pay_m / tube_m, 0.3 / tube_base, 1e-12);
}

#[test]
fn override_on_massless_component() {
    let mut comps = vec![comp(
        "tube",
        None,
        0.0,
        0.5,
        json!({"type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.046}),
    )];
    comps[0]["material"] = json!("missing");
    comps[0]["override"] = json!({"mass": 0.25, "subtree": false});
    let (_, mm) = build(&model(comps, 1000.0));
    let c = mm.breakdown().remove(0);
    assert_close("m", c.mass, 0.25, 1e-15);
    assert_close("cg = middle", c.cg, 0.25, 1e-15);
    assert!(c.overridden);
}

/// `[stage.<id>] override` (case 5): the stage's members scale together,
/// after their own overrides, to the stage mass and CG.
#[test]
fn stage_override_replaces_the_stage() {
    let comps = |tube_over: bool| {
        let mut v = vec![
            comp(
                "nose",
                None,
                0.0,
                0.1,
                json!({"type": "nose_cone", "shape": "conical",
                "shape_param": 0.0, "length": 0.1, "od": 0.05, "thickness": 0.0}),
            ),
            comp(
                "tube",
                Some("nose"),
                0.1,
                0.6,
                json!({"type": "body_tube", "length": 0.5, "od": 0.05, "id": 0.046}),
            ),
        ];
        if tube_over {
            v[1]["override"] = json!({"mass": 0.5, "subtree": false});
        }
        v
    };
    let staged = |tube_over: bool, o: Option<Value>| {
        let mut m = model(comps(tube_over), 1000.0);
        m.stages = vec![
            serde_json::from_value(json!({
                "id": "sustainer", "name": "Sustainer", "first": "nose",
                "members": ["nose", "tube"], "x_fore": 0.0, "x_aft": 0.6,
                "overrides": o,
            }))
            .unwrap(),
        ];
        build(&m).1
    };
    let base = staged(true, None).breakdown();
    let mm = staged(true, Some(json!({"mass": 1.5, "cg": 0.3, "subtree": true})));
    let o = mm.breakdown();
    assert_close("dry mass", mm.dry().mass, 1.5, 1e-13);
    assert_close("dry cg", mm.dry().cg, 0.3, 1e-13);
    assert!(get(&o, "nose").overridden && get(&o, "tube").overridden);
    // The tube's own 0.5 kg override survives as its share of the stage.
    let r0 = get(&base, "tube").mass / get(&base, "nose").mass;
    let r1 = get(&o, "tube").mass / get(&o, "nose").mass;
    assert_close("ratio", r1, r0, 1e-12);
    // Mass only: the CG stays where the parts put it.
    let plain = staged(false, None);
    let mo = staged(false, Some(json!({"mass": 2.0, "subtree": true})));
    assert_close("mass", mo.dry().mass, 2.0, 1e-13);
    assert_close("cg kept", mo.dry().cg, plain.dry().cg, 1e-12);
}
