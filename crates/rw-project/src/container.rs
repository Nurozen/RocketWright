//! `.ork` containers (M2.5): a ZIP holding the rocket XML (plus embedded
//! thrust curves and decals), a gzip-compressed XML, or bare XML. Some files
//! hold a ZIP inside the ZIP (or gzip inside it); [`read_container`] unwraps
//! those too. Entry names are sanitized (no absolute paths, no `..`), and the
//! total unpacked size is capped so a hostile archive cannot exhaust memory.
//!
//! [`write_container`] writes the ZIP form deterministically (fixed entry
//! times, sorted entries), so the same model always exports the same bytes.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

use rw_ork::OrkFiles;

/// The most bytes an import unpacks (all entries, all nesting levels).
pub const MAX_UNPACKED: u64 = 256 * 1024 * 1024;
/// How deep containers may nest (zip in zip in gzip ...).
const MAX_NESTING: usize = 4;
/// The rocket document's entry name in the files this writer produces.
pub const ROCKET_ENTRY: &str = "rocket.ork";

/// What the first bytes say a blob is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniff {
    Zip,
    Gzip,
    Xml,
    Unknown,
}

/// Classifies `bytes` by magic number (XML: optional BOM and whitespace,
/// then `<`).
pub fn sniff(bytes: &[u8]) -> Sniff {
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Sniff::Zip;
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Sniff::Gzip;
    }
    let b = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    match b.iter().find(|c| !c.is_ascii_whitespace()) {
        Some(b'<') => Sniff::Xml,
        _ => Sniff::Unknown,
    }
}

