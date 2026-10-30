//! The containment rule table (R2.4, gaps §4.3): which component types may sit
//! in which parents, per containment kind. An invalid pair is `RW-E030`.
//!
//! - `axial`: the external body chain (nose cone, body tubes, transitions).
//! - `surface`: on a body component's outer surface (fins, lugs, buttons).
//! - `inner`: inside a tube (inner tubes, couplers, rings, bulkheads, engine
//!   blocks, recovery, mass components, tanks).

use crate::types::{AnchorKind, ComponentType as T};

/// Body-chain types.
pub const BODY: &[T] = &[T::NoseCone, T::BodyTube, T::Transition];

/// Types that can contain inner components.
pub const CONTAINERS: &[T] = &[
    T::NoseCone,
    T::BodyTube,
    T::Transition,
    T::Coupler,
    T::InnerTube,
];

/// One rule: any of `parents` may hold any of `children` with `kind`.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub kind: AnchorKind,
    pub parents: &'static [T],
    pub children: &'static [T],
}

/// The rule table. A pair not listed here is invalid.
pub const RULES: &[Rule] = &[
    Rule {
        kind: AnchorKind::Axial,
        parents: BODY,
        children: &[T::BodyTube, T::Transition],
    },
    Rule {
        kind: AnchorKind::Surface,
        parents: BODY,
        children: &[
            T::TrapezoidalFinSet,
            T::EllipticalFinSet,
            T::FreeformFinSet,
            T::TubeFinSet,
            T::LaunchLug,
            T::RailButton,
        ],
    },
    Rule {
        kind: AnchorKind::Inner,
        parents: CONTAINERS,
        children: &[
            T::InnerTube,
            T::Coupler,
            T::CenteringRing,
            T::Bulkhead,
            T::EngineBlock,
            T::Parachute,
            T::Streamer,
            T::ShockCord,
            T::MassComponent,
        ],
    },
    Rule {
        kind: AnchorKind::Inner,
        parents: &[T::BodyTube, T::Coupler],
        children: &[T::Tank],
    },
];

/// The containment a type takes when placed against an axial anchor.
pub const fn natural_kind(t: T) -> AnchorKind {
    match t {
        T::NoseCone | T::BodyTube | T::Transition => AnchorKind::Axial,
        T::TrapezoidalFinSet
        | T::EllipticalFinSet
        | T::FreeformFinSet
        | T::TubeFinSet
        | T::LaunchLug
        | T::RailButton => AnchorKind::Surface,
        _ => AnchorKind::Inner,
    }
}

/// True when `child` may sit in `parent` with containment `kind`.
pub fn allowed(parent: T, child: T, kind: AnchorKind) -> bool {
    RULES
        .iter()
        .any(|r| r.kind == kind && r.parents.contains(&parent) && r.children.contains(&child))
}

/// Valid parent types of `child` with containment `kind` (for hints).
pub fn parents_of(child: T, kind: AnchorKind) -> Vec<T> {
    let mut v: Vec<T> = RULES
        .iter()
        .filter(|r| r.kind == kind && r.children.contains(&child))
        .flat_map(|r| r.parents.iter().copied())
        .collect();
    v.sort();
    v.dedup();
    v
}

/// True when the type may be the first (root) component.
pub fn can_be_root(t: T) -> bool {
    BODY.contains(&t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_pair_table() {
        use AnchorKind::*;
        let ok = [
            (T::NoseCone, T::BodyTube, Axial),
            (T::BodyTube, T::Transition, Axial),
            (T::Transition, T::BodyTube, Axial),
            (T::BodyTube, T::TrapezoidalFinSet, Surface),
            (T::BodyTube, T::LaunchLug, Surface),
            (T::Transition, T::RailButton, Surface),
            (T::BodyTube, T::InnerTube, Inner),
            (T::BodyTube, T::CenteringRing, Inner),
            (T::InnerTube, T::EngineBlock, Inner),
            (T::NoseCone, T::MassComponent, Inner),
            (T::Coupler, T::Bulkhead, Inner),
            (T::BodyTube, T::Parachute, Inner),
            (T::BodyTube, T::Tank, Inner),
        ];
        let bad = [
            (T::BodyTube, T::NoseCone, Axial),
            (T::BodyTube, T::TrapezoidalFinSet, Inner),
            (T::BodyTube, T::TrapezoidalFinSet, Axial),
            (T::BodyTube, T::CenteringRing, Surface),
            (T::BodyTube, T::BodyTube, Inner),
            (T::TrapezoidalFinSet, T::LaunchLug, Surface),
            (T::CenteringRing, T::MassComponent, Inner),
            (T::Parachute, T::ShockCord, Inner),
            (T::InnerTube, T::Tank, Inner),
            (T::InnerTube, T::BodyTube, Axial),
        ];
        for (p, c, k) in ok {
            assert!(allowed(p, c, k), "{p:?} > {c:?} ({k:?}) should be allowed");
        }
        for (p, c, k) in bad {
            assert!(
                !allowed(p, c, k),
                "{p:?} > {c:?} ({k:?}) should be rejected"
            );
        }
    }

    #[test]
    fn every_non_root_type_has_a_parent_in_its_natural_kind() {
        for &t in T::ALL {
            if t == T::NoseCone {
                assert!(can_be_root(t));
                continue;
            }
            assert!(
                !parents_of(t, natural_kind(t)).is_empty(),
                "{t:?} has no valid parent"
            );
        }
    }
}
