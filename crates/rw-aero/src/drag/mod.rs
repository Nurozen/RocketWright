//! Drag buildup (R4.3): skin friction with roughness, body and fin pressure
//! drag, base drag, parasitic drag, compressibility corrections, and the
//! axial scaling with angle of attack. One function per equation-sheet row
//! (`docs/dev/literature-map.md`, rows SF, CC, PD, BD, PA).

pub mod axial;
pub mod base;
pub mod friction;
pub mod parasitic;
pub mod pressure;

#[cfg(test)]
mod tests {
    //! CD(M) sanity on the case-1 equivalent (shape of the curve only; the
    //! oracle comparison is the M1.38-p diagnostic, see docs/dev/parity-log.md).
    use crate::testutil::case_model;
    use crate::{AeroModel, AeroOptions, AeroState};

    fn cd_at(am: &AeroModel, mach: f64) -> crate::DragBreakdown {
        am.eval(&AeroState {
            mach,
            speed: mach * 340.294,
            alpha: 0.0,
            roll_rate: 0.0,
            pitch_rate: 0.0,
            kinematic_viscosity: 1.4607e-5,
            thrusting: false,
        })
        .drag
    }

    #[test]
    fn case1_cd_mach_sanity() {
        let m = case_model("case1");
        let am = AeroModel::new(&m, &rw_geom::build(&m), &AeroOptions::default());
        let sub: Vec<_> = (1..=18).map(|k| cd_at(&am, 0.05 * k as f64)).collect();
        for d in &sub {
            assert!(d.total > 0.3 && d.total < 1.5, "{d:?}");
            assert!(d.friction > 0.0 && d.pressure > 0.0 && d.base > 0.0 && d.parasitic > 0.0);
        }
        // Subsonic: friction falls with Re, base and pressure rise with M, total rises past M 0.3.
        for w in sub.windows(2) {
            assert!(w[1].friction <= w[0].friction + 1e-12);
            assert!(w[1].base > w[0].base && w[1].pressure >= w[0].pressure);
        }
        assert!(sub[17].total > sub[5].total);
        // Transonic rise, supersonic decay.
        let (m1, m12, m3) = (cd_at(&am, 1.0), cd_at(&am, 1.2), cd_at(&am, 3.0));
        assert!(m1.total > sub[17].total && m12.total > m3.total);
        for k in 0..60 {
            assert!(cd_at(&am, 0.05 * k as f64).total.is_finite());
        }
    }
}
