//! Propellant tanks (`type = "tank"`, R2.5): a cylinder closed by two end
//! caps, with an optional propellant fill. The same rules check a tank given
//! inline on a feed node (`[feed.node.<id>.tank]`, see [`super::engine`]).

use rw_units::DimKind;

use super::Check;
use crate::diag;
use crate::types::{Component, ComponentKind, EndCap, EvalComponent, EvalShape};

/// Depth of one end cap of inner radius `r`: a hemisphere (r) or a 2:1
/// ellipsoidal head (r/2); flat ends have none.
pub fn cap_depth(cap: EndCap, r: f64) -> f64 {
    match cap {
        EndCap::Flat => 0.0,
        EndCap::Hemispherical => r,
        EndCap::Ellipsoidal => r / 2.0,
    }
}

/// Geometry rules shared by tank components and inline tanks. `field`
/// prefixes the field names (`""` for a component, `"tank/"` inline).
pub(crate) fn check_geometry(
    chk: &mut Check,
    prefix: &str,
    length: f64,
    od: f64,
    wall: f64,
    cap: EndCap,
) -> bool {
    let f = |n: &str| format!("{prefix}{n}");
    let mut ok = chk.positive(&f("od"), od, DimKind::Length);
    ok &= chk.positive(&f("wall"), wall, DimKind::Length);
    ok &= chk.positive(&f("length"), length, DimKind::Length);
    if !ok {
        return false;
    }
    if !chk.below(
        &f("wall"),
        wall,
        od / 2.0,
        "half the outer diameter",
        DimKind::Length,
    ) {
        return false;
    }
    let r = od / 2.0 - wall;
    let need = 2.0 * (cap_depth(cap, r) + wall);
    if length < need {
        chk.push(
            diag::E_GEOMETRY,
            &f("length"),
            format!(
                "tank `{}` is {} long but its two {:?} end caps and walls need {}",
                chk.id,
                super::show(length, DimKind::Length),
                cap,
                super::show(need, DimKind::Length)
            ),
            "lengthen the tank, reduce the diameter, or use flatter end caps",
        );
        return false;
    }
    true
}

/// Fill rules: a fraction within (0, 1] or a volume within the tank.
pub(crate) fn check_fill(
    chk: &mut Check,
    prefix: &str,
    fraction: Option<f64>,
    volume: Option<f64>,
    tank_volume: f64,
) {
    if let Some(x) = fraction
        && !(x > 0.0 && x <= 1.0)
    {
        chk.push(
            diag::E_GEOMETRY,
            &format!("{prefix}fill/fraction"),
            format!(
                "tank `{}` fill fraction is {x}; it must be in (0, 1]",
                chk.id
            ),
            "give the loaded fraction of the internal volume, e.g. 0.8",
        );
    }
    if let Some(v) = volume {
        if v <= 0.0 {
            chk.positive(&format!("{prefix}fill/volume"), v, DimKind::Volume);
        } else {
            chk.at_most(
                &format!("{prefix}fill/volume"),
                v,
                tank_volume,
                "the tank's internal volume",
                DimKind::Volume,
            );
        }
    }
}

pub(crate) fn check(chk: &mut Check, src: &Component, e: &EvalComponent) {
    let EvalShape::Tank {
        length,
        od,
        wall,
        end_cap,
        volume,
        ..
    } = &e.shape
    else {
        return;
    };
    if !check_geometry(chk, "", *length, *od, *wall, *end_cap) {
        return;
    }
    if let ComponentKind::Tank(t) = &src.kind
        && let Some(fill) = &t.fill
    {
        let fraction = fill
            .fraction
            .as_ref()
            .and_then(|q| q.literal().ok().flatten());
        let vol = fill
            .volume
            .as_ref()
            .and_then(|q| q.literal().ok().flatten());
        check_fill(
            chk,
            "",
            fraction.map(|q| q.value),
            vol.map(|q| q.value),
            *volume,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use crate::types::EvalShape;

    fn tank(fields: &str) -> crate::types::EvaluatedModel {
        model(&format!(
            r#"
[c.body]
type = "body_tube"
length = "1 m"
od = "160 mm"
thickness = "2 mm"

[c.t]
type = "tank"
attach = {{ to = "body.inner", at = "fore", offset = "100 mm" }}
{fields}
"#
        ))
    }

    #[test]
    fn a_good_tank_is_clean_and_has_its_volume() {
        let m = tank(
            r#"length = "400 mm"
od = "150 mm"
wall = "2 mm"
end_cap = "hemispherical"
fill = { propellant = "n2o", fraction = 0.8 }"#,
        );
        assert_clean(&m);
        let EvalShape::Tank { volume, .. } = comp(&m, "t").shape else {
            panic!()
        };
        let r: f64 = 0.073;
        let want = std::f64::consts::PI * r * r * (0.396 - 2.0 * r)
            + 4.0 / 3.0 * std::f64::consts::PI * r.powi(3);
        assert!((volume - want).abs() < 1e-12, "{volume} vs {want}");
    }

    #[test]
    fn bad_geometry_and_fill_are_reported() {
        let m = tank(
            r#"length = "400 mm"
od = "150 mm"
wall = "80 mm"
end_cap = "flat""#,
        );
        assert_diag(&m, "RW-E061", "/c/t/wall");
        let m = tank(
            r#"length = "100 mm"
od = "150 mm"
wall = "2 mm"
end_cap = "hemispherical""#,
        );
        assert_diag(&m, "RW-E061", "/c/t/length");
        let m = tank(
            r#"length = "400 mm"
od = "150 mm"
wall = "2 mm"
end_cap = "flat"
fill = { propellant = "n2o", fraction = 1.5 }"#,
        );
        assert_diag(&m, "RW-E061", "/c/t/fill/fraction");
        let m = tank(
            r#"length = "400 mm"
od = "150 mm"
wall = "2 mm"
end_cap = "flat"
fill = { propellant = "n2o", volume = "50 L" }"#,
        );
        assert_diag(&m, "RW-E061", "/c/t/fill/volume");
    }

    /// Final review (REV-phys): a filled tank carries its loaded propellant,
    /// fill volume × the liquid's reference density (NIST WebBook, 20 °C).
    #[test]
    fn a_filled_tank_carries_its_propellant_mass() {
        let geom = r#"length = "400 mm"
od = "150 mm"
wall = "2 mm"
end_cap = "hemispherical""#;
        let shape = |fill: &str| {
            let m = tank(&format!("{geom}\n{fill}"));
            assert_clean(&m);
            let EvalShape::Tank {
                volume,
                propellant_mass,
                ..
            } = comp(&m, "t").shape
            else {
                panic!()
            };
            (volume, propellant_mass)
        };
        let (v, m) = shape(r#"fill = { propellant = "n2o", fraction = 0.8 }"#);
        assert!((m - 0.8 * v * 786.6).abs() < 1e-9, "{m}");
        let (_, m) = shape(r#"fill = { propellant = "C2H5OH(L)", volume = "2 L" }"#);
        assert!((m - 0.002 * 789.3).abs() < 1e-12, "{m}");
        let (_, m) = shape("");
        assert_eq!(m, 0.0);
    }
}
