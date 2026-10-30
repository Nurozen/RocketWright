//! Builds the vendored NASA CEA (`third_party/cea`) as static libraries and
//! links them, plus the GCC runtime archives, into the crate. Only runs with
//! the `cea` feature; without it this script does nothing.
//!
//! Recipe (docs/dev/environment.md, RL2):
//! 1. Copy `third_party/cea` to `$OUT_DIR/cea-src` (CEA's top-level build
//!    writes into its source tree; the vendored tree stays pristine) and apply
//!    `patches/0001-bindc-libtype.patch` to the copy.
//! 2. Configure, build, and install with cmake into `$OUT_DIR/install`
//!    (static `cea_bindc`, C binding only, `CMAKE_OSX_DEPLOYMENT_TARGET` set).
//! 3. Copy the GCC runtime archives (resolved with `gfortran -print-file-name`)
//!    into `$OUT_DIR` as `librw_*.a`: macOS ld64 has no `-l:libfoo.a`, and
//!    `-lgfortran` would pick the dylib next to the archive.
//! 4. Export the compiled database dir: `cargo:data` (DEP_CEA_BINDC_DATA for
//!    dependents) and `RW_CEA_BUILD_DATA_DIR` (in-tree tests and tools only).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)] // native build script

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_CEA").is_none() {
        return;
    }
    let target = env::var("TARGET").unwrap_or_default();
    if target.starts_with("wasm32") {
        panic!("rw-cea-sys: the `cea` feature is native-only (target {target})");
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendored = manifest.join("../../third_party/cea");
    let vendored = vendored
        .canonicalize()
        .unwrap_or_else(|e| panic!("rw-cea-sys: {} not found: {e}", vendored.display()));
    println!("cargo:rerun-if-changed={}", vendored.display());
    for var in ["MACOSX_DEPLOYMENT_TARGET", "FC", "RW_CEA_JOBS"] {
        println!("cargo:rerun-if-env-changed={var}");
    }

    let gfortran = env::var("FC").unwrap_or_else(|_| "gfortran".into());
    require_tool(
        &gfortran,
        "--version",
        "install GCC's gfortran (macOS: `brew install gcc`; Debian/Ubuntu: `apt install gfortran`)",
    );
    require_tool(
        "cmake",
        "--version",
        "install cmake >= 3.20 (macOS: `brew install cmake`)",
    );
    require_tool("patch", "--version", "install `patch`");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));

    // 1. Pristine copy + patch.
    let src = out.join("cea-src");
    if src.exists() {
        fs::remove_dir_all(&src).expect("remove stale cea-src");
    }
    copy_tree(&vendored, &src, true);
    run(Command::new("patch")
        .args(["-p1", "--batch", "--forward", "-d"])
        .arg(&src)
        .arg("-i")
        .arg(src.join("patches/0001-bindc-libtype.patch")));

    // 2. cmake configure / build / install.
    let build = out.join("cea-build");
    let prefix = out.join("install");
    let deployment = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".into());
    let mut configure = Command::new("cmake");
    configure
        .arg("-S")
        .arg(&src)
        .arg("-B")
        .arg(&build)
        .args(["-G", "Unix Makefiles"])
        .arg("-DCMAKE_BUILD_TYPE=Release")
        .arg(format!("-DCMAKE_Fortran_COMPILER={gfortran}"))
        .arg("-DCMAKE_Fortran_FLAGS=-fimplicit-none -ffree-line-length-none")
        .arg("-DCEA_ENABLE_BIND_C=ON")
        .arg("-DCEA_ENABLE_BIND_CXX=OFF")
        .arg("-DCEA_ENABLE_BIND_PYTHON=OFF")
        .arg("-DCEA_ENABLE_BIND_MATLAB=OFF")
        .arg("-DCEA_ENABLE_BIND_EXCEL=OFF")
        .arg("-DCEA_BUILD_TESTING=OFF")
        .arg("-DBUILD_TESTING=OFF")
        .arg("-DCEA_BINDC_LIBTYPE=STATIC")
        .arg("-DCMAKE_INSTALL_LIBDIR=lib")
        .arg(format!("-DCMAKE_INSTALL_PREFIX={}", prefix.display()));
    if target.contains("apple") {
        configure.arg(format!("-DCMAKE_OSX_DEPLOYMENT_TARGET={deployment}"));
    }
    run(&mut configure);
    let jobs = env::var("RW_CEA_JOBS")
        .or_else(|_| env::var("NUM_JOBS"))
        .unwrap_or_else(|_| "4".into());
    run(Command::new("cmake")
        .arg("--build")
        .arg(&build)
        .args(["-j", &jobs]));
    run(Command::new("cmake").arg("--install").arg(&build));

    let lib = prefix.join("lib");
    for a in ["libcea_bindc.a", "libcea_core.a", "libfbasics_core.a"] {
        assert!(
            lib.join(a).is_file(),
            "rw-cea-sys: cmake install did not produce {}",
            lib.join(a).display()
        );
    }
    println!("cargo:rustc-link-search=native={}", lib.display());
    for l in ["cea_bindc", "cea_core", "fbasics_core"] {
        println!("cargo:rustc-link-lib=static={l}");
    }

    // 3. GCC runtime, static, under unique names.
    let gfortran_a = PathBuf::from(tool_output(&gfortran, "-print-file-name=libgfortran.a"));
    let libgcc_a = PathBuf::from(tool_output(&gfortran, "-print-libgcc-file-name"));
    let gf_dir = gfortran_a
        .parent()
        .expect("libgfortran.a dir")
        .to_path_buf();
    let gcc_dir = libgcc_a.parent().expect("libgcc.a dir").to_path_buf();
    let runtime = [
        (gfortran_a.clone(), "rw_gfortran", true),
        (gf_dir.join("libquadmath.a"), "rw_quadmath", false),
        (libgcc_a.clone(), "rw_gcc", true),
        // Needed under rustc on macOS (___emutls_get_address); absent on Linux.
        (gcc_dir.join("libemutls_w.a"), "rw_emutls_w", false),
    ];
    let mut linked = Vec::new();
    for (from, name, required) in runtime {
        let to = out.join(format!("lib{name}.a"));
        // Stale copies inherit Homebrew's 0444 mode; delete only our copy.
        if to.exists() {
            fs::remove_file(&to).expect("remove stale runtime archive copy");
        }
        if !from.is_file() {
            assert!(
                !required,
                "rw-cea-sys: GCC runtime archive {} not found (from `{gfortran} -print-file-name`)",
                from.display()
            );
            continue;
        }
        fs::copy(&from, &to).unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
        let mut perm = fs::metadata(&to).expect("stat copy").permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&to, perm).expect("chmod copy");
        linked.push(name);
    }
    println!("cargo:rustc-link-search=native={}", out.display());
    for name in linked {
        println!("cargo:rustc-link-lib=static={name}");
    }

    // 4. Compiled databases (thermo.lib, trans.lib; compiler-ABI specific).
    let data = prefix.join("share/cea");
    for f in ["thermo.lib", "trans.lib"] {
        assert!(
            data.join(f).is_file(),
            "rw-cea-sys: cmake install did not produce {}",
            data.join(f).display()
        );
    }
    println!("cargo:data={}", data.display());
    println!("cargo:rustc-env=RW_CEA_BUILD_DATA_DIR={}", data.display());
}

