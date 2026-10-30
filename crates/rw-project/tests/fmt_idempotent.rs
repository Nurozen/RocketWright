//! `rw fmt` (R2.12, Acceptance 4): formatting is idempotent, canonical (the
//! output does not depend on key order, unit spelling, or whitespace in the
//! input), keeps every comment, and never changes the evaluated model.

use std::collections::BTreeMap;

use proptest::prelude::*;
use rw_model::{EvalOptions, SourceSet, eval, model_hash, parse_source};
use rw_project::fmt::format_text;

const FILES: &[(&str, &str)] = &[
    (
        "rocketwright.toml",
        include_str!("fixtures/project/rocketwright.toml"),
    ),
    (
        "rocket.rw.toml",
        include_str!("fixtures/project/rocket.rw.toml"),
    ),
    (
        "parts/fin_can.rw.toml",
        include_str!("fixtures/project/parts/fin_can.rw.toml"),
    ),
    (
        "configs/baseline.rw.toml",
        include_str!("fixtures/project/configs/baseline.rw.toml"),
    ),
    (
        "sims/baseline.rw.toml",
        include_str!("fixtures/project/sims/baseline.rw.toml"),
    ),
];

fn evaluate(files: &BTreeMap<String, String>) -> String {
    let mut set = SourceSet::default();
    for (p, t) in files {
        set.docs
            .insert(p.clone(), parse_source(p, t).expect("parses"));
    }
    model_hash(&eval(&set, &EvalOptions::default()))
}

fn comments(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.find('#').map(|at| l[at..].trim().to_string()))
        .collect()
}

#[test]
fn fixtures_are_idempotent_and_keep_the_model() {
    let original: BTreeMap<String, String> = FILES
        .iter()
        .map(|(p, t)| (p.to_string(), t.to_string()))
        .collect();
    let mut formatted = BTreeMap::new();
    for (path, text) in &original {
        let once = format_text(path, text).expect("formats");
        let twice = format_text(path, &once).expect("formats again");
        assert_eq!(once, twice, "{path}: not idempotent");
        let mut kept = comments(text);
        let mut got = comments(&once);
        kept.sort();
        got.sort();
        assert_eq!(kept, got, "{path}: comments changed");
        formatted.insert(path.clone(), once);
    }
    assert_eq!(evaluate(&original), evaluate(&formatted));
}

#[test]
fn json_twins_are_idempotent() {
    let text =
        r#"{"c": {"body": {"od": "54mm", "type": "body_tube", "length": "300 mm"}}, "name": "J"}"#;
    let once = format_text("rocket.rw.json", text).expect("formats");
    assert_eq!(
        once,
        "{\n  \"name\": \"J\",\n  \"c\": {\n    \"body\": {\n      \"type\": \"body_tube\",\n      \"length\": \"300 mm\",\n      \"od\": \"54 mm\"\n    }\n  }\n}\n"
    );
    assert_eq!(format_text("rocket.rw.json", &once).expect("formats"), once);
}

// ---- canonical form, by property -------------------------------------------------

