//! A small element tree read with quick-xml's streaming reader, plus an
//! escaping writer. Heavy subtrees the importer never needs (stored flight
//! data, photo-studio settings) are skipped while streaming, so a file with
//! thousands of stored data points never lands in memory as elements.

use std::collections::BTreeMap;

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::OrkError;

/// One XML element: name, attributes, trimmed text, children in order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Element {
    pub name: String,
    pub attrs: BTreeMap<String, String>,
    pub text: String,
    pub children: Vec<Element>,
}

/// Elements skipped while streaming (never needed for import).
const SKIP: &[&str] = &["flightdata", "photostudio", "datatypes", "decal"];

impl Element {
    /// The first child named `name`.
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Every child named `name`.
    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// The trimmed text of child `name` (empty text counts as absent).
    pub fn text_of(&self, name: &str) -> Option<&str> {
        self.child(name)
            .map(|c| c.text.trim())
            .filter(|t| !t.is_empty())
    }

    /// Child `name` parsed as a number.
    pub fn num(&self, name: &str) -> Option<f64> {
        self.text_of(name).and_then(parse_num)
    }

    /// Child `name` as a boolean (`true`/`false`).
    pub fn flag(&self, name: &str) -> Option<bool> {
        match self.text_of(name)?.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        }
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
}

/// Parses a number as the format writes it (`NaN`, `Infinity` included).
pub fn parse_num(s: &str) -> Option<f64> {
    let t = s.trim();
    match t {
        "NaN" => Some(f64::NAN),
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => t.parse::<f64>().ok(),
    }
}

fn resolve_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => {
            let n = name.strip_prefix('#')?;
            let code = match n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                Some(h) => u32::from_str_radix(h, 16).ok()?,
                None => n.parse().ok()?,
            };
            return char::from_u32(code);
        }
    })
}