/// A sanitized relative entry path (`/` separators, no `.`/`..`, not
/// absolute), or `None` for a name that tries to escape.
pub fn sanitize(name: &str) -> Option<String> {
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for p in name.split('/') {
        match p {
            "" | "." => {}
            ".." => return None,
            p if p.contains(':') => return None,
            p => parts.push(p),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

struct Budget(u64);

impl Budget {
    fn take(&mut self, n: u64) -> Result<(), String> {
        if n > self.0 {
            return Err(format!(
                "the file unpacks to more than {} MB",
                MAX_UNPACKED / (1024 * 1024)
            ));
        }
        self.0 -= n;
        Ok(())
    }
}

fn read_limited(r: impl Read, budget: &mut Budget) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    r.take(budget.0 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("cannot decompress: {e}"))?;
    budget.take(out.len() as u64)?;
    Ok(out)
}

fn gunzip(bytes: &[u8], budget: &mut Budget) -> Result<Vec<u8>, String> {
    read_limited(flate2::read::GzDecoder::new(bytes), budget)
}

/// Unwraps an `.ork` (zip, gzip, or XML; nested containers included).
pub fn read_container(bytes: &[u8]) -> Result<OrkFiles, String> {
    let mut budget = Budget(MAX_UNPACKED);
    let mut out = OrkFiles::default();
    let mut xml = None;
    unwrap_into(bytes, "", 0, &mut budget, &mut xml, &mut out.files)?;
    out.xml = xml.ok_or_else(|| "the file holds no rocket XML document".to_string())?;
    Ok(out)
}

/// Picks the rocket document among XML candidates: `rocket.ork` first, then
/// any `.ork`, then the first other XML entry.
fn rank(name: &str) -> u8 {
    let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    if base == ROCKET_ENTRY {
        0
    } else if base.ends_with(".ork") {
        1
    } else if base.ends_with(".xml") || !base.contains('.') {
        2
    } else {
        3
    }
}

fn unwrap_into(
    bytes: &[u8],
    prefix: &str,
    depth: usize,
    budget: &mut Budget,
    xml: &mut Option<Vec<u8>>,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    if depth > MAX_NESTING {
        return Err("containers are nested too deeply".into());
    }
    match sniff(bytes) {
        Sniff::Xml => {
            if xml.is_none() {
                *xml = Some(bytes.to_vec());
            }
            Ok(())
        }
        Sniff::Gzip => {
            let inner = gunzip(bytes, budget)?;
            unwrap_into(&inner, prefix, depth + 1, budget, xml, files)
        }
        Sniff::Zip => {
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
                .map_err(|e| format!("not a readable zip: {e}"))?;
            let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
            for i in 0..zip.len() {
                let f = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
                if f.is_dir() {
                    continue;
                }
                let Some(name) = f.name().ok().and_then(|n| sanitize(&n)) else {
                    continue;
                };
                let data = read_limited(f, budget)?;
                entries.push((name, data));
            }
            // The rocket document: the best-ranked XML entry; nested
            // containers are searched when no entry here is XML.
            let mut best: Option<(u8, usize)> = None;
            for (k, (name, data)) in entries.iter().enumerate() {
                if sniff(data) == Sniff::Xml && rank(name) < 3 {
                    let r = rank(name);
                    if best.is_none_or(|(b, _)| r < b) {
                        best = Some((r, k));
                    }
                }
            }
            if xml.is_none()
                && let Some((_, k)) = best
            {
                *xml = Some(entries[k].1.clone());
            }
            for (k, (name, data)) in entries.into_iter().enumerate() {
                if best.is_some_and(|(_, b)| b == k) {
                    continue;
                }
                let path = format!("{prefix}{name}");
                match sniff(&data) {
                    Sniff::Zip | Sniff::Gzip if rank(&name) < 3 || name.ends_with(".gz") => {
                        unwrap_into(&data, prefix, depth + 1, budget, xml, files)?;
                    }
                    _ => {
                        files.insert(path, data);
                    }
                }
            }
            Ok(())
        }
        Sniff::Unknown => Err("not an .ork file (neither zip, gzip, nor XML)".into()),
    }
}

/// Writes the ZIP form: `rocket.ork` first, then `files` sorted by path.
pub fn write_container(xml: &[u8], files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    let mut put = |name: &str, data: &[u8]| {
        // In-memory writes cannot fail short of allocation failure.
        w.start_file(name, opts).expect("zip entry");
        w.write_all(data).expect("zip write");
    };
    put(ROCKET_ENTRY, xml);
    for (p, data) in files {
        if let Some(p) = sanitize(p) {
            put(&p, data);
        }
    }
    w.finish().expect("zip finish").into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &[u8] = b"<?xml version='1.0'?>\n<openrocket version=\"1.9\"><rocket/></openrocket>";

    fn gz(b: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn sniffs_and_reads_every_form() {
        assert_eq!(sniff(XML), Sniff::Xml);
        assert_eq!(sniff(b"\xef\xbb\xbf  <a/>"), Sniff::Xml);
        assert_eq!(sniff(b"hello"), Sniff::Unknown);
        assert_eq!(read_container(XML).unwrap().xml, XML);
        assert_eq!(sniff(&gz(XML)), Sniff::Gzip);
        assert_eq!(read_container(&gz(XML)).unwrap().xml, XML);
        let mut files = BTreeMap::new();
        files.insert(
            "thrustcurves/abc.rse".to_string(),
            b"<engine-database/>".to_vec(),
        );
        let z = write_container(XML, &files);
        assert_eq!(sniff(&z), Sniff::Zip);
        let back = read_container(&z).unwrap();
        assert_eq!(back.xml, XML);
        assert_eq!(
            back.files, files,
            "non-rocket XML entries are kept as files"
        );
        assert_eq!(write_container(XML, &files), z, "deterministic");
        assert!(read_container(b"junk").is_err());
    }

    #[test]
    fn unwraps_a_zip_inside_a_zip_and_gzip_inside_zip() {
        let inner = write_container(XML, &BTreeMap::new());
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("rocket.ork", o).unwrap();
        w.write_all(&inner).unwrap();
        w.start_file("decals/x.png", o).unwrap();
        w.write_all(b"\x89PNG").unwrap();
        let outer = w.finish().unwrap().into_inner();
        let r = read_container(&outer).unwrap();
        assert_eq!(r.xml, XML);
        assert!(r.files.contains_key("decals/x.png"));

        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("rocket.ork", o).unwrap();
        w.write_all(&gz(XML)).unwrap();
        let r = read_container(&w.finish().unwrap().into_inner()).unwrap();
        assert_eq!(r.xml, XML);
    }

    #[test]
    fn hostile_names_are_dropped() {
        assert_eq!(sanitize("a/./b"), Some("a/b".into()));
        assert_eq!(sanitize("../x"), None);
        assert_eq!(sanitize("/etc/passwd"), None);
        assert_eq!(sanitize("C:/x"), None);
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("rocket.ork", o).unwrap();
        w.write_all(XML).unwrap();
        w.start_file("../evil", o).unwrap();
        w.write_all(b"x").unwrap();
        let r = read_container(&w.finish().unwrap().into_inner()).unwrap();
        assert!(r.files.is_empty());
    }
}