/// A value in the generated model: plain TOML text, or a quantity whose
/// spelling the generator varies.
#[derive(Clone, Copy, Debug)]
enum V {
    Raw(&'static str),
    /// Number, canonical unit, and an alias that parses the same.
    Q(&'static str, &'static str, &'static str),
}

use V::{Q, Raw};

type Entry = (&'static str, V, Option<&'static str>);

/// Section (for ordering), header, entries `(key, value, trailing comment)`.
const TABLES: &[(&str, &str, &[Entry])] = &[
    (
        "params",
        "params.span",
        &[
            ("value", Q("50", "mm", "mm"), Some("# nominal")),
            ("min", Q("30", "mm", "mm"), None),
            ("max", Q("80", "mm", "mm"), None),
            ("group", Raw("\"Fins\""), None),
        ],
    ),
    (
        "params",
        "params.angle",
        &[("value", Q("3", "deg", "°"), None)],
    ),
    (
        "c",
        "c.nose",
        &[
            ("type", Raw("\"nose_cone\""), None),
            ("name", Raw("\"Nose\""), Some("# display")),
            ("shape", Raw("\"ogive\""), None),
            ("length", Q("150", "mm", "mm"), None),
            ("od", Q("41.6", "mm", "mm"), None),
            ("material", Raw("\"plastic\""), None),
        ],
    ),
    (
        "c",
        "c.body",
        &[
            ("type", Raw("\"body_tube\""), None),
            ("attach", Raw("{ to = \"nose.base\" }"), None),
            ("length", Raw("\"= 400 mm\""), Some("# expr")),
            ("od", Raw("\"= c.nose.od\""), None),
            ("id", Q("39.8", "mm", "mm"), None),
            ("finish", Raw("{ roughness = \"60 um\" }"), None),
        ],
    ),
    (
        "c",
        "c.weight",
        &[
            ("type", Raw("\"mass_component\""), None),
            ("attach", Raw("{ to = \"body.inner\" }"), None),
            ("mass", Q("10", "lb", "lbs"), None),
            ("length", Q("20", "mm", "mm"), None),
        ],
    ),
    (
        "materials",
        "materials.plastic",
        &[("density", Q("1.05", "g/cm^3", "g/cm³"), Some("# PLA"))],
    ),
];

/// One rendering of the model. `order` permutes keys within each table and
/// `sections` the order of sections; `spell` picks unit spellings; `pad` adds
/// whitespace noise.
fn render(order: &[Vec<usize>], sections: &[&str], spell: &[u8], pad: &[bool]) -> String {
    let mut out = String::from("# leading file comment\n\nname = \"Gen\"\n");
    let mut n = 0;
    for section in sections {
        for (t, (sec, header, entries)) in TABLES.iter().enumerate() {
            if sec != section {
                continue;
            }
            out.push_str(if pad[t % pad.len()] { "\n\n\n" } else { "\n" });
            out.push_str(&format!("[{header}]\n"));
            for &i in &order[t] {
                let (key, v, comment) = entries[i];
                let value = match v {
                    Raw(s) => s.to_string(),
                    Q(num, unit, alias) => {
                        n += 1;
                        match spell[n % spell.len()] % 4 {
                            0 => format!("\"{num} {unit}\""),
                            1 => format!("\"{num}{unit}\""),
                            2 => format!("\"{num}  {alias}\""),
                            _ => format!("\" {num}{alias} \""),
                        }
                    }
                };
                let eq = if pad[(t + i) % pad.len()] {
                    "   =  "
                } else {
                    " = "
                };
                out.push_str(&format!("{key}{eq}{value}"));
                if let Some(c) = comment {
                    out.push_str(&format!("   {c}"));
                }
                out.push('\n');
            }
        }
    }
    out
}

fn canonical() -> String {
    let order: Vec<Vec<usize>> = TABLES
        .iter()
        .map(|(_, _, e)| (0..e.len()).collect())
        .collect();
    render(&order, &["params", "c", "materials"], &[0], &[false])
}

fn shuffled(len: usize) -> impl Strategy<Value = Vec<usize>> {
    Just((0..len).collect::<Vec<_>>()).prop_shuffle()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Any key order, section order, unit spelling, and spacing formats to
    /// the same text as the canonical rendering, and formatting it again
    /// changes nothing.
    #[test]
    fn canonical_regardless_of_input(
        order in TABLES.iter().map(|(_, _, e)| shuffled(e.len())).collect::<Vec<_>>(),
        sections in Just(vec!["params", "c", "materials"]).prop_shuffle(),
        spell in prop::collection::vec(any::<u8>(), 1..8),
        pad in prop::collection::vec(any::<bool>(), 1..5),
    ) {
        let messy = render(&order, &sections, &spell, &pad);
        let want = format_text("rocket.rw.toml", &canonical()).expect("canonical formats");
        let got = format_text("rocket.rw.toml", &messy).expect("messy formats");
        prop_assert_eq!(&got, &want, "input:\n{}", messy);
        prop_assert_eq!(format_text("rocket.rw.toml", &got).expect("formats"), got.clone());
        let model = |t: &str| {
            let files = BTreeMap::from([("rocket.rw.toml".to_string(), t.to_string())]);
            evaluate(&files)
        };
        prop_assert_eq!(model(&messy), model(&got));
    }
}

#[test]
fn canonical_form_is_stable() {
    let want = r#"# leading file comment

name = "Gen"

[params.span]
value = "50 mm" # nominal
min = "30 mm"
max = "80 mm"
group = "Fins"

[params.angle]
value = "3 deg"

[c.nose]
type = "nose_cone"
name = "Nose" # display
material = "plastic"
shape = "ogive"
length = "150 mm"
od = "41.6 mm"

[c.body]
type = "body_tube"
attach = { to = "nose.base" }
finish = { roughness = "60 um" }
length = "= 400 mm" # expr
od = "= c.nose.od"
id = "39.8 mm"

[c.weight]
type = "mass_component"
attach = { to = "body.inner" }
mass = "10 lb"
length = "20 mm"

[materials.plastic]
density = "1.05 g/cm^3" # PLA
"#;
    let messy = render(
        &TABLES
            .iter()
            .map(|(_, _, e)| (0..e.len()).rev().collect())
            .collect::<Vec<_>>(),
        &["materials", "c", "params"],
        &[1, 2, 3],
        &[true, false],
    );
    assert_eq!(
        format_text("rocket.rw.toml", &messy).expect("formats"),
        want
    );
}
