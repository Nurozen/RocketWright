//! `cargo test -p rw-project fmt::` (idempotence and canonical order by
//! property: `tests/fmt_idempotent.rs`).

use super::*;

#[test]
fn quantities_get_canonical_spelling() {
    let cases = [
        ("54mm", Some("54 mm")),
        ("54 mm", None),
        ("  54   mm ", Some("54 mm")),
        ("1/4in", Some("1/4 in")),
        ("1 1/4 in", None),
        ("1e3mm", Some("1e3 mm")),
        ("5°", Some("5 deg")),
        ("20 °C", Some("20 degC")),
        ("60 µm", Some("60 um")),
        ("10 lbs", Some("10 lb")),
        ("1.05 g/cm³", Some("1.05 g/cm^3")),
        ("2 kg · m²", Some("2 kg*m^2")),
        ("9.8 m / s^2", Some("9.8 m/s^2")),
        ("= params.span * 2", None),
        ("ogive", None),
        ("3-ring", None),
        ("0", None),
        ("12", None),
    ];
    for (input, want) in cases {
        assert_eq!(normalize_quantity(input).as_deref(), want, "{input}");
    }
}

#[test]
fn only_dimensional_fields_are_respelled() {
    let src = "name = \"54mm\"\n\n[c.body]\ntype = \"body_tube\"\nname = \"5mm tube\"\nlength = \"300mm\"\nod = \"54mm\"\nmaterial = \"1mm\"\n";
    let out = format_text("rocket.rw.toml", src).unwrap();
    assert!(out.starts_with("name = \"54mm\"\n"), "{out}");
    assert!(out.contains("name = \"5mm tube\""));
    assert!(out.contains("material = \"1mm\""));
    assert!(out.contains("length = \"300 mm\"\nod = \"54 mm\""));
}

#[test]
fn messy_file_formats_to_the_canonical_form() {
    let messy = r#"# My rocket


include = [ "parts/a.rw.toml",
  "parts/b.rw.toml" ]
name="X"    #   the name
[c.body]
od =   "54mm"
length = "1/4in"   # quarter
type = "body_tube"
finish={roughness="60 µm" ,  preset="polished"}
spam = 1
name = "Body"
[params.span]
group = "Fins"
value = "50mm"


# zzz

[c.nose]
length = "150 mm"
type = "nose_cone"
shape = "ogive"
od = "54 mm"
attach = { at = "base",to = "body.fore" }
[[assert]]
expr = "x"
id = "a"
[materials.alu]
density = "2.7 g/cm³"
# end
"#;
    let want = r#"# My rocket

name = "X" #   the name
include = [ "parts/a.rw.toml",
  "parts/b.rw.toml" ]

[params.span]
value = "50 mm"
group = "Fins"

[c.body]
type = "body_tube"
name = "Body"
finish = { roughness = "60 um", preset = "polished" }
length = "1/4 in" # quarter
od = "54 mm"
spam = 1

# zzz

[c.nose]
type = "nose_cone"
attach = { to = "body.fore", at = "base" }
shape = "ogive"
length = "150 mm"
od = "54 mm"

[materials.alu]
density = "2.7 g/cm^3"

[[assert]]
id = "a"
expr = "x"

# end
"#;
    let out = format_text("rocket.rw.toml", messy).unwrap();
    assert_eq!(out, want);
    assert_eq!(format_text("rocket.rw.toml", &out).unwrap(), out);
    assert!(is_formatted("rocket.rw.toml", &out).unwrap());
    assert!(!is_formatted("rocket.rw.toml", messy).unwrap());
}

#[test]
fn every_document_kind_is_ordered_by_its_schema() {
    let cases = [
        (
            "rocketwright.toml",
            "default_config = \"b\"\nname = \"P\"\nformat = 1\n",
            "format = 1\nname = \"P\"\ndefault_config = \"b\"\n",
        ),
        (
            "configs/b.rw.toml",
            "[motors.mount]\ndelay = \"5s\"\nmotor = \"generic:RW_C6G\"\n",
            "[motors.mount]\nmotor = \"generic:RW_C6G\"\ndelay = \"5 s\"\n",
        ),
        (
            "sims/b.rw.toml",
            "[launch]\nrod_angle = \"5°\"\nrail_length = \"1.5m\"\n\n[x]\ny = 1\n",
            "config = \"b\"\n\n[launch]\nrail_length = \"1.5 m\"\nrod_angle = \"5 deg\"\n\n[x]\ny = 1\n",
        ),
    ];
    for (path, input, want) in cases {
        let input = if path.starts_with("sims/") {
            format!("config = \"b\"\n{input}")
        } else {
            input.to_string()
        };
        assert_eq!(format_text(path, &input).unwrap(), want, "{path}");
    }
}

#[test]
fn invalid_files_are_not_formatted() {
    let err = format_text("rocket.rw.toml", "[c.body\n").unwrap_err();
    assert_eq!(err[0].code, "RW-E001");
    let err = format_text("notes.toml", "a = 1\n").unwrap_err();
    assert_eq!(err[0].code, "RW-E005");
}
