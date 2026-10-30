//! Appearance (R2.5): renderer presets and their PBR parameters.
//!
//! `appearance = { preset, color, roughness, metalness, transmission }`.
//! The evaluated model keeps the appearance as written; [`resolve`] gives
//! the PBR parameters (preset values, then explicit fields on top) for flat
//! check renders and as the base the viewport refines (M3.1). Display data,
//! not physics.

use serde::{Deserialize, Serialize};

use super::Check;
use crate::diag;
use crate::types::{Appearance, AppearancePreset};

/// Metallic-roughness PBR parameters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Pbr {
    /// Base color, sRGB.
    pub color: [u8; 3],
    pub roughness: f64,
    pub metalness: f64,
    pub transmission: f64,
}

/// The preset used when a component has no appearance.
pub const DEFAULT_PRESET: AppearancePreset = AppearancePreset::CompositeWhite;

/// PBR parameters of a preset.
pub const fn preset_pbr(p: AppearancePreset) -> Pbr {
    use AppearancePreset as P;
    let (color, roughness, metalness, transmission) = match p {
        P::CompositeWhite => ([0xf2, 0xf1, 0xed], 0.45, 0.0, 0.0),
        P::CompositeGray => ([0x8a, 0x8d, 0x91], 0.5, 0.0, 0.0),
        P::CarbonFiber => ([0x1c, 0x1d, 0x20], 0.35, 0.1, 0.0),
        P::AluminiumBrushed => ([0xc9, 0xcc, 0xd1], 0.3, 1.0, 0.0),
        P::SteelMachined => ([0xa7, 0xab, 0xb0], 0.35, 1.0, 0.0),
        P::ClearPolycarbonate => ([0xf5, 0xf8, 0xfa], 0.05, 0.0, 0.9),
        P::NylonOrange => ([0xff, 0x6a, 0x1a], 0.7, 0.0, 0.0),
        P::PcbGreen => ([0x1f, 0x6f, 0x3a], 0.45, 0.0, 0.0),
        P::BlackGloss => ([0x0d, 0x0d, 0x0f], 0.1, 0.0, 0.0),
        P::KraftPaper => ([0xb9, 0x8b, 0x5a], 0.85, 0.0, 0.0),
        P::Wood => ([0xc3, 0x9a, 0x63], 0.75, 0.0, 0.0),
    };
    Pbr {
        color,
        roughness,
        metalness,
        transmission,
    }
}

/// `#rrggbb` → bytes.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

/// The PBR parameters of an appearance: the preset (default
/// [`DEFAULT_PRESET`]) with any explicit, valid fields applied on top.
pub fn resolve(a: Option<&Appearance>) -> Pbr {
    let mut p = preset_pbr(a.and_then(|a| a.preset).unwrap_or(DEFAULT_PRESET));
    let Some(a) = a else { return p };
    if let Some(c) = a.color.as_deref().and_then(parse_hex) {
        p.color = c;
    }
    let unit = |v: Option<f64>| v.filter(|v| (0.0..=1.0).contains(v));
    if let Some(v) = unit(a.roughness) {
        p.roughness = v;
    }
    if let Some(v) = unit(a.metalness) {
        p.metalness = v;
    }
    if let Some(v) = unit(a.transmission) {
        p.transmission = v;
    }
    p
}

pub(crate) fn check(chk: &mut Check, a: Option<&Appearance>) {
    let Some(a) = a else { return };
    if let Some(c) = &a.color
        && parse_hex(c).is_none()
    {
        chk.push(
            diag::E_APPEARANCE,
            "appearance/color",
            format!("`{}.appearance.color` is {c:?}, not `#rrggbb`", chk.id),
            "write a hex color, e.g. \"#ff6a1a\"",
        );
    }
    for (k, v) in [
        ("roughness", a.roughness),
        ("metalness", a.metalness),
        ("transmission", a.transmission),
    ] {
        if let Some(v) = v
            && !(0.0..=1.0).contains(&v)
        {
            chk.push(
                diag::E_APPEARANCE,
                &format!("appearance/{k}"),
                format!("`{}.appearance.{k}` is {v}; it must be in 0..1", chk.id),
                format!("set `{k}` between 0 and 1"),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    #[test]
    fn every_preset_is_in_range() {
        let all: [AppearancePreset; 11] = [
            AppearancePreset::CompositeWhite,
            AppearancePreset::CompositeGray,
            AppearancePreset::CarbonFiber,
            AppearancePreset::AluminiumBrushed,
            AppearancePreset::SteelMachined,
            AppearancePreset::ClearPolycarbonate,
            AppearancePreset::NylonOrange,
            AppearancePreset::PcbGreen,
            AppearancePreset::BlackGloss,
            AppearancePreset::KraftPaper,
            AppearancePreset::Wood,
        ];
        for p in all {
            let x = preset_pbr(p);
            for v in [x.roughness, x.metalness, x.transmission] {
                assert!((0.0..=1.0).contains(&v), "{p:?}");
            }
        }
        assert_eq!(
            preset_pbr(AppearancePreset::AluminiumBrushed).metalness,
            1.0
        );
        assert!(preset_pbr(AppearancePreset::ClearPolycarbonate).transmission > 0.5);
    }

    #[test]
    fn explicit_fields_override_the_preset() {
        let a = Appearance {
            preset: Some(AppearancePreset::NylonOrange),
            color: Some("#102030".into()),
            roughness: Some(0.2),
            metalness: None,
            transmission: Some(3.0),
        };
        let p = resolve(Some(&a));
        assert_eq!(p.color, [0x10, 0x20, 0x30]);
        assert_eq!(p.roughness, 0.2);
        assert_eq!(p.transmission, 0.0, "out-of-range values are ignored");
        assert_eq!(resolve(None), preset_pbr(DEFAULT_PRESET));
        assert_eq!(parse_hex("#FFa000"), Some([255, 160, 0]));
        assert_eq!(parse_hex("ffa000"), None);
        assert_eq!(parse_hex("#ffa00"), None);
    }

    #[test]
    fn appearance_is_kept_and_checked() {
        let m = model(
            r##"
[c.body]
type = "body_tube"
length = "300 mm"
od = "25 mm"
thickness = "1 mm"
appearance = { preset = "aluminium_brushed", color = "#c0c0c0" }

[c.fins]
type = "trapezoidal_fin_set"
attach = { to = "body.aft", at = "root_te" }
count = 3
root_chord = "50 mm"
tip_chord = "30 mm"
span = "30 mm"
sweep = "20 mm"
thickness = "2 mm"
appearance = { color = "orange", roughness = 1.5 }
"##,
        );
        let body = comp(&m, "body");
        assert_eq!(
            body.appearance.as_ref().unwrap().preset,
            Some(AppearancePreset::AluminiumBrushed)
        );
        assert_diag(&m, "RW-E066", "/c/fins/appearance/color");
        assert_diag(&m, "RW-E066", "/c/fins/appearance/roughness");
        assert!(!codes(&m).iter().any(|(_, p)| p.starts_with("/c/body")));
    }
}
