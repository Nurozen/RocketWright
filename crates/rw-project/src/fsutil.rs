//! Atomic file writes: a sibling temp file, `fsync`, then `rename`, so a
//! reader (the watcher, an editor, another process) never sees half a file.

use std::io::Write;
use std::path::{Path, PathBuf};

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.rw-tmp-{}", std::process::id()))
}

/// True for the temp files [`write_atomic`] creates (the watcher skips them).
pub fn is_temp_name(name: &str) -> bool {
    name.contains(".rw-tmp-")
}

/// Writes `bytes` to `path` atomically, creating parent directories.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = temp_path(path);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Removes `path`; a missing file is not an error.
pub fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_atomically() {
        let dir = crate::testutil::TempDir::new("fsutil");
        let p = dir.path().join("a/b/c.txt");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        let names: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["c.txt"], "no temp file left behind");
        remove_if_exists(&p).unwrap();
        remove_if_exists(&p).unwrap();
        assert!(is_temp_name(".c.txt.rw-tmp-12"));
    }
}
