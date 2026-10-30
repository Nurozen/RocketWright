//! `cargo test -p rw-project tomlpatch`: insert, replace, nested, array of
//! tables, re-parse idempotence, TOML 1.0 output, comment preservation.

use super::*;

/// A model file in the shape of a hand-edited `*.rw.toml`: leading comment,
/// implicit `[c]`, trailing value comments, a comment between tables, dotted
/// keys, an inline table, arrays, an array of tables, and an end-of-file note.
const MODEL: &str = r#"# rocket model (hand-edited)
name = "demo"   # display name

[c.nose]
type = "nose_cone"
shape = { kind = "ogive", length = "120 mm" }   # inline

[c.fin]   # fin set
type = "trapezoidal_fins"
# span is measured from the body surface
span = "80 mm"   # tweak me
count = 4
root.chord = "60 mm"   # dotted
points = [1, 2, 3]

# trailing comment before the body
[c.body]
type = "body_tube"

[[stage]]   # booster
motor = "H128"

[[stage]]   # sustainer
motor = "G80"   # long burn

# end of file
"#;

fn doc(src: &str) -> DocumentMut {
    src.parse().expect("fixture parses")
}

fn p(path: &str) -> Vec<Seg> {
    parse_path(path).expect("test path parses")
}

fn set(d: &mut DocumentMut, path: &str, v: impl Into<Value>) -> Option<Value> {
    set_value_preserving(d, &p(path), v).expect("patch applies")
}

/// Output re-parses to the same text, and the logical data round-trips.
fn assert_reparse_idempotent(out: &str) {
    let again = doc(out).to_string();
    assert_eq!(again, out, "re-parse changed the text");
}

/// Every comment line of `src` survives in `out`, in the same order.
fn assert_comments_kept(src: &str, out: &str) {
    let mut rest = out;
    for line in src.lines() {
        if let Some(at) = line.find('#') {
            let comment = &line[at..];
            let pos = rest
                .find(comment)
                .unwrap_or_else(|| panic!("lost or reordered comment {comment:?} in:\n{out}"));
            rest = &rest[pos + comment.len()..];
        }
    }
}

// ---- replace ---------------------------------------------------------------------

#[test]
fn replace_keeps_trailing_comment() {
    // Trap 1: plain assignment drops `# tweak me`.
    let mut d = doc(MODEL);
    let old = set(&mut d, "c.fin.span", "90 mm");
    assert_eq!(
        old.and_then(|v| v.as_str().map(str::to_owned)).as_deref(),
        Some("80 mm")
    );
    let out = d.to_string();
    assert_eq!(
        out,
        MODEL.replace(
            r#"span = "80 mm"   # tweak me"#,
            r#"span = "90 mm"   # tweak me"#
        )
    );
}

#[test]
fn naive_assignment_drops_trailing_comment() {
    // Documents the trap the helper exists for; if toml_edit ever fixes it,
    // this test tells us the helper's decor copy is no longer load-bearing.
    let mut d = doc(MODEL);
    d["c"]["fin"]["span"] = toml_edit::value("90 mm");
    assert!(!d.to_string().contains("# tweak me"));
}

#[test]
fn replace_keeps_key_formatting_and_leading_comment() {
    let src = "[a]\n# above\n  x   =   1   # after\n";
    let mut d = doc(src);
    set(&mut d, "a.x", 2);
    assert_eq!(d.to_string(), "[a]\n# above\n  x   =   2   # after\n");
}

#[test]
fn replace_changes_type_and_keeps_decor() {
    let mut d = doc(MODEL);
    set(&mut d, "c.fin.count", "4 per stage");
    assert!(d.to_string().contains("count = \"4 per stage\"\n"));
    set(&mut d, "name", 7);
    assert!(d.to_string().contains("name = 7   # display name\n"));
}

