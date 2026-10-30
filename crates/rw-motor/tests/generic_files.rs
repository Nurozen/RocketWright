//! M1.36a, M2.4a: the committed generic motor files in `lib/motors/generic/` obey
//! their recipe (`PROVENANCE.md`).
//!
//! Files are embedded with `include_str!` so this pure crate's tests touch no
//! filesystem API (I5). The parsers here are deliberately minimal and local;
//! the real `.rse`/`.eng` readers land in M1.36b.

macro_rules! generic {
    ($f:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../lib/motors/generic/",
            $f
        ))
    };
}

struct Motor {
    name: &'static str,
    class: &'static str,
    avg_n: f64,
    rse: &'static str,
    eng: &'static str,
}

/// Every committed generic motor: M1.36a (A-C, 18 mm) and M2.4a (the oracle
/// case 2-7 mounts: D 24 mm; I 38 mm short, mid, and long burn).
const MOTORS: [Motor; 7] = [
    Motor {
        name: "RW_A8G",
        class: "A",
        avg_n: 8.0,
        rse: generic!("RW_A8G.rse"),
        eng: generic!("RW_A8G.eng"),
    },
    Motor {
        name: "RW_B4G",
        class: "B",
        avg_n: 4.0,
        rse: generic!("RW_B4G.rse"),
        eng: generic!("RW_B4G.eng"),
    },
    Motor {
        name: "RW_C6G",
        class: "C",
        avg_n: 6.0,
        rse: generic!("RW_C6G.rse"),
        eng: generic!("RW_C6G.eng"),
    },
    Motor {
        name: "RW_D10G",
        class: "D",
        avg_n: 10.0,
        rse: generic!("RW_D10G.rse"),
        eng: generic!("RW_D10G.eng"),
    },
    Motor {
        name: "RW_I261G",
        class: "I",
        avg_n: 261.0,
        rse: generic!("RW_I261G.rse"),
        eng: generic!("RW_I261G.eng"),
    },
    Motor {
        name: "RW_I1294G",
        class: "I",
        avg_n: 1294.0,
        rse: generic!("RW_I1294G.rse"),
        eng: generic!("RW_I1294G.eng"),
    },
    Motor {
        name: "RW_I60G",
        class: "I",
        avg_n: 60.0,
        rse: generic!("RW_I60G.rse"),
        eng: generic!("RW_I60G.eng"),
    },
];

const PROVENANCE: &str = generic!("PROVENANCE.md");

/// Value of `key="..."` in an XML start tag (attribute names are unique here).
fn attr<'a>(tag: &'a str, key: &str) -> &'a str {
    let pat = format!(" {key}=\"");
    let start = tag
        .find(&pat)
        .unwrap_or_else(|| panic!("missing attribute {key}"))
        + pat.len();
    let len = tag[start..].find('"').expect("unterminated attribute");
    &tag[start..start + len]
}

fn num(tag: &str, key: &str) -> f64 {
    attr(tag, key)
        .parse()
        .unwrap_or_else(|e| panic!("{key}: {e}"))
}

struct Rse {
    header: String,
    /// (t s, F N, m g, cg mm)
    rows: Vec<[f64; 4]>,
}

fn parse_rse(text: &str) -> Rse {
    let start = text.find("<engine ").expect("no <engine>");
    let end = start + text[start..].find('>').expect("unterminated <engine>");
    let header = text[start..end].to_string();
    let rows = text
        .match_indices("<eng-data ")
        .map(|(i, _)| {
            let tag = &text[i..i + text[i..].find("/>").expect("unterminated eng-data")];
            [num(tag, "t"), num(tag, "f"), num(tag, "m"), num(tag, "cg")]
        })
        .collect();
    Rse { header, rows }
}

/// Header fields and (t, F) points of a RASP `.eng` file.
fn parse_eng(text: &str) -> (Vec<String>, Vec<(f64, f64)>) {
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with(';'));
    let header = lines
        .next()
        .expect("no header")
        .split_whitespace()
        .map(String::from)
        .collect();
    let pts = lines
        .map(|l| {
            let mut it = l
                .split_whitespace()
                .map(|v| v.parse::<f64>().expect("number"));
            (it.next().expect("t"), it.next().expect("F"))
        })
        .collect();
    (header, pts)
}

/// Cumulative trapezoid impulse at each sample.
fn cumulative_impulse(pts: &[(f64, f64)]) -> Vec<f64> {
    let mut cum = vec![0.0];
    for w in pts.windows(2) {
        let last = *cum.last().expect("non-empty");
        cum.push(last + (w[1].0 - w[0].0) * (w[0].1 + w[1].1) / 2.0);
    }
    cum
}

fn rel(a: f64, b: f64) -> f64 {
    ((a - b) / b).abs()
}

#[test]
fn rse_impulse_matches_header_within_0p1_percent() {
    for m in &MOTORS {
        let r = parse_rse(m.rse);
        let pts: Vec<_> = r.rows.iter().map(|p| (p[0], p[1])).collect();
        let itot = num(&r.header, "Itot");
        let integral = *cumulative_impulse(&pts).last().expect("points");
        assert!(
            rel(integral, itot) < 1e-3,
            "{}: integral {integral} vs header {itot}",
            m.name
        );
    }
}