/// Parses an XML document into its root element.
pub fn parse(bytes: &[u8]) -> Result<Element, OrkError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let bad = |e: &dyn std::fmt::Display, r: &Reader<&[u8]>| {
        OrkError::Xml(format!("{e} (at byte {})", r.buffer_position()))
    };
    loop {
        let ev = reader.read_event().map_err(|e| bad(&e, &reader))?;
        match ev {
            Event::Start(e) => {
                let name = e.name().as_ref().to_string();
                if SKIP.contains(&name.as_str()) {
                    reader
                        .read_to_end(e.name())
                        .map_err(|err| bad(&err, &reader))?;
                    continue;
                }
                stack.push(element(&e, name)?);
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_string();
                let el = element(&e, name)?;
                match stack.last_mut() {
                    Some(p) => p.children.push(el),
                    None => root = Some(el),
                }
            }
            Event::End(_) => {
                let Some(mut el) = stack.pop() else {
                    return Err(OrkError::Xml("unbalanced end tag".into()));
                };
                el.text = el.text.trim().to_string();
                match stack.last_mut() {
                    Some(p) => p.children.push(el),
                    None => root = Some(el),
                }
            }
            Event::Text(t) => {
                if let Some(p) = stack.last_mut() {
                    p.text.push_str(&t.xml10_content());
                }
            }
            Event::CData(t) => {
                if let Some(p) = stack.last_mut() {
                    p.text.push_str(&t.into_inner());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(p) = stack.last_mut() {
                    let name = r.as_ref().to_string();
                    match resolve_entity(&name) {
                        Some(c) => p.text.push(c),
                        None => {
                            p.text.push('&');
                            p.text.push_str(&name);
                            p.text.push(';');
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(OrkError::Xml("unexpected end of file".into()));
    }
    root.ok_or_else(|| OrkError::Xml("no root element".into()))
}

fn element(e: &quick_xml::events::BytesStart<'_>, name: String) -> Result<Element, OrkError> {
    let mut attrs = BTreeMap::new();
    for a in e.attributes() {
        let a = a.map_err(|err| OrkError::Xml(err.to_string()))?;
        let k = a.key.as_ref().to_string();
        let v = a
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|err| OrkError::Xml(err.to_string()))?
            .into_owned();
        attrs.insert(k, v);
    }
    Ok(Element {
        name,
        attrs,
        ..Element::default()
    })
}

/// Escapes text for element content and attribute values.
pub fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            c => o.push(c),
        }
    }
    o
}

/// An indenting XML writer.
#[derive(Debug, Default)]
pub struct Writer {
    pub out: String,
    depth: usize,
    open: Vec<String>,
}

impl Writer {
    pub fn new() -> Self {
        let mut w = Writer::default();
        w.out.push_str("<?xml version='1.0' encoding='utf-8'?>\n");
        w
    }

    fn indent(&mut self) {
        for _ in 0..self.depth {
            self.out.push_str("  ");
        }
    }

    fn attrs(&mut self, attrs: &[(&str, String)]) {
        for (k, v) in attrs {
            self.out.push(' ');
            self.out.push_str(k);
            self.out.push_str("=\"");
            self.out.push_str(&escape(v));
            self.out.push('"');
        }
    }

    /// `<name attrs>` and descend.
    pub fn open(&mut self, name: &str, attrs: &[(&str, String)]) {
        self.indent();
        self.out.push('<');
        self.out.push_str(name);
        self.attrs(attrs);
        self.out.push_str(">\n");
        self.depth += 1;
        self.open.push(name.to_string());
    }

    /// `</name>` of the innermost open element.
    pub fn close(&mut self) {
        let name = self.open.pop().unwrap_or_default();
        self.depth = self.depth.saturating_sub(1);
        self.indent();
        self.out.push_str("</");
        self.out.push_str(&name);
        self.out.push_str(">\n");
    }

    /// `<name attrs>text</name>`.
    pub fn leaf(&mut self, name: &str, attrs: &[(&str, String)], text: &str) {
        self.indent();
        self.out.push('<');
        self.out.push_str(name);
        self.attrs(attrs);
        if text.is_empty() {
            self.out.push_str("/>\n");
            return;
        }
        self.out.push('>');
        self.out.push_str(&escape(text));
        self.out.push_str("</");
        self.out.push_str(name);
        self.out.push_str(">\n");
    }

    /// `<name>number</name>` with the shortest round-tripping decimal.
    pub fn num(&mut self, name: &str, v: f64) {
        self.leaf(name, &[], &fmt_num(v));
    }
}

/// The shortest decimal that parses back to exactly `v`.
pub fn fmt_num(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if v == 0.0 {
        "0.0".into()
    } else {
        let s = format!("{v:?}");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entities_attributes_and_skips_heavy_subtrees() {
        let x = br#"<?xml version='1.0' encoding='utf-8'?>
<root a="1 &amp; 2">
  <name>Nose &amp; cone &#x41;</name>
  <flightdata maxaltitude="10"><databranch><datapoint>1,2</datapoint></databranch></flightdata>
  <empty k='v'/>
</root>"#;
        let r = parse(x).unwrap();
        assert_eq!(r.attr("a"), Some("1 & 2"));
        assert_eq!(r.text_of("name"), Some("Nose & cone A"));
        assert!(r.child("flightdata").is_none());
        assert_eq!(r.child("empty").unwrap().attr("k"), Some("v"));
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(parse(b"<a><b></a>").is_err());
        assert!(parse(b"").is_err());
    }

    #[test]
    fn writer_round_trips_through_the_reader() {
        let mut w = Writer::new();
        w.open("root", &[("v", "1<2".into())]);
        w.leaf("t", &[], "a & b");
        w.num("n", 0.1 + 0.2);
        w.close();
        let r = parse(w.out.as_bytes()).unwrap();
        assert_eq!(r.attr("v"), Some("1<2"));
        assert_eq!(r.text_of("t"), Some("a & b"));
        assert_eq!(r.num("n"), Some(0.1 + 0.2));
    }
}