#[test]
fn replace_root_and_dotted_and_inline_values() {
    let mut d = doc(MODEL);
    set(&mut d, "c.fin.root.chord", "65 mm");
    set(&mut d, "c.nose.shape.length", "130 mm");
    let out = d.to_string();
    let expected = MODEL
        .replace(
            r#"root.chord = "60 mm"   # dotted"#,
            r#"root.chord = "65 mm"   # dotted"#,
        )
        .replace(r#"length = "120 mm" }"#, r#"length = "130 mm" }"#);
    assert_eq!(out, expected);
}

// ---- insert ----------------------------------------------------------------------

#[test]
fn insert_key_into_existing_table() {
    let mut d = doc(MODEL);
    assert!(set(&mut d, "c.fin.cant", "0 deg").is_none());
    let out = d.to_string();
    let expected = MODEL.replace(
        "points = [1, 2, 3]\n",
        "points = [1, 2, 3]\ncant = \"0 deg\"\n",
    );
    assert_eq!(out, expected);
    assert_comments_kept(MODEL, &out);
}

#[test]
fn insert_table_under_implicit_parent() {
    // Trap 2: no inline `chute = {..}`, no stray `[c]` header, leading comment first.
    let mut d = doc(MODEL);
    set(&mut d, "c.chute.type", "parachute");
    set(&mut d, "c.chute.cd", 0.8);
    let out = d.to_string();
    assert!(out.starts_with("# rocket model (hand-edited)\n"), "{out}");
    assert!(!out.contains("[c]"), "stray [c] header:\n{out}");
    assert!(!out.contains("chute ="), "inline table created:\n{out}");
    assert!(
        out.contains("[c.chute]\ntype = \"parachute\"\ncd = 0.8\n"),
        "{out}"
    );
    // The new table follows the other `c.*` tables, before the stages.
    let chute = out.find("[c.chute]").unwrap();
    assert!(out.find("[c.body]").unwrap() < chute && chute < out.find("[[stage]]").unwrap());
    assert_comments_kept(MODEL, &out);
    assert_reparse_idempotent(&out);
}

#[test]
fn insert_into_empty_document() {
    let mut d = DocumentMut::new();
    set(&mut d, "a.b.c.d", 1);
    set(&mut d, "top", true);
    assert_eq!(d.to_string(), "top = true\n\n[a.b.c]\nd = 1\n");
}

#[test]
fn ensure_table_creates_explicit_final_table() {
    let mut d = doc(MODEL);
    let t = ensure_table(&mut d, &p("c.mass")).unwrap();
    assert!(t.is_empty());
    let out = d.to_string();
    assert!(out.contains("[c.mass]\n"), "{out}");
    assert!(!out.contains("[c]"), "{out}");
    let reparsed = doc(&out);
    assert!(
        reparsed["c"]["mass"]
            .as_table()
            .is_some_and(Table::is_empty)
    );
    assert_reparse_idempotent(&out);
}

#[test]
fn ensure_table_returns_existing_without_flipping_implicit() {
    let mut d = doc(MODEL);
    let c = ensure_table(&mut d, &p("c")).unwrap();
    assert!(c.contains_key("fin"));
    let fin = ensure_table(&mut d, &p("c.fin")).unwrap();
    fin.insert("cant", toml_edit::value("1 deg"));
    let out = d.to_string();
    assert!(!out.contains("[c]"), "{out}");
    assert!(
        out.contains("points = [1, 2, 3]\ncant = \"1 deg\"\n"),
        "{out}"
    );
}

// ---- nested ----------------------------------------------------------------------

#[test]
fn nested_insert_inside_inline_table_stays_inline() {
    let mut d = doc(MODEL);
    set(&mut d, "c.nose.shape.tip.radius", "2 mm");
    let out = d.to_string();
    assert!(
        out.contains(
            r#"shape = { kind = "ogive", length = "120 mm", tip = { radius = "2 mm" } }   # inline"#
        ),
        "{out}"
    );
    assert_reparse_idempotent(&out);
}

#[test]
fn nested_insert_under_dotted_key_stays_dotted() {
    let mut d = doc(MODEL);
    set(&mut d, "c.fin.root.thickness", "3 mm");
    set(&mut d, "c.fin.root.edge.profile", "rounded");
    let out = d.to_string();
    assert!(out.contains("root.thickness = \"3 mm\"\n"), "{out}");
    assert!(out.contains("root.edge.profile = \"rounded\"\n"), "{out}");
    assert!(!out.contains("[c.fin.root"), "{out}");
    let r = doc(&out);
    assert_eq!(
        r["c"]["fin"]["root"]["edge"]["profile"].as_str(),
        Some("rounded")
    );
    assert_reparse_idempotent(&out);
}

#[test]
fn nested_new_subtable_under_explicit_table() {
    let mut d = doc(MODEL);
    set(&mut d, "c.body.finish.paint", "gloss");
    let out = d.to_string();
    assert!(
        out.contains("[c.body]\ntype = \"body_tube\"\n\n[c.body.finish]\npaint = \"gloss\"\n"),
        "{out}"
    );
    assert_reparse_idempotent(&out);
}

// ---- arrays ----------------------------------------------------------------------

#[test]
fn array_of_tables_replace_and_insert() {
    let mut d = doc(MODEL);
    set(&mut d, "stage[1].motor", "G64");
    set(&mut d, "stage[0].delay", "6 s");
    let out = d.to_string();
    assert!(
        out.contains("[[stage]]   # booster\nmotor = \"H128\"\ndelay = \"6 s\"\n"),
        "{out}"
    );
    assert!(
        out.contains("[[stage]]   # sustainer\nmotor = \"G64\"   # long burn\n"),
        "{out}"
    );
    assert_comments_kept(MODEL, &out);
    assert_reparse_idempotent(&out);
}

#[test]
fn array_of_tables_append_entry() {
    let mut d = doc(MODEL);
    set(&mut d, "stage[2].motor", "F50");
    let t = ensure_table(&mut d, &p("stage[3]")).unwrap();
    assert!(t.is_empty());
    let out = d.to_string();
    let r = doc(&out);
    let stages = r["stage"].as_array_of_tables().unwrap();
    assert_eq!(stages.len(), 4);
    assert_eq!(stages.get(2).unwrap()["motor"].as_str(), Some("F50"));
    assert!(
        out.contains("motor = \"G80\"   # long burn\n\n[[stage]]\nmotor = \"F50\"\n"),
        "{out}"
    );
    assert_comments_kept(MODEL, &out);
    assert_reparse_idempotent(&out);
}

#[test]
fn array_of_tables_created_from_scratch() {
    let mut d = doc("# top\n[c.body]\ntype = \"body_tube\"\n");
    set(&mut d, "event[0].trigger", "apogee");
    set(&mut d, "event[1].trigger", "altitude");
    let out = d.to_string();
    assert_eq!(
        out,
        "# top\n[c.body]\ntype = \"body_tube\"\n\n[[event]]\ntrigger = \"apogee\"\n\n[[event]]\ntrigger = \"altitude\"\n"
    );
    assert_reparse_idempotent(&out);
}

#[test]
fn array_of_tables_nested_table_inside_entry() {
    let mut d = doc(MODEL);
    set(&mut d, "stage[0].recovery.main", "chute");
    let out = d.to_string();
    assert!(
        out.contains("[stage.recovery]\nmain = \"chute\"\n"),
        "{out}"
    );
    let r = doc(&out);
    let first = r["stage"].as_array_of_tables().unwrap().get(0).unwrap();
    assert_eq!(first["recovery"]["main"].as_str(), Some("chute"));
    assert_reparse_idempotent(&out);
}

#[test]
fn array_value_replace_and_append() {
    let mut d = doc(MODEL);
    set(&mut d, "c.fin.points[1]", 20);
    set(&mut d, "c.fin.points[3]", 4);
    set(&mut d, "c.fin.tags[0]", "red");
    let out = d.to_string();
    assert!(out.contains("points = [1, 20, 3, 4]\n"), "{out}");
    assert!(out.contains("tags = [\"red\"]\n"), "{out}");

    let mut m = doc("xs = [\n  1,  # one\n  2,\n]\n");
    set(&mut m, "xs[2]", 3);
    set(&mut m, "xs[0]", 10);
    assert_eq!(m.to_string(), "xs = [\n  10,  # one\n  2,\n  3,\n]\n");
}

// ---- errors leave the document unchanged ------------------------------------------

#[test]
fn errors_are_atomic() {
    let cases: &[(&str, PatchError)] = &[
        (
            "c.fin",
            PatchError::TypeConflict {
                path: "c.fin".into(),
                found: "a table",
                expected: "a value",
            },
        ),
        (
            "c.fin.span.x",
            PatchError::TypeConflict {
                path: "c.fin.span".into(),
                found: "a string",
                expected: "a table",
            },
        ),
        (
            "stage[5].motor",
            PatchError::IndexOutOfRange {
                path: "stage[5]".into(),
                index: 5,
                len: 2,
            },
        ),
        (
            "newarr[1]",
            PatchError::IndexOutOfRange {
                path: "newarr[1]".into(),
                index: 1,
                len: 0,
            },
        ),
        (
            "c.fin.count[0]",
            PatchError::TypeConflict {
                path: "c.fin.count".into(),
                found: "an integer",
                expected: "an array",
            },
        ),
        (
            "fresh.list[2].x",
            PatchError::IndexOutOfRange {
                path: "fresh.list[2]".into(),
                index: 2,
                len: 0,
            },
        ),
    ];
    for (path, want) in cases {
        let mut d = doc(MODEL);
        let got = set_value_preserving(&mut d, &p(path), 1).unwrap_err();
        assert_eq!(&got, want, "{path}");
        assert_eq!(d.to_string(), MODEL, "{path} modified the document");
    }

    let mut d = doc(MODEL);
    assert_eq!(
        set_value_preserving(&mut d, &[], 1).unwrap_err(),
        PatchError::EmptyPath
    );
    let err = ensure_table(&mut d, &p("c.fin.span")).err().unwrap();
    assert_eq!(
        err,
        PatchError::TypeConflict {
            path: "c.fin.span".into(),
            found: "a string",
            expected: "a table"
        }
    );
    let err = ensure_table(&mut d, &p("new.tbl.list[3]")).err().unwrap();
    assert_eq!(
        err,
        PatchError::IndexOutOfRange {
            path: "new.tbl.list[3]".into(),
            index: 3,
            len: 0
        }
    );
    assert_eq!(d.to_string(), MODEL);
}

// ---- idempotence and comment preservation ------------------------------------------

/// A batch of patches covering every kind of edit above.
fn patch_all(d: &mut DocumentMut) {
    set(d, "name", "demo-2");
    set(d, "c.fin.span", "90 mm");
    set(d, "c.fin.cant", "0 deg");
    set(d, "c.fin.root.thickness", "3 mm");
    set(d, "c.nose.shape.length", "130 mm");
    set(d, "c.chute.type", "parachute");
    set(d, "c.fin.points[3]", 4);
    set(d, "stage[1].motor", "G64");
    set(d, "stage[2].motor", "F50");
}

#[test]
fn reparse_idempotent_and_patch_idempotent() {
    let mut d = doc(MODEL);
    patch_all(&mut d);
    let out = d.to_string();
    assert_reparse_idempotent(&out);

    // Re-applying the same patches to the parsed output changes nothing,
    // except the append that adds another array element / stage.
    let mut again = doc(&out);
    for (path, v) in [
        ("name", Value::from("demo-2")),
        ("c.fin.span", Value::from("90 mm")),
        ("c.fin.cant", Value::from("0 deg")),
        ("c.fin.root.thickness", Value::from("3 mm")),
        ("c.nose.shape.length", Value::from("130 mm")),
        ("c.chute.type", Value::from("parachute")),
        ("c.fin.points[3]", Value::from(4)),
        ("stage[1].motor", Value::from("G64")),
        ("stage[2].motor", Value::from("F50")),
    ] {
        set_value_preserving(&mut again, &p(path), v).unwrap();
    }
    assert_eq!(again.to_string(), out);

    // The logical data matches what was written.
    let r = doc(&out);
    assert_eq!(r["c"]["fin"]["span"].as_str(), Some("90 mm"));
    assert_eq!(r["c"]["chute"]["type"].as_str(), Some("parachute"));
    assert_eq!(r["stage"].as_array_of_tables().unwrap().len(), 3);
}

#[test]
fn comments_preserved_through_all_patches() {
    let mut d = doc(MODEL);
    patch_all(&mut d);
    let out = d.to_string();
    assert_comments_kept(MODEL, &out);
    assert!(out.contains(r#"span = "90 mm"   # tweak me"#), "{out}");
    assert!(out.contains(r#"name = "demo-2"   # display name"#), "{out}");
    assert!(
        out.contains("[[stage]]   # sustainer\nmotor = \"G64\"   # long burn\n"),
        "{out}"
    );
    assert!(out.ends_with("\n# end of file\n"), "{out}");
}

// ---- TOML 1.0 output --------------------------------------------------------------

#[test]
fn toml10_values_written_by_helpers() {
    let mut d = DocumentMut::new();
    set(&mut d, "s", "esc\u{1b}[0m tab\t");
    let time: toml_edit::Datetime = "07:30".parse().unwrap();
    set(&mut d, "t", time);
    let mut inline = InlineTable::new();
    inline.insert("a", 1.into());
    inline.insert("b", 2.into());
    set(&mut d, "i", inline);
    assert_eq!(
        d.to_string(),
        "s = \"esc\\u001B[0m tab\\t\"\nt = 07:30:00\ni = { a = 1, b = 2 }\n"
    );
}

#[test]
fn toml10_rewrites_toml11_source_syntax() {
    let src = "# keep\n\
               a = {\n  x = 1,\n  y = { z = 2, },\n}   # was multi-line\n\
               s = \"\\e[1m\\x41\"   # esc\n\
               lit = 'C:\\x\\e'\n\
               keep = \"\\\\e and \\\\x\"\n\
               t = 07:30\n\
               dt = 2026-10-15T07:30Z\n";
    let d = doc(src);
    let out = to_toml10_string(&d);
    assert_eq!(
        out,
        "# keep\n\
         a = { x = 1, y = { z = 2 } }   # was multi-line\n\
         s = \"\\u001B[1mA\"   # esc\n\
         lit = 'C:\\x\\e'\n\
         keep = \"\\\\e and \\\\x\"\n\
         t = 07:30:00\n\
         dt = 2026-10-15T07:30:00Z\n"
    );
    // The logical values are unchanged.
    let r = doc(&out);
    assert_eq!(r["s"].as_str(), Some("\u{1b}[1mA"));
    assert_eq!(r["a"]["y"]["z"].as_integer(), Some(2));
    assert_reparse_idempotent(&out);
}

#[test]
fn toml10_leaves_toml10_source_byte_identical() {
    let d = doc(MODEL);
    assert_eq!(to_toml10_string(&d), MODEL);
    let mut d = doc(MODEL);
    patch_all(&mut d);
    assert_eq!(to_toml10_string(&d), d.to_string());
}

// ---- paths ------------------------------------------------------------------------

#[test]
fn path_parse_and_render() {
    assert_eq!(
        parse_path("c.fin.span").unwrap(),
        vec![Seg::from("c"), Seg::from("fin"), Seg::from("span")]
    );
    assert_eq!(
        parse_path("stage[1].m[0][2]").unwrap(),
        vec![
            Seg::from("stage"),
            Seg::Index(1),
            Seg::from("m"),
            Seg::Index(0),
            Seg::Index(2)
        ]
    );
    let odd = vec![Seg::from("c"), Seg::from("a.b \"q\""), Seg::from("x-1")];
    assert_eq!(path_string(&odd), r#"c."a.b \"q\"".x-1"#);
    assert_eq!(parse_path(&path_string(&odd)).unwrap(), odd);
    assert_eq!(Seg::Index(3).to_string(), "[3]");
    for bad in [
        "", ".", "a.", "a..b", "a[", "a[x]", "[0]", "a b", "\"open", "a[1]b",
    ] {
        assert!(parse_path(bad).is_err(), "{bad:?} should not parse");
    }
}

#[test]
fn quoted_keys_patch() {
    let mut d = doc("[c.\"odd.id\"]   # quoted\nx = 1\n");
    set(&mut d, "c.\"odd.id\".x", 2);
    assert_eq!(d.to_string(), "[c.\"odd.id\"]   # quoted\nx = 2\n");
}

#[test]
fn value_into_implicit_parent_goes_last() {
    // The spike's source: the leading comment is the prefix of `[c.fin]`, and
    // `[c]` is implicit with no position. Giving `c` a value must not print
    // `[c]` above `# rocket model`.
    let src = "# rocket model\n[c.fin]   # fin set\ntype = \"trapezoidal_fins\"\nspan = \"80 mm\"   # tweak me\ncount = 4\n\n# trailing comment\n[c.body]\ntype = \"body_tube\"\n";
    let mut d = doc(src);
    set(&mut d, "c.version", 1);
    set(&mut d, "c.fin.span", "90 mm");
    set(&mut d, "c.chute.type", "parachute");
    let out = d.to_string();
    assert_eq!(
        out,
        "# rocket model\n[c.fin]   # fin set\ntype = \"trapezoidal_fins\"\nspan = \"90 mm\"   # tweak me\ncount = 4\n\n# trailing comment\n[c.body]\ntype = \"body_tube\"\n\n[c.chute]\ntype = \"parachute\"\n\n[c]\nversion = 1\n"
    );
    assert_eq!(doc(&out)["c"]["version"].as_integer(), Some(1));
    assert_reparse_idempotent(&out);
}