fn require_tool(tool: &str, arg: &str, hint: &str) {
    match Command::new(tool).arg(arg).output() {
        Ok(o) if o.status.success() => {}
        _ => panic!("rw-cea-sys (feature `cea`): `{tool}` not found or not working; {hint}"),
    }
}

fn tool_output(tool: &str, arg: &str) -> String {
    let o = Command::new(tool)
        .arg(arg)
        .output()
        .unwrap_or_else(|e| panic!("run `{tool} {arg}`: {e}"));
    assert!(o.status.success(), "`{tool} {arg}` failed");
    String::from_utf8(o.stdout)
        .expect("utf-8 tool output")
        .trim()
        .to_string()
}

fn run(cmd: &mut Command) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("rw-cea-sys: spawn {cmd:?}: {e}"));
    assert!(status.success(), "rw-cea-sys: {cmd:?} failed ({status})");
}

/// Recursive copy. At the top level, skips in-place build dirs (`build*`).
fn copy_tree(from: &Path, to: &Path, top: bool) {
    fs::create_dir_all(to).unwrap_or_else(|e| panic!("mkdir {}: {e}", to.display()));
    for entry in fs::read_dir(from).unwrap_or_else(|e| panic!("read {}: {e}", from.display())) {
        let entry = entry.expect("dir entry");
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s == ".DS_Store" || (top && name_s.starts_with("build")) {
            continue;
        }
        let ty = entry.file_type().expect("file type");
        let dst = to.join(&name);
        if ty.is_dir() {
            copy_tree(&entry.path(), &dst, false);
        } else if ty.is_file() {
            fs::copy(entry.path(), &dst)
                .unwrap_or_else(|e| panic!("copy {}: {e}", entry.path().display()));
        }
    }
}
