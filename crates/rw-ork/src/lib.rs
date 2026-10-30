//! OpenRocket `.ork` import and export (R5.5, R3.1; M2.5/M2.6).
//!
//! Works on in-memory data only: the container (zip, gzip, or plain XML,
//! including a zip nested inside the zip) is unwrapped by
//! `rw_project::container` into an [`OrkFiles`]; this crate turns the XML
//! into RocketWright source documents and writes the format back.
//!
//! Import ([`import`]):
//!
//! - streaming XML read (quick-xml), skipping stored flight data;
//! - each component gets a slug id from its name (the file's UUID is kept in
//!   `import.uuid` for event mapping);
//! - top/middle/bottom/absolute/after placement becomes `attach` with an
//!   `offset` (an expression when it depends on a length);
//! - "auto" radii become expressions on the neighbour or parent (`= c.body.od`),
//!   or are left to RocketWright's own defaults (ring and bulkhead diameters);
//! - a body tube that is itself a motor mount gets a zero-mass inner tube in
//!   its bore that holds the motors (RocketWright mounts motors in inner
//!   tubes only), with a `RW-W010` note;
//! - materials, finishes (as explicit roughness), appearance colours,
//!   overrides, stages, flight configurations, and simulations map to their
//!   RocketWright fields;
//! - motors resolve in order: a curve embedded in the file (copied into
//!   `lib/motors/`), a local ThrustCurve cache entry ([`MotorCache`]), else the
//!   nearest built-in generic curve (`RW-W103 motor-substituted`, recorded in
//!   the configuration's `import` provenance).
//!
//! Export ([`export::write_ork`]) writes the evaluated model back as format
//! XML that this importer reads; a round trip keeps component ids (stored in
//! each component's comment) and dimensions.
//!
//! Pure crate (invariant I5): builds for native and wasm32, with no filesystem,
//! clock, randomness, or threads. Enforced by the root `clippy.toml`.
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;

use rw_model::{
    ConfigDoc, Diagnostic, MotorResolution, ProjectManifest, RocketDoc, SimDoc, SourceDoc,
    SourceSet,
};

pub mod export;
mod import;
pub mod motors;
mod sims;
pub mod util;
pub mod xml;

pub use import::import;

/// The unwrapped contents of an `.ork` container.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrkFiles {
    /// The rocket XML document.
    pub xml: Vec<u8>,
    /// Every other entry, by sanitized relative path (`thrustcurves/<x>.rse`).
    pub files: BTreeMap<String, Vec<u8>>,
}

/// An import or export failure.
#[derive(Debug, Clone, PartialEq)]
pub enum OrkError {
    /// The XML does not parse.
    Xml(String),
    /// The XML parses but is not an OpenRocket document.
    NotOrk(String),
}

impl std::fmt::Display for OrkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OrkError::Xml(m) => write!(f, "the .ork XML does not parse: {m}"),
            OrkError::NotOrk(m) => write!(f, "not an OpenRocket document: {m}"),
        }
    }
}

impl std::error::Error for OrkError {}

/// The identity of a motor as an `.ork` names it.
#[derive(Debug, Clone, PartialEq)]
pub struct MotorKey {
    pub manufacturer: Option<String>,
    pub designation: String,
    pub digest: Option<String>,
    /// Diameter (m).
    pub diameter: Option<f64>,
    /// Length (m).
    pub length: Option<f64>,
}

/// A motor file found in a cache.
#[derive(Debug, Clone, PartialEq)]
pub struct CachedMotor {
    /// File name (`Estes_C6.rse`); `.eng` or `.rse`.
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// A local cache of downloaded thrust curves (ThrustCurve.org, filled only
/// under `make parity` or an approved call). The importer never fetches.
pub trait MotorCache {
    fn lookup(&self, key: &MotorKey) -> Option<CachedMotor>;
}

/// No cache: embedded curves, else generic substitutes.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCache;

impl MotorCache for NoCache {
    fn lookup(&self, _key: &MotorKey) -> Option<CachedMotor> {
        None
    }
}

/// How one configuration's mount got its motor.
#[derive(Debug, Clone, PartialEq)]
pub struct MotorUse {
    pub config: String,
    pub mount: String,
    pub key: MotorKey,
    pub resolution: MotorResolution,
    /// The motor ref written into the configuration.
    pub motor_ref: String,
}

/// The documents an import produces.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OrkImport {
    /// The rocket's name.
    pub name: String,
    /// `<openrocket version>`.
    pub format_version: Option<String>,
    pub rocket: RocketDoc,
    /// Default configuration id.
    pub default_config: Option<String>,
    /// Configuration id → document (`configs/<id>.rw.toml`).
    pub configs: BTreeMap<String, ConfigDoc>,
    /// Simulation id → document (`sims/<id>.rw.toml`).
    pub sims: BTreeMap<String, SimDoc>,
    /// Motor files to write, by project-relative path (`lib/motors/…`).
    pub lib_files: BTreeMap<String, Vec<u8>>,
    pub motors: Vec<MotorUse>,
    /// Component id → the file's UUID.
    pub uuids: BTreeMap<String, String>,
    /// Import findings (`RW-W010`, `RW-W103`).
    pub diagnostics: Vec<Diagnostic>,
}

impl OrkImport {
    /// The project source documents of the import, by project-relative path:
    /// `rocketwright.toml` (named `project_name`, or the rocket's name),
    /// `rocket.rw.toml`, `configs/<id>.rw.toml`, and `sims/<id>.rw.toml`.
    /// Motor files ([`OrkImport::lib_files`]) are not sources.
    pub fn source_set(&self, project_name: Option<&str>) -> SourceSet {
        let mut docs = BTreeMap::new();
        docs.insert(
            "rocketwright.toml".to_string(),
            SourceDoc::Project(ProjectManifest {
                schema_url: None,
                format: 1,
                name: project_name.unwrap_or(&self.name).to_string(),
                model: None,
                default_config: self.default_config.clone(),
                display_units: [("length", "mm"), ("mass", "g")]
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                lib: None,
            }),
        );
        docs.insert(
            "rocket.rw.toml".to_string(),
            SourceDoc::Rocket(self.rocket.clone()),
        );
        for (id, c) in &self.configs {
            docs.insert(
                format!("configs/{id}.rw.toml"),
                SourceDoc::Config(c.clone()),
            );
        }
        for (id, s) in &self.sims {
            docs.insert(format!("sims/{id}.rw.toml"), SourceDoc::Sim(s.clone()));
        }
        SourceSet { docs }
    }
}

/// Options for [`import`].
pub struct ImportOptions<'a> {
    pub cache: &'a dyn MotorCache,
}

impl Default for ImportOptions<'_> {
    fn default() -> Self {
        ImportOptions { cache: &NoCache }
    }
}