#[test]
fn rse_header_is_consistent() {
    for m in &MOTORS {
        let r = parse_rse(m.rse);
        let h = &r.header;
        assert_eq!(attr(h, "code"), m.name);
        assert_eq!(attr(h, "mfg"), "RocketWright");
        let itot = num(h, "Itot");
        let tb = num(h, "burn-time");
        // NAR/TRA impulse classes: A (1.25, 2.5] N s, each letter doubling.
        let (lo, hi) = rw_motor::class::class_bounds(m.class)
            .unwrap_or_else(|| panic!("{}: unknown class {}", m.name, m.class));
        assert!(
            itot > lo && itot <= hi,
            "{}: Itot {itot} not class {}",
            m.name,
            m.class
        );
        assert!(rel(num(h, "avgThrust"), itot / tb) < 1e-3, "{}", m.name);
        // The designation number is the average thrust to the nearest newton.
        assert_eq!((itot / tb).round(), m.avg_n, "{}: designation", m.name);
        let peak = r.rows.iter().map(|p| p[1]).fold(0.0, f64::max);
        assert!(rel(num(h, "peakThrust"), peak) < 1e-9, "{}", m.name);
        let last = r.rows.last().expect("rows");
        assert!(rel(last[0], tb) < 1e-9, "{}: last t != burn-time", m.name);
        assert_eq!(r.rows[0][0], 0.0, "{}: first t", m.name);
        assert_eq!(r.rows[0][1], 0.0, "{}: first F", m.name);
        assert_eq!(last[1], 0.0, "{}: last F", m.name);
        for w in r.rows.windows(2) {
            assert!(w[1][0] > w[0][0], "{}: t not increasing", m.name);
        }
        assert!(r.rows.iter().all(|p| p[1] >= 0.0), "{}: negative F", m.name);
        let len = num(h, "len");
        assert!(
            r.rows.iter().all(|p| p[3] > 0.0 && p[3] < len),
            "{}: cg",
            m.name
        );
    }
}

#[test]
fn rse_mass_is_total_motor_mass() {
    for m in &MOTORS {
        let r = parse_rse(m.rse);
        let init = num(&r.header, "initWt");
        let prop = num(&r.header, "propWt");
        let dry = init - prop;
        let first = r.rows[0][2];
        let end = r.rows.last().expect("rows")[2];
        assert!(
            (first - init).abs() < 1e-9,
            "{}: m(0) {first} != initWt {init}",
            m.name
        );
        assert!(
            (end - dry).abs() < 1e-9,
            "{}: m(end) {end} != dry {dry}",
            m.name
        );
        assert!(
            ((first - end) - prop).abs() < 1e-9,
            "{}: m(0) - m(end) != propWt",
            m.name
        );
        for w in r.rows.windows(2) {
            assert!(w[1][2] <= w[0][2], "{}: m not monotone", m.name);
        }
        // m(t) = dry + prop * (1 - I(t) / I(tb)), to the written 1 mg.
        let pts: Vec<_> = r.rows.iter().map(|p| (p[0], p[1])).collect();
        let cum = cumulative_impulse(&pts);
        let total = *cum.last().expect("points");
        for (row, i) in r.rows.iter().zip(&cum) {
            let want = dry + prop * (1.0 - i / total);
            assert!(
                (row[2] - want).abs() <= 5e-4 + 1e-9,
                "{}: m({})",
                m.name,
                row[0]
            );
        }
    }
}

#[test]
fn eng_matches_rse() {
    for m in &MOTORS {
        let r = parse_rse(m.rse);
        let (head, pts) = parse_eng(m.eng);
        assert_eq!(head[0], m.name);
        assert_eq!(head.last().map(String::as_str), Some("RocketWright"));
        let num_at = |i: usize| head[i].parse::<f64>().expect("header number");
        assert!(rel(num_at(1), num(&r.header, "dia")) < 1e-9);
        assert!(rel(num_at(2), num(&r.header, "len")) < 1e-9);
        assert!(rel(num_at(4) * 1000.0, num(&r.header, "propWt")) < 1e-9);
        assert!(rel(num_at(5) * 1000.0, num(&r.header, "initWt")) < 1e-9);
        // RASP omits the implicit (0, 0) point.
        assert_eq!(pts.len() + 1, r.rows.len(), "{}", m.name);
        for (p, row) in pts.iter().zip(&r.rows[1..]) {
            assert_eq!((p.0, p.1), (row[0], row[1]), "{}", m.name);
        }
        let mut full = vec![(0.0, 0.0)];
        full.extend(pts);
        let integral = *cumulative_impulse(&full).last().expect("points");
        assert!(rel(integral, num(&r.header, "Itot")) < 1e-3, "{}", m.name);
    }
}

#[test]
fn every_file_is_in_the_embedded_library() {
    let names: Vec<&str> = MOTORS.iter().map(|m| m.name).collect();
    assert_eq!(names, rw_motor::generic::GENERIC_IDS);
    for m in &MOTORS {
        assert_eq!(rw_motor::generic::generic_source(m.name), Some(m.rse));
        let c = rw_motor::generic::generic_motor(m.name).expect("parses");
        assert_eq!(c.class, m.class, "{}", m.name);
        assert!(
            PROVENANCE.contains(&format!("| `{}` |", m.name)),
            "{}: no parameters row",
            m.name
        );
    }
}

#[test]
fn provenance_lists_every_file_hash() {
    for m in &MOTORS {
        for (ext, text) in [("eng", m.eng), ("rse", m.rse)] {
            let row = format!("| `{}.{ext}` | `{}` |", m.name, sha256_hex(text.as_bytes()));
            assert!(PROVENANCE.contains(&row), "PROVENANCE.md lacks {row}");
        }
    }
}

#[test]
fn sha256_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

/// FIPS 180-4 SHA-256 (test-only; avoids a new dependency).
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}
