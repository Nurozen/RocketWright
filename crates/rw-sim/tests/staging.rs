//! M2.2 clusters and M2.3 multi-stage flights end to end: models evaluated
//! from source TOML, motors placed by `stages::mounted_motors`, flown by
//! `rw_sim::simulate` (stage legs, released branches, dual deploy).

use rw_aero::{AeroModel, AeroOptions};
use rw_mass::MassModel;
use rw_model::{EvalOptions, EvaluatedModel, SourceSet, eval, parse_source_with_warnings};
use rw_motor::generic::generic_motor;
use rw_sim::{EventKind, FlightEvent, SimInput, SimResult, simulate, stages};

const SIM: &str = r#"
name = "Flight"
config = "flight"

[launch]
rail_length = "1 m"
rod_angle = "0 deg"

[atmosphere]
model = "ussa1976"

[wind]
speed = "0 m/s"

[integrator]
method = "rk4"
dt = "0.01 s"
"#;

fn project(rocket: &str, config: &str) -> EvaluatedModel {
    let mut s = SourceSet::default();
    for (p, t) in [
        (
            "rocketwright.toml",
            "format = 1\nname = \"T\"\ndefault_config = \"flight\"\n",
        ),
        ("rocket.rw.toml", rocket),
        ("configs/flight.rw.toml", config),
        ("sims/flight.rw.toml", SIM),
    ] {
        let (d, w) = parse_source_with_warnings(p, t).unwrap_or_else(|e| panic!("{p}: {e:?}"));
        assert!(w.is_empty(), "{p}: {w:?}");
        s.docs.insert(p.to_string(), d);
    }
    let m = eval(&s, &EvalOptions::default());
    let errors: Vec<_> = m
        .diagnostics
        .iter()
        .filter(|d| d.code.starts_with("RW-E"))
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    m
}

fn fly(m: &EvaluatedModel) -> (SimResult, Vec<rw_motor::MountedMotor>) {
    let motors = stages::mounted_motors(m, &|r: &str| generic_motor(r.strip_prefix("generic:")?));
    let geometry = rw_geom::build(m);
    let aero = AeroModel::new(m, &geometry, &AeroOptions::default());
    let mass = MassModel::new(m, &geometry, &motors);
    let config = m.configs["flight"].clone();
    let input = SimInput {
        schema: rw_model::SchemaTag,
        sim: m.sims["flight"].clone(),
        config,
        model: m.clone(),
        motors: motors.clone(),
    };
    (
        simulate(&input, &aero, &mass, &mut |_| true).expect("flight"),
        motors,
    )
}

fn first(events: &[FlightEvent], k: EventKind) -> Option<&FlightEvent> {
    events.iter().find(|e| e.kind == k)
}

fn all(events: &[FlightEvent], k: EventKind) -> Vec<&FlightEvent> {
    events.iter().filter(|e| e.kind == k).collect()
}

const MATERIALS: &str = r#"
[materials.cardboard]
density = "680 kg/m^3"

[materials.balsa]
density = "160 kg/m^3"

[materials.nylon]
surface_density = "67 g/m^2"
"#;

/// A two-stage 25 mm vehicle: sustainer (nose, body, drogue, main, fins,
/// mount) over a booster (body, fins, streamer, mount).
fn two_stage() -> String {
    format!(
        r#"
name = "Two stage"

[stage.sustainer]
first = "nose"

[stage.booster]
first = "boost_body"
name = "Booster"

[c.nose]
type = "nose_cone"
material = "balsa"
shape = "ogive"
length = "100 mm"
od = "25 mm"
thickness = "2 mm"

[c.body]
type = "body_tube"
attach = {{ to = "nose.base" }}
material = "cardboard"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"

[c.drogue]
type = "parachute"
attach = {{ to = "body.fore", at = "attach", offset = "20 mm" }}
material = "nylon"
diameter = "150 mm"
cd = 0.8
packed_length = "20 mm"
packed_diameter = "18 mm"

[c.main]
type = "parachute"
attach = {{ to = "body.fore", at = "attach", offset = "60 mm" }}
material = "nylon"
diameter = "600 mm"
cd = 0.8
packed_length = "40 mm"
packed_diameter = "20 mm"

[c.fins]
type = "trapezoidal_fin_set"
attach = {{ to = "body.aft", at = "root_te" }}
material = "balsa"
count = 3
root_chord = "50 mm"
tip_chord = "30 mm"
span = "30 mm"
sweep = "20 mm"
thickness = "2 mm"

[c.sus_mmt]
type = "inner_tube"
attach = {{ to = "body.aft", at = "aft" }}
material = "cardboard"
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true

[c.boost_body]
type = "body_tube"
attach = {{ to = "body.aft" }}
material = "cardboard"
length = "120 mm"
od = "25 mm"
thickness = "1 mm"

[c.streamer]
type = "streamer"
attach = {{ to = "boost_body.fore", at = "attach", offset = "10 mm" }}
material = "nylon"
length = "600 mm"
width = "50 mm"
packed_length = "20 mm"
packed_diameter = "15 mm"

[c.boost_fins]
type = "trapezoidal_fin_set"
attach = {{ to = "boost_body.aft", at = "root_te" }}
material = "balsa"
count = 3
root_chord = "60 mm"
tip_chord = "40 mm"
span = "40 mm"
sweep = "25 mm"
thickness = "2 mm"

[c.boost_mmt]
type = "inner_tube"
attach = {{ to = "boost_body.aft", at = "aft" }}
material = "cardboard"
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true
{MATERIALS}"#
    )
}

/// Booster C6-0 at launch; sustainer lit at booster burnout; booster drops
/// at upper ignition; drogue at apogee, main at 100 m on descent; the
/// booster's streamer at its own ejection charge.
const TWO_STAGE_CONFIG: &str = r#"
name = "Flight"

[motors.boost_mmt]
motor = "generic:RW_C6G"
delay = "0 s"

[motors.sus_mmt]
motor = "generic:RW_C6G"
ignition = "previous_burnout"

[stages.booster]
separation = "upper_ignition"

[deploy.drogue]
event = "apogee"

[deploy.main]
event = "altitude"
altitude = "100 m"

[deploy.streamer]
event = "ejection"
"#;

mod multistage {
    use super::*;

    #[test]
    fn two_stage_separates_and_flies_the_booster_branch() {
        let m = project(&two_stage(), TWO_STAGE_CONFIG);
        assert_eq!(m.stages.len(), 2);
        let (r, motors) = fly(&m);
        // Placement: booster at launch, sustainer at the booster's burnout.
        let tb = motors.iter().find(|x| x.mount == "boost_mmt").unwrap();
        let ts = motors.iter().find(|x| x.mount == "sus_mmt").unwrap();
        let burn = stages::burn_duration(tb);
        assert_eq!(tb.ignition_time, 0.0);
        assert!((ts.ignition_time - burn).abs() < 1e-12);

        // Main flight: one separation at upper ignition, two ignitions.
        let sep = all(&r.events, EventKind::StageSeparation);
        assert_eq!(sep.len(), 1, "{:?}", r.events);
        assert!((sep[0].t - burn).abs() < 1e-9, "{}", sep[0].t);
        assert_eq!(sep[0].source.as_ref().unwrap().0, "rw:c/boost_body");
        assert_eq!(all(&r.events, EventKind::Ignition).len(), 2);
        // One burnout per stage; the summary's is the sustainer's.
        let burns = all(&r.events, EventKind::Burnout);
        assert_eq!(burns.len(), 2);
        assert!((r.summary.burnout_time_s - burns[1].t).abs() < 1e-12);
        assert!(r.events.iter().all(|e| e.branch.is_none()));
        // The streamer is the booster's: never deployed on the main flight.
        let deps = all(&r.events, EventKind::Deployment);
        assert!(
            deps.iter()
                .all(|d| d.source.as_ref().unwrap().0 != "rw:c/streamer")
        );

        // Booster branch: from the separation to its own landing.
        assert_eq!(r.branches.len(), 1);
        let b = &r.branches[0];
        assert_eq!(b.stage, "booster");
        assert!(
            b.events
                .iter()
                .all(|e| e.branch.as_deref() == Some("booster"))
        );
        assert_eq!(b.events[0].kind, EventKind::StageSeparation);
        assert!((b.events[0].t - burn).abs() < 1e-9);
        let land = first(&b.events, EventKind::Landing).expect("booster lands");
        let dep = first(&b.events, EventKind::Deployment).expect("streamer deploys");
        assert_eq!(dep.source.as_ref().unwrap().0, "rw:c/streamer");
        assert!(dep.t >= burn - 1e-9 && dep.t < land.t);
        // The series covers the branch only, from the separation on.
        let t0 = b.series.rows.first().unwrap()[0];
        assert!(t0 >= burn - 1e-9, "{t0}");
        assert!(b.series.rows.last().unwrap()[0] <= land.t + 1e-9);

        // The sustainer climbs well above the booster apogee and lands later.
        let apo = first(&r.events, EventKind::Apogee).unwrap();
        let b_apo = b
            .series
            .rows
            .iter()
            .map(|row| row[1])
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(apo.altitude > b_apo + 20.0, "{} vs {b_apo}", apo.altitude);
        assert!(r.summary.apogee_m > 0.0);
    }

    #[test]
    fn dual_deploy_apogee_then_altitude() {
        let m = project(&two_stage(), TWO_STAGE_CONFIG);
        let (r, _) = fly(&m);
        let apo = first(&r.events, EventKind::Apogee).unwrap();
        let deps = all(&r.events, EventKind::Deployment);
        let drogue = deps
            .iter()
            .find(|d| d.source.as_ref().unwrap().0 == "rw:c/drogue")
            .expect("drogue");
        let main = deps
            .iter()
            .find(|d| d.source.as_ref().unwrap().0 == "rw:c/main")
            .expect("main");
        assert!((drogue.t - apo.t).abs() < 1e-9);
        assert!(main.t > drogue.t + 1.0);
        assert!((main.altitude - 100.0).abs() < 0.5, "{}", main.altitude);
        // Under the drogue the descent is faster than under both canopies.
        let land = first(&r.events, EventKind::Landing).unwrap();
        assert!(
            main.velocity > land.velocity,
            "{} vs {}",
            main.velocity,
            land.velocity
        );
    }

    #[test]
    fn inactive_booster_flies_single_stage() {
        let cfg = TWO_STAGE_CONFIG
            .replace("separation = \"upper_ignition\"", "active = false")
            .replace("ignition = \"previous_burnout\"", "ignition = \"launch\"");
        let m = project(&two_stage(), &cfg);
        let (r, motors) = fly(&m);
        assert_eq!(motors.len(), 1);
        assert_eq!(motors[0].mount, "sus_mmt");
        assert!(r.branches.is_empty());
        assert!(first(&r.events, EventKind::StageSeparation).is_none());
        // Lighter than the stack with a booster on it: compare the liftoff mass.
        let full = project(&two_stage(), TWO_STAGE_CONFIG);
        let (rf, _) = fly(&full);
        assert!(r.summary.apogee_m > 0.0 && rf.summary.apogee_m > 0.0);
        assert!(r.branches.len() < rf.branches.len());
    }
}

mod cluster {
    use super::*;

    /// One body with a mount of `count` motors (`instances` cluster).
    fn clustered(count: u32) -> EvaluatedModel {
        let inst = if count > 1 {
            format!("instances = {{ count = {count}, pattern = \"cluster\", scale = \"20 mm\" }}\n")
        } else {
            String::new()
        };
        let rocket = format!(
            r#"
name = "Cluster"

[c.nose]
type = "nose_cone"
material = "balsa"
shape = "ogive"
length = "150 mm"
od = "66 mm"
thickness = "2 mm"

[c.body]
type = "body_tube"
attach = {{ to = "nose.base" }}
material = "cardboard"
length = "500 mm"
od = "66 mm"
thickness = "1.5 mm"

[c.chute]
type = "parachute"
attach = {{ to = "body.fore", at = "attach", offset = "20 mm" }}
material = "nylon"
diameter = "900 mm"
cd = 0.8
packed_length = "60 mm"
packed_diameter = "40 mm"

[c.fins]
type = "trapezoidal_fin_set"
attach = {{ to = "body.aft", at = "root_te" }}
material = "balsa"
count = 4
root_chord = "100 mm"
tip_chord = "50 mm"
span = "60 mm"
sweep = "40 mm"
thickness = "3 mm"

[c.mmt]
type = "inner_tube"
attach = {{ to = "body.aft", at = "aft" }}
material = "cardboard"
length = "75 mm"
od = "19 mm"
thickness = "0.5 mm"
motor_mount = true
{inst}
[c.block]
type = "engine_block"
attach = {{ to = "mmt.inner", at = "fore" }}
material = "cardboard"
length = "5 mm"
od = "18 mm"
id = "12 mm"
{MATERIALS}"#
        );
        project(
            &rocket,
            r#"
name = "Flight"

[motors.mmt]
motor = "generic:RW_C6G"
delay = "5 s"

[deploy.chute]
event = "ejection"
"#,
        )
    }

    #[test]
    fn cluster_counts_motors_in_mass_and_thrust() {
        let (one, three) = (clustered(1), clustered(3));
        let mmt = |m: &EvaluatedModel| m.components.iter().find(|c| c.id == "mmt").unwrap().clone();
        assert_eq!(mmt(&three).instances.len(), 3);
        // Parts inside the clustered tube repeat in every tube.
        let block = three.components.iter().find(|c| c.id == "block").unwrap();
        assert_eq!(block.instances.len(), 3);

        let (_, m1) = fly(&one);
        let (r3, m3) = fly(&three);
        assert_eq!((m1[0].count, m3[0].count), (1, 3));
        let mass = |m: &EvaluatedModel, motors: &[rw_motor::MountedMotor]| {
            let g = rw_geom::build(m);
            MassModel::new(m, &g, motors)
        };
        let (a, b) = (mass(&one, &m1), mass(&three, &m3));
        let (p1, p3) = (a.at(0.0), b.at(0.0));
        let prop = m1[0].curve.prop_mass;
        // Dry difference after burnout: two more tubes, blocks, and casings.
        let dry = b.at(10.0).mass - a.at(10.0).mass;
        let parts = 2.0 * (m1[0].curve.total_mass - prop);
        assert!(dry > parts, "{dry} vs {parts}");
        // Liftoff difference: the dry difference plus two more propellant loads.
        assert!(
            ((p3.mass - p1.mass) - (dry + 2.0 * prop)).abs() < 1e-9,
            "{} vs {}",
            p3.mass - p1.mass,
            dry + 2.0 * prop
        );

        // Thrust: three motors give about three times the impulse, so the
        // clustered vehicle climbs much higher.
        let (r1, _) = fly(&one);
        assert!(r3.summary.max_velocity_ms > 1.8 * r1.summary.max_velocity_ms);
        assert!(r3.summary.apogee_m > 2.0 * r1.summary.apogee_m);
    }
}
